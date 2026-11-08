import type { MemoryResult } from "../domain/errors.js";
import type { OrganizationResumeState } from "./punchDataPorts.js";
import { operationKey, pairKey } from "./modelInvocationScope.js";
import { isRecord, type Job } from "./organizationJobState.js";

export const MAX_CONTINUATIONS = 6;
export const PAIR_BLOCKED_LOCAL_CODE = "pair_blocked";

export interface CaptureOutcome {
  readonly code: string | null;
  readonly processing: boolean;
  readonly classificationFailed: boolean;
  readonly terminalOutcome: "committed" | "empty_success" | null;
}

// why: one reading of a capture result decides both the stored job state and whether the same job continues, so the two can never disagree
export function captureOutcome(result: MemoryResult<unknown>): CaptureOutcome {
  const value = result.ok ? result.value : null;
  const processing = isRecord(value) && value.processing === true;
  const classification = isRecord(value) && isRecord(value.classification) ? value.classification : undefined;
  const classificationFailed = classification?.status === "failed";
  const code = result.ok
    ? processing ? "RESOURCE_BUSY" : classificationFailed ? (isRecord(classification.error) && "code" in classification.error ? String(classification.error.code).toUpperCase() : "INTERNAL") : null
    : result.error.code;
  const terminalOutcome = code === null
    ? classification?.status === "skipped" || (isRecord(value) && value.emptySuccess === true) ? "empty_success" as const : "committed" as const
    : null;
  return { code, processing, classificationFailed, terminalOutcome };
}

export function isPairBlocked(result: MemoryResult<unknown>): boolean {
  return !result.ok && result.error.localCode === PAIR_BLOCKED_LOCAL_CODE;
}

// why: a saved reply is the only thing a retry can reuse, so the count of them is the one measure of progress inside a job
export function replyProgress(state: OrganizationResumeState | null, job: Job): number {
  if (state === null) return 0;
  const key = operationKey(pairKey(job.actor.agentId, job.actor.projectId), job.input.operationId);
  return Object.values(state.operations[key]?.calls ?? {}).filter((call) => call.replyJson !== null && ["reply_ready", "commit_retry"].includes(call.phase)).length;
}

export interface ContinuationDeps {
  readonly capture: () => Promise<MemoryResult<unknown>>;
  readonly readProgress: () => Promise<number>;
  readonly awaitPending: () => Promise<void>;
  readonly shouldStop: () => boolean;
}

// why: a model turn that outlives Cairn's 30 seconds finishes on its own and is cached, so the same job calls Cairn again for as long as each round saved something new
export async function captureWithContinuation(deps: ContinuationDeps): Promise<{ readonly result: MemoryResult<unknown>; readonly continuations: number }> {
  let seen = await deps.readProgress();
  let result = await deps.capture();
  let continuations = 0;
  while (continuations < MAX_CONTINUATIONS) {
    if (result.ok || captureOutcome(result).code !== "MODEL_TIMEOUT" || deps.shouldStop()) break;
    await deps.awaitPending();
    if (deps.shouldStop()) break;
    const now = await deps.readProgress();
    if (now <= seen) break;
    seen = now;
    continuations += 1;
    result = await deps.capture();
  }
  return { result, continuations };
}
