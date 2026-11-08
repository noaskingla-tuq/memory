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
import { operationKey, pairKey } from "../out/application/modelInvocationScope.js";
import { buildPunchSourceMessages, punchOperationId } from "../out/application/punchContent.js";
import { createStallGuard, stallOutcome } from "../out/application/organizationStall.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { databasePathOf } from "./readerHarness.mjs";

const AGENT = "sw/jp";
const PROJECT = "jp-project";
const settings = () => readOrganizationSettings({ organizationEnabled: true });
const text = (n) => `Decision number ${n}: every upgrade ${n} is tried on a synthetic copy of the old library first.`;
const punchOf = (n) => ({
  id: "jp-punch-" + n, agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock", model: "allowed", punchType: "main",
  startedAtMs: Date.now() - 500_000, endedAtMs: Date.now() - 200_000, name: "Decide " + n,
  description: JSON.stringify({ root: { children: [{ type: "text", text: text(n) }] } }),
});
const ACTOR = { agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock" };
const inputOf = (n) => ({ scope: "project", operationId: "organize:" + punchOperationId(punchOf(n).id), messages: buildPunchSourceMessages(punchOf(n)) });
const BROKEN = '{"items":[{"content":"missing the closing quote,"kind":"decision"}]}';

// why: the first `bad` turns the host answers are the model slip seen in the field, a string value missing its closing quote
function host(bad) {
  const state = { sent: 0, open: 0, peak: 0, opened: 0 };
  const sessions = [];
  const make = () => {
    let listener;
    const session = Object.freeze({
      sessionId: "s" + (sessions.length + 1), effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send({ text: body }) {
        const envelope = JSON.parse(body);
        state.sent += 1;
        const turnId = "t" + state.sent + "0".repeat(10);
        const n = /Decision number (\d+)/u.exec(JSON.stringify(envelope.input))?.[1];
        const reply = envelope.operation === "extract" && n ? { items: [{ content: text(Number(n)), kind: "decision", confidence: 0.9, sourceIndices: [0] }] }
          : envelope.operation === "classify" ? { items: envelope.input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [] })) } : { items: [] };
        const out = state.sent <= bad ? BROKEN : JSON.stringify(reply);
        setImmediate(() => {
          listener?.({ turnId, kind: "started" });
          listener?.({ turnId, kind: "textDelta", text: out });
          listener?.({ turnId, kind: "contentSaved", sequenceNo: state.sent });
          listener?.({ turnId, kind: "completed" });
        });
        return { turnId };
      },
      async close() { state.open -= 1; }, async interrupt() {},
    });
    sessions.push(session);
    return session;
  };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  return { state, ai: { async getOptions() { return options; }, async openSession() { state.open += 1; state.opened += 1; state.peak = Math.max(state.peak, state.open); return make(); } } };
}

function rig(t, bad) {
  const dir = mkdtempSync(join(tmpdir(), "memory-json-retry-"));
  const root = join(dir, "memory-cairn-v1");
  const fake = host(bad);
  const store = createLocalPunchOrganizationStore(dir);
  const port = createHostMemoryModelPort(fake.ai, settings, undefined, store, undefined, { graceMs: 150, backstopMs: 60_000 });
  const app = new MemoryApplication(new CoreHandlePool({ layout: new CairnDataLayout(root), openCore: (path) => openCairnCore(path, { agentId: AGENT, port }) }));
  t.after(async () => { await port.cancel(); await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const db = () => {
    let database;
    try { database = new DatabaseSync(databasePathOf(root, AGENT), { readOnly: true }); } catch { return { claims: [], memories: [] }; }
    try { return { claims: database.prepare("SELECT event_id,state FROM admission_claims").all(), memories: database.prepare("SELECT id FROM memories WHERE origin='agent-inferred'").all() }; } finally { database.close(); }
  };
  const calls = async () => Object.values((await store.readResumeState()).operations[operationKey(pairKey(AGENT, PROJECT), inputOf(1).operationId)]?.calls ?? {}).sort((a, b) => a.updatedAt - b.updatedAt || a.occurrence - b.occurrence);
  return { fake, app, db, calls };
}

test("a broken JSON reply then a good one settles: one admission, the broken turn is journaled as retryable", async (t) => {
  const baseline = rig(t, 0);
  assert.equal((await baseline.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true)).ok, true);
  const r = rig(t, 1);
  const first = await r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(r.fake.state.sent, baseline.fake.state.sent + 1, "exactly one extra model call");
  const found = r.db();
  assert.equal(found.claims.length, 1, "one admission");
  assert.equal(found.memories.length, 1);
  const broken = (await r.calls()).filter((call) => call.hostErrorCode === "json_parse");
  assert.deepEqual(broken.map((call) => [call.phase, call.retryable, call.partialDelivered]), [["failed", true, false]]);
  assert.equal(r.fake.state.peak, 1, "one session at a time");
  assert.equal(stallOutcome(first), "settled");
});

test("three broken replies in a row stop the retries: three model calls, the last call is not retryable, nothing is admitted, and it is not a stall", async (t) => {
  const r = rig(t, 99);
  const first = await r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true);
  assert.equal(first.ok, false);
  assert.equal(r.fake.state.sent, 3);
  assert.deepEqual((await r.calls()).map((call) => [call.hostErrorCode, call.retryable]), [["json_parse", true], ["json_parse", true], ["json_parse", false]]);
  assert.equal(r.db().memories.length, 0);
  const again = await r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true);
  assert.equal(again.ok, false);
  assert.equal(r.fake.state.sent, 3, "no fourth model call");
  const guard = createStallGuard();
  for (const result of [first, again]) {
    assert.equal(stallOutcome(result), "other");
    guard.observe(stallOutcome(result));
  }
  assert.equal(guard.count(), 0);
  assert.equal(guard.paused(), false);
  assert.equal(r.fake.state.peak, 1);
});

test("the retry cap is exactly two: a good reply on the third turn still settles", async (t) => {
  const r = rig(t, 2);
  const first = await r.app.execute("memory_capture", inputOf(1), ACTOR, undefined, true);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(r.db().memories.length, 1);
});
