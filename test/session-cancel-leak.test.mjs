import assert from "node:assert/strict";
import test from "node:test";
import { REPLY, actorOf, callRecord, invokeScoped, portOf, seed, sessionRecord, tempStore } from "./recoverHarness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OPTIONS = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } };

// why: the host allows one session per plugin, so the fake refuses a second open exactly like Core does
function limitedHost({ optionsDelay = 0, openDelay = 0, replyDelay = 0 } = {}) {
  const state = { open: 0, opened: 0, peak: 0, refused: 0 };
  const make = (sessionId, turn = null) => {
    let listener;
    const session = {
      sessionId, effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn,
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send() {
        const turnId = sessionId + "-turn";
        const text = JSON.stringify(REPLY);
        const finish = () => {
          session.turn = { turnId, text, terminal: { kind: "completed" } };
          listener?.({ turnId, kind: "textDelta", text });
          listener?.({ turnId, kind: "contentSaved", sequenceNo: 1 });
          listener?.({ turnId, kind: "completed" });
        };
        if (replyDelay > 0) setTimeout(finish, replyDelay); else finish();
        return { turnId };
      },
      async close() { state.open -= 1; },
      async interrupt() {},
    };
    return session;
  };
  const take = () => {
    if (state.open >= 1) { state.refused += 1; throw Object.assign(new Error("session limit"), { code: "session_limit" }); }
    state.open += 1; state.opened += 1; state.peak = Math.max(state.peak, state.open);
  };
  const ai = {
    async getOptions() { if (optionsDelay > 0) await sleep(optionsDelay); return OPTIONS; },
    async openSession(input) {
      if (openDelay > 0) await sleep(openDelay);
      take();
      if ("resume" in input) return make(input.resume, { turnId: "turn-old", text: JSON.stringify(REPLY), terminal: { kind: "completed" } });
      return make("fresh-" + state.opened);
    },
  };
  return { ai, state };
}

function slowFirstWrite(store, ms) {
  const original = store.transactResumeState.bind(store);
  let armed = true;
  store.transactResumeState = async (fn) => {
    if (armed) { armed = false; await sleep(ms); }
    return original(fn);
  };
}

async function cancelAt(t, { host, delayWrite = 0, abortAfter, seedStranded = false }) {
  const { store } = tempStore(t, "session-leak-");
  const actor = actorOf("sw/a", "p1");
  if (seedStranded) {
    const call = await callRecord(actor, "job1", { hostSessionId: "host-old", turnId: "turn-old", phase: "sent", hostErrorCode: null, retryable: false });
    await seed(store, { sessions: [sessionRecord(actor, "host-old", "active")], calls: [call] });
  }
  if (delayWrite > 0) slowFirstWrite(store, delayWrite);
  const port = portOf(host.ai, store, { graceMs: 20, backstopMs: 60_000 });
  t.after(() => port.cancel());
  const controller = new AbortController();
  const first = invokeScoped(port, actor, "job1", { value: 1 }, controller.signal).then(() => "ok", (error) => "err:" + error.message);
  await sleep(abortAfter);
  controller.abort();
  const firstOutcome = await first;
  return { port, actor, firstOutcome, store };
}

const settle = () => sleep(450);

const POINTS = [
  ["before the session is opened", { host: () => limitedHost({ optionsDelay: 150 }), abortAfter: 40 }],
  ["while the session is being opened", { host: () => limitedHost({ openDelay: 150 }), abortAfter: 40 }],
  ["while the session record is being written", { host: () => limitedHost(), delayWrite: 200, abortAfter: 60 }],
  ["after the turn was sent", { host: () => limitedHost({ replyDelay: 150 }), abortAfter: 60, again: ["job1", { value: 1 }] }],
];

for (const [label, spec] of POINTS) {
  test("a call cancelled " + label + " leaves no open session, the next call runs, and cancel() leaves none", async (t) => {
    const host = spec.host();
    const { port, actor } = await cancelAt(t, { ...spec, host });
    await settle();
    assert.equal(host.state.open, 0, "no session is left open once the cancelled call has settled");
    assert.deepEqual(await invokeScoped(port, actor, ...(spec.again ?? ["job2", { value: 2 }])), REPLY);
    assert.equal(host.state.refused, 0, "the host never refused an open");
    assert.equal(host.state.peak, 1, "at most one session was open at any time");
    await port.cancel();
    assert.equal(host.state.open, 0);
  });
}

test("a next call that arrives while the abandoned open is still being written waits and then runs", async (t) => {
  const host = limitedHost();
  const { port, actor } = await cancelAt(t, { host, delayWrite: 300, abortAfter: 60 });
  assert.deepEqual(await invokeScoped(port, actor, "job2", { value: 2 }), REPLY);
  assert.equal(host.state.refused, 0);
  assert.equal(host.state.peak, 1);
  await port.cancel();
  assert.equal(host.state.open, 0);
});

test("cancel() while an abandoned open is still being written closes it too", async (t) => {
  const host = limitedHost();
  const { port } = await cancelAt(t, { host, delayWrite: 300, abortAfter: 60 });
  await port.cancel();
  assert.equal(host.state.open, 0, "cancel waits for the abandoned open and closes it");
});

test("a resumed session cancelled while its record is being written is closed, and the next call runs", async (t) => {
  const host = limitedHost();
  const { port, actor } = await cancelAt(t, { host, delayWrite: 200, abortAfter: 60, seedStranded: true });
  await settle();
  assert.equal(host.state.open, 0);
  assert.deepEqual(await invokeScoped(port, actor, "job1"), REPLY);
  assert.equal(host.state.refused, 0);
  assert.equal(host.state.peak, 1);
  await port.cancel();
  assert.equal(host.state.open, 0);
});

test("a resumed session cancelled while it is being opened is closed, and cancel() leaves none", async (t) => {
  const host = limitedHost({ openDelay: 150 });
  const { port, actor } = await cancelAt(t, { host, abortAfter: 40, seedStranded: true });
  await settle();
  assert.equal(host.state.open, 0);
  assert.deepEqual(await invokeScoped(port, actor, "job1"), REPLY);
  assert.equal(host.state.refused, 0);
  await port.cancel();
  assert.equal(host.state.open, 0);
});

test("a close() that throws is treated as stuck: the session is invalidated and the next call reports it once", async (t) => {
  const { store } = tempStore(t, "session-close-throw-");
  const actor = actorOf("sw/a", "p1");
  const host = limitedHost();
  const originalOpen = host.ai.openSession;
  let first = true;
  host.ai.openSession = async (input) => {
    const session = await originalOpen(input);
    if (first) { first = false; session.close = async () => { host.state.open -= 1; throw new Error("close exploded"); }; }
    return session;
  };
  const port = portOf(host.ai, store);
  t.after(() => port.cancel());
  assert.deepEqual(await invokeScoped(port, actor, "job1"), REPLY, "the saved reply is still returned");
  const state = await store.readResumeState();
  assert.equal(Object.values(state.sessions)[0].state, "invalidated", "the session record is invalidated");
  await assert.rejects(() => port.releasePair(actor.agentId, actor.projectId), (error) => error.code === "RESOURCE_BUSY", "the stuck close is reported");
  await port.releasePair(actor.agentId, actor.projectId);
});
