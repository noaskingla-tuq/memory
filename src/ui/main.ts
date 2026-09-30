import type { UiStatus } from "../contracts/uiContract.js";
import { backendClient, type BackendResult } from "./api/backendClient.js";
import { html, mount } from "./dom/html.js";
import { t } from "./i18n/index.js";

function isStatus(value: unknown): value is UiStatus {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true && typeof (value as { version?: unknown }).version === "string" && typeof (value as { storage?: { status?: unknown } }).storage?.status === "string";
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

function lastWriteText(lastWriteAt: string | null): string {
  if (lastWriteAt === null) return t("status.noWrite");
  const at = new Date(lastWriteAt);
  return t("status.lastWrite", { time: Number.isNaN(at.getTime()) ? lastWriteAt : at.toLocaleString("zh-TW", { hour12: false }) });
}

// why: the container carries the overall state too, because the real-Electron harness and any outside probe read #status[data-state] rather than its children
function renderStatus(target: HTMLElement, result: BackendResult): void {
  target.dataset.state = result.ok && isStatus(result.value) ? "ok" : "error";
  if (result.ok && isStatus(result.value)) {
    mount(target, html`<p class="state" data-state="ok">${t("status.ok", { version: result.value.version, storage: result.value.storage.status })}</p><p>${lastWriteText(result.value.lastWriteAt)}</p>`);
    return;
  }
  if (result.ok) {
    mount(target, html`<p class="state" data-state="error">${t("status.malformed")}</p>`);
    return;
  }
  const retry = result.retryable ? html` <button type="button" class="btn" data-retry>${t("common.retry")}</button>` : "";
  mount(target, html`<p class="state" data-state="error"><strong>${result.message}</strong> <span>${result.action}</span>${retry}</p>`);
}

async function showStatus(): Promise<void> {
  const target = element("status");
  target.dataset.state = "loading";
  mount(target, html`<p class="state" data-state="loading">${t("status.loading")}</p>`);
  renderStatus(target, await backendClient().call("ui.status", {}));
}

element("title").textContent = t("app.title");
element("status").addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-retry]") !== null) void showStatus();
});
void showStatus();
