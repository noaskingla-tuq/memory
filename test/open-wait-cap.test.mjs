import assert from "node:assert/strict";
import test from "node:test";
import { REPLY, actorOf, invokeScoped, portOf, tempStore } from "./recoverHarness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OPTIONS = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } };
const OPEN_WAIT_MS = 400;
const HANG_MS = 2000;

// why: like the real host, a pending open already holds the one session slot, so a second open is refused while the first never answers
function hangingHost() {
  const state = { open: 0, opened: 0, peak: 0, refused: 0, closed: [], hangs: 1 };
  const make = (sessionId) => {
    let listener;
    return {
      sessionId, effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send() {
        const turnId = sessionId + "-turn";
        const text = JSON.stringify(REPLY);
        listener?.({ turnId, kind: "textDelta", text });
        listener?.({ turnId, kind: "contentSaved", sequenceNo: 1 });
        listener?.({ turnId, kind: "completed" });
        return { turnId };
      },
      async close() { state.open -= 1; state.closed.push(sessionId); },
      async interrupt() {},
    };
  };
  const ai = {
    async getOptions() { return OPTIONS; },
    async openSession() {
      if (state.open >= 1) { state.refused += 1; throw Object.assign(new Error("session limit"), { code: "session_limit" }); }
      state.open += 1; state.opened += 1; state.peak = Math.max(state.peak, state.open);
      const id = "fresh-" + state.opened;
      if (state.hangs > 0) { state.hangs -= 1; await sleep(HANG_MS); }
      return make(id);
    },
  };
  return { ai, state };
}

async function abandonedOpen(t) {
  const host = hangingHost();
  const { store } = tempStore(t, "open-wait-");
  const port = portOf(host.ai, store, { graceMs: 20, backstopMs: 60_000, openWaitMs: OPEN_WAIT_MS });
  t.after(() => port.cancel());
  const controller = new AbortController();
  const first = invokeScoped(port, actorOf("sw/a", "p1"), "job1", { value: 1 }, controller.signal).then(() => "ok", (error) => "err:" + error.message);
  await sleep(40);
  controller.abort();
  await first;
  return { host, port };
}

test("a call behind an abandoned open that never answers fails fast after the wait cap, never opens a second session, and the late session is closed", async (t) => {
  const { host, port } = await abandonedOpen(t);
  const started = Date.now();
  await assert.rejects(invokeScoped(port, actorOf("sw/b", "p2"), "job2", { value: 2 }), { code: "RESOURCE_BUSY" });
  const waited = Date.now() - started;
  assert.ok(waited >= OPEN_WAIT_MS - 30, "it did wait for the abandoned open first: " + waited);
  assert.ok(waited < HANG_MS - 300, "it did not wait for the whole hang: " + waited);
  assert.ok(host.state.refused >= 1, "the host refused the second open, as session_limit always did");
  await sleep(HANG_MS);
  assert.equal(host.state.open, 0, "the late session was closed");
  assert.deepEqual(host.state.closed, ["fresh-1"]);
  assert.equal(host.state.peak, 1, "never more than one open session");
});

test("once an open is stuck, later calls do not wait for it again", async (t) => {
  const { host, port } = await abandonedOpen(t);
  await assert.rejects(invokeScoped(port, actorOf("sw/b", "p2"), "job2", { value: 2 }), { code: "RESOURCE_BUSY" });
  const started = Date.now();
  await assert.rejects(invokeScoped(port, actorOf("sw/c", "p3"), "job3", { value: 3 }), { code: "RESOURCE_BUSY" });
  assert.ok(Date.now() - started < OPEN_WAIT_MS - 100, "the second call went straight to the host");
  await sleep(HANG_MS);
  assert.deepEqual(await invokeScoped(port, actorOf("sw/d", "p4"), "job4", { value: 4 }), REPLY);
  assert.equal(host.state.peak, 1);
});
