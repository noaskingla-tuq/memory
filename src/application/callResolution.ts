import type { OrganizationCallRecord } from "./punchDataPorts.js";

export const JSON_PARSE_CODE = "json_parse";
// why: these codes mean the model finished a reply that is unusable, so no turn is left to recover and no later send could differ
export const FINAL_OUTPUT_CODES: readonly string[] = [JSON_PARSE_CODE, "reply_too_long", "empty_reply"];
const IN_FLIGHT_PHASES: readonly string[] = ["prepared", "sent", "reply_ready", "commit_retry", "send_unknown"];

export const isFinalOutputFailure = (call: OrganizationCallRecord): boolean =>
  call.phase === "failed" && !call.retryable && call.hostErrorCode !== null && FINAL_OUTPUT_CODES.includes(call.hostErrorCode);

// why: a call that blocks its pair is one that may still own a host turn or a reply; a final output failure only stays behind as a record
export const needsRecovery = (call: OrganizationCallRecord): boolean =>
  IN_FLIGHT_PHASES.includes(call.phase) || call.phase === "failed" && !(call.retryable && !call.partialDelivered) && !isFinalOutputFailure(call);
