import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { punchOperationId } from "../out/application/punchContent.js";
import { legacyModelCallKey, operationKey, pairKey, sha256 } from "../out/application/modelInvocationScope.js";

export const FILE = "punch-organization.json";
export const ok = (value = {}) => ({ ok: true, value, requestId: "r" });
export const fail = (code, extra = {}) => ({ ok: false, error: { code, retryable: true, ...extra } });

// why: a job stored by 1.3.4 has no queueSequence and no resumeDisposition, so the store reads it back as legacy_unlinked
export function legacyJob(id, { agentId = "sw/a", projectId = "project", state = "pending", attempts = 0, lastError = null, messages = true, operationId } = {}) {
  const op = punchOperationId(id);
  return {
    version: 1, punchId: id, memoryId: "raw-" + id,
    actor: { agentId, projectId, sessionId: "s-" + id, providerId: "mock" },
    input: {
      scope: projectId === null ? "personal" : "project", operationId: operationId ?? `organize:${op}`,
      messages: messages ? [{ id: `${op}:request`, role: "user", content: "request " + id }, { id: `${op}:outcome`, role: "assistant", content: "outcome " + id }] : [],
    },
    state, attempts, nextAttemptAt: 0, lastError,
  };
}

export async function seed(store, jobs) {
  await store.writeBatch(jobs.map((job) => ({ key: job.punchId, value: job, expectedRevision: null, sourceKind: "work-record", sourceId: job.punchId })));
  await store.readPage(null, 100);
}

export async function addJournal(store, job) {
  const pair = pairKey(job.actor.agentId, job.actor.projectId);
  const operation = operationKey(pair, job.input.operationId);
  const requestSha256 = "a".repeat(64);
  const replyJson = '{"items":[]}';
  const callKey = legacyModelCallKey(operation, "extract", requestSha256, 0);
  await store.transactResumeState((state) => ({
    ...state,
    operations: { ...state.operations, [operation]: {
      operationKey: operation, pairKey: pair, operationId: job.input.operationId, agentId: job.actor.agentId, projectId: job.actor.projectId, updatedAt: Date.now(),
      calls: { [callKey]: {
        callKey, operationKey: operation, pairKey: pair, modelOperation: "extract", operationSystemSha256: "b".repeat(64), requestSha256, occurrence: 0,
        hostSessionId: "saved-session", turnId: "saved-turn", sequenceNo: 1, phase: "reply_ready", retryable: false, partialDelivered: false, hostErrorCode: null,
        replyJson, replySha256: sha256(replyJson), responseBytes: Buffer.byteLength(replyJson), createdAt: Date.now(), updatedAt: Date.now(),
      } },
    } },
  }));
}

export const readFile = (dir) => JSON.parse(readFileSync(join(dir, FILE), "utf8"));
export const rowsOf = async (store) => (await store.readPage(null, 100)).records;
export const rowOf = async (store, key) => (await rowsOf(store)).find((row) => row.key === key);
export const START = (count, requestId = "req-" + count + "-aaaaaa") => ({ action: "start", requestId, count });
export const STOP = { action: "stop", requestId: "req-stop-bbbbbb" };

export function storeRig(t) {
  const dir = mkdtempSync(join(tmpdir(), "memory-trial-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createLocalPunchOrganizationStore(dir) };
}

export function workerRig(t, overrides = {}) {
  const { dir, store } = storeRig(t);
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.stop(); });
  let enabled = true;
  let frequency = "daily";
  let now = new Date(2026, 0, 1, 1, 59).getTime();
  const calls = [];
  const create = (patch = {}) => {
    const worker = createPunchOrganizationWorker({
      store, enabled: () => enabled, frequency: () => frequency, dailyTime: () => "02:00", now: () => now,
      ...overrides, ...patch,
      capture: async (job) => { calls.push(job); return (patch.capture ?? overrides.capture ?? (async () => ok()))(job); },
    });
    workers.push(worker);
    return worker;
  };
  return {
    dir, store, create, calls,
    setEnabled: (value) => { enabled = value; }, setFrequency: (value) => { frequency = value; }, setNow: (value) => { now = value; },
    at: (day, hour, minute = 0) => { now = new Date(2026, 0, day, hour, minute).getTime(); },
  };
}
