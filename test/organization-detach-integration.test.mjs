import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { operationKey, pairKey } from "../out/application/modelInvocationScope.js";
import { buildPunchSourceMessages, punchOperationId } from "../out/application/punchContent.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { databasePathOf } from "./readerHarness.mjs";

const AGENT = "sw/detach";
const PROJECT = "detach-project";
const settings = () => readOrganizationSettings({ organizationEnabled: true });
const ticks = async (count = 20) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const PUNCH = {
  id: "detach-punch", agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock", model: "allowed", punchType: "main",
  startedAtMs: Date.now() - 500_000, endedAtMs: Date.now() - 200_000, name: "Decide how upgrades are tested",
  description: JSON.stringify({ root: { children: [{ type: "text", text: "Every upgrade is tried on a synthetic copy of the old library first." }] } }),
};
const ACTOR = { agentId: AGENT, projectId: PROJECT, sessionId: PUNCH.sessionId, providerId: PUNCH.providerId };
const OPERATION_ID = "organize:" + punchOperationId(PUNCH.id);
const INPUT = { scope: "project", operationId: OPERATION_ID, messages: buildPunchSourceMessages(PUNCH) };

function fakeAi(hold) {
  const turns = [];
  const counts = {};
  const held = new Map();
  const state = { interrupted: 0, resumes: 0, opened: 0 };
  let listener;
  const session = {
    sessionId: "detach-session", effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
    onEvent(next) { listener = next; return () => { if (listener === next) listener = undefined; }; },
    async send({ text }) {
      const envelope = JSON.parse(text);
      counts[envelope.operation] = (counts[envelope.operation] ?? 0) + 1;
      const label = envelope.operation + "#" + counts[envelope.operation];
      const turnId = "turn-" + (turns.length + 1);
      const reply = envelope.operation === "extract"
        ? { items: [{ content: "Every upgrade is tried on a synthetic copy of the old library first.", kind: "decision", confidence: 0.9, sourceIndices: [0] }] }
        : envelope.operation === "classify" ? { items: envelope.input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [] })) } : { items: [] };
      turns.push({ operation: envelope.operation, callKey: envelope.callKey, turnId, label });
      const complete = () => {
        const body = JSON.stringify(reply);
        session.turn = { turnId, text: body, terminal: { kind: "completed" } };
        listener?.({ turnId, kind: "textDelta", text: body });
        listener?.({ turnId, kind: "contentSaved", sequenceNo: turns.length });
        listener?.({ turnId, kind: "completed" });
      };
      if (hold.has(label)) { session.turn = { turnId, text: "", terminal: null }; held.set(label, complete); }
      else complete();
      return { turnId };
    },
    async close() {},
    async interrupt() { state.interrupted += 1; },
  };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  const ai = {
    async getOptions() { return options; },
    async openSession(input) { if ("resume" in input) state.resumes += 1; else state.opened += 1; return session; },
  };
  return {
    ai, turns, state,
    sent: (operation) => counts[operation] ?? 0,
    release: (label) => { const complete = held.get(label); assert.ok(complete, "no held turn " + label); held.delete(label); complete(); },
    until: async (condition) => { for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setImmediate(resolve)); assert.ok(condition(), "condition not reached"); },
  };
}

