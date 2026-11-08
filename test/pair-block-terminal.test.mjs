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
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { databasePathOf } from "./readerHarness.mjs";

const AGENT = "sw/pb";
const PROJECT = "pb-project";
const F = String.fromCharCode(96).repeat(3);
const settings = () => readOrganizationSettings({ organizationEnabled: true });
const text = (n) => `Decision number ${n}: every upgrade ${n} is tried on a synthetic copy of the old library first.`;
const punchOf = (n) => ({
  id: "pb-punch-" + n, agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock", model: "allowed", punchType: "main",
  startedAtMs: Date.now() - 500_000, endedAtMs: Date.now() - 200_000, name: "Decide " + n,
  description: JSON.stringify({ root: { children: [{ type: "text", text: text(n) }] } }),
});
const ACTOR = { agentId: AGENT, projectId: PROJECT, sessionId: "source-session", providerId: "mock" };
const operationIdOf = (n) => "organize:" + punchOperationId(punchOf(n).id);
const inputOf = (n) => ({ scope: "project", operationId: operationIdOf(n), messages: buildPunchSourceMessages(punchOf(n)) });
const BROKEN = '{"items":[{"content":"missing the closing quote,"kind":"decision"}]}';

// why: `plan(n, sentNo)` says what the host does with the sent-th turn of decision n: good, fenced, broken, toolong, empty or revoked
function host(plan) {
  const state = { sent: 0, open: 0, perDecision: {} };
  const make = () => {
    let listener;
    return Object.freeze({
      sessionId: "s" + (state.perDecision.opened = (state.perDecision.opened ?? 0) + 1), effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
      onEvent(next) { listener = next; return () => { listener = undefined; }; },
      async send({ text: body }) {
        const envelope = JSON.parse(body);
        state.sent += 1;
        const turnId = "t" + state.sent + "0".repeat(10);
        const n = Number(/Decision number (\d+)/u.exec(JSON.stringify(envelope.input))?.[1] ?? 0);
        state.perDecision[n] = (state.perDecision[n] ?? 0) + 1;
        const reply = envelope.operation === "extract" && n ? { items: [{ content: text(n), kind: "decision", confidence: 0.9, sourceIndices: [0] }] }
          : envelope.operation === "classify" ? { items: envelope.input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [] })) } : { items: [] };
        const kind = plan(n, state.perDecision[n]);
        const out = kind === "broken" ? BROKEN : kind === "toolong" ? "x".repeat(20_000) : kind === "fenced" ? F + "json\r\n" + JSON.stringify(reply) + "\r\n" + F : JSON.stringify(reply);
        setImmediate(() => {
          listener?.({ turnId, kind: "started" });
          if (kind === "empty" || kind === "revoked") {
            listener?.({ turnId, kind: "failed", code: kind === "empty" ? "empty_reply" : "access_revoked", retryable: false, partialDelivered: false });
            return;
          }
          listener?.({ turnId, kind: "textDelta", text: out });
          listener?.({ turnId, kind: "contentSaved", sequenceNo: state.sent });
          listener?.({ turnId, kind: "completed" });
        });
        return { turnId };
      },
      async close() {}, async interrupt() {},
    });
  };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  return { state, ai: { async getOptions() { return options; }, async openSession() { return make(); } } };
}

