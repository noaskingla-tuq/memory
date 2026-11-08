import assert from "node:assert/strict";
import test from "node:test";
import { REPLY, actorOf, callRecord, invokeScoped, portOf, tempStore } from "./recoverHarness.mjs";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OPTIONS = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000, transcriptLines: 80 } };

function host({ close, openDelay = 0 }) {
  const state = { opened: 0, resumed: 0, closes: [] };
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
      close() { state.closes.push(sessionId); return close(sessionId); },
      async interrupt() {},
    };
  };
  const ai = {
    async getOptions() { return OPTIONS; },
    async openSession(input) {
      if (openDelay > 0) await sleep(openDelay);
      if ("resume" in input) { state.resumed += 1; return make(input.resume); }
      state.opened += 1;
      return make("fresh-" + state.opened);
    },
  };
  return { ai, state };
}

test("two pairs whose close both timed out are each reported once", async (t) => {
  const fake = host({ close: () => new Promise(() => {}) });
  const port = createHostMemoryModelPort(fake.ai, () => readOrganizationSettings({ organizationEnabled: true }), undefined, undefined, 40);
  t.after(() => port.cancel());
  const input = { value: 1 };
  const call = (agentId) => port.invoke({ agentId, policy: port.resolvePolicy(agentId), operation: "extract", system: "schema", input, maxOutputTokens: 1024, signal: new AbortController().signal });
  assert.deepEqual(await call("sw/a"), REPLY);
  assert.deepEqual(await call("sw/b"), REPLY);
  await assert.rejects(port.releasePair("sw/a", null), { code: "RESOURCE_BUSY", localCode: "close_timeout" });
  await assert.rejects(port.releasePair("sw/b", null), { code: "RESOURCE_BUSY", localCode: "close_timeout" });
  await port.releasePair("sw/a", null);
  await port.releasePair("sw/b", null);
});

test("closeQuietly adds a session whose close() throws to the abandoned set, so it is never resumed", async (t) => {
  const fake = host({ close: async () => { throw new Error("close failed"); } });
  const { store } = tempStore(t, "close-throw-");
  const actor = actorOf("sw/a", "p1");
  const port = portOf(fake.ai, store, { graceMs: 20, backstopMs: 60_000 });
  t.after(() => port.cancel());
  const controller = new AbortController();
  const slow = store.transactResumeState.bind(store);
  let armed = true;
  store.transactResumeState = async (fn) => { if (armed) { armed = false; await sleep(150); } return slow(fn); };
  const first = invokeScoped(port, actor, "job1", { value: 1 }, controller.signal).then(() => "ok", () => "err");
  await sleep(60);
  controller.abort();
  await first;
  await sleep(450);
  assert.deepEqual(fake.state.closes, ["fresh-1"], "the late session was closed, and that close threw");
  const saved = (await store.readResumeState()).sessions;
  const stranded = await callRecord(actor, "job1", { hostSessionId: "fresh-1", turnId: "turn-old", phase: "sent" });
  const state = await store.readResumeState();
  await store.writeResumeState({ ...state, operations: { ...state.operations, [stranded.operation.operationKey]: stranded.operation } });
  assert.equal(Object.values(saved)[0]?.hostSessionId, "fresh-1");
  assert.deepEqual(await invokeScoped(port, actor, "job1"), REPLY);
  assert.equal(fake.state.resumed, 0, "the abandoned session was not resumed");
});
