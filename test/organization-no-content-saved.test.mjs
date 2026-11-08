import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { operationKey, pairKey } from "../out/application/modelInvocationScope.js";
import { buildPunchSourceMessages, punchOperationId } from "../out/application/punchContent.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { databasePathOf } from "./readerHarness.mjs";

const AGENT = "sw/settle";
const PROJECT = "settle-project";
const settings = () => readOrganizationSettings({ organizationEnabled: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (n) => `Decision number ${n}: every upgrade ${n} is tried on a synthetic copy of the old library first.`;
const punchOf = (n) => ({
  id: "settle-punch-" + n, agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock", model: "allowed", punchType: "main",
  startedAtMs: Date.now() - 500_000, endedAtMs: Date.now() - 200_000, name: "Decide how upgrades are tested " + n,
  description: JSON.stringify({ root: { children: [{ type: "text", text: text(n) }] } }),
});

// why: this is the real Core's event stream: started, textDelta, completed with the output, and never contentSaved
function realCore(mode) {
  const state = { sent: 0, interrupted: 0, opened: 0, extracts: 0 };
  const sessions = [];
  const makeSession = () => {
    let listener;
    const session = {
      sessionId: "core-session-" + (sessions.length + 1), effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      onEvent(next) { listener = next; return () => { if (listener === next) listener = undefined; }; },
      async send({ text: body }) {
        const envelope = JSON.parse(body);
        state.sent += 1;
        const turnId = session.sessionId + "-turn-" + state.sent;
        session.turn = { turnId, text: "", terminal: null };
        if (mode === "silent" || (mode === "first-silent" && state.sent === 1)) return { turnId };
        const n = /Decision number (\d+)/u.exec(JSON.stringify(envelope.input))?.[1];
        const reply = envelope.operation === "extract" && n !== undefined
          ? { items: [{ content: text(Number(n)), kind: "decision", confidence: 0.9, sourceIndices: [0] }] }
          : envelope.operation === "classify" ? { items: envelope.input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [] })) } : { items: [] };
        const output = JSON.stringify(reply);
        setImmediate(() => {
          session.turn = { turnId, text: output, terminal: { kind: "completed" } };
          listener?.({ turnId, kind: "textDelta", text: output });
          listener?.({ turnId, kind: "completed" });
        });
        return { turnId };
      },
      async close() {},
      async interrupt() { state.interrupted += 1; },
    };
    sessions.push(session);
    return session;
  };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  const ai = {
    async getOptions() { return options; },
    async openSession(input) {
      if ("resume" in input) {
        const found = sessions.find((entry) => entry.sessionId === input.resume);
        if (found === undefined) throw Object.assign(new Error("session not found"), { code: "session_not_found" });
        return found;
      }
      state.opened += 1;
      return makeSession();
    },
  };
  return { ai, state, sessions };
}

function rig(t, mode, limits, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "memory-settle-real-"));
  const root = join(dir, "memory-cairn-v1");
  const core = realCore(mode);
  const store = createLocalPunchOrganizationStore(dir);
  const port = createHostMemoryModelPort(core.ai, settings, undefined, store, undefined, limits);
  const app = new MemoryApplication(new CoreHandlePool({ layout: new CairnDataLayout(root), openCore: (path) => openCairnCore(path, { agentId: AGENT, port }) }));
  const clock = new Date(2026, 0, 1, 1).getTime();
  const worker = createPunchOrganizationWorker({
    store, enabled: () => true, frequency: () => "daily", dailyTime: () => "02:00", now: () => clock,
    awaitPending: (job, signal) => port.awaitPair(job.actor.agentId, job.actor.projectId, signal), waiting: () => port.waiting(),
    async capture(job) {
      try { return await app.execute("memory_capture", job.input, job.actor, undefined, job.allowModelSend ?? true); }
      finally { await port.releasePair(job.actor.agentId, job.actor.projectId); }
    },
    ...patch,
  });
  t.after(async () => {
    await worker.stop();
    await port.cancel();
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const database = () => {
    const db = new DatabaseSync(databasePathOf(root, AGENT), { readOnly: true });
    try {
      return {
        claims: db.prepare("SELECT event_id, state FROM admission_claims ORDER BY event_id").all().map((row) => [row.event_id, row.state]),
        inferred: db.prepare("SELECT id FROM memories WHERE origin = 'agent-inferred' ORDER BY id").all().map((row) => row.id),
      };
    } finally { db.close(); }
  };
  const rows = async () => Object.fromEntries((await store.readPage(null, 100)).records.map((row) => [row.key, row.value]));
  const settled = async (what, condition, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !await condition()) await pause(25);
    assert.ok(await condition(), "not reached within " + ms + " ms: " + what);
  };
  return { dir, store, port, app, worker, core, database, rows, settled };
}

