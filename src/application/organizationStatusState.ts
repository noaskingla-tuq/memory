import type { Job } from "./organizationJobState.js";

export type PauseReason = "stall" | "model_not_configured" | "model_policy_denied" | "operator_reconcile";

// why: only these stop a pass for a reason the user has to act on; an old RESOURCE_BUSY or a legacy job never stops one, so neither is a pause
const BLOCKING: Readonly<Record<string, PauseReason>> = {
  MODEL_NOT_CONFIGURED: "model_not_configured",
  MODEL_POLICY_DENIED: "model_policy_denied",
  OPERATOR_RECONCILE: "operator_reconcile",
};

export function blockingReasonOf(code: string | null): PauseReason | null {
  return code === null ? null : BLOCKING[code] ?? null;
}

// why: the first blocking job decides, wherever it sits in the queue, so an old error in front of it cannot hide it
export function findBlockingCode(pending: ReadonlyArray<{ readonly job: Job }>, operatorReconcile: boolean): string | null {
  if (operatorReconcile) return "OPERATOR_RECONCILE";
  return pending.find(({ job }) => job.resumeDisposition !== "legacy_unlinked" && blockingReasonOf(job.lastError) !== null)?.job.lastError ?? null;
}

export function deriveState(enabled: boolean, blockingCode: string | null, errorCode: string | null): { readonly state: "disabled" | "idle" | "paused" | "error"; readonly pauseReason: PauseReason | null } {
  if (!enabled) return { state: "disabled", pauseReason: null };
  const reason = blockingReasonOf(blockingCode);
  if (reason !== null) return { state: "paused", pauseReason: reason };
  // why: RESOURCE_BUSY from an earlier attempt is retried by itself, so it stays a plain note (lastError) and not a state
  return { state: errorCode !== null && errorCode !== "RESOURCE_BUSY" ? "error" : "idle", pauseReason: null };
}
