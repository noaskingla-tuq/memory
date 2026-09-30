import type { UiStatus } from "../../contracts/uiContract.js";
import type { BackendClient, BackendResult } from "../api/backendClient.js";
import { EMPTY_HTML, html, mount, type MountTarget } from "../dom/html.js";
import { t } from "../i18n/index.js";
import { relativeTime } from "../i18n/relativeTime.js";

export const STATUS_POLL_MS = 30_000;

export interface StatusTarget extends MountTarget {
  dataset: { [name: string]: string | undefined };
}

export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface Visibility {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface StatusLineDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly target: StatusTarget;
  readonly now: () => number;
  readonly scheduler: Scheduler;
  readonly visibility: Visibility;
}

export interface StatusLine {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

function isStatus(value: unknown): value is UiStatus {
  const record = value as { ok?: unknown; version?: unknown; storage?: { status?: unknown } } | null;
  return typeof record === "object" && record !== null && record.ok === true && typeof record.version === "string" && typeof record.storage?.status === "string";
}

function writeText(status: UiStatus, nowMs: number): string {
  return status.lastWriteAt === null ? t("status.noWrite") : t("status.lastWrite", { ago: relativeTime(status.lastWriteAt, nowMs) });
}

// why: the container carries the overall state too, because the real-Electron harness and any outside probe read #status[data-state] rather than its children
function renderResult(target: StatusTarget, result: BackendResult, nowMs: number): void {
  if (result.ok && isStatus(result.value)) {
    const status = result.value;
    const ready = status.storage.status === "ready";
    target.dataset.state = ready ? "ok" : "warn";
    const detail = t("status.detail", { version: status.version, storage: status.storage.status });
    mount(target, html`<p class="state" data-state="${ready ? "ok" : "warn"}" title="${detail}">${ready ? t("status.ok") : t("status.storageTrouble")}${ready ? html`<span class="muted">・${writeText(status, nowMs)}</span>` : EMPTY_HTML}</p>`);
    return;
  }
  target.dataset.state = "error";
  if (result.ok) {
    mount(target, html`<p class="state" data-state="error">${t("status.malformed")}</p>`);
    return;
  }
  const retry = result.retryable ? html` <button type="button" class="btn" data-retry>${t("common.retry")}</button>` : EMPTY_HTML;
  mount(target, html`<p class="state" data-state="error"><strong>${result.message}</strong> <span>${result.action}</span>${retry}</p>`);
}

export function createStatusLine(deps: StatusLineDeps): StatusLine {
  let timer: unknown = null;
  let running = false;
  let unsubscribe: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let shown = false;

  function cancelTimer(): void {
    if (timer !== null) deps.scheduler.clear(timer);
    timer = null;
  }

  function schedule(): void {
    cancelTimer();
    if (running && deps.visibility.isVisible()) timer = deps.scheduler.set(() => void refresh(), STATUS_POLL_MS);
  }

  function refresh(): Promise<void> {
    if (inFlight !== null) return inFlight;
    if (!shown) {
      deps.target.dataset.state = "loading";
      mount(deps.target, html`<p class="state" data-state="loading">${t("status.loading")}</p>`);
    }
    inFlight = (async () => {
      const result = await deps.client.call("ui.status", {});
      inFlight = null;
      if (!result.ok && result.superseded) {
        schedule();
        return;
      }
      shown = true;
      renderResult(deps.target, result, deps.now());
      schedule();
    })();
    return inFlight;
  }

  return {
    start() {
      running = true;
      unsubscribe = deps.visibility.subscribe(() => {
        if (deps.visibility.isVisible()) void refresh();
        else cancelTimer();
      });
      void refresh();
    },
    stop() {
      running = false;
      cancelTimer();
      unsubscribe?.();
      unsubscribe = null;
    },
    refresh,
  };
}
