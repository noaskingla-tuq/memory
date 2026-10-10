import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalPunchReceiptStore } from "../out/adapters/storage/punchStateStore.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { buildPunchSourceMessages } from "../out/application/punchContent.js";
import { startBackend, callInspect } from "./backendHarness.mjs";

const punch = (overrides = {}) => ({ id: "p", agentId: "sw/a", projectId: "project", sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Remember a project decision", description: JSON.stringify({ root: { children: [{ type: "text", text: "Use a synthetic fixture for every upgrade." }] } }), ...overrides });
const ok = (value = {}) => ({ ok: true, value, requestId: "r" });
function rig(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "memory-organize-"));
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.stop(); rmSync(dir, { recursive: true, force: true }); });
  const store = createLocalPunchReceiptStore(dir);
  let enabled = false;
  let now = 100;
  const calls = [];
  const create = (patch = {}) => { const worker = createPunchOrganizationWorker({ store, enabled: () => enabled, now: () => now, capture: async (job) => { calls.push(job); return ok(); }, ...overrides, ...patch }); workers.push(worker); return worker; };
  return { store, create, calls, enable: () => { enabled = true; }, advance: () => { now += 100000; } };
}
test("disabled organization preserves a durable job; enabling captures provenance once across restart", async (t) => {
  const h = rig(t);
  const first = h.create(); first.start();
  await first.enqueue(punch(), "raw"); await first.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(first.status().state, "disabled");
  await first.stop();
  h.enable();
  const second = h.create(); second.start(); await second.idle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual((await h.store.readPage(null, 100)).records[0].value.input.messages, []);
  assert.equal(h.calls[0].actor.projectId, "project");
  assert.equal(h.calls[0].actor.sessionId, "s");
  assert.equal(h.calls[0].input.scope, "project");
  assert.deepEqual(h.calls[0].input.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(h.calls[0].input.messages[1].content, "Use a synthetic fixture for every upgrade.");
  assert.match(h.calls[0].input.messages[0].id, /^punch:/);
  await second.enqueue(punch(), "raw"); await second.idle(); await second.stop();
  const third = h.create(); third.start(); await third.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(third.status().completed, 1);
});
test("retry state survives restart and waits for backoff before another capture", async (t) => {
  const h = rig(t); h.enable();
  const first = h.create({ capture: async () => ({ ok: false, error: { code: "MODEL_NOT_CONFIGURED", retryable: false } }) });
  first.start(); await first.enqueue(punch(), "raw"); await first.idle();
  assert.equal(first.status().state, "paused");
  const saved = (await h.store.readPage(null, 100)).records[0].value;
  assert.equal(saved.attempts, 1); assert.equal(saved.state, "pending");
  await first.stop();
  const second = h.create(); second.start(); await second.idle(); assert.equal(h.calls.length, 0);
  h.advance(); second.wake(); await second.idle(); assert.equal(h.calls.length, 1);
});
test("processing captures stay pending and a forgotten source is terminally skipped", async (t) => {
  const h = rig(t); h.enable();
  const worker = h.create({ capture: async () => ok({ processing: true }) });
  worker.start(); await worker.enqueue(punch(), "raw"); await worker.idle();
  assert.equal((await h.store.readPage(null, 100)).records[0].value.state, "pending");
  await worker.stop(); h.advance();
  const skipped = h.create({ capture: async () => ({ ok: false, error: { code: "MEMORY_SUPPRESSED", retryable: false } }) });
  skipped.start(); await skipped.idle();
  assert.equal((await h.store.readPage(null, 100)).records[0].value.state, "skipped");
});
test("source conversion bounds CJK bytes and preserves valid surrogate pairs", () => {
  const messages = buildPunchSourceMessages(punch({ name: "😀".repeat(1000), description: "測".repeat(6000) }));
  assert.ok(Buffer.byteLength(messages[0].content, "utf8") <= 900);
  assert.ok(Buffer.byteLength(messages[1].content, "utf8") <= 2400);
  assert.ok(messages.every((message) => message.content.isWellFormed()));
});

function hostRig() {
  let events;
  let settingsListener;
  let values = {};
  let aiCalls = 0;
  let closed = 0;
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, records: [{ ...punch(), punchId: "p" }], nextCursor: null }; }, subscribeSettledChanges(listener) { events = listener; return () => { events = undefined; }; } },
    agentDirectory: { async readPage() { return { snapshot, entries: [{ id: "sw/a", name: "Synthetic", teamKey: "sw", teamName: "SW", title: "", enabled: true }], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [{ id: "project", name: "Synthetic project", archived: false }], nextCursor: null }; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    ai: {
      async getOptions() { return { providers: [{ id: "mock", state: "ready", models: [{ id: "allowed", isDefault: true }] }], defaultProviderId: "mock", quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 10000 } }; },
      async openSession() {
        let listener;
        return { effective: { providerId: "mock", modelId: "allowed" }, turn: null, onEvent(next) { listener = next; return () => { listener = undefined; }; },
          async send({ text }) {
            aiCalls++;
            const input = JSON.parse(text);
            const answer = input.messages ? { items: [{ content: "Use a synthetic fixture for every upgrade.", kind: "decision", confidence: 0.9, sourceIndices: [0, 1] }] } : { items: input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [], newL1: { title: "Upgrade testing", parentL2Ids: [] } })) };
            listener({ turnId: "t", kind: "textDelta", text: JSON.stringify(answer) }); listener({ turnId: "t", kind: "completed" }); return { turnId: "t" };
          }, async interrupt() {}, async close() { closed++; },
        };
      },
    },
  };
  const settings = { all: () => values, onChange(listener) { settingsListener = listener; return () => { settingsListener = undefined; }; } };
  return { host, settings, enable() { values = { organizationEnabled: true }; settingsListener?.(values); }, event() { events?.({}); }, get aiCalls() { return aiCalls; }, get closed() { return closed; }, get listeners() { return [events, settingsListener].filter(Boolean).length; } };
}
test("production service admits raw context with retired host state, then captures through real Cairn and mock host AI", async (t) => {
  const h = hostRig();
  const { backend, dataRoot } = startBackend(t, { host: h.host, settings: h.settings });
  backend.startWorkers(); await backend.idleWorkers();
  const queue = createLocalPunchReceiptStore(dirname(dataRoot), "punch-organization.json");
  const unacknowledged = (await queue.readPage(null, 100)).records[0].value;
  const raw = await callInspect(backend, { scope: "project", limit: 12 }, { agentId: "sw/a", projectId: "project" });
  assert.equal(raw.result.value.memories.length, 1);
  assert.equal(h.aiCalls, 0);
  h.enable(); await backend.idleWorkers();
  const organized = await callInspect(backend, { scope: "project", limit: 12 }, { agentId: "sw/a", projectId: "project" });
  assert.equal(organized.result.value.memories.length, 2);
  assert.equal(h.aiCalls, 2); assert.equal(h.closed, 2);
  const inferred = organized.result.value.memories.find((memory) => memory.origin === "agent-inferred");
  assert.ok(inferred);
  const detail = await callInspect(backend, { scope: "project", memoryId: inferred.id }, { agentId: "sw/a", projectId: "project" });
  assert.deepEqual(detail.result.value.receipts.map((row) => row.role).sort(), ["assistant", "user"]);
  assert.ok(detail.result.value.receipts.every((row) => row.sessionId === "s" && row.eventId.startsWith("punch:")));
  const status = await backend.call("ui.status", {});
  assert.equal(status.organization.completed, 1);
  h.event(); await backend.idleWorkers(); assert.equal(h.aiCalls, 2);
  await backend.dispose(); assert.equal(h.listeners, 0);
  const completed = (await queue.readPage(null, 100)).records[0];
  await queue.writeBatch([{ key: completed.key, value: { ...unacknowledged, state: "pending", nextAttemptAt: 0 }, expectedRevision: completed.revision }]);
  const { backend: reopened } = startBackend(t, { dataRoot, host: h.host, settings: h.settings });
  reopened.startWorkers(); await reopened.idleWorkers(); assert.equal(h.aiCalls, 2);
  assert.equal((await reopened.call("ui.status", {})).organization.pending, 0);
  assert.equal((await callInspect(reopened, { scope: "project", limit: 12 }, { agentId: "sw/a", projectId: "project" })).result.value.memories.length, 2);
  await reopened.dispose();
});
test("production organization skips a forgotten raw source before any model request", async (t) => {
  const h = hostRig(); const { backend, dataRoot } = startBackend(t, { host: h.host, settings: h.settings });
  backend.startWorkers(); await backend.idleWorkers();
  const listed = await backend.call("ui.list", { agentId: "sw/a" });
  const raw = listed.items[0];
  assert.equal((await backend.call("ui.forget", { ...raw.ref, expectedRevision: raw.revision })).ok, true);
  const rows = (await createLocalPunchReceiptStore(dirname(dataRoot), "punch-organization.json").readPage(null, 100)).records;
  assert.equal(rows[0].value.state, "skipped");
  assert.deepEqual(rows[0].value.input.messages, []);
  h.enable(); await backend.idleWorkers();
  assert.equal(h.aiCalls, 0);
  assert.equal((await backend.call("ui.status", {})).organization.pending, 0);
});
