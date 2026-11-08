import type { PluginBackendAiSessionV1 } from "@teamuq/plugin-sdk";
import type { OrganizationCallRecord, OrganizationResumeStorePort, OrganizationSessionRecord } from "../../application/punchDataPorts.js";

export interface CallRecoveryDeps {
  readonly resumeStore: OrganizationResumeStorePort;
  failCall(call: OrganizationCallRecord, fields: Partial<OrganizationCallRecord>): Promise<void>;
  persistSession(record: OrganizationSessionRecord): Promise<void>;
}

const UNRECOVERABLE = "reconciled_unrecoverable";
export const ROTATION_BLOCKED_LOCAL_CODE = "rotation_blocked";
const DEAD_SESSION = new Set<OrganizationSessionRecord["state"]>(["expired", "invalidated", "resume_unavailable"]);

// why: a sent call with a turn but no saved reply has no live owner once the pair lock is held, so it is the only shape that can strand a pair
export function isStrandedSent(call: OrganizationCallRecord | undefined): call is OrganizationCallRecord {
  return call !== undefined && call.phase === "sent" && call.turnId !== null && call.replyJson === null;
}

async function giveUp(deps: CallRecoveryDeps, call: OrganizationCallRecord, saved: OrganizationSessionRecord | undefined): Promise<true> {
  await deps.failCall(call, { retryable: true, partialDelivered: false, hostErrorCode: UNRECOVERABLE });
  if (saved !== undefined && saved.state !== "invalidated") await deps.persistSession({ ...saved, state: "invalidated" });
  return true;
}

async function savedSession(deps: CallRecoveryDeps, pair: string): Promise<{ saved: OrganizationSessionRecord | undefined; known: boolean }> {
  const state = await deps.resumeStore.readResumeState();
  return state === null ? { saved: undefined, known: false } : { saved: state.sessions[pair], known: true };
}

export async function reconcileBeforeSession(deps: CallRecoveryDeps, pair: string, call: OrganizationCallRecord): Promise<boolean> {
  const { saved, known } = await savedSession(deps, pair);
  if (!known) return false;
  if (saved === undefined || DEAD_SESSION.has(saved.state)) return giveUp(deps, call, saved);
  return false;
}

// why: getSession records session_not_found as expired before it throws, so the saved state is the only trace of that error left here
export async function reconcileAfterResumeError(deps: CallRecoveryDeps, pair: string, call: OrganizationCallRecord, error?: unknown): Promise<boolean> {
  const { saved } = await savedSession(deps, pair);
  if (saved !== undefined && saved.state === "expired") return giveUp(deps, call, saved);
  // why: a stranded call is the only thing holding back the rotation, and a rotation means its session is never resumed, so the call cannot be recovered
  return (error as { localCode?: unknown } | null)?.localCode === ROTATION_BLOCKED_LOCAL_CODE ? giveUp(deps, call, saved) : false;
}

export async function reconcileWithSession(deps: CallRecoveryDeps, pair: string, call: OrganizationCallRecord, session: PluginBackendAiSessionV1): Promise<boolean> {
  const turn = session.turn;
  const { saved } = await savedSession(deps, pair);
  if (turn === null || turn.turnId !== call.turnId) return giveUp(deps, call, saved);
  const terminal = turn.terminal;
  if (terminal?.kind === "failed") {
    await deps.failCall(call, { retryable: terminal.retryable, partialDelivered: false, hostErrorCode: terminal.code });
    return true;
  }
  if (terminal?.kind === "interrupted") {
    await deps.failCall(call, { retryable: true, partialDelivered: false, hostErrorCode: "interrupted" });
    return true;
  }
  if (terminal?.kind === "completed" && turn.text.length === 0) return giveUp(deps, call, saved);
  return false;
}
