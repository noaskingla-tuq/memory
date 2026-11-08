import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { dispatchUi } from "../out/backend/uiDispatch.js";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { currentMemoryInvocation, operationKey, pairKey, withMemoryCaptureScope } from "../out/application/modelInvocationScope.js";
import { failure, success } from "../out/domain/errors.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { startBackend } from "./backendHarness.mjs";
import { ui } from "./homeFixtures.mjs";

const CLOSE_LIMIT_MS = 120;
const enabled = () => readOrganizationSettings({ organizationEnabled: true });

// why: the first opened session's close() never settles, which is the host hang seen in the field
function hangingCloseAi({ hangAll = false } = {}) {
  const counters = { opened: 0, closeCalls: 0, sent: 0, openOptions: [] };
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  return {
    counters,
    ai: {
      async getOptions() { return options; },
      async openSession(openOptions) {
        counters.opened += 1;
        counters.openOptions.push(openOptions);
        const index = counters.opened;
        let listener;
        // why: a resume request is answered with the session it asked for, as a host that still holds that session would
        const session = {
          sessionId: openOptions?.resume ?? "close-session-" + index, effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
          onEvent(next) { listener = next; return () => { listener = undefined; }; },
          async send() {
            counters.sent += 1;
            const turnId = "turn-" + index + "-" + counters.sent;
            const reply = '{"items":[]}';
            session.turn = { turnId, text: reply, terminal: { kind: "completed" } };
            listener?.({ turnId, kind: "textDelta", text: reply });
            listener?.({ turnId, kind: "contentSaved", sequenceNo: counters.sent });
            listener?.({ turnId, kind: "completed" });
            return { turnId };
          },
          close() { counters.closeCalls += 1; return index === 1 || hangAll ? new Promise(() => {}) : Promise.resolve(); },
          async interrupt() {},
        };
        return session;
      },
    },
  };
}

function invokeScoped(port, actor, operationId) {
  return withMemoryCaptureScope(actor, operationId, async () => {
    const invocation = currentMemoryInvocation("extract", "system", { operationId });
    return port.invoke({ agentId: actor.agentId, policy: port.resolvePolicy(actor.agentId), operation: "extract", system: "system", input: { operationId }, maxOutputTokens: 1024, signal: new AbortController().signal, invocation });
  });
}

const actorOf = (agentId) => ({ agentId, projectId: "close-project", sessionId: "source-session", providerId: "mock" });

test("a close() that never settles is abandoned after the limit, recorded as session_close, and the next call still runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-close-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = hangingCloseAi();
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, createLocalPunchOrganizationStore(dir), CLOSE_LIMIT_MS);
  assert.deepEqual(await invokeScoped(port, actorOf("sw/a"), "organize:one"), { items: [] });

  const startedAt = Date.now();
  await assert.rejects(invokeScoped(port, actorOf("sw/b"), "organize:two"), (error) => {
    assert.equal(error.name, "MemoryServiceError");
    assert.equal(error.code, "RESOURCE_BUSY");
    assert.equal(error.phase, "session_close");
    assert.equal(error.retryable, true);
    return true;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= CLOSE_LIMIT_MS - 20 && elapsed < CLOSE_LIMIT_MS + 1500, "released near the limit, not after the hang: " + elapsed + "ms");

  assert.deepEqual(await invokeScoped(port, actorOf("sw/b"), "organize:three"), { items: [] });
  assert.equal(h.counters.closeCalls, 1, "the stuck session was asked to close once; the abandoned handle is not retried by the next call");
  await port.cancel();
});

test("after a close timed out, the same pair opens a new session instead of resuming the one that never confirmed closing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-close-resume-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = hangingCloseAi();
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store, CLOSE_LIMIT_MS);
  assert.deepEqual(await invokeScoped(port, actorOf("sw/a"), "organize:one"), { items: [] });
  // why: the worker prunes a finished operation, and an unpruned one would block the pair for a reason unrelated to resume
  await store.pruneOperation(operationKey(pairKey("sw/a", "close-project"), "organize:one"));
  const stuckId = "close-session-1";
  assert.equal(h.counters.openOptions.length, 1);
  assert.equal(h.counters.openOptions[0].resume, undefined);

  await assert.rejects(invokeScoped(port, actorOf("sw/b"), "organize:two"), (error) => error.phase === "session_close");
  const afterTimeout = (await store.readResumeState()).sessions;
  const savedA = Object.values(afterTimeout).find((record) => record.hostSessionId === stuckId);
  assert.notEqual(savedA?.state, "active", "the saved record of the unclosed session is no longer resumable");

  const opensBefore = h.counters.openOptions.length;
  assert.deepEqual(await invokeScoped(port, actorOf("sw/a"), "organize:three"), { items: [] });
  const laterOpens = h.counters.openOptions.slice(opensBefore);
  assert.ok(laterOpens.length >= 1, "the pair opened a session again");
  assert.deepEqual(laterOpens.filter((entry) => entry.resume !== undefined), [], "no later open asked to resume the session whose close timed out");
  const current = Object.values((await store.readResumeState()).sessions).find((record) => record.pairKey === savedA.pairKey);
  assert.notEqual(current.hostSessionId, stuckId);
  assert.equal(current.state, "active");
  await port.cancel();
});

