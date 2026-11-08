import { MemoryServiceError } from "../../domain/errors.js";
import { sha256 } from "../../application/modelInvocationScope.js";
import type { OrganizationCallRecord } from "../../application/punchDataPorts.js";

export function parseCached(call: OrganizationCallRecord): unknown {
  if (call.replyJson === null) throw new MemoryServiceError("RESOURCE_BUSY", "A previous memory turn requires reconciliation", undefined, "session_resume");
  if (typeof call.hostSessionId !== "string" || call.hostSessionId.length === 0 || typeof call.turnId !== "string" || call.turnId.length === 0
    || !(call.sequenceNo === null || Number.isSafeInteger(call.sequenceNo))) throw new MemoryServiceError("RESOURCE_BUSY", "Saved memory model reply is not linked to a completed turn", undefined, "session_resume");
  if (Buffer.byteLength(call.replyJson, "utf8") !== call.responseBytes || sha256(call.replyJson) !== call.replySha256) {
    throw new MemoryServiceError("STORAGE_BUSY", "Saved memory recovery state failed integrity validation", false, "state");
  }
  try { return JSON.parse(call.replyJson); }
  catch { throw new MemoryServiceError("MODEL_OUTPUT_INVALID", "Saved memory model reply is invalid", false, "reply_contract"); }
}

export function parseReply(text: string): unknown {
  const fence = String.fromCharCode(96).repeat(3);
  const json = text.trim().replace(new RegExp("^" + fence + "(?:json)?\s*\n([\s\S]*?)\n" + fence + "$", "u"), "$1");
  try { return JSON.parse(json); }
  catch { throw new MemoryServiceError("MODEL_OUTPUT_INVALID", "Memory model returned invalid JSON", false, "reply_contract"); }
}
