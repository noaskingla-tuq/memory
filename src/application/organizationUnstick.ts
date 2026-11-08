import type { OrganizationCallRecord, OrganizationOperationRecord, OrganizationResumeState, OrganizationResumeStorePort } from "./punchDataPorts.js";

export interface UnstickResult {
  readonly migrated: number;
  readonly sessionsInvalidated: number;
  readonly at: number;
}

export const MIGRATED_UNRECOVERABLE = "migrated_unrecoverable";

// why: this shape was only ever written by the removed local-deadline path, so it doubles as the once-only flag
export function isLocalDeadlineStrand(call: OrganizationCallRecord): boolean {
  return call.phase === "sent" && call.hostErrorCode === "local_deadline" && call.replyJson === null && call.sequenceNo === null && call.turnId !== null;
}

function countStranded(state: OrganizationResumeState): number {
  let count = 0;
  for (const operation of Object.values(state.operations)) for (const call of Object.values(operation.calls)) if (isLocalDeadlineStrand(call)) count += 1;
  return count;
}

function migrate(state: OrganizationResumeState): { state: OrganizationResumeState; migrated: number; sessionsInvalidated: number } {
  const operations: Record<string, OrganizationOperationRecord> = {};
  const sessions = { ...state.sessions };
  let migrated = 0;
  let sessionsInvalidated = 0;
  for (const [key, operation] of Object.entries(state.operations)) {
    let calls: Record<string, OrganizationCallRecord> | undefined;
    for (const [callKey, call] of Object.entries(operation.calls)) {
      if (!isLocalDeadlineStrand(call)) continue;
      // why: updatedAt must stay, or failedModelAttemptInRound would read it as a failure from today and skip the retry
      calls ??= { ...operation.calls };
      calls[callKey] = { ...call, phase: "failed", retryable: true, partialDelivered: false, hostErrorCode: MIGRATED_UNRECOVERABLE };
      migrated += 1;
      const saved = sessions[operation.pairKey];
      if (saved !== undefined && saved.pairKey === operation.pairKey && saved.hostSessionId === call.hostSessionId && saved.state !== "invalidated") {
        sessions[operation.pairKey] = { ...saved, state: "invalidated" };
        sessionsInvalidated += 1;
      }
    }
    operations[key] = calls === undefined ? operation : { ...operation, calls };
  }
  return { state: { ...state, sessions, operations }, migrated, sessionsInvalidated };
}

export async function unstickLocalDeadline(store: OrganizationResumeStorePort, now: number, backup?: () => void | Promise<void>): Promise<UnstickResult> {
  const current = await store.readResumeState();
  if (current === null || countStranded(current) === 0) return { migrated: 0, sessionsInvalidated: 0, at: now };
  await backup?.();
  let result = { migrated: 0, sessionsInvalidated: 0 };
  await store.transactResumeState((state) => {
    const next = migrate(state);
    result = { migrated: next.migrated, sessionsInvalidated: next.sessionsInvalidated };
    return next.migrated === 0 ? state : next.state;
  });
  return { ...result, at: now };
}
