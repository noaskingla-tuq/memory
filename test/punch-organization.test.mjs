import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalPunchOrganizationStore, createLocalPunchReceiptStore } from "../out/adapters/storage/punchStateStore.js";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { createCairnModelAdapter } from "../out/adapters/model/cairnModelAdapter.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { buildPunchSourceMessages, punchOperationId } from "../out/application/punchContent.js";
import { currentMemoryInvocation, legacyModelCallKey, operationKey, pairKey, sha256, withMemoryCaptureScope } from "../out/application/modelInvocationScope.js";
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
  const create = (patch = {}) => { const worker = createPunchOrganizationWorker({ store, enabled: () => enabled, frequency: () => frequency, dailyTime: () => dailyTime, now: () => now, capture: async (job) => { calls.push(job); return ok(); }, ...overrides, ...patch }); workers.push(worker); return worker; };
  return { dir, store, create, calls, enable: () => { enabled = true; }, setFrequency: (value) => { frequency = value; }, setDailyTime: (value) => { dailyTime = value; }, setNow: (value) => { now = value; }, advanceDay: () => { now = new Date(2026, 0, 2, 3).getTime(); } };
}
test("disabled organization preserves a durable job; enabling captures provenance once across restart", async (t) => {
  const h = rig(t);
  const first = h.create();
  await first.enqueue(punch(), "raw"); first.start(); await first.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(first.status().state, "disabled");
  assert.equal(JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationClaims, undefined);
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
  const savedRound = JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8")).organizationResume.dailyRounds["2026-01-01"];
  assert.equal(savedRound.snapshot.queueSequenceHighWatermark, 1);
  assert.equal(savedRound.deferredMembers, 1);

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
test("a claim-only legacy date permits exact journal recovery in local-only mode", async (t) => {
  const h = rig(t); h.enable();
  const source = punch({ id: "legacy-reply" });
  const worker = h.create({ capture: async (job) => { h.calls.push(job); return ok({ emptySuccess: true }); } });
  await worker.enqueue(source, "raw");
  const path = join(h.dir, "punch-organization.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.organizationClaims = { version: 1, dates: ["2026-01-01"] };
  delete saved.organizationResume;
  writeFileSync(path, JSON.stringify(saved));

  const rows = await h.store.readPage(null, 100);
  const job = rows.records.find((row) => row.key === source.id).value;
  const pair = pairKey(job.actor.agentId, job.actor.projectId);
  const operation = operationKey(pair, job.input.operationId);
  const requestSha256 = "a".repeat(64);
  const replyJson = '{"items":[]}';
  const callKey = legacyModelCallKey(operation, "extract", requestSha256, 0);
  await h.store.transactResumeState((state) => ({
    ...state,
    operations: {
      ...state.operations,
      [operation]: {
        operationKey: operation, pairKey: pair, operationId: job.input.operationId, agentId: job.actor.agentId, projectId: job.actor.projectId, updatedAt: Date.now(),
        calls: {
          [callKey]: {
            callKey, operationKey: operation, pairKey: pair, modelOperation: "extract", operationSystemSha256: "b".repeat(64),
            requestSha256, occurrence: 0, hostSessionId: "saved-session", turnId: "saved-turn", sequenceNo: 1,
            phase: "reply_ready", retryable: false, partialDelivered: false, hostErrorCode: null,
            replyJson, replySha256: sha256(replyJson), responseBytes: Buffer.byteLength(replyJson),
            createdAt: Date.now(), updatedAt: Date.now(),
          },
        },
      },
    },
  }));
  worker.start(); await worker.idle();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].allowModelSend, false);
  assert.equal((await h.store.readPage(null, 100)).records.find((row) => row.key === source.id).value.state, "completed");
  const state = await h.store.readResumeState();
  assert.equal(Object.hasOwn(state.operations, operation), false, "terminal job state and operation-journal removal commit together");
  assert.deepEqual(state.dailyRounds, {}, "legacy membership is not synthesized from a claim-only date");
  await worker.stop();
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
  const blocked = h.create({ beginOrResumeDailyRound: async () => { throw new Error("round write failed"); } });
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
test("same-day restart continues unattempted frozen members, leaves failed AI work until tomorrow, and excludes newer jobs", async (t) => {
  const h = rig(t); h.enable();
  const calls = [];
  const first = h.create({ capture: async (job) => {
    calls.push(job.actor.projectId + ":" + job.input.operationId);
    return job.input.operationId.endsWith(punchOperationId("first"))
      ? { ok: false, error: { code: "MODEL_TIMEOUT", retryable: true } }
      : ok();
  } });
  await first.enqueue(punch({ id: "first" }), "raw-first");
  await first.enqueue(punch({ id: "second" }), "raw-second");
  first.start(); await first.idle();
  const stateAfterFirst = JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8"));
  const originalRound = stateAfterFirst.organizationResume.dailyRounds["2026-01-01"];
  assert.equal(originalRound.snapshot.eligibleMemberCount, 2);
  assert.equal(originalRound.state, "paused");
  assert.equal(originalRound.completedMembers, 1);
  assert.equal(originalRound.deferredMembers, 1);
  assert.equal(calls.length, 2, "the failure is deferred while the next frozen member is attempted once");

  await first.enqueue(punch({ id: "post-snapshot" }), "raw-post");
  await first.idle();
  const afterNewJob = JSON.parse(readFileSync(join(h.dir, "punch-organization.json"), "utf8"));
  assert.equal(afterNewJob.organizationResume.dailyRounds["2026-01-01"].roundId, originalRound.roundId);
  assert.equal(calls.length, 2, "new queue entries do not enter the frozen daily round");
  await first.stop();

  const sameDay = h.create({ capture: async (job) => { calls.push("same-day:" + job.punchId); return ok(); } });
  sameDay.start(); await sameDay.idle();
  assert.equal(calls.length, 2, "restart on the same date does not retry an AI failure");
  assert.equal(sameDay.status().pending, 2);
  await sameDay.stop();

  h.advanceDay();
  const nextDay = h.create({ capture: async (job) => { calls.push("next-day:" + job.punchId); return ok(); } });
  nextDay.start(); await nextDay.idle();
  assert.deepEqual(calls.slice(2).sort(), ["next-day:first", "next-day:post-snapshot"]);
  assert.equal(nextDay.status().completed, 3);
});

test("a durable retryable failed turn blocks same-day daily resend across a job-write crash, then retries next date", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-daily-journal-boundary-"));
  const workers = [];
  const ports = [];
  t.after(async () => {
    for (const worker of workers) await worker.stop();
    for (const port of ports) await port.cancel();
    rmSync(dir, { recursive: true, force: true });
  });
  const baseStore = createLocalPunchOrganizationStore(dir);
  let failJobWrite = true;
  const faultStore = {
    ...baseStore,
    async writeBatch(records) {
      if (failJobWrite && records.some((record) => record.key === "failed-journal" && record.value?.state === "pending" && record.value?.lastError !== null)) {
        failJobWrite = false;
        throw new Error("injected process stop after failed-call journal commit");
      }
      return baseStore.writeBatch(records);
    },
  };
  const counters = { sent: 0, opened: 0, resumed: 0 };
  let listener;
  const session = {
    sessionId: "daily-failed-session", effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null }, turn: null,
    onEvent(next) { listener = next; return () => { listener = undefined; }; },
    async send() {
      counters.sent += 1;
      const turnId = `daily-failed-turn-${counters.sent}`;
      queueMicrotask(() => listener?.({ turnId, kind: "failed", code: "provider_error", retryable: true, partialDelivered: false }));
      return { turnId };
    },
    async close() {},
    async interrupt() {},
  };
  const ai = {
    async getOptions() {
      return {
        providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }],
        defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" },
        limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 },
      };
    },
    async openSession(input) {
      if (input.resume !== undefined) { counters.resumed += 1; return session; }
      counters.opened += 1;
      return session;
    },
  };
  const makePort = () => {
    const port = createHostMemoryModelPort(ai, () => readOrganizationSettings({ organizationEnabled: true }), 1_000, undefined, baseStore);
    ports.push(port);
    return port;
  };
  const makeCapture = (port, calls) => async (job) => {
    calls.push(job.punchId);
    const input = { messages: job.input.messages };
    return withMemoryCaptureScope(job.actor, job.input.operationId, async () => {
      const invocation = currentMemoryInvocation("extract", "daily retry schema", input);
      try {
        const value = await port.invoke({ agentId: job.actor.agentId, policy: port.resolvePolicy(job.actor.agentId), operation: "extract", system: "daily retry schema", input, maxOutputTokens: 1024, signal: new AbortController().signal, invocation });
        return { ok: true, value, requestId: "synthetic" };
      } catch (error) {
        return { ok: false, error: { code: error.code ?? "INTERNAL", retryable: error.retryable ?? false, ...(error.phase === undefined ? {} : { phase: error.phase }) } };
      }
    });
  };
  let clock = Date.now();
  const captureCalls = [];
  const makeWorker = (store, port) => {
    const worker = createPunchOrganizationWorker({
      store, enabled: () => true, frequency: () => "daily", dailyTime: () => "00:00", now: () => clock,
      capture: makeCapture(port, captureCalls),
    });
    workers.push(worker);
    return worker;
  };
  const source = punch({ id: "failed-journal" });
  const first = makeWorker(faultStore, makePort());
  await first.enqueue(source, "raw-failed-journal");
  first.start();
  await first.idle();
  const pair = pairKey(source.agentId, source.projectId);
  const key = operationKey(pair, "organize:" + punchOperationId(source.id));
  const firstResume = await baseStore.readResumeState();
  const failedCall = Object.values(firstResume.operations[key].calls).find((call) => call.phase === "failed");
  assert.ok(failedCall, "the retryable model failure is durable before the injected job write failure");
  assert.equal(failedCall.retryable, true);
  assert.equal(failedCall.partialDelivered, false);
  assert.ok(failedCall.turnId, "the journal proves that a host turn was actually sent");
  assert.equal((await baseStore.readPage(null, 100)).records[0].value.lastAttemptDate, null);
  await first.stop();
  await ports[0].cancel();

  const sameDate = makeWorker(baseStore, makePort());
  sameDate.start();
  await sameDate.idle();
  assert.equal(captureCalls.length, 1, "the durable failed send blocks a same-date new model request despite the missing job marker");
  assert.equal(counters.sent, 1);
  assert.equal((await baseStore.readPage(null, 100)).records[0].value.lastAttemptDate, null);

  const nextDay = new Date(clock);
  nextDay.setDate(nextDay.getDate() + 1);
  clock = nextDay.getTime();
  sameDate.wake();
  await sameDate.idle();
  assert.equal(captureCalls.length, 2, "the saved failure may be retried in the next local daily round");
  assert.equal(counters.sent, 2);
  const row = (await baseStore.readPage(null, 100)).records[0].value;
  const nextDate = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, "0")}-${String(nextDay.getDate()).padStart(2, "0")}`;
  assert.equal(row.lastAttemptDate, nextDate);
  assert.equal(row.state, "pending");
  assert.equal(counters.opened, 1);
  assert.equal(counters.resumed, 1);
});

test("same-day reply-ready storage recovery retries the Cairn commit without another model send", async (t) => {
  const h = rig(t); h.enable();
  const operationId = "organize:" + punchOperationId("reply-ready");
  const source = punch({ id: "reply-ready" });
  const actor = { agentId: source.agentId, projectId: source.projectId, sessionId: source.sessionId, providerId: source.providerId };
  const pair = pairKey(actor.agentId, actor.projectId);
  const key = operationKey(pair, operationId);
  const replyJson = '{"items":[]}';
  const requestSha256 = "b".repeat(64);
  const callKey = sha256(key + "|extract|" + requestSha256 + "|0");
  let captures = 0;
  let sends = 0;
  const first = h.create({ capture: async () => {
    captures += 1;
    sends += 1;
    await h.store.transactResumeState((state) => ({
      ...state,
      operations: {
        ...state.operations,
        [key]: {
          operationKey: key, pairKey: pair, operationId, agentId: actor.agentId, projectId: actor.projectId,
          updatedAt: Date.now(),
          calls: {
            [callKey]: {
              callKey, operationKey: key, pairKey: pair, modelOperation: "extract",
              operationSystemSha256: "a".repeat(64), requestSha256, occurrence: 0,
              hostSessionId: "host-session", turnId: "turn", sequenceNo: 1, phase: "reply_ready",
              retryable: false, partialDelivered: false, hostErrorCode: null,
              replyJson, replySha256: sha256(replyJson), responseBytes: Buffer.byteLength(replyJson),
              createdAt: Date.now(), updatedAt: Date.now(),
            },
          },
        },
      },
    }));
    return { ok: false, error: { code: "STORAGE_BUSY", retryable: true } };
  } });
  await first.enqueue(source, "raw-memory");
  first.start(); await first.idle(); await first.stop();
  assert.equal((await h.store.readPage(null, 100)).records[0].value.errorPhase, "commit");
  assert.equal(Object.values((await h.store.readResumeState()).operations[key].calls)[0].phase, "commit_retry");
  const retry = h.create({ capture: async () => { captures += 1; return ok({ classification: { status: "skipped" } }); } });
  retry.start(); await retry.idle();
  const row = (await h.store.readPage(null, 100)).records[0].value;
  assert.equal(captures, 2);
  assert.equal(sends, 1);
  assert.equal(row.state, "completed");
  assert.equal(row.outcome, "empty_success");
  assert.equal(retry.status().completed, 1);
});
test("seven-day unresolved recovery stays stored and visible for operator reconciliation instead of resending", async (t) => {
  const h = rig(t); h.enable();
  const roundAt = new Date(2026, 0, 10, 3).getTime();
  h.setNow(roundAt);
  const source = punch({ id: "old-unresolved" });
  const jobStore = h.store;
  await jobStore.enqueueJob(source.id, {
    version: 1, punchId: source.id, memoryId: "raw", actor: { agentId: source.agentId, projectId: source.projectId, sessionId: source.sessionId, providerId: source.providerId },
    input: { scope: "project", operationId: "organize:" + punchOperationId(source.id), messages: buildPunchSourceMessages(source) },
    state: "pending", attempts: 1, nextAttemptAt: 0, lastError: null, lastAttemptDate: null,
  }, "work-record", source.id);
  const actor = { agentId: source.agentId, projectId: source.projectId };
  const pair = pairKey(actor.agentId, actor.projectId);
  const operationId = "organize:" + punchOperationId(source.id);
  const operation = operationKey(pair, operationId);
  const requestSha256 = "c".repeat(64);
  const callKey = sha256(operation + "|extract|" + requestSha256 + "|0");
  const replyJson = '{"items":[]}';
  const staleAt = roundAt - 8 * 24 * 60 * 60_000;
  await jobStore.transactResumeState((state) => ({
    ...state,
    operations: {
      ...state.operations,
      [operation]: {
        operationKey: operation, pairKey: pair, operationId, agentId: actor.agentId, projectId: actor.projectId, updatedAt: staleAt,
        calls: {
          [callKey]: {
            callKey, operationKey: operation, pairKey: pair, modelOperation: "extract", operationSystemSha256: "d".repeat(64),
            requestSha256, occurrence: 0, hostSessionId: "old-session", turnId: "old-turn", sequenceNo: 1,
            phase: "reply_ready", retryable: false, partialDelivered: false, hostErrorCode: null,
            replyJson, replySha256: sha256(replyJson), responseBytes: Buffer.byteLength(replyJson),
            createdAt: staleAt, updatedAt: staleAt,
          },
        },
      },
    },
  }));
  let sends = 0;
  const worker = h.create({ capture: async () => { sends += 1; return ok(); } });
  worker.start(); await worker.idle();
  const savedJob = (await jobStore.readPage(null, 100)).records.find((row) => row.key === source.id).value;
  assert.equal(sends, 0);
  assert.equal(savedJob.state, "pending");
  assert.equal(savedJob.input.messages.length, 2);
  assert.equal(worker.status().state, "paused");
  assert.equal(worker.status().errorPhase, "operator_reconcile");
  assert.equal(worker.status().lastError, "OPERATOR_RECONCILE");
  const savedReply = Object.values((await jobStore.readResumeState()).operations[operation].calls)[0].replyJson;
  assert.equal(savedReply, replyJson);
  await worker.stop();
});
test("an unknown optional resume version is preserved and fails closed before any model send", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-organize-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = punch({ id: "future-version" });
  const job = {
    version: 1, punchId: source.id, memoryId: "raw", actor: { agentId: source.agentId, projectId: source.projectId, sessionId: source.sessionId, providerId: source.providerId },
    input: { scope: "project", operationId: "organize:" + punchOperationId(source.id), messages: buildPunchSourceMessages(source) },
    state: "pending", attempts: 0, nextAttemptAt: 0, lastError: null, queueSequence: 1, resumeDisposition: "eligible",
  };
  writeFileSync(join(dir, "punch-organization.json"), JSON.stringify({
    version: 1, records: { [source.id]: { key: source.id, value: job, revision: 1 } },
    organizationClaims: { version: 1, dates: [] }, organizationQueueSequence: 1,
    organizationResume: { version: 99, preserved: true },
  }));
  const store = createLocalPunchOrganizationStore(dir);
  let sends = 0;
  const worker = createPunchOrganizationWorker({ store, enabled: () => true, now: () => new Date(2026, 0, 11, 3).getTime(), capture: async () => { sends += 1; return ok(); } });
  worker.start(); await worker.idle();
  assert.equal(sends, 0);
  assert.equal(worker.status().state, "error");
  assert.equal((await store.readPage(null, 100)).records[0].value.state, "pending");
  const persisted = JSON.parse(readFileSync(join(dir, "punch-organization.json"), "utf8"));
  assert.deepEqual(persisted.organizationResume, { version: 99, preserved: true });
  await worker.stop();
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
test("a persisted v1 legacy job keeps its exact input and is excluded from automatic model sends", async (t) => {
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
  const first = createPunchOrganizationWorker({ store, enabled: () => true, now: () => now, capture: async (call) => { calls.push(call); return { ok: false, error: { code: "MODEL_NOT_CONFIGURED", retryable: false } }; } });
  first.start(); await first.idle();
  assert.equal(calls.length, 0);
  const pending = (await store.readPage(null, 100)).records[0].value;
  assert.equal(pending.state, "pending");
  assert.equal(pending.resumeDisposition, "legacy_unlinked");
  assert.equal(JSON.stringify(pending.input), JSON.stringify(legacyInput));
  assert.equal(first.status().legacyUnlinked, 1);
  await first.stop();
  now = new Date(2026, 0, 2, 3).getTime();
  const second = createPunchOrganizationWorker({ store, enabled: () => true, now: () => now, capture: async (call) => { calls.push(call); return ok(); } });
  second.start(); await second.idle();
  assert.equal(calls.length, 0);
  assert.equal((await store.readPage(null, 100)).records[0].value.resumeDisposition, "legacy_unlinked");
  assert.deepEqual((await store.readPage(null, 100)).records[0].value.input, legacyInput);
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
      async getOptions() { return { providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }], defaultProviderId: "codex", quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 10000 } }; },
      async openSession() {
        let listener;
        return { sessionId: "host-session-1", effective: { providerId: "codex", modelId: "gpt-6-luna" }, turn: null, onEvent(next) { listener = next; return () => { listener = undefined; }; },
          async send({ text }) {
            aiCalls++;
            const envelope = JSON.parse(text);
            const input = envelope.input;
            const answer = input.messages ? { items: [{ content: "Use a synthetic fixture for every upgrade.", kind: "decision", confidence: 0.9, sourceIndices: [0, 1] }] } : { items: input.memories.map((memory) => ({ memoryId: memory.id, parentIds: [], newL1: { title: "Upgrade testing", parentL2Ids: [] } })) };
            listener({ turnId: "t", kind: "textDelta", text: JSON.stringify(answer) }); listener({ turnId: "t", kind: "contentSaved", sequenceNo: aiCalls }); listener({ turnId: "t", kind: "completed" }); return { turnId: "t" };
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
  assert.equal(h.closed, 1);
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
  assert.equal(h.aiCalls, 2); assert.equal(h.closed, 1);
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

test("R-AC06-002 multi-stage crash recovery replays saved prefix without same-day resend and retries next local day", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-daily-multistage-resume-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = new Date(2026, 0, 1, 3, 0, 0).getTime();
  const actualDateNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = actualDateNow; });
  const localDateOf = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const localDate = localDateOf(new Date(now));
  const baseStore = createLocalPunchOrganizationStore(dir);
  const sourceId = "r3-multistage-reply-ready-failed-suffix";
  let failJobDateWrite = true;
  const store = {
    ...baseStore,
    async writeBatch(records) {
      if (failJobDateWrite && records.some((record) => record.key === sourceId
        && record.value?.state === "pending" && record.value?.attempts === 1 && record.value?.lastAttemptDate === localDate)) {
        failJobDateWrite = false;
        throw new Error("SYNTHETIC_INTERRUPT after durable failed-stage journal, before job/date write");
      }
      return baseStore.writeBatch(records);
    },
  };
  const who = { agentId: "sw/r3-multistage", projectId: "r3-multistage-project", sessionId: "synthetic-task", providerId: "mock" };
  const counters = { sends: 0, discoveries: 0, opens: 0 };
  const sendStages = [];
  let listener;
  const session = {
    sessionId: "r3-multistage-session",
    effective: { providerId: "codex", modelId: "gpt-6-luna", effort: null },
    turn: null,
    onEvent(next) { listener = next; return () => { if (listener === next) listener = undefined; }; },
    async send({ text }) {
      const envelope = JSON.parse(text);
      counters.sends += 1;
      const sendNumber = counters.sends;
      const turnId = `r3-multistage-turn-${sendNumber}`;
      sendStages.push({ operation: envelope.operation, turnId, localDate: localDateOf(new Date(Date.now())) });
      queueMicrotask(() => {
        if (sendNumber === 2) {
          listener?.({ turnId, kind: "failed", code: "provider_error", retryable: true, fallbackUsed: false, partialDelivered: false });
          return;
        }
        const body = JSON.stringify({ items: [] });
        session.turn = { turnId, text: body, terminal: { kind: "completed" } };
        listener?.({ turnId, kind: "textDelta", text: body });
        listener?.({ turnId, kind: "contentSaved", sequenceNo: sendNumber });
        listener?.({ turnId, kind: "completed" });
      });
      return { turnId };
    },
    async close() {},
    async interrupt() {},
  };
  const ai = {
    async getOptions() {
      counters.discoveries += 1;
      return {
        providers: [{ id: "codex", state: "ready", models: [{ id: "gpt-6-luna", isDefault: true }] }],
        defaultProviderId: "codex", capabilities: { closedSessionResume: true }, quota: { state: "ok" },
        limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 },
      };
    },
    async openSession() { counters.opens += 1; return session; },
  };
  const port = createHostMemoryModelPort(ai, () => readOrganizationSettings({ organizationEnabled: true }), 1_000, undefined, baseStore);
  const modelAdapter = createCairnModelAdapter(who.agentId, port);
  const syntheticCore = {
    async capture() {
      await modelAdapter.extract({ system: "synthetic extract schema", input: { stage: "extract" }, maxOutputTokens: 1_024, signal: new AbortController().signal });
      await modelAdapter.classify({ system: "synthetic classify schema", input: { stage: "classify" }, maxOutputTokens: 1_024, signal: new AbortController().signal });
      return { ok: true, value: { classification: { status: "skipped" } } };
    },
    close() {},
  };
  const pool = new CoreHandlePool({
    layout: { agentDbPath: (agentId) => join(dir, `${agentId.replaceAll("/", "_")}.synthetic`) },
    openCore: () => syntheticCore,
    now: () => now,
  });
  const app = new MemoryApplication(pool);
  let captureCalls = 0;
  const captureAllowModelSend = [];
  const createWorker = () => createPunchOrganizationWorker({
    store,
    enabled: () => true,
    frequency: () => "daily",
    dailyTime: () => "00:00",
    now: () => now,
    capture: async (job) => {
      captureCalls += 1;
      captureAllowModelSend.push(job.allowModelSend ?? true);
      try {
        return await app.execute("memory_capture", job.input, job.actor, undefined, job.allowModelSend ?? true);
      } finally {
        await port.releasePair(job.actor.agentId, job.actor.projectId).catch(() => undefined);
      }
    },
  });

  const source = punch({ id: sourceId, ...who });
  const firstWorker = createWorker();
  let recoveryWorker;
  try {
    await firstWorker.enqueue(source, "synthetic-multistage-source");
    firstWorker.start();
    await firstWorker.idle();
    const rowBeforeRestart = (await baseStore.readPage(null, 20)).records.find((record) => record.key === sourceId).value;
    const operation = operationKey(pairKey(who.agentId, who.projectId), rowBeforeRestart.input.operationId);
    const callsBeforeRestart = Object.values((await baseStore.readResumeState()).operations[operation]?.calls ?? {});
    const firstExtract = callsBeforeRestart.find((call) => call.modelOperation === "extract");
    const firstClassify = callsBeforeRestart.find((call) => call.modelOperation === "classify");
    await firstWorker.stop();

    recoveryWorker = createWorker();
    recoveryWorker.start();
    await recoveryWorker.idle();
    const rowAfterSameDay = (await baseStore.readPage(null, 20)).records.find((record) => record.key === sourceId).value;
    const callsAfterSameDay = Object.values((await baseStore.readResumeState()).operations[operation]?.calls ?? {});
    const sameDaySends = counters.sends;
    const sameDaySendStages = sendStages.map((item) => item.operation);
    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    now = nextDay.getTime();
    recoveryWorker.wake();
    await recoveryWorker.idle();
    const finalRow = (await baseStore.readPage(null, 20)).records.find((record) => record.key === sourceId).value;
    const callsAfterNextDay = Object.values((await baseStore.readResumeState()).operations[operation]?.calls ?? {});
    const afterExtract = callsAfterSameDay.find((call) => call.modelOperation === "extract");
    const afterClassify = callsAfterSameDay.find((call) => call.modelOperation === "classify");
    const observation = {
      probe: "R-AC06-002 multi-stage reply_ready prefix plus retryable failed suffix",
      productionPath: "organization worker -> MemoryApplication.execute -> Cairn model adapter -> host model port",
      environment: "synthetic in-memory core and host; no real app/provider/model or user data",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      clockSource: "worker now and host journal Date.now share one patched clock",
      localDate,
      firstAttempt: {
        jobLastAttemptDate: rowBeforeRestart.lastAttemptDate,
        extractPhase: firstExtract?.phase,
        classifyPhase: firstClassify?.phase,
        classifyRetryable: firstClassify?.retryable,
        classifyTurnId: firstClassify?.turnId,
        classifyUpdatedAtLocalDate: localDateOf(new Date(firstClassify.updatedAt)),
        captures: 1,
        sendStages: sendStages.slice(0, 2).map((item) => item.operation),
      },
      sameDateRestart: {
        captureAllowModelSend: captureAllowModelSend.slice(1, 2),
        extractReplyStillReady: afterExtract?.phase === "reply_ready" && afterExtract.replyJson !== null,
        classifyPhase: afterClassify?.phase,
        sendsAdded: sameDaySends - 2,
        sendStages: sameDaySendStages,
        rowLastAttemptDate: rowAfterSameDay.lastAttemptDate,
      },
      nextDateRetry: {
        localDate: localDateOf(new Date(now)),
        allowModelSend: captureAllowModelSend[2],
        sendsAdded: counters.sends - sameDaySends,
        sendStages: sendStages.map((item) => item.operation),
        finalState: finalRow.state,
        classifyPhases: callsAfterNextDay.filter((call) => call.modelOperation === "classify").map((call) => call.phase),
      },
      captures: captureCalls,
      sends: counters.sends,
    };
    assert.equal(rowBeforeRestart.lastAttemptDate, null, JSON.stringify(observation));
    assert.equal(firstExtract?.phase, "reply_ready", JSON.stringify(observation));
    assert.ok(firstExtract?.replyJson, JSON.stringify(observation));
    assert.equal(firstClassify?.phase, "failed", JSON.stringify(observation));
    assert.equal(firstClassify?.retryable, true, JSON.stringify(observation));
    assert.equal(firstClassify?.partialDelivered, false, JSON.stringify(observation));
    assert.ok(firstClassify?.turnId, JSON.stringify(observation));
    assert.equal(localDateOf(new Date(firstClassify.updatedAt)), localDate, JSON.stringify(observation));
    assert.equal(captureAllowModelSend[0], true, JSON.stringify(observation));
    assert.equal(captureAllowModelSend[1], false, JSON.stringify(observation));
    assert.equal(afterExtract?.phase, "reply_ready", JSON.stringify(observation));
    assert.ok(afterExtract?.replyJson, JSON.stringify(observation));
    assert.equal(sameDaySends, 2, JSON.stringify(observation));
    assert.deepEqual(sameDaySendStages, ["extract", "classify"], JSON.stringify(observation));
    assert.equal(rowAfterSameDay.lastAttemptDate, localDate, JSON.stringify(observation));
    assert.equal(captureAllowModelSend[2], true, JSON.stringify(observation));
    assert.equal(counters.sends, 3, JSON.stringify(observation));
    assert.deepEqual(sendStages.map((item) => item.operation), ["extract", "classify", "classify"], JSON.stringify(observation));
    assert.equal(finalRow.state, "completed", JSON.stringify(observation));
    assert.equal(callsAfterNextDay.length, 0, JSON.stringify(observation));
    t.diagnostic(JSON.stringify(observation));
  } finally {
    await firstWorker.stop();
    if (recoveryWorker !== undefined) await recoveryWorker.stop();
    await app.close();
    await port.cancel();
  }
});
