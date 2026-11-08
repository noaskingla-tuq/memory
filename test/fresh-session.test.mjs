import assert from "node:assert/strict";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { currentMemoryInvocation, operationKey, pairKey, withMemoryCaptureScope } from "../out/application/modelInvocationScope.js";
import { BASE_SYSTEM } from "../out/adapters/model/turnSession.js";
import { settings, tempStore, actorOf } from "./recoverHarness.mjs";

const OPTIONS = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } };

function trackedAi({ holdSend = false } = {}) {
  const log = [];
  const sessions = new Map();
  const state = { open: 0, maxOpen: 0 };
  const markOpen = (session) => {
    if (session.isOpen) return;
    if (state.open >= 1) throw Object.assign(new Error("session limit"), { code: "session_limit" });
    session.isOpen = true;
    state.open += 1;
    state.maxOpen = Math.max(state.maxOpen, state.open);
  };
  const make = (sessionId) => {
    let listener;
    let turns = 0;
    const session = {
      sessionId, isOpen: false, sends: 0, effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      finish(turnId, silent = false) {
        const text = JSON.stringify({ items: [] });
        session.turn = { turnId, text, terminal: { kind: "completed" } };
        if (silent) return;
        listener?.({ turnId, kind: "textDelta", text });
        listener?.({ turnId, kind: "contentSaved", sequenceNo: turns });
        listener?.({ turnId, kind: "completed" });
      },
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send() {
        turns += 1;
        session.sends += 1;
        const turnId = sessionId + "-turn-" + turns;
        log.push({ kind: "send", sessionId });
        if (holdSend) { session.turn = { turnId, text: "", terminal: null }; return { turnId }; }
        session.finish(turnId);
        return { turnId };
      },
      async close() { if (session.isOpen) { session.isOpen = false; state.open -= 1; } log.push({ kind: "close", sessionId }); },
      async interrupt() {},
    };
    sessions.set(sessionId, session);
    return session;
  };
  const ai = {
    async getOptions() { return OPTIONS; },
    async openSession(input) {
      log.push({ kind: "open", input });
      if ("resume" in input) {
        const found = sessions.get(input.resume);
        if (found === undefined) throw Object.assign(new Error("session not found"), { code: "session_not_found" });
        markOpen(found);
        return found;
      }
      const created = make("fresh-" + (sessions.size + 1));
      markOpen(created);
      return created;
    },
  };
  return { ai, log, sessions, state };
}

async function call(port, actor, operationId, operation, system, input) {
  return withMemoryCaptureScope(actor, operationId, async () => {
    const invocation = currentMemoryInvocation(operation, system, input);
    return port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), operation, system, input, maxOutputTokens: 1024, signal: new AbortController().signal, invocation });
  });
}

test("one pair, two jobs of extract plus classify: four fresh sessions, each with system only, one turn and a close, never more than one open", async (t) => {
  const { store } = tempStore(t, "memory-fresh-");
  const h = trackedAi();
  const port = createHostMemoryModelPort(h.ai, settings, undefined, store);
  const actor = actorOf("sw/a", "project-1");
  const calls = [];
  for (const job of ["job-1", "job-2"]) {
    await call(port, actor, job, "extract", "extract system", { records: [job] });
    await call(port, actor, job, "classify", "classify system", { selected: [job] });
    const key = operationKey(pairKey(actor.agentId, actor.projectId), job);
    calls.push(...Object.values((await store.readResumeState()).operations[key].calls));
    // why: a finished job drops its journal in production, which is what lets the next job of the pair start
    await store.pruneOperation(key);
  }
  const opens = h.log.filter((entry) => entry.kind === "open");
  assert.equal(opens.length, 4, "every invoke opens its own session");
  for (const { input } of opens) {
    assert.deepEqual(Object.keys(input).sort(), ["modelId", "providerId", "system"], "no resume, no transcript, no history");
    assert.equal(input.system, BASE_SYSTEM);
  }
  assert.equal(h.sessions.size, 4);
  for (const session of h.sessions.values()) assert.equal(session.sends, 1, session.sessionId + " carries exactly one turn");
  assert.deepEqual(h.log.filter((entry) => entry.kind !== "open").map((entry) => entry.kind + ":" + entry.sessionId),
    ["send:fresh-1", "close:fresh-1", "send:fresh-2", "close:fresh-2", "send:fresh-3", "close:fresh-3", "send:fresh-4", "close:fresh-4"]);
  assert.equal(h.state.maxOpen, 1);
  assert.equal(h.state.open, 0);
  assert.deepEqual(calls.map((entry) => entry.hostSessionId).sort(), ["fresh-1", "fresh-2", "fresh-3", "fresh-4"], "the journal still names the session and the turn of every call");
  assert.ok(calls.every((entry) => entry.turnId !== null && entry.phase === "reply_ready"));
  await port.cancel();
});

test("after a restart the call that was sent on a fresh session is read back from that session, and no new session is opened", async (t) => {
  const { store } = tempStore(t, "memory-fresh-restart-");
  const h = trackedAi({ holdSend: true });
  const actor = actorOf("sw/a", "project-1");
  const before = createHostMemoryModelPort(h.ai, settings, undefined, store);
  const first = call(before, actor, "job-1", "extract", "extract system", { records: ["r"] });
  first.catch(() => undefined);
  const deadline = Date.now() + 5000;
  let sent;
  while (sent === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const state = await store.readResumeState();
    sent = Object.values(state?.operations ?? {}).flatMap((operation) => Object.values(operation.calls)).find((entry) => entry.phase === "sent" && entry.turnId !== null);
  }
  assert.ok(sent, "the journal holds the sent call with its host session and turn");
  assert.equal(sent.hostSessionId, "fresh-1");
  const session = h.sessions.get("fresh-1");
  session.finish(sent.turnId, true);
  // why: the first port is abandoned as a crash would leave it, so only the journal and the host survive into the second port
  session.isOpen = false;
  h.state.open = 0;
  h.log.length = 0;
  const after = createHostMemoryModelPort(h.ai, settings, undefined, store, undefined, { graceMs: 50, backstopMs: 60_000 });
  const value = await call(after, actor, "job-1", "extract", "extract system", { records: ["r"] });
  assert.deepEqual(value, { items: [] });
  const opens = h.log.filter((entry) => entry.kind === "open");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].input.resume, "fresh-1", "the one open is a resume of the session the call was sent on");
  assert.equal(h.sessions.size, 1, "no fresh session was opened");
  assert.equal(session.sends, 1, "the turn is not sent again");
  assert.equal(h.log.filter((entry) => entry.kind === "close").length, 1);
  const saved = Object.values((await store.readResumeState()).operations).flatMap((operation) => Object.values(operation.calls));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].phase, "reply_ready");
  assert.equal(saved[0].hostSessionId, "fresh-1");
  assert.equal(h.state.maxOpen, 1);
  await after.cancel();
  await before.cancel();
});