test("without a resume store the per-invoke close is bounded too and the value is still returned", async () => {
  const h = hangingCloseAi({ hangAll: true });
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, undefined, CLOSE_LIMIT_MS);
  const startedAt = Date.now();
  const value = await port.invoke({ agentId: "a", policy: port.resolvePolicy("a"), operation: "extract", system: "JSON please", input: {}, maxOutputTokens: 1024, signal: new AbortController().signal });
  assert.deepEqual(value, { items: [] });
  assert.ok(Date.now() - startedAt < CLOSE_LIMIT_MS + 1500);
  assert.equal(h.counters.closeCalls, 1);
});

test("cancel() and releasePair() do not hang on a stuck close", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-close-cancel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = hangingCloseAi({ hangAll: true });
  const open = async () => {
    const port = createHostMemoryModelPort(h.ai, enabled, undefined, createLocalPunchOrganizationStore(mkdtempSync(join(dir, "s-"))), CLOSE_LIMIT_MS);
    await invokeScoped(port, actorOf("sw/a"), "organize:one");
    return port;
  };
  const released = await open();
  await assert.rejects(released.releasePair("sw/a", "close-project"), (error) => error.phase === "session_close");
  const cancelled = await open();
  const startedAt = Date.now();
  await cancelled.cancel();
  assert.ok(Date.now() - startedAt < CLOSE_LIMIT_MS + 1500);
});

function punch(id, agentId) {
  const now = Date.now();
  return {
    id, agentId, projectId: "close-project", sessionId: "source-session", providerId: "mock", model: "allowed",
    punchType: "main", startedAtMs: now - 500_000, endedAtMs: now - 200_000,
    name: "Synthetic close request", description: "Synthetic close result.",
  };
}

test("the organization worker records the close timeout with its phase and plugin-decided code and still completes the next job", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-close-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const h = hangingCloseAi();
  const port = createHostMemoryModelPort(h.ai, enabled, undefined, store, CLOSE_LIMIT_MS);
  const worker = createPunchOrganizationWorker({
    store, enabled: () => true, frequency: () => "immediate", now: () => Date.now(),
    capture: async (job) => {
      try { await invokeScoped(port, job.actor, job.input.operationId); return success("close-worker", { classification: { status: "ok" } }); }
      catch (error) { return failure("close-worker", error); }
    },
  });
  await worker.enqueue(punch("close-a", "sw/a"), "memory-a");
  await worker.enqueue(punch("close-b", "sw/b"), "memory-b");
  await worker.enqueue(punch("close-c", "sw/c"), "memory-c");
  const startedAt = Date.now();
  worker.start();
  await worker.idle();
  const elapsed = Date.now() - startedAt;
  const rows = new Map((await store.readPage(null, 100)).records.map((entry) => [entry.key, entry.value]));
  const organizationStatus = worker.status();
  const uiStatus = await dispatchUi("ui.status", {}, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, organizationStatus: () => organizationStatus });
  const target = { innerHTML: "", dataset: {} };
  const line = ui.createStatusLine({
    client: { async call() { return { ok: true, value: uiStatus }; } }, target, now: () => Date.now(),
    scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  line.start();
  await new Promise((resolve) => setImmediate(resolve));
  line.stop();
  await worker.stop();
  await port.cancel();

  assert.ok(elapsed < CLOSE_LIMIT_MS + 3000, "the run was not held by the stuck close: " + elapsed + "ms");
  assert.equal(rows.get("close-a").state, "completed");
  assert.equal(rows.get("close-b").state, "pending");
  assert.equal(rows.get("close-b").lastError, "RESOURCE_BUSY");
  assert.equal(rows.get("close-b").errorPhase, "session_close");
  assert.equal(rows.get("close-b").localErrorCode, "close_timeout");
  assert.equal(rows.get("close-b").hostErrorCode, null, "a code the plugin decided is not stored as a host code");
  assert.equal(rows.get("close-c").state, "completed", "the job after the stuck close was still processed");
  assert.equal(organizationStatus.state, "paused");
  assert.equal(organizationStatus.errorPhase, "session_close");
  assert.equal(organizationStatus.localErrorCode, "close_timeout");
  assert.equal(organizationStatus.hostErrorCode, null);
  assert.equal(uiStatus.organization.errorPhase, "session_close");
  assert.equal(uiStatus.organization.localErrorCode, "close_timeout");
  assert.ok(target.innerHTML.includes("失敗階段 session_close・外掛自行判定 close_timeout"), "the headline says the plugin decided this code");
  const headline = target.innerHTML.slice(target.innerHTML.indexOf("AI 整理暫停"), target.innerHTML.indexOf("</span>", target.innerHTML.indexOf("AI 整理暫停")));
  assert.equal(headline.includes("主程式代碼"), false, "the headline does not present it as a host code");
});

