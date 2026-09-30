import type { UiStatus } from "../contracts/uiContract.js";
import { callBackend } from "./api/backendClient.js";

function isStatus(value: unknown): value is UiStatus {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true && typeof (value as { version?: unknown }).version === "string";
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

async function showStatus(): Promise<void> {
  const target = element("status");
  const result = await callBackend("ui.status", {});
  if (!result.ok) {
    target.dataset.state = "error";
    target.textContent = result.message;
    return;
  }
  if (!isStatus(result.value)) {
    target.dataset.state = "error";
    target.textContent = "記憶服務回傳了看不懂的內容，請稍後再試。";
    return;
  }
  target.dataset.state = "ok";
  target.textContent = `記憶服務運作中（版本 ${result.value.version}，儲存狀態 ${result.value.storage.status}）`;
}

element("title").textContent = "記憶";
void showStatus();