const ACTOR = { agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock" };
const RUN = { action: "run", agentId: AGENT };

test("the real Core never sends contentSaved: three jobs of one immediate organization run settle one after another, each admitted once, and a rerun changes nothing", async (t) => {
  const r = rig(t, "answer", { graceMs: 60, backstopMs: 60_000 });
  for (const n of [1, 2, 3]) await r.worker.enqueue(punchOf(n), "raw-" + n);
  assert.equal((await r.worker.agentOrganization(RUN)).blocked, null);
  r.worker.start();
  await r.settled("three completed jobs", async () => Object.values(await r.rows()).filter((job) => job.state === "completed").length === 3);

  const run = (await r.worker.agentOrganization({ action: "status", agentId: AGENT })).run;
  assert.deepEqual([run.state, run.total, run.done, run.failed, run.untried], ["completed", 3, 3, 0, 0]);
  const after = r.database();
  assert.equal(after.claims.length, 3, "one admission claim per job");
  assert.ok(after.claims.every(([, state]) => state === "completed"));
  assert.equal(after.inferred.length, 3);
  assert.equal(r.core.state.interrupted, 0, "no turn was cut off");
  for (const job of Object.values(await r.rows())) assert.equal(job.attempts, 1, "each job took one attempt");

  const state = await r.store.readResumeState();
  assert.equal(Object.keys(state.operations).length, 0, "settled jobs leave no stuck journal entries behind");

  const sentBefore = r.core.state.sent;
  const punch = punchOf(1);
  const rerun = await r.app.execute("memory_capture", { scope: "project", operationId: "organize:" + punchOperationId(punch.id), messages: buildPunchSourceMessages(punch) }, ACTOR, undefined, true);
  assert.equal(rerun.ok, true, JSON.stringify(rerun));
  assert.equal(rerun.value.duplicate, true, "a finished punch is a duplicate, not a second admission");
  assert.equal(r.core.state.sent, sentBefore, "the rerun sent nothing to the model");
  assert.deepEqual(r.database().inferred, after.inferred, "the agent-inferred set is the same before and after the rerun");
  assert.equal(r.database().claims.length, 3);
});

test("a direct capture without contentSaved journals a reply_ready call with a null sequenceNo whose reply passes the hash and byte checks", async (t) => {
  const r = rig(t, "answer", { graceMs: 60, backstopMs: 60_000 });
  const punch = punchOf(1);
  const input = { scope: "project", operationId: "organize:" + punchOperationId(punch.id), messages: buildPunchSourceMessages(punch) };
  const first = await r.app.execute("memory_capture", input, ACTOR, undefined, true);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.admission.memories.length, 1);
  const operation = (await r.store.readResumeState()).operations[operationKey(pairKey(AGENT, PROJECT), input.operationId)];
  const replies = Object.values(operation.calls).filter((call) => call.phase === "reply_ready");
  assert.deepEqual(replies.map((call) => call.modelOperation).sort(), ["classify", "extract"]);
  for (const call of replies) {
    assert.equal(call.sequenceNo, null);
    assert.equal(Buffer.byteLength(call.replyJson, "utf8"), call.responseBytes);
    assert.match(call.replySha256, /^[0-9a-f]{64}$/u);
  }
});

test("a Core that never ends the first turn: the backstop frees the lock, the call is journaled turn_backstop, and the next job of the run still settles", async (t) => {
  const r = rig(t, "first-silent", { graceMs: 60, backstopMs: 250 });
  for (const n of [1, 2]) await r.worker.enqueue(punchOf(n), "raw-" + n);
  await r.worker.agentOrganization(RUN);
  r.worker.start();
  await r.settled("the second job completed", async () => (await r.rows())["settle-punch-2"]?.state === "completed");
  await r.settled("the run ended", async () => (await r.worker.agentOrganization({ action: "status", agentId: AGENT })).run.state === "completed");
  const rows = await r.rows();
  assert.equal(rows["settle-punch-1"].state, "pending", "the stuck job stays in the queue for a retry");
  assert.equal(rows["settle-punch-1"].lastError, "MODEL_TIMEOUT");
  assert.equal(r.core.state.interrupted, 1, "the backstop interrupted the silent turn");
  const operation = (await r.store.readResumeState()).operations[operationKey(pairKey(AGENT, PROJECT), "organize:" + punchOperationId("settle-punch-1"))];
  const [stuck] = Object.values(operation.calls);
  assert.deepEqual([stuck.phase, stuck.hostErrorCode, stuck.retryable, stuck.partialDelivered], ["failed", "turn_backstop", true, false]);
  assert.deepEqual(r.database().claims.filter(([, state]) => state === "completed").map(([event]) => event), ["organize:" + punchOperationId("settle-punch-2")], "only the second job was admitted, once");
  assert.equal(r.database().inferred.length, 1);
  assert.equal(r.worker.status().waiting ?? null, null);
});
