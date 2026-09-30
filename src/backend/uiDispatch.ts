import { UI_METHOD_NAMES, type UiFailure, type UiMethodName, type UiStatus } from "../contracts/uiContract.js";
import { CAIRN_COMMIT } from "../adapters/storage/dataLayout.js";
import { jsonSafe } from "../application/ui/jsonSafe.js";
import { PLUGIN_VERSION } from "./diagnose.js";

export interface UiDispatchDeps {
  readonly storageStatus: () => string;
}

export function isUiMethod(method: unknown): method is UiMethodName {
  return typeof method === "string" && (UI_METHOD_NAMES as readonly string[]).includes(method);
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: UiFailure["code"]): UiFailure {
  return { ok: false, code, retryable: false };
}

function status(deps: UiDispatchDeps): UiStatus {
  return {
    ok: true,
    stub: true,
    version: PLUGIN_VERSION,
    cairnCommit: CAIRN_COMMIT,
    storage: { status: deps.storageStatus() },
    profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null },
    lastWriteAt: null,
    uptimeSec: Math.round(process.uptime()),
  };
}

export function dispatchUi(method: UiMethodName, params: unknown, deps: UiDispatchDeps): unknown {
  if (!isPlainObject(params)) return jsonSafe(failure("INVALID_PARAMS"));
  if (method === "ui.status") return jsonSafe(status(deps));
  return jsonSafe(failure("NOT_IMPLEMENTED"));
}
