import { classifyLegacyJob, pickRoundRobin } from "../../application/organizationTrial.js";
import type { OrganizationResumeState, OrganizationTrial, OrganizationTrialHaltReason, PunchStateRecord, TrialAdoption, TrialAdoptionRequest, TrialEnd } from "../../application/punchDataPorts.js";

type Records = Readonly<Record<string, PunchStateRecord>>;

const TRIAL_STATES = ["running", "completed", "halted", "stopped"];

function wholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validHalt(value: unknown): value is OrganizationTrialHaltReason | null {
  return value === null || (plain(value) && typeof value.code === "string" && textOrNull(value.phase) && textOrNull(value.hostCode) && textOrNull(value.localCode) && wholeNumber(value.consecutive));
}

// why: undefined means the file never held a trial; null means it held something that is not a valid trial, which the caller must treat as a corrupt file
export function parseTrial(value: unknown): OrganizationTrial | null | undefined {
  if (value === undefined) return undefined;
  if (!plain(value) || value.version !== 1 || typeof value.batchId !== "string" || value.batchId.length === 0 || typeof value.requestId !== "string"
    || !wholeNumber(value.requested) || !wholeNumber(value.adopted) || !wholeNumber(value.skippedAmbiguous) || !wholeNumber(value.startedAt)
    || !TRIAL_STATES.includes(String(value.state)) || !(value.endedAt === null || wholeNumber(value.endedAt)) || !validHalt(value.haltReason)) return null;
  return value as unknown as OrganizationTrial;
}

function classified(records: Records, resume: OrganizationResumeState) {
  const candidates: { readonly key: string; readonly agentId: string }[] = [];
  let ambiguous = 0;
  for (const record of Object.values(records)) {
    const kind = classifyLegacyJob(record.value, resume);
    if (kind === "ambiguous") ambiguous += 1;
    else if (kind === "candidate") candidates.push({ key: record.key, agentId: (record.value as { actor: { agentId: string } }).actor.agentId });
  }
  return { candidates, ambiguous };
}

export interface AdoptionPlan {
  readonly result: TrialAdoption;
  readonly write: null | { readonly records: Records; readonly sequence: number; readonly trial: OrganizationTrial };
}

// why: the whole decision is computed from one read and returned as one write, so a failed write leaves the file exactly as it was
export function planAdoption(input: { readonly records: Records; readonly resume: OrganizationResumeState; readonly trial: OrganizationTrial | null; readonly sequence: number }, request: TrialAdoptionRequest): AdoptionPlan {
  const { candidates, ambiguous } = classified(input.records, input.resume);
  if (input.trial !== null && input.trial.requestId === request.requestId) {
    return { result: { blocked: null, replayed: true, trial: input.trial, adopted: input.trial.adopted, candidates: candidates.length, skippedAmbiguous: input.trial.skippedAmbiguous }, write: null };
  }
  if (input.trial?.state === "running") return { result: { blocked: "trial_running", replayed: false, trial: input.trial, adopted: 0, candidates: candidates.length, skippedAmbiguous: ambiguous }, write: null };
  if (candidates.length === 0) return { result: { blocked: "no_candidates", replayed: false, trial: input.trial, adopted: 0, candidates: 0, skippedAmbiguous: ambiguous }, write: null };
  const picked = pickRoundRobin(candidates, request.count);
  const records: Record<string, PunchStateRecord> = { ...input.records };
  let sequence = input.sequence;
  for (const { key } of picked) {
    sequence += 1;
    const before = input.records[key]!;
    const value = { ...(before.value as Record<string, unknown>), queueSequence: sequence, resumeDisposition: "eligible", nextAttemptAt: 0, adoptedBatchId: request.batchId, adoptedAt: request.at };
    Object.defineProperty(records, key, { value: { ...before, value, revision: (before.revision ?? 0) + 1 }, enumerable: true, configurable: true, writable: true });
  }
  if (!Number.isSafeInteger(sequence)) throw new Error("organization_queue_sequence_invalid");
  const trial: OrganizationTrial = { version: 1, batchId: request.batchId, requestId: request.requestId, requested: request.count, adopted: picked.length, skippedAmbiguous: ambiguous, startedAt: request.at, state: "running", endedAt: null, haltReason: null };
  return { result: { blocked: null, replayed: false, trial, adopted: picked.length, candidates: candidates.length - picked.length, skippedAmbiguous: ambiguous }, write: { records, sequence, trial } };
}

function unadopted(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...value, resumeDisposition: "legacy_unlinked" };
  delete next.queueSequence;
  delete next.adoptedBatchId;
  delete next.adoptedAt;
  return next;
}

export interface RevertPlan {
  readonly records: Records;
  readonly reverted: number;
  readonly trial: OrganizationTrial;
}

// why: only jobs never sent go back to the legacy state; a job that was attempted keeps its batch so the counts still add up
export function planRevert(records: Records, trial: OrganizationTrial | null, batchId: string, end: TrialEnd): RevertPlan | null {
  if (trial === null || trial.batchId !== batchId || trial.state !== "running") return null;
  const next: Record<string, PunchStateRecord> = { ...records };
  let reverted = 0;
  for (const record of Object.values(records)) {
    const job = record.value;
    if (!plain(job) || job.state !== "pending" || job.adoptedBatchId !== batchId || job.attempts !== 0) continue;
    reverted += 1;
    Object.defineProperty(next, record.key, { value: { ...record, value: unadopted(job), revision: (record.revision ?? 0) + 1 }, enumerable: true, configurable: true, writable: true });
  }
  return { records: next, reverted, trial: { ...trial, state: end.state, endedAt: end.endedAt, haltReason: end.haltReason } };
}
