import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
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
      async getOptions() { return { providers: [{ id: "mock", state: "ready", models: [{ id: "allowed", isDefault: true }] }], defaultProviderId: "mock", quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 10000 } }; },
      async openSession() { return { effective: { providerId: "mock", modelId: "allowed" }, turn: null,
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
