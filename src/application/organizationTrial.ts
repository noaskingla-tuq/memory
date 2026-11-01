import { memoryActorSchema } from "../../vendor/teamuq-contract/contract.mjs";
import { isRecord, type Job } from "./organizationJobState.js";
import { operationKey, pairKey } from "./modelInvocationScope.js";
import { punchOperationId } from "./punchContent.js";
import type { OrganizationResumeState, OrganizationTrial, OrganizationTrialHaltReason } from "./punchDataPorts.js";
import { memoryCaptureSchema } from "./toolContract.js";

export const TRIAL_FAILURE_STREAK = 3;
const TRIAL_FAILURE_GROUPS = 5;
const HARD_CODES: ReadonlySet<string> = new Set(["MODEL_NOT_CONFIGURED", "MODEL_POLICY_DENIED"]);
const HARD_PHASES: ReadonlySet<string> = new Set(["quota", "policy", "task_binding"]);

export type LegacyClass = "candidate" | "ambiguous" | "none";

export interface TrialFailureGroup {
  readonly code: string;
  readonly phase: string | null;
  readonly hostCode: string | null;
  readonly localCode: string | null;
  readonly count: number;
}

export interface TrialSummary {
  readonly batchId: string;
  readonly state: OrganizationTrial["state"];
  readonly requested: number;
  readonly adopted: number;
  readonly attempted: number;
  readonly committed: number;
  readonly emptySuccess: number;
  readonly skipped: number;
  readonly failed: number;
  readonly untried: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly haltReason: OrganizationTrialHaltReason | null;
  readonly failures: TrialFailureGroup[];
}

export type LegacyTrialRequest =
  | { readonly action: "start"; readonly requestId: string; readonly count: number }
  | { readonly action: "stop"; readonly requestId: string };

export interface LegacyTrialResponse {
  readonly action: "start" | "stop";
  readonly requested: number;
  readonly adopted: number;
  readonly candidates: number;
  readonly skippedAmbiguous: number;
  readonly blocked: null | "disabled" | "trial_running" | "no_candidates" | "not_running";
  readonly trial: TrialSummary | null;
}

interface JobRow { readonly job: Job }

// why: a legacy job is only safe to adopt if no model call could ever have been made for it, so every sign of an earlier send excludes it
export function classifyLegacyJob(value: unknown, resume: OrganizationResumeState): LegacyClass {
  if (!isRecord(value) || value.state !== "pending" || value.resumeDisposition !== "legacy_unlinked" || value.attempts !== 0 || value.lastError !== null) return "none";
  const { actor, input, punchId, memoryId } = value;
  if (typeof punchId !== "string" || typeof memoryId !== "string" || memoryId.length === 0 || !memoryActorSchema.safeParse(actor).success || !isRecord(input)) return "none";
  const owner = actor as { agentId: string; projectId: string | null };
  if (input.operationId !== "organize:" + punchOperationId(punchId) || input.scope !== (owner.projectId === null ? "personal" : "project")) return "none";
  if (!Array.isArray(input.messages) || input.messages.length === 0 || !memoryCaptureSchema.safeParse(input).success) return "none";
  return resume.operations[operationKey(pairKey(owner.agentId, owner.projectId), input.operationId as string)] === undefined ? "candidate" : "ambiguous";
}

// why: taking one job per agent in turn lets a small trial reach several host sessions, and sorting keeps the choice repeatable
export function pickRoundRobin<T extends { readonly agentId: string; readonly key: string }>(items: readonly T[], count: number): T[] {
  const queues = new Map<string, T[]>();
  for (const item of [...items].sort((left, right) => left.key.localeCompare(right.key))) {
    const queue = queues.get(item.agentId);
    if (queue === undefined) queues.set(item.agentId, [item]);
    else queue.push(item);
  }
  const agents = [...queues.keys()].sort();
  const picked: T[] = [];
  while (picked.length < count && agents.some((agent) => queues.get(agent)!.length > 0)) {
    for (const agent of agents) {
      const next = queues.get(agent)!.shift();
      if (next !== undefined && picked.length < count) picked.push(next);
    }
  }
  return picked;
}

export function isTrialRow(job: Job, batchId: string | null): boolean {
  return batchId !== null && job.state === "pending" && job.adoptedBatchId === batchId && job.attempts === 0;
}

const isFailure = (job: Job): boolean => job.state === "pending" && job.attempts > 0 && job.lastError !== null;

function groupFailures(rows: readonly JobRow[]): TrialFailureGroup[] {
  const groups = new Map<string, TrialFailureGroup>();
  for (const { job } of rows) {
    if (!isFailure(job)) continue;
    const group = { code: job.lastError!, phase: job.errorPhase ?? null, hostCode: job.hostErrorCode ?? null, localCode: job.localErrorCode ?? null };
    const key = JSON.stringify(group);
    groups.set(key, { ...group, count: (groups.get(key)?.count ?? 0) + 1 });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count).slice(0, TRIAL_FAILURE_GROUPS);
}

// why: every count comes from the job rows, so a restart or a later daily retry changes the numbers without any extra state to keep in step
export function summarizeTrial(trial: OrganizationTrial, rows: readonly JobRow[]): TrialSummary {
  const own = rows.filter(({ job }) => job.adoptedBatchId === trial.batchId);
  const untried = own.filter(({ job }) => job.state === "pending" && job.attempts === 0).length;
  const committed = own.filter(({ job }) => job.state === "completed" && job.outcome !== "empty_success").length;
  const emptySuccess = own.filter(({ job }) => job.state === "completed" && job.outcome === "empty_success").length;
  const skipped = own.filter(({ job }) => job.state === "skipped").length;
  const failed = own.filter(({ job }) => isFailure(job)).length;
  return {
    batchId: trial.batchId, state: trial.state, requested: trial.requested, adopted: trial.adopted,
    attempted: committed + emptySuccess + skipped + failed, committed, emptySuccess, skipped, failed, untried,
    startedAt: trial.startedAt, endedAt: trial.endedAt, haltReason: trial.haltReason, failures: groupFailures(own),
  };
}

function reasonOf(job: Job, consecutive: number): OrganizationTrialHaltReason {
  return { code: job.lastError ?? "UNKNOWN", phase: job.errorPhase ?? null, hostCode: job.hostErrorCode ?? null, localCode: job.localErrorCode ?? null, consecutive };
}

// why: the breaker reads the job rows only, so it holds after a restart; completed work resets the streak and a skipped job neither counts nor resets
export function trialBreaker(rows: readonly JobRow[], batchId: string): OrganizationTrialHaltReason | null {
  const tried = rows.filter(({ job }) => job.adoptedBatchId === batchId && job.attempts > 0 && job.lastAttemptAt != null)
    .sort((left, right) => right.job.lastAttemptAt! - left.job.lastAttemptAt! || (right.job.queueSequence ?? 0) - (left.job.queueSequence ?? 0));
  const hard = tried.find(({ job }) => isFailure(job) && (HARD_CODES.has(job.lastError!) || HARD_PHASES.has(job.errorPhase ?? "")));
  if (hard !== undefined) return reasonOf(hard.job, 1);
  let streak = 0;
  let newest: Job | undefined;
  for (const { job } of tried) {
    if (job.state === "completed") break;
    if (!isFailure(job)) continue;
    streak += 1;
    newest ??= job;
  }
  return streak >= TRIAL_FAILURE_STREAK && newest !== undefined ? reasonOf(newest, streak) : null;
}
