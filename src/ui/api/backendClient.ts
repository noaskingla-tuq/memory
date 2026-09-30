import type { UiMethodName } from "../../contracts/uiContract.js";

export type BackendResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const PLAIN_MESSAGES: Readonly<Record<string, string>> = {
  plugin_backend_unavailable: "記憶服務暫時沒有回應，請稍後再試。",
  plugin_backend_crashed: "記憶服務剛剛中斷，請稍後再試。",
  backend_invoke_timeout: "記憶服務回應太久，請稍後再試。",
  plugin_permission_denied: "這個畫面沒有讀取記憶的權限，請到「外掛」頁確認。",
  plugin_disabled: "記憶外掛目前是停用狀態，請到「外掛」頁啟用。",
  backend_method_not_allowed: "這個畫面要求的功能不在允許清單內。",
};

export function plainMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return PLAIN_MESSAGES[code] ?? "暫時無法讀取記憶狀態，請稍後再試。";
}

export async function callBackend(method: UiMethodName, params: Record<string, never>): Promise<BackendResult<unknown>> {
  try {
    return { ok: true, value: await window.tuqPlugin.backend.call(method, params) };
  } catch (error) {
    return { ok: false, message: plainMessage(error) };
  }
}
