import type { UiFailureCode } from "../../contracts/uiContract.js";
import { t, type StringKey } from "../i18n/index.js";

export const PLATFORM_CODES = [
  "plugin_disabled",
  "plugin_backend_unavailable",
  "plugin_backend_crashed",
  "backend_invoke_timeout",
  "plugin_permission_denied",
  "plugin_not_installed",
  "backend_invoke_too_large",
  "backend_method_not_allowed",
  "backend_invoke_invalid",
] as const;

export const PLUGIN_CODES = [
  "STORAGE_BUSY",
  "RESOURCE_BUSY",
  "REVISION_CONFLICT",
  "NOT_FOUND",
  "INVALID_CURSOR",
  "CURSOR_STALE",
  "INVALID_PARAMS",
  "STORAGE_UNSUPPORTED",
  "STORAGE_UNSAFE",
  "NOT_IMPLEMENTED",
  "MEMORY_SUPPRESSED",
  "INTERNAL",
  "unknown_method",
  "invalid_params",
  "result_too_large",
  "internal",
] as const;

export const CLIENT_CODES = ["superseded", "malformed_response", "unknown"] as const;

export type PlatformCode = (typeof PLATFORM_CODES)[number];
export type PluginCode = (typeof PLUGIN_CODES)[number];
export type ClientCode = (typeof CLIENT_CODES)[number];
export type KnownCode = PlatformCode | PluginCode | ClientCode;

// why: a code added to UI_FAILURE_CODES that has no plain-language entry here fails tsc -p tsconfig.ui.json instead of reaching users as "unknown"
export const UI_FAILURE_CODES_COVERED: [Exclude<UiFailureCode, PluginCode>] extends [never] ? true : never = true;

export type ActionKind = "retry" | "wait" | "narrow" | "reload" | "restartList" | "openPlugins" | "updatePlugin" | "report" | "none";

export type ErrorSource = "platform" | "plugin" | "client";

const ACTIONS: Readonly<Record<KnownCode, { readonly kind: ActionKind; readonly retryable: boolean }>> = {
  plugin_disabled: { kind: "openPlugins", retryable: false },
  plugin_backend_unavailable: { kind: "retry", retryable: true },
  plugin_backend_crashed: { kind: "retry", retryable: true },
  backend_invoke_timeout: { kind: "narrow", retryable: true },
  plugin_permission_denied: { kind: "openPlugins", retryable: false },
  plugin_not_installed: { kind: "openPlugins", retryable: false },
  backend_invoke_too_large: { kind: "narrow", retryable: false },
  backend_method_not_allowed: { kind: "updatePlugin", retryable: false },
  backend_invoke_invalid: { kind: "reload", retryable: false },
  STORAGE_BUSY: { kind: "wait", retryable: true },
  RESOURCE_BUSY: { kind: "wait", retryable: true },
  REVISION_CONFLICT: { kind: "reload", retryable: false },
  NOT_FOUND: { kind: "reload", retryable: false },
  INVALID_CURSOR: { kind: "restartList", retryable: false },
  CURSOR_STALE: { kind: "restartList", retryable: false },
  INVALID_PARAMS: { kind: "report", retryable: false },
  STORAGE_UNSUPPORTED: { kind: "updatePlugin", retryable: false },
  STORAGE_UNSAFE: { kind: "report", retryable: false },
  NOT_IMPLEMENTED: { kind: "none", retryable: false },
  MEMORY_SUPPRESSED: { kind: "none", retryable: false },
  INTERNAL: { kind: "retry", retryable: true },
  unknown_method: { kind: "updatePlugin", retryable: false },
  invalid_params: { kind: "report", retryable: false },
  result_too_large: { kind: "narrow", retryable: false },
  internal: { kind: "retry", retryable: true },
  superseded: { kind: "none", retryable: false },
  malformed_response: { kind: "retry", retryable: true },
  unknown: { kind: "retry", retryable: true },
};

export interface ErrorDescription {
  readonly code: string;
  readonly known: boolean;
  readonly source: ErrorSource;
  readonly message: string;
  readonly action: string;
  readonly actionKind: ActionKind;
  readonly retryable: boolean;
}

const KNOWN_CODES: readonly KnownCode[] = [...PLATFORM_CODES, ...PLUGIN_CODES, ...CLIENT_CODES];
const LONGEST_FIRST = [...KNOWN_CODES].sort((left, right) => right.length - left.length);

export function isKnownCode(code: string): code is KnownCode {
  return (KNOWN_CODES as readonly string[]).includes(code);
}

function sourceOf(code: KnownCode): ErrorSource {
  if ((PLATFORM_CODES as readonly string[]).includes(code)) return "platform";
  return (PLUGIN_CODES as readonly string[]).includes(code) ? "plugin" : "client";
}

export function describeError(code: string, source?: ErrorSource): ErrorDescription {
  const known = isKnownCode(code);
  const key: KnownCode = known ? code : "unknown";
  const entry = ACTIONS[key];
  return {
    code,
    known,
    source: source ?? (known ? sourceOf(code) : "client"),
    message: t(`error.${key}.message` as StringKey),
    action: t(`error.${key}.action` as StringKey),
    actionKind: entry.kind,
    retryable: entry.retryable,
  };
}

// why: Electron wraps an ipc rejection as "Error invoking remote method '...': Error: <code>", so the code is searched for inside the message instead of compared whole
export function codeFromThrown(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const found = LONGEST_FIRST.find((code) => raw.includes(code));
  return found ?? "unknown";
}

export function isCursorReset(code: string): boolean {
  return ACTIONS[isKnownCode(code) ? code : "unknown"].kind === "restartList";
}