test("a session_close phase alone does not become a timeout code, and a retry without it clears the local code", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-close-phase-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  let attempt = 0;
  const worker = createPunchOrganizationWorker({
    store, enabled: () => true, frequency: () => "immediate", now: () => Date.now(),
    capture: async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, error: { code: "RESOURCE_BUSY", message: "close failed", retryable: true, requestId: "p1", phase: "session_close" } };
      if (attempt === 2) return { ok: false, error: { code: "RESOURCE_BUSY", message: "close timed out", retryable: true, requestId: "p2", phase: "session_close", localCode: "close_timeout" } };
      return { ok: false, error: { code: "MODEL_TIMEOUT", message: "turn", retryable: true, requestId: "p3", phase: "turn_timeout" } };
    },
  });
  await worker.enqueue(punch("phase-a", "sw/a"), "memory-a");
  const rowOf = async () => (await store.readPage(null, 10)).records[0].value;
  worker.start();
  await worker.idle();
  const first = await rowOf();
  assert.equal(first.errorPhase, "session_close");
  assert.equal(first.hostErrorCode ?? null, null, "the phase name does not imply any code");
  assert.equal(first.localErrorCode ?? null, null);
  assert.equal(worker.status().hostErrorCode, null);
  assert.equal(worker.status().localErrorCode, null);

  worker.settingsChanged();
  await worker.idle();
  const second = await rowOf();
  assert.equal(second.localErrorCode, "close_timeout");
  assert.equal(second.hostErrorCode, null);

  worker.settingsChanged();
  await worker.idle();
  const third = await rowOf();
  assert.equal(third.errorPhase, "turn_timeout");
  assert.equal(third.localErrorCode, null, "a later failure of another kind does not keep the old local code");
  assert.equal(worker.status().localErrorCode, null);
  await worker.stop();
});

