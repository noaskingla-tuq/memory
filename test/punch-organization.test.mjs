import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalPunchOrganizationStore, createLocalPunchReceiptStore } from "../out/adapters/storage/punchStateStore.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { buildPunchSourceMessages, punchOperationId } from "../out/application/punchContent.js";
import { startBackend, callInspect, callRemember, op } from "./backendHarness.mjs";
import { databasePathOf, rawWrite } from "./readerHarness.mjs";

const punch = (overrides = {}) => ({ id: "p", agentId: "sw/a", projectId: "project", sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Remember a project decision", description: JSON.stringify({ root: { children: [{ type: "text", text: "Use a synthetic fixture for every upgrade." }] } }), ...overrides });
const ok = (value = {}) => ({ ok: true, value, requestId: "r" });
function rig(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "memory-organize-"));
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.stop(); rmSync(dir, { recursive: true, force: true }); });
  const store = createLocalPunchOrganizationStore(dir);
  let enabled = false;
  let frequency = "daily";
  let dailyTime = "02:00";
  let now = new Date(2026, 0, 1, 3).getTime();
  const calls = [];
  const create = (patch = {}) => { const worker = createPunchOrganizationWorker({ store, claimDailyRound: store.claimDailyRound, enabled: () => enabled, frequency: () => frequency, dailyTime: () => dailyTime, now: () => now, capture: async (job) => { calls.push(job); return ok(); }, ...overrides, ...patch }); workers.push(worker); return worker; };
  return { dir, store, create, calls, enable: () => { enabled = true; }, setFrequency: (value) => { frequency = value; }, setDailyTime: (value) => { dailyTime = value; }, setNow: (value) => { now = value; }, advanceDay: () => { now = new Date(2026, 0, 2, 3).getTime(); } };
}
test("disabled organization preserves a durable job; enabling captures provenance once across restart", async (t) => {
  const h = rig(t);
  const first = h.create();
  await first.enqueue(punch(), "raw"); first.start(); await first.idle();
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
  assert.ok(h.calls[0].input.messages[1].content.endsWith("Use a synthetic fixture for every upgrade."));
  assert.match(h.calls[0].input.messages[0].id, /^punch:/);
  await second.enqueue(punch(), "raw"); await second.idle(); await second.stop();
  const third = h.create(); third.start(); await third.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(third.status().completed, 1);
});
test("local 02:00 claim gates every trigger and leaves post-round work for tomorrow", async (t) => {
  const h = rig(t); h.enable();
  const worker = h.create();
  await worker.enqueue(punch(), "raw");
  h.setNow(new Date(2026, 0, 1, 1, 59, 59).getTime());
  worker.start(); await worker.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims, undefined);

  h.setNow(new Date(2026, 0, 1, 2, 0, 0).getTime());
  worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 1);
  worker.settingsChanged(); await worker.idle(); worker.wake(); await worker.idle();
  await worker.enqueue(punch({ id: "arrived-after-round" }), "raw-later"); await worker.idle();
  assert.equal(h.calls.length, 1);
  assert.equal((await h.store.readPage(null, 100)).records.find((row) => row.key === "arrived-after-round").value.state, "pending");

  h.setNow(new Date(2026, 0, 2, 1, 59, 59).getTime()); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 1);
  h.setNow(new Date(2026, 0, 2, 2, 0, 0).getTime()); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 2);
  await worker.enqueue(punch({ id: "after-clock-rollback" }), "raw-rollback"); await worker.idle();
  h.setNow(new Date(2026, 0, 1, 3, 0, 0).getTime()); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.store.readPage(null, 100)).records.find((row) => row.key === "after-clock-rollback").value.state, "pending");
  h.setNow(new Date(2026, 0, 3, 2, 0, 0).getTime()); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 3);
  const saved = JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8"));
  assert.deepEqual(saved.organizationClaims.dates, ["2026-01-01", "2026-01-02", "2026-01-03"]);
});
test("immediate mode bypasses the daily startup gate, preserves retry backoff and never claims a date", async (t) => {
  const h = rig(t); h.enable(); h.setFrequency("immediate"); h.setNow(new Date(2026, 0, 1, 1, 0).getTime());
  let attempts = 0;
  const worker = h.create({ capture: async () => { attempts++; return attempts === 1 ? { ok: false, error: { code: "MODEL_NOT_CONFIGURED", retryable: false } } : ok(); } });
  await worker.enqueue(punch(), "raw");
  worker.start({ deferInitialRun: true }); await worker.idle();
  assert.equal(attempts, 1, "immediate work is not held by the daily-only startup gate or 02:00 time");
  assert.equal(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims, undefined);
  worker.wake(); await worker.idle();
  assert.equal(attempts, 1, "ordinary wakes respect the retry backoff");
  worker.settingsChanged(); await worker.idle();
  assert.equal(attempts, 2, "an explicit settings wake keeps the existing immediate retry behavior");
  await worker.stop();
});
test("switching immediate to daily lets the active job finish and gates the next job at the selected time", async (t) => {
  const h = rig(t); h.enable(); h.setFrequency("immediate"); h.setNow(new Date(2026, 0, 1, 3, 0).getTime()); h.setDailyTime("04:00");
  let release;
  let entered;
  const capturing = new Promise((resolve) => { entered = resolve; });
  const activeJob = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const worker = h.create({ capture: async (job) => { calls.push(job.punchId); if (calls.length === 1) { entered(); await activeJob; } return ok(); } });
  await worker.enqueue(punch({ id: "in-flight" }), "raw-1");
  await worker.enqueue(punch({ id: "next-job" }), "raw-2");
  worker.start(); await capturing;
  h.setFrequency("daily"); worker.settingsChanged(); release(); await worker.idle();
  assert.deepEqual(calls, ["in-flight"]);
  assert.equal(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims, undefined);
  assert.equal((await h.store.readPage(null, 100)).records.find((row) => row.key === "next-job").value.state, "pending");

  h.setNow(new Date(2026, 0, 1, 4, 0).getTime()); worker.wake(); await worker.idle();
  assert.deepEqual(calls, ["in-flight", "next-job"]);
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims.dates, ["2026-01-01"]);
  await worker.stop();
});
test("switching daily to immediate at an in-flight job boundary uses the new mode and keeps the daily claim", async (t) => {
  const h = rig(t); h.enable();
  let mode = "daily";
  let frequencyReads = 0;
  let readsAtRelease = 0;
  let readsAtNextCapture = -1;
  let release;
  let entered;
  const capturing = new Promise((resolve) => { entered = resolve; });
  const activeJob = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const worker = h.create({
    frequency: () => { frequencyReads++; return mode; },
    capture: async (job) => {
      calls.push(job.punchId);
      if (calls.length === 1) { entered(); await activeJob; }
      else readsAtNextCapture = frequencyReads - readsAtRelease;
      return ok();
    },
  });
  await worker.enqueue(punch({ id: "daily-in-flight" }), "raw-1");
  await worker.enqueue(punch({ id: "immediate-pending" }), "raw-2");
  worker.start(); await capturing;
  mode = "immediate"; worker.settingsChanged();
  readsAtRelease = frequencyReads;
  release(); await worker.idle();
  assert.deepEqual(calls, ["daily-in-flight", "immediate-pending"]);
  assert.ok(readsAtNextCapture >= 2, "the changed mode is read at the old job boundary and again for the queued immediate run");
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims.dates, ["2026-01-01"]);
  await worker.stop();
});
test("switching daily to immediate preserves the date claim and processes pending work", async (t) => {
  const h = rig(t); h.enable();
  const worker = h.create(); worker.start(); await worker.idle();
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims.dates, ["2026-01-01"]);
  h.setFrequency("immediate"); h.setDailyTime("08:00");
  await worker.enqueue(punch({ id: "immediate-after-switch" }), "raw"); await worker.idle();
  assert.equal(h.calls.length, 1);
  h.setFrequency("daily"); worker.settingsChanged(); await worker.idle();
  assert.equal(h.calls.length, 1, "the prior daily claim is retained when switching modes and time");
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims.dates, ["2026-01-01"]);
  await worker.stop();
});
test("an empty due round is still claimed and cannot consume later work that day", async (t) => {
  const h = rig(t); h.enable();
  const worker = h.create(); worker.start(); await worker.idle();
  await worker.enqueue(punch(), "raw"); await worker.idle();
  assert.equal(h.calls.length, 0);
  h.advanceDay(); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 1);
});
test("a failed daily-claim write prevents capture and can be retried before the date is claimed", async (t) => {
  const h = rig(t); h.enable();
  const blocked = h.create({ claimDailyRound: async () => { throw new Error("claim write failed"); } });
  await blocked.enqueue(punch(), "raw"); blocked.start(); await blocked.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(blocked.status().lastError, "STORAGE_BUSY");
  await blocked.stop();
  const recovered = h.create(); recovered.start(); await recovered.idle();
  assert.equal(h.calls.length, 1);
});
test("a failed round stays pending across restart and retries in the next day's round", async (t) => {
  const h = rig(t); h.enable();
  const first = h.create({ capture: async () => ({ ok: false, error: { code: "MODEL_NOT_CONFIGURED", retryable: false } }) });
  await first.enqueue(punch(), "raw"); first.start(); await first.idle();
  assert.equal(first.status().state, "paused");
  const saved = (await h.store.readPage(null, 100)).records[0].value;
  assert.equal(saved.attempts, 1); assert.equal(saved.state, "pending");
  await first.stop();
  const second = h.create(); second.start(); await second.idle(); assert.equal(h.calls.length, 0);
  h.advanceDay(); second.wake(); await second.idle(); assert.equal(h.calls.length, 1);
});
test("processing captures stay pending and a forgotten source is terminally skipped", async (t) => {
  const h = rig(t); h.enable();
  const worker = h.create({ capture: async () => ok({ processing: true }) });
  await worker.enqueue(punch(), "raw"); worker.start(); await worker.idle();
  assert.equal((await h.store.readPage(null, 100)).records[0].value.state, "pending");
  await worker.stop(); h.advanceDay();
  const skipped = h.create({ capture: async () => ({ ok: false, error: { code: "MEMORY_SUPPRESSED", retryable: false } }) });
  skipped.start(); await skipped.idle();
  assert.equal((await h.store.readPage(null, 100)).records[0].value.state, "skipped");
});
test("a persisted legacy queue input is retried byte-for-byte without adding new summary labels", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-organize-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const id = punchOperationId("legacy-punch");
  const legacyInput = {
    scope: "project",
    operationId: `organize:${id}`,
    messages: [
      { id: `${id}:request`, role: "user", content: "Old request payload." },
      { id: `${id}:outcome`, role: "assistant", content: "Old outcome payload." },
    ],
  };
  const job = { version: 1, punchId: "legacy-punch", memoryId: "raw-memory", actor: { agentId: "sw/a", projectId: "project", sessionId: "s", providerId: "mock" }, input: legacyInput, state: "pending", attempts: 0, nextAttemptAt: 0, lastError: null };
  await store.writeBatch([{ key: job.punchId, value: job, expectedRevision: null, sourceKind: "work-record", sourceId: job.punchId }]);
  let now = new Date(2026, 0, 1, 3).getTime();
  const calls = [];
  const first = createPunchOrganizationWorker({ store, claimDailyRound: store.claimDailyRound, enabled: () => true, now: () => now, capture: async (call) => { calls.push(call); return { ok: false, error: { code: "MODEL_NOT_CONFIGURED", retryable: false } }; } });
  first.start(); await first.idle();
  assert.equal(JSON.stringify(calls[0].input), JSON.stringify(legacyInput));
  const pending = (await store.readPage(null, 100)).records[0].value;
  assert.equal(pending.state, "pending");
  assert.equal(JSON.stringify(pending.input), JSON.stringify(legacyInput));
  await first.stop();
  now = new Date(2026, 0, 2, 3).getTime();
  const second = createPunchOrganizationWorker({ store, claimDailyRound: store.claimDailyRound, enabled: () => true, now: () => now, capture: async (call) => { calls.push(call); return ok(); } });
  second.start(); await second.idle();
  assert.equal(JSON.stringify(calls[1].input), JSON.stringify(legacyInput));
  assert.deepEqual((await store.readPage(null, 100)).records[0].value.input.messages, []);
  await second.stop();
});
test("source conversion bounds CJK bytes and preserves valid surrogate pairs", () => {
  const messages = buildPunchSourceMessages(punch({ name: "😀".repeat(1000), description: "測".repeat(6000) }));
  assert.ok(Buffer.byteLength(messages[0].content, "utf8") <= 900);
  assert.ok(Buffer.byteLength(messages[1].content, "utf8") <= 2400);
  assert.ok(messages.every((message) => message.content.isWellFormed()));
  assert.match(messages[0].content, /name（工作名稱／請求欄位）.*role=user.*合成角色，不代表原始發話者/u);
  assert.match(messages[1].content, /description（Lexical 純文字成果欄位；作者未知）.*role=assistant.*合成角色，不代表原始發話者/u);
  assert.deepEqual(messages.map((message) => message.id), [`${punchOperationId("p")}:request`, `${punchOperationId("p")}:outcome`]);
});

