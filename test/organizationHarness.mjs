import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPunchOrganizationStore } from "../out/adapters/storage/punchStateStore.js";
import { createPunchOrganizationWorker } from "../out/application/punchOrganization.js";
import { modelCallKey, operationKey, pairKey, sha256 } from "../out/application/modelInvocationScope.js";

export const punch = (overrides = {}) => ({
  id: "p", agentId: "sw/a", projectId: "project", sessionId: "s", providerId: "mock", model: "allowed", punchType: "main",
  startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Remember a project decision",
  description: JSON.stringify({ root: { children: [{ type: "text", text: "Use a synthetic fixture for every upgrade." }] } }), ...overrides,
});
export const ok = (value = {}) => ({ ok: true, value, requestId: "r" });
export const timeout = (localCode = "detached_running") => ({ ok: false, error: { code: "MODEL_TIMEOUT", message: "timeout", retryable: true, requestId: "r", phase: "turn_timeout", localCode } });
export const failed = (code, localCode) => ({ ok: false, error: { code, message: code, retryable: true, requestId: "r", ...(localCode === undefined ? {} : { localCode }) } });
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function workerRig(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "memory-queue-"));
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.stop(); rmSync(dir, { recursive: true, force: true }); });
  const store = createLocalPunchOrganizationStore(dir);
  const state = { enabled: true, frequency: "immediate", dailyTime: "02:00", now: new Date(2026, 0, 1, 3).getTime() };
  const calls = [];
  const create = (patch = {}) => {
    const worker = createPunchOrganizationWorker({
      store, enabled: () => state.enabled, frequency: () => state.frequency, dailyTime: () => state.dailyTime, now: () => state.now,
      capture: async (job) => { calls.push(job.punchId); return ok(); }, ...overrides, ...patch,
    });
    workers.push(worker);
    return worker;
  };
  const rows = async () => Object.fromEntries((await store.readPage(null, 100)).records.map((row) => [row.key, row.value]));
  return { dir, store, state, calls, create, rows };
}

export async function addReply(store, job, number) {
  const pair = pairKey(job.actor.agentId, job.actor.projectId);
  const key = operationKey(pair, job.input.operationId);
  const callKey = modelCallKey(key, "extract", "a".repeat(64), "b".repeat(64), number);
  const replyJson = '{"items":[]}';
  await store.transactResumeState((resume) => {
    const operation = resume.operations[key] ?? { operationKey: key, pairKey: pair, operationId: job.input.operationId, agentId: job.actor.agentId, projectId: job.actor.projectId, calls: {}, updatedAt: Date.now() };
    const call = {
      callKey, callKeyVersion: 2, operationKey: key, pairKey: pair, modelOperation: "extract", operationSystemSha256: "a".repeat(64), requestSha256: "b".repeat(64),
      occurrence: number, hostSessionId: "s", turnId: "t" + number, sequenceNo: number, phase: "reply_ready", retryable: false, partialDelivered: false,
      hostErrorCode: null, replyJson, replySha256: sha256(replyJson), responseBytes: Buffer.byteLength(replyJson), createdAt: Date.now(), updatedAt: Date.now(),
    };
    return { ...resume, operations: { ...resume.operations, [key]: { ...operation, calls: { ...operation.calls, [callKey]: call }, updatedAt: Date.now() } } };
  });
}