function closeHangingHost(ai) {
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const row = { id: "row", punchId: "p", agentId: "sw/a", projectId: null, sessionId: "s", providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request", description: "Outcome" };
  return {
    workRecords: { async readPage() { return { snapshot, nextCursor: null, records: [row] }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    ai,
  };
}

test("through the backend's own capture wiring, a close that times out in the final release shows session_close in ui.status while the job completes", async (t) => {
  const hang = hangingCloseAi({ hangAll: true });
  const counters = hang.counters;
  const settings = { all: () => ({ organizationEnabled: true, organizationFrequency: "immediate" }), onChange() { return () => {}; } };
  const { backend, dataRoot } = startBackend(t, { host: closeHangingHost(hang.ai), settings, hostSessionCloseTimeoutMs: CLOSE_LIMIT_MS });
  const startedAt = Date.now();
  backend.startWorkers();
  await backend.idleWorkers();
  const elapsed = Date.now() - startedAt;
  const job = (await createLocalPunchOrganizationStore(dirname(dataRoot)).readPage(null, 10)).records[0].value;
  const status = await backend.call("ui.status", {});

  assert.ok(counters.closeCalls >= 1, "the release really asked the host session to close");
  assert.equal(job.state, "completed", "the job result is not turned into a failure by the release");
  assert.equal(status.organization.errorPhase, "session_close");
  assert.equal(status.organization.localErrorCode, "close_timeout");
  assert.equal(status.organization.hostErrorCode, null);
  assert.equal(status.organization.state, "paused");
  assert.equal(status.organization.lastError, "RESOURCE_BUSY");
  assert.ok(elapsed < CLOSE_LIMIT_MS + 5000, "the stuck close did not hold the worker: " + elapsed + "ms");
});

// why: sessions are opened in order, so the first (pair A) hangs on close and every later one (pair A again, pair B) closes normally
function twoPairHost(ai) {
  const rows = [];
  const listeners = [];
  const record = (id, agent) => ({ id, punchId: id, agentId: agent, projectId: null, sessionId: "s-" + id, providerId: "mock", model: "allowed", punchType: "main", startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request " + id, description: "Outcome " + id });
  const host = {
    workRecords: {
      async readPage() { return { snapshot: { snapshotId: "s" + rows.length, generation: "g" + rows.length, highWatermark: "p" + rows.length }, nextCursor: null, records: [...rows] }; },
      subscribeSettledChanges(listener) { listeners.push(listener); return () => {}; },
    },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot: { snapshotId: "s", generation: "g", highWatermark: "p" }, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot: { snapshotId: "s", generation: "g", highWatermark: "p" }, entries: [], nextCursor: null }; } },
    ai,
  };
  return { host, add(id, agent) { rows.push(record(id, agent)); }, notify() { for (const listener of listeners) listener(); } };
}

test("each pair keeps its own close timeout record: another pair's successful release does not clear it, and only its own release does", async (t) => {
  const hang = hangingCloseAi();
  const feed = twoPairHost(hang.ai);
  feed.add("pa1", "sw/a");
  feed.add("pb1", "sw/b");
  const settings = { all: () => ({ organizationEnabled: true, organizationFrequency: "immediate" }), onChange() { return () => {}; } };
  const { backend } = startBackend(t, { host: feed.host, settings, hostSessionCloseTimeoutMs: CLOSE_LIMIT_MS });
  backend.startWorkers();
  await backend.idleWorkers();
  const afterAB = (await backend.call("ui.status", {})).organization;
  assert.equal(hang.counters.closeCalls, 2, "pair A's close hung and pair B's close then succeeded");
  assert.equal(afterAB.errorPhase, "session_close", "pair B releasing cleanly must not erase pair A's record");
  assert.equal(afterAB.localErrorCode, "close_timeout");
  assert.equal(afterAB.state, "paused");

  feed.add("pa2", "sw/a");
  feed.notify();
  await backend.idleWorkers();
  const afterA = (await backend.call("ui.status", {})).organization;
  assert.equal(hang.counters.closeCalls, 3, "pair A released again, this time successfully");
  assert.equal(afterA.errorPhase, null, "pair A's own successful release clears its record");
  assert.equal(afterA.lastError, null);
  assert.equal(afterA.state, "idle");
});

// why: this pins an accepted trade-off, not an ideal: an unfinished operation whose session could not be confirmed closed is never resumed, so it waits for the 7-day operator reconcile
test("after a hard cancel and then a close timeout, the retry sends on a fresh session and never resumes the old one", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-close-unresolved-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createLocalPunchOrganizationStore(dir);
  const opens = [];
  const options = { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  // why: the turn never answers and is stopped by hand, and the only session ever opened never confirms its close
  const ai = {
    async getOptions() { return options; },
    async openSession(openOptions) {
      opens.push(openOptions);
      return {
        sessionId: openOptions?.resume ?? "unresolved-session-" + opens.length, effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
        onEvent() { return () => undefined; },
        async send() { return { turnId: "turn-never-answered" }; },
        close() { return new Promise(() => {}); },
        async interrupt() {},
      };
    },
  };
  const port = createHostMemoryModelPort(ai, enabled, undefined, store, CLOSE_LIMIT_MS);
  const actor = actorOf("sw/a");
  const stopped = async () => {
    const call = invokeScoped(port, actor, "organize:x");
    const rejection = assert.rejects(call, (error) => error.code === "RESOURCE_BUSY" && error.phase === "cancelled");
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    port.interrupt();
    await rejection;
  };
  await stopped();
  await assert.rejects(port.releasePair(actor.agentId, actor.projectId), (error) => error.code === "RESOURCE_BUSY" && error.phase === "session_close");
  const opensBefore = opens.length;

  const firstCalls = Object.values(Object.values((await store.readResumeState()).operations)[0].calls);
  assert.deepEqual(firstCalls.map((call) => [call.phase, call.hostErrorCode, call.retryable, call.partialDelivered]), [["failed", "cancelled_local", true, false]], "the cancelled call is closed, not left sent");
  await stopped();
  assert.equal(opens.length, opensBefore + 1, "the retry opened exactly one new session");
  assert.deepEqual(opens.filter((entry) => entry?.resume !== undefined), [], "the old session was never asked to resume");
  const saved = Object.values((await store.readResumeState()).sessions);
  assert.deepEqual(saved.map((record) => record.state), ["active"], "the retry saved its own session");
  await port.cancel();
});