function rig(t, hold) {
  const dir = mkdtempSync(join(tmpdir(), "memory-detach-real-"));
  const root = join(dir, "memory-cairn-v1");
  const ai = fakeAi(new Set(hold));
  const open = () => {
    const store = createLocalPunchOrganizationStore(dir);
    const port = createHostMemoryModelPort(ai.ai, settings, undefined, store);
    const app = new MemoryApplication(new CoreHandlePool({ layout: new CairnDataLayout(root), openCore: (path) => openCairnCore(path, { agentId: AGENT, port }) }));
    return { store, port, app, capture: () => app.execute("memory_capture", INPUT, ACTOR, undefined, true) };
  };
  const first = open();
  const live = [first];
  t.after(async () => {
    mock.timers.reset();
    for (const entry of live) { await entry.port.cancel(); await entry.app.close(); }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const journal = async (store) => {
    const operation = (await store.readResumeState()).operations[operationKey(pairKey(AGENT, PROJECT), OPERATION_ID)];
    return Object.values(operation?.calls ?? {}).sort((left, right) => left.createdAt - right.createdAt);
  };
  const database = () => {
    const db = new DatabaseSync(databasePathOf(root, AGENT), { readOnly: true });
    try {
      return {
        claims: db.prepare("SELECT state FROM admission_claims WHERE event_id = ?").all(OPERATION_ID).map((row) => row.state),
        inferred: db.prepare("SELECT id FROM memories WHERE origin = 'agent-inferred' ORDER BY id").all().map((row) => row.id),
        classification: db.prepare("SELECT status FROM capture_initial_classification WHERE event_id = ?").all(OPERATION_ID).map((row) => row.status),
      };
    } finally { db.close(); }
  };
  return { ...first, ai, journal, database, open, live };
}

test("after Cairn's 30 seconds the turn keeps running; the next call has the same callKey, is answered from the cache, and the punch is admitted once", async (t) => {
  const r = rig(t, ["extract#1"]);
  mock.timers.enable({ apis: ["setTimeout"] });
  const firstCall = r.capture();
  await r.ai.until(() => r.ai.sent("extract") === 1);
  mock.timers.tick(30_000);
  const timedOut = await firstCall;
  mock.timers.reset();
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, "MODEL_TIMEOUT");
  assert.equal(timedOut.error.localCode, "detached_running");
  assert.equal(r.ai.state.interrupted, 0, "Cairn's timeout never interrupts the host turn");
  assert.deepEqual(r.database().claims.filter((state) => state === "completed"), [], "nothing was admitted by the first call");
  let calls = await r.journal(r.store);
  assert.deepEqual(calls.map((call) => call.phase), ["sent"]);
  const extractKey = calls[0].callKey;

  r.ai.release("extract#1");
  await r.port.awaitPair(AGENT, PROJECT);
  calls = await r.journal(r.store);
  assert.deepEqual(calls.map((call) => [call.phase, call.callKey]), [["reply_ready", extractKey]]);

  const second = await r.capture();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.duplicate, false);
  assert.equal(second.value.admission.memories.length, 1);
  assert.equal(second.value.classification.status, "applied");
  assert.equal(r.ai.sent("extract"), 1, "the second call did not send the extract request again");
  assert.deepEqual(r.ai.turns.filter((turn) => turn.operation === "extract").map((turn) => turn.callKey), [extractKey], "the one extract request carried the key the second call looked up");
  calls = await r.journal(r.store);
  const extractCalls = calls.filter((call) => call.modelOperation === "extract");
  assert.deepEqual(extractCalls.map((call) => [call.callKey, call.occurrence, call.phase]), [[extractKey, 0, "reply_ready"]], "same callKey, still occurrence 0, one call");
  const classifyCalls = calls.filter((call) => call.modelOperation === "classify");
  assert.deepEqual(classifyCalls.map((call) => [call.occurrence, call.phase]), [[0, "reply_ready"]], "the classify stage made one stable call");
  assert.equal(r.ai.turns.filter((turn) => turn.operation === "classify")[0].callKey, classifyCalls[0].callKey);

  const afterSecond = r.database();
  assert.deepEqual(afterSecond.claims, ["completed"], "one admission for this punch");
  assert.equal(afterSecond.inferred.length, 1);
  assert.deepEqual(afterSecond.classification, ["applied"]);

  const rerun = await r.capture();
  assert.equal(rerun.ok, true);
  assert.equal(rerun.value.duplicate, true, "a repeat of a finished punch is a duplicate, not a second admission");
  const afterRerun = r.database();
  assert.deepEqual(afterRerun.inferred, afterSecond.inferred, "the agent-inferred memory set is the same before and after the rerun");
  assert.deepEqual(afterRerun.claims, ["completed"]);
  assert.equal(r.ai.sent("extract") + r.ai.sent("classify"), 2, "the rerun sent nothing");
});