function rig(t, plan) {
  const dir = mkdtempSync(join(tmpdir(), "memory-pair-block-"));
  const root = join(dir, "memory-cairn-v1");
  const fake = host(plan);
  const store = createLocalPunchOrganizationStore(dir);
  const port = createHostMemoryModelPort(fake.ai, settings, undefined, store, undefined, { graceMs: 150, backstopMs: 60_000 });
  const app = new MemoryApplication(new CoreHandlePool({ layout: new CairnDataLayout(root), openCore: (path) => openCairnCore(path, { agentId: AGENT, port }) }));
  t.after(async () => { await port.cancel(); await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const claims = () => {
    let database;
    try { database = new DatabaseSync(databasePathOf(root, AGENT), { readOnly: true }); } catch { return []; }
    try { return database.prepare("SELECT id FROM memories WHERE origin='agent-inferred'").all(); } finally { database.close(); }
  };
  const operation = async (n) => (await store.readResumeState()).operations[operationKey(pairKey(AGENT, PROJECT), operationIdOf(n))];
  const capture = (n) => app.execute("memory_capture", inputOf(n), ACTOR, undefined, true);
  return { fake, app, store, claims, operation, capture };
}

const FINAL = [
  ["json_parse after the last retry", (n) => n === 1 ? "broken" : "good", 3, "json_parse"],
  ["reply_too_long", (n) => n === 1 ? "toolong" : "good", 1, "reply_too_long"],
  ["empty_reply that the host marks not retryable", (n) => n === 1 ? "empty" : "good", 1, "empty_reply"],
];

for (const [name, plan, sentForFirst, code] of FINAL) {
  test(`${name}: the failed call stays as a record and the next operation of the same pair is sent and settled`, async (t) => {
    const r = rig(t, plan);
    const first = await r.capture(1);
    assert.equal(first.ok, false);
    assert.equal(first.error.code, "MODEL_OUTPUT_INVALID");
    assert.equal(r.fake.state.sent, sentForFirst);
    const kept = Object.values((await r.operation(1)).calls).find((call) => call.hostErrorCode === code && !call.retryable);
    assert.ok(kept, "the failed call is still journaled");
    assert.equal(kept.phase, "failed");
    assert.equal(kept.retryable, false);
    const other = await r.capture(2);
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.equal(r.claims().length, 1, "only decision 2 was admitted");
    const sentBefore = r.fake.state.sent;
    const again = await r.capture(1);
    assert.equal(again.ok, false);
    assert.equal(again.error.code, "MODEL_OUTPUT_INVALID", "an exhausted operation keeps answering with the same error");
    assert.equal(r.fake.state.sent, sentBefore, "and is never sent again");
  });
}

test("a host failure that is not retryable and not an output defect still holds the pair for reconciliation (decision left to the manager)", async (t) => {
  const r = rig(t, (n) => n === 1 ? "revoked" : "good");
  const first = await r.capture(1);
  assert.equal(first.ok, false);
  const other = await r.capture(2);
  assert.equal(other.ok, false);
  assert.equal(other.error.localCode, "pair_blocked");
});

test("a reply wrapped in a json fence with CRLF line ends settles without a retry", async (t) => {
  const r = rig(t, () => "fenced");
  const first = await r.capture(1);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(r.claims().length, 1);
  assert.equal(r.fake.state.perDecision[1], r.fake.state.sent, "every turn belongs to decision 1");
  assert.equal(Object.values((await r.operation(1)).calls).filter((call) => call.hostErrorCode === "json_parse").length, 0);
});

test("organization: an operation that ran out of json_parse retries ends as a skipped job with its error kept, its operation is pruned, and the next job of the pair settles", async (t) => {
  const r = rig(t, (n) => n === 1 ? "broken" : "good");
  const worker = createPunchOrganizationWorker({
    store: r.store, enabled: () => true, frequency: () => "immediate", dailyTime: () => "02:00", now: () => Date.now(),
    capture: (job) => r.app.execute("memory_capture", job.input, job.actor, undefined, job.allowModelSend ?? true),
  });
  t.after(() => worker.stop());
  await worker.enqueue(punchOf(1), "raw-1");
  await worker.enqueue(punchOf(2), "raw-2");
  worker.start();
  await worker.idle();
  const rows = Object.fromEntries((await r.store.readPage(null, 100)).records.map((row) => [row.key, row.value]));
  const one = rows[punchOf(1).id];
  assert.equal(one.state, "skipped");
  assert.equal(one.outcome, "skipped");
  assert.equal(one.lastError, "MODEL_OUTPUT_INVALID");
  assert.equal(one.errorPhase, "reply_contract");
  assert.equal(one.hostErrorCode, "json_parse");
  assert.equal(one.attempts, 1);
  assert.deepEqual(one.input.messages, []);
  assert.equal(rows[punchOf(2).id].state, "completed");
  assert.equal(rows[punchOf(2).id].lastError, null);
  assert.equal(await r.operation(1), undefined, "the operation of the dead job is gone");
  assert.equal(r.fake.state.perDecision[1], 3, "the dead job was sent three times and no more");
  assert.equal(r.claims().length, 1);
});
