const PLAIN = Object.freeze({
  capability_request_invalid: "請求的格式不對：欄位缺少、型別錯誤或多了不認得的欄位。",
  session_not_found: "這條連線上沒有開啟的語音工作，請重新連線。",
  message_too_large: "送來的訊息太大，請縮小內容。",
  data_too_large: "送來的資料太大，請分段送。",
  rate_limited: "呼叫得太頻繁了，請稍後再試。",
  capability_busy: "現在忙不過來，請稍後再試。",
  provider_not_ready: "工具還在準備中，請稍後再試。",
  provider_error: "工具發生預料之外的問題，暫時無法使用。",
  not_configured: "工具還沒設定完成，請先到它的設定頁完成設定。",
  auth_failed: "帳號或金鑰驗證失敗，請檢查後再試。",
  quota_exceeded: "使用額度用完了。",
  network_unreachable: "連不上這個工具使用的服務，請檢查網路後再試。",
  unsupported_options: "這個工具不支援你要求的選項。",
  not_supported: "這個工具沒有提供這個功能。",
  job_not_found: "找不到這個工作：它不存在、已經過期，或不是你的。",
  job_cancelled: "工作已被取消。",
  provider_lost: "工具在工作進行中停止了，請重新送出。",
  content_refused: "這個內容工具無法處理。",
  blob_not_found: "找不到這個檔案：它不存在、已經過期，或不是你的。",
  blob_too_large: "檔案太大，或工具的暫存空間已滿。",
} as const);

export type ProviderErrorCode = keyof typeof PLAIN;

export const PROVIDER_ERROR_CODES: readonly ProviderErrorCode[] = Object.freeze(Object.keys(PLAIN) as ProviderErrorCode[]);

export function plain(code: string): string {
  return Object.hasOwn(PLAIN, code) ? PLAIN[code as ProviderErrorCode] : PLAIN.provider_error;
}

export interface ProviderRefusal extends Error {
  readonly code: ProviderErrorCode;
  readonly retryAfterMs?: number;
}

export function refuse(code: string, details: { readonly retryAfterMs?: number } = {}): ProviderRefusal {
  const known: ProviderErrorCode = Object.hasOwn(PLAIN, code) ? (code as ProviderErrorCode) : "provider_error";
  return Object.assign(new Error(plain(known)), details, { code: known });
}