test("a classify turn that outlives Cairn's 30 seconds is cached under its own stable key, and a rerun admits nothing again", async (t) => {
  const r = rig(t, ["classify#1"]);
  mock.timers.enable({ apis: ["setTimeout"] });
  const firstCall = r.capture();
  await r.ai.until(() => r.ai.sent("classify") === 1);
  mock.timers.tick(30_000);
  const first = await firstCall;
  mock.timers.reset();
  assert.equal(first.ok, true, "the memory was admitted; only the filing stage ran out of time");
  assert.equal(first.value.classification.status, "failed");
  assert.equal(r.ai.state.interrupted, 0);
  const before = r.database();
  assert.equal(before.inferred.length, 1);
  assert.deepEqual(before.claims, ["completed"]);

  r.ai.release("classify#1");
  await r.port.awaitPair(AGENT, PROJECT);
  const calls = await r.journal(r.store);
  const classify = calls.filter((call) => call.modelOperation === "classify");
  assert.deepEqual(classify.map((call) => [call.occurrence, call.phase]), [[0, "reply_ready"]]);
  assert.equal(r.ai.turns.find((turn) => turn.operation === "classify").callKey, classify[0].callKey, "the cached reply is under the key that was sent");

  const rerun = await r.capture();
  assert.equal(rerun.value.duplicate, true);
  assert.equal(r.ai.sent("extract"), 1);
  assert.equal(r.ai.sent("classify"), 1, "Cairn does not file an admission again on a duplicate, so the cached reply is simply unused");
  const after = r.database();
  assert.deepEqual(after.inferred, before.inferred);
  assert.deepEqual(after.claims, ["completed"]);
  t.diagnostic("classification journal status after the timeout and the rerun: " + after.classification.join(","));
});

test("restart: a turn that finished while the plugin was down is found again and the extract is not sent twice", async (t) => {
  const r = rig(t, ["extract#1"]);
  mock.timers.enable({ apis: ["setTimeout"] });
  const firstCall = r.capture();
  await r.ai.until(() => r.ai.sent("extract") === 1);
  mock.timers.tick(30_000);
  await firstCall;
  mock.timers.reset();
  const extractKey = (await r.journal(r.store))[0].callKey;
  r.ai.release("extract#1");
  await r.port.awaitPair(AGENT, PROJECT);
  await r.app.close();

  const restarted = r.open();
  r.live.push(restarted);
  const second = await restarted.capture();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(r.ai.sent("extract"), 1, "the saved reply served the restarted plugin");
  const extractCalls = (await r.journal(restarted.store)).filter((call) => call.modelOperation === "extract");
  assert.deepEqual(extractCalls.map((call) => call.callKey), [extractKey]);
  assert.deepEqual(r.database().claims, ["completed"]);
  assert.equal(r.database().inferred.length, 1);
});

test("restart: a turn that is still running is picked up again from the host session and answered without a second send", async (t) => {
  const r = rig(t, ["extract#1"]);
  mock.timers.enable({ apis: ["setTimeout"] });
  const firstCall = r.capture();
  await r.ai.until(() => r.ai.sent("extract") === 1);
  mock.timers.tick(30_000);
  await firstCall;
  mock.timers.reset();
  const extractKey = (await r.journal(r.store))[0].callKey;
  await r.app.close();

  const restarted = r.open();
  r.live.push(restarted);
  const second = restarted.capture();
  await r.ai.until(() => r.ai.state.resumes === 1);
  await ticks();
  r.ai.release("extract#1");
  const result = await second;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(r.ai.sent("extract"), 1, "the running turn was followed, not sent again");
  const extractCalls = (await r.journal(restarted.store)).filter((call) => call.modelOperation === "extract");
  assert.deepEqual(extractCalls.map((call) => [call.callKey, call.occurrence]), [[extractKey, 0]]);
  assert.deepEqual(r.database().claims, ["completed"]);
  assert.equal(r.database().inferred.length, 1);
});
