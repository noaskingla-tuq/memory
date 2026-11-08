import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { createLocalPunchReceiptStore } from "../out/adapters/storage/punchStateStore.js";
import { startBackend } from "./backendHarness.mjs";

test("dispose cancels an in-flight host model, removes subscriptions and preserves a retryable job", { timeout: 5000 }, async (t) => {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const counters = { interrupted: 0, closed: 0, off: 0, settingsOff: 0, feedOff: 0 };
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, nextCursor: null, records: [{ id: "row", punchId: "p", agentId: "sw/a", projectId: null, sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request", description: "Outcome" }] }; }, subscribeSettledChanges() { return () => { counters.feedOff++; }; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    ai: {
      async getOptions() { return { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 10000 } }; },
      async openSession() { return { sessionId: "host-session", effective: { providerId: "codex", modelId: "gpt-6-luna" }, turn: null,
        onEvent() { return () => { counters.off++; }; }, async send() { signalStarted(); return { turnId: "t" }; },
        async interrupt() { counters.interrupted++; }, async close() { counters.closed++; },
      }; },
    },
  };
  const { backend, dataRoot } = startBackend(t, { host, settings: { all: () => ({ organizationEnabled: true }), onChange() { return () => { counters.settingsOff++; }; } } });
  backend.startWorkers(); await started; await backend.dispose();
  await backend.dispose();
  assert.deepEqual(counters, { interrupted: 1, closed: 1, off: 1, settingsOff: 1, feedOff: 1 });
  assert.equal(backend.openHandles(), 0);
  const saved = (await createLocalPunchReceiptStore(dirname(dataRoot), "punch-organization.json").readPage(null, 100)).records[0].value;
  assert.equal(saved.state, "pending");
  assert.ok(saved.input.messages.length > 0);
});
test("late startup holds the daily claim until an initially failing punch catch-up succeeds", async (t) => {
  let failInitialRead = true;
  let settledChanged;
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const punch = { id: "row", punchId: "p", agentId: "sw/a", projectId: null, sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request", description: "Outcome" };
  const host = {
    workRecords: {
      async readPage() {
        if (failInitialRead) throw Object.assign(new Error("temporarily unavailable"), { code: "temporary" });
        return { snapshot, records: [punch], nextCursor: null };
      },
      subscribeSettledChanges(listener) { settledChanged = listener; return () => { settledChanged = undefined; }; },
    },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
  };
  const localDue = new Date(); localDue.setHours(3, 0, 0, 0);
  const { backend, dataRoot } = startBackend(t, { host, organizationNow: () => localDue.getTime(), settings: { all: () => ({ organizationEnabled: true }), onChange() { return () => {}; } } });
  backend.startWorkers(); await backend.idleWorkers();
  const organizationStore = createLocalPunchReceiptStore(dirname(dataRoot), "punch-organization.json");
  assert.equal((await organizationStore.readPage(null, 100)).records.length, 0);

  failInitialRead = false;
  settledChanged?.({});
  await backend.idleWorkers();
  const organizationRows = (await organizationStore.readPage(null, 100)).records;
  assert.equal(organizationRows.length, 1);
  assert.equal(organizationRows[0].value.state, "pending");
  assert.equal(organizationRows[0].value.attempts, 1);
  assert.equal(organizationRows[0].value.lastError, "MODEL_NOT_CONFIGURED");
  const localDate = `${localDue.getFullYear()}-${String(localDue.getMonth() + 1).padStart(2, "0")}-${String(localDue.getDate()).padStart(2, "0")}`;
  const saved = JSON.parse(readFileSync(join(dirname(dataRoot), "punch-organization.json"), "utf8"));
  assert.deepEqual(saved.organizationClaims.dates, [localDate]);
  const punchState = await createLocalPunchReceiptStore(dirname(dataRoot)).readPage(null, 100);
  assert.equal(punchState.records.find((row) => row.key === "p").value.state, "written");
  await backend.dispose();
});
test("settings subscription applies the selected local daily time and immediate mode to the running worker", async (t) => {
  let settingsListener;
  let values = { organizationEnabled: true, organizationFrequency: "daily", organizationDailyTime: "04:00" };
  let now = new Date(2026, 0, 1, 3, 30).getTime();
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, records: [{ id: "row", punchId: "p", agentId: "sw/a", projectId: null, sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request", description: "Outcome" }], nextCursor: null }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
  };
  const settings = { all: () => values, onChange(listener) { settingsListener = listener; return () => { settingsListener = undefined; }; } };
  const { backend, dataRoot } = startBackend(t, { host, organizationNow: () => now, settings });
  backend.startWorkers(); await backend.idleWorkers();
  const dir = dirname(dataRoot);
  const organizationStore = createLocalPunchReceiptStore(dir, "punch-organization.json");
  assert.equal((await organizationStore.readPage(null, 100)).records.length, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "punch-organization.json"), "utf8")).organizationClaims, undefined);

  values = { ...values, organizationDailyTime: "03:00" };
  settingsListener?.(values);
  await backend.idleWorkers();
  let saved = JSON.parse(readFileSync(join(dir, "punch-organization.json"), "utf8"));
  assert.deepEqual(saved.organizationClaims.dates, ["2026-01-01"]);
  let job = (await organizationStore.readPage(null, 100)).records[0].value;
  assert.equal(job.attempts, 1);

  values = { ...values, organizationFrequency: "immediate", organizationDailyTime: "23:00" };
  settingsListener?.(values);
  await backend.idleWorkers();
  saved = JSON.parse(readFileSync(join(dir, "punch-organization.json"), "utf8"));
  job = (await organizationStore.readPage(null, 100)).records[0].value;
  assert.deepEqual(saved.organizationClaims.dates, ["2026-01-01"], "switching modes and time never clears the durable daily claim");
  assert.equal(job.attempts, 2, "the immediate settings update wakes the pending job through the settings subscription");
  await backend.dispose();
});
test("per-key time then frequency subscription uses the daily gate without retrying immediate work early", async (t) => {
  let settingsListener;
  let values = { organizationEnabled: true, organizationFrequency: "immediate", organizationDailyTime: "02:00" };
  let now = new Date(2026, 0, 1, 3, 0).getTime();
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, records: [{ id: "row", punchId: "p", agentId: "sw/a", projectId: null, sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request", description: "Outcome" }], nextCursor: null }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
  };
  const settings = { all: () => values, onChange(listener) { settingsListener = listener; return () => { settingsListener = undefined; }; } };
  const { backend, dataRoot } = startBackend(t, { host, organizationNow: () => now, settings });
  backend.startWorkers(); await backend.idleWorkers();
  const organizationStore = createLocalPunchReceiptStore(dirname(dataRoot), "punch-organization.json");
  let job = (await organizationStore.readPage(null, 100)).records[0].value;
  assert.equal(job.attempts, 1);
  assert.equal(job.lastError, "MODEL_NOT_CONFIGURED");
  now = new Date(2026, 0, 1, 3, 30).getTime();

  values = { ...values, organizationDailyTime: "04:00" };
  settingsListener?.(values);
  await backend.idleWorkers();
  job = (await organizationStore.readPage(null, 100)).records[0].value;
  assert.equal(job.attempts, 1, "the daily-time-only intermediate snapshot does not force an immediate retry");

  values = { ...values, organizationFrequency: "daily" };
  settingsListener?.(values);
  await backend.idleWorkers();
  job = (await organizationStore.readPage(null, 100)).records[0].value;
  assert.equal(job.attempts, 1, "the mode change observes the saved 04:00 gate before starting work");
  assert.equal(JSON.parse(readFileSync(join(dirname(dataRoot), "punch-organization.json"), "utf8")).organizationClaims, undefined);

  now = new Date(2026, 0, 1, 4, 0).getTime();
  values = { ...values, organizationContextBudget: 65536 };
  settingsListener?.(values);
  await backend.idleWorkers();
  job = (await organizationStore.readPage(null, 100)).records[0].value;
  assert.equal(job.attempts, 1, "a failed AI attempt from earlier that day remains deferred to the next daily round");
  assert.equal(job.lastAttemptDate, "2026-01-01");
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(dataRoot), "punch-organization.json"), "utf8")).organizationClaims.dates, ["2026-01-01"]);
  await backend.dispose();
});
test("a capture queued behind forget checks its raw source inside the shared write lane", async () => {
  let alive = true;
  let calls = 0;
  let release;
  let notify;
  const entered = new Promise((resolve) => { notify = resolve; });
  const core = {
    get: () => alive ? { ok: true, value: {} } : { ok: false, error: { code: "memory_not_found" } },
    capture: async () => { calls++; notify(); await new Promise((resolve) => { release = resolve; }); return { ok: true, value: {} }; },
    forget: () => { alive = false; return { ok: true, value: { forgotten: true } }; },
    close() {},
  };
  const pool = new CoreHandlePool({ layout: { agentDbPath: () => ":memory:" }, openCore: () => core });
  const app = new MemoryApplication(pool);
  const actor = { agentId: "a", projectId: null, providerId: "mock", sessionId: "s" };
  const capture = { scope: "personal", operationId: "c", messages: [{ id: "m", role: "user", content: "source" }] };
  const first = app.execute("memory_capture", capture, actor, "raw");
  await entered;
  const forget = app.execute("memory_forget", { scope: "personal", memoryId: "raw", expectedRevision: 1, operationId: "f" }, actor);
  const queued = app.execute("memory_capture", capture, actor, "raw");
  release();
  assert.equal((await first).ok, true); assert.equal((await forget).ok, true);
  assert.equal((await queued).error.code, "MEMORY_SUPPRESSED");
  assert.equal(calls, 1);
  await app.close();
});
