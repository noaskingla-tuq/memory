import type { OrganizationDailyRound, OrganizationResumeState } from "./punchDataPorts.js";
import type { MemoryActor } from "../contracts/actor.js";
import type { MemoryCaptureInput } from "./toolContract.js";
import { operationKey, pairKey } from "./modelInvocationScope.js";
import type { OrganizationStatus } from "./punchOrganization.js";

export interface Job {
  readonly version: 1;
  readonly punchId: string;
  readonly memoryId: string;
  readonly actor: MemoryActor;
  readonly input: MemoryCaptureInput;
  readonly state: "pending" | "completed" | "skipped";
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly queueSequence?: number;
  readonly resumeDisposition?: "legacy_unlinked" | "eligible" | "resolved";
  readonly lastAttemptDate?: string | null;
  readonly lastAttemptAt?: number | null;
  readonly errorPhase?: string | null;
  readonly hostErrorCode?: string | null;
  readonly localErrorCode?: string | null;
  readonly retryable?: boolean | null;
  readonly partialDelivered?: boolean | null;
  readonly outcome?: "committed" | "empty_success" | "skipped" | null;
  readonly adoptedBatchId?: string;
  readonly adoptedAt?: number;
}

export function localRoundDate(at: number, configuredTime: string): { readonly date: string; readonly due: boolean } {
  const local = new Date(at);
  if (!Number.isFinite(local.getTime())) throw new Error("organization_clock_invalid");
  const date = String(local.getFullYear()).padStart(4, "0") + "-" + String(local.getMonth() + 1).padStart(2, "0") + "-" + String(local.getDate()).padStart(2, "0");
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(configuredTime) ? configuredTime : "02:00";
  const [hourText, minuteText] = time.split(":");
  const dueMinute = Number(hourText) * 60 + Number(minuteText);
  return { date, due: local.getHours() * 60 + local.getMinutes() >= dueMinute };
}

export function nextLocalDay(at: number): number {
  const next = new Date(at);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function replyReady(state: OrganizationResumeState | null, job: Job): boolean {
  if (state === null) return false;
  const pair = pairKey(job.actor.agentId, job.actor.projectId);
  const key = operationKey(pair, job.input.operationId);
  const operation = state.operations[key];
  return operation !== undefined && operation.operationKey === key && operation.pairKey === pair
    && operation.operationId === job.input.operationId && operation.agentId === job.actor.agentId && operation.projectId === job.actor.projectId
    && Object.values(operation.calls).some((call) => call.operationKey === key && call.pairKey === pair
      && call.replyJson !== null && ["reply_ready", "commit_retry"].includes(call.phase));
}

export function failedModelAttemptInRound(state: OrganizationResumeState | null, job: Job, date: string, dailyTime: string): boolean {
  if (state === null) return false;
  const pair = pairKey(job.actor.agentId, job.actor.projectId);
  const key = operationKey(pair, job.input.operationId);
  const operation = state.operations[key];
  if (operation === undefined || operation.operationKey !== key || operation.pairKey !== pair
    || operation.operationId !== job.input.operationId || operation.agentId !== job.actor.agentId || operation.projectId !== job.actor.projectId) return false;
  return Object.values(operation.calls).some((call) => call.operationKey === key && call.pairKey === pair
    && call.phase === "failed" && call.retryable && !call.partialDelivered && call.turnId !== null
    && localRoundDate(call.updatedAt, dailyTime).date === date);
}

// why: a code the plugin decided itself is not a host reply, so while it is set no older journal call may supply a host code
export function phaseOf(state: OrganizationResumeState | null, job: Job, at = Date.now(), attemptLocalCode?: string | null): { phase: string | null; journalPhase: string | null; hostCode: string | null; localCode: string | null; partial: boolean | null } {
  const localCode = (attemptLocalCode === undefined ? job.localErrorCode : attemptLocalCode) ?? null;
  if (state === null) return { phase: job.errorPhase ?? null, journalPhase: null, hostCode: localCode === null ? job.hostErrorCode ?? null : null, localCode, partial: job.partialDelivered ?? null };
  const key = operationKey(pairKey(job.actor.agentId, job.actor.projectId), job.input.operationId);
  const calls = Object.values(state.operations[key]?.calls ?? {}).sort((left, right) => right.updatedAt - left.updatedAt);
  const latest = calls[0];
  const commitRetry = job.lastError === "STORAGE_BUSY" && (latest?.phase === "reply_ready" || latest?.phase === "commit_retry");
  const expired = state.operations[key] !== undefined && at - state.operations[key].updatedAt >= 7 * 24 * 60 * 60_000
    && latest !== undefined && ["prepared", "sent", "reply_ready", "commit_retry", "send_unknown"].includes(latest.phase);
  return {
    phase: expired ? "operator_reconcile" : job.errorPhase ?? (commitRetry ? "commit" : null),
    journalPhase: latest?.phase ?? null,
    hostCode: localCode === null ? latest?.hostErrorCode ?? job.hostErrorCode ?? null : null,
    localCode,
    partial: latest?.partialDelivered ?? job.partialDelivered ?? null,
  };
}

export function dailyRoundStatus(date: string, round: OrganizationDailyRound): NonNullable<OrganizationStatus["dailyRound"]> {
  return {
    date, roundId: round.roundId, state: round.state === "superseded" ? "completed" : round.state, nextResumeAt: round.nextResumeAt,
    snapshotHighWatermark: round.snapshot.queueSequenceHighWatermark,
    snapshotMembers: round.snapshot.eligibleMemberCount,
    completedMembers: round.completedMembers,
    deferredMembers: round.deferredMembers,
  };
}