function hostRig(initialValues = { organizationEnabled: false }) {
  let events;
  let settingsListener;
  let values = initialValues;
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
test("production service organizes settled punches by default without toggling a setting", async (t) => {
  const h = hostRig({});
  const { backend } = startBackend(t, { host: h.host, settings: h.settings });
  backend.startWorkers(); await backend.idleWorkers();
  assert.equal(h.aiCalls, 2);
  assert.equal(h.closed, 2);
  const memories = await callInspect(backend, { scope: "project", limit: 12 }, { agentId: "sw/a", projectId: "project" });
  assert.equal(memories.result.value.memories.length, 2);
  assert.ok(memories.result.value.memories.some((memory) => memory.origin === "agent-inferred"));
  const status = await backend.call("ui.status", {});
  assert.equal(status.organization.completed, 1);
  assert.equal(status.organization.pending, 0);
  assert.equal(status.organization.state, "idle");
});
test("production service admits raw context with retired host state, then captures through real Cairn and mock host AI", async (t) => {
  const h = hostRig();
  const { backend, dataRoot } = startBackend(t, { host: h.host, settings: h.settings });
  backend.startWorkers(); await backend.idleWorkers();
  const queue = createLocalPunchReceiptStore(dirname(dataRoot), "punch-organization.json");
  const unacknowledged = (await queue.readPage(null, 100)).records[0].value;
  assert.deepEqual(unacknowledged.input.messages.map((message) => message.id), [`${punchOperationId("p")}:request`, `${punchOperationId("p")}:outcome`]);
  assert.match(unacknowledged.input.messages[0].content, /name（工作名稱／請求欄位）.*role=user.*合成角色，不代表原始發話者/u);
  assert.match(unacknowledged.input.messages[1].content, /description（Lexical 純文字成果欄位；作者未知）.*role=assistant.*合成角色，不代表原始發話者/u);
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
  assert.ok(detail.result.value.receipts.every((row) => row.sessionId === "s" && /^punch:[0-9a-f]{32}:(?:request|outcome)$/u.test(row.eventId)));
  const inferredUi = await backend.call("ui.get", { agentId: "sw/a", scope: "project", projectId: "project", memoryId: inferred.id });
  assert.equal(Object.hasOwn(inferredUi, "source"), false);
  const rawMemory = raw.result.value.memories[0];
  const rawUi = await backend.call("ui.get", { agentId: "sw/a", scope: "project", projectId: "project", memoryId: rawMemory.id });
  assert.equal(Object.hasOwn(rawUi, "source"), false);
  const status = await backend.call("ui.status", {});
  assert.equal(status.organization.completed, 1);
  h.event(); await backend.idleWorkers(); assert.equal(h.aiCalls, 2);
  await backend.dispose(); assert.equal(h.listeners, 0);
  const completed = (await queue.readPage(null, 100)).records[0];
  await queue.writeBatch([{ key: completed.key, value: { ...unacknowledged, state: "pending", nextAttemptAt: 0 }, expectedRevision: completed.revision }]);
  const { backend: reopened } = startBackend(t, { dataRoot, host: h.host, settings: h.settings });
  reopened.startWorkers(); await reopened.idleWorkers(); assert.equal(h.aiCalls, 2);
  assert.equal((await reopened.call("ui.status", {})).organization.pending, 1);
  assert.equal((await callInspect(reopened, { scope: "project", limit: 12 }, { agentId: "sw/a", projectId: "project" })).result.value.memories.length, 2);
  await reopened.dispose();
});
test("memory.remember operation IDs that collide with Punch receipt IDs do not label ui.get", async (t) => {
  const { backend } = startBackend(t);
  const binding = { agentId: "sw/a", projectId: "project" };
  const operationIds = [
    "punch:0123456789abcdef0123456789abcdef",
    "punch:fedcba9876543210fedcba9876543210:request",
  ];
  for (const [index, operationId] of operationIds.entries()) {
    const remembered = await callRemember(backend, [op(`A manual note with a colliding receipt ID ${index}.`, operationId, "project")], binding);
    const memoryId = remembered.results[0].value.memory.id;
    const detail = await backend.call("ui.get", { ...binding, scope: "project", memoryId });
    assert.equal(detail.ok, true);
    assert.equal(Object.hasOwn(detail, "source"), false, `manual operationId ${operationId} must not imply a Punch source`);
  }
});
test("ui.get leaves manual and mixed receipt-ID memories without individual source claims", async (t) => {
  const { backend, dataRoot } = startBackend(t);
  const binding = { agentId: "sw/a", projectId: "project" };
  const content = "A synthetic memory with mixed receipt IDs.";
  const mixedWrites = await callRemember(backend, Array.from({ length: 12 }, (_, index) => op(content, `manual-mixed-${index}`, "project")), binding);
  const memoryId = mixedWrites.results[0].value.memory.id;
  const punchEvent = punchOperationId("mixed-punch");
  const collisionWrite = await callRemember(backend, [op(content, punchEvent, "project")], binding);
  assert.equal(collisionWrite.results[0].value.memory.id, memoryId);
  rawWrite(databasePathOf(dataRoot, "sw/a"), (db) => {
    db.prepare("UPDATE receipts SET created_at = '2026-09-01T00:00:00.000Z' WHERE memory_id = ? AND event_id <> ?").run(memoryId, punchEvent);
    db.prepare("UPDATE receipts SET created_at = '2026-09-01T00:00:01.000Z' WHERE memory_id = ? AND event_id = ?").run(memoryId, punchEvent);
  });
  const mixed = await backend.call("ui.get", { ...binding, scope: "project", memoryId });
  assert.equal(Object.hasOwn(mixed, "source"), false);
  assert.equal(mixed.receipts.length, 12);
  assert.ok(mixed.receipts.every((receipt) => receipt.eventId !== punchEvent), "the Punch-shaped manual receipt is outside the displayed page");
  const manual = await callRemember(backend, [op("A manual-only synthetic note.", "manual-only-event", "project")], binding);
  const manualDetail = await backend.call("ui.get", { ...binding, scope: "project", memoryId: manual.results[0].value.memory.id });
  assert.equal(Object.hasOwn(manualDetail, "source"), false);
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
