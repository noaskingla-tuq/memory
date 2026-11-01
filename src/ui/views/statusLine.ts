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

function detailTime(value: number | null): string {
  return value === null ? t("status.organization.unknown") : new Date(value).toISOString();
}

const HEADLINE_VALUE_LIMIT = 40;

// why: the host decides these strings and the schema gives them no length, so the one-line headline keeps only a bounded prefix
function clip(value: string): string {
  const characters = Array.from(value);
  return characters.length <= HEADLINE_VALUE_LIMIT ? value : characters.slice(0, HEADLINE_VALUE_LIMIT).join("") + "…";
}

// why: older or partial status payloads may omit the failure fields, so each falls back to the unknown label instead of printing undefined
function failureReason(organization: NonNullable<UiStatus["organization"]>): string {
  if (organization.state !== "error" && organization.state !== "paused") return "";
  // why: a pause caused only by legacy jobs is not a failure and has nothing to explain
  if (organization.state === "paused" && organization.lastError == null && organization.errorPhase == null && organization.hostErrorCode == null && organization.localErrorCode == null) return "";
  const unknown = t("status.organization.unknown");
  const phase = clip(organization.errorPhase ?? unknown);
  // why: a code the plugin decided itself must not read as something the host reported
  if (organization.localErrorCode != null) return t("status.organization.reasonLocal", { phase, code: clip(organization.localErrorCode) });
  return t("status.organization.reason", { phase, code: clip(organization.hostErrorCode ?? unknown) });
}

// why: the container carries the overall state too, because the real-Electron harness and any outside probe read #status[data-state] rather than its children
function renderResult(target: StatusTarget, result: BackendResult, nowMs: number): void {
  if (result.ok && isStatus(result.value)) {
    const status = result.value;
    const ready = status.storage.status === "ready";
    const organization = status.organization;
    const organizationState = organization?.state;
    const warn = !ready || organizationState === "paused" || organizationState === "error";
    target.dataset.state = warn ? "warn" : "ok";
    const detail = t("status.detail", { version: status.version, storage: status.storage.status });
    const organizationText = organization !== undefined ? html`
      <span class="muted">・${t(`status.organization.phase.${organization.state}`)}${failureReason(organization)}</span>
      <span class="muted">・${t("status.organization.summary", { admitted: organization.admitted ?? t("status.organization.unknown"), pending: organization.pending, replies: organization.replyReady, completed: organization.completed })}</span>
      ${organization.legacyUnlinked > 0 ? html`<span class="muted">・${t("status.organization.legacy", { n: organization.legacyUnlinked })}</span>` : EMPTY_HTML}
      <span class="muted">・${organization.diagnosticsAvailable === true ? t("status.organization.skipped", { n: organization.schemaSkipped ?? 0 }) : t("status.organization.skippedUnknown")}</span>
      <details class="organization-details">
        <summary>${t("status.organization.diagnostics")}</summary>
        <dl>
          <dt>${t("status.organization.phase")}</dt><dd>${organization.errorPhase ?? t("status.organization.unknown")}</dd>
          <dt>${t("status.organization.hostCode")}</dt><dd>${organization.hostErrorCode ?? t("status.organization.unknown")}</dd>
          <dt>${t("status.organization.localCode")}</dt><dd>${organization.localErrorCode ?? t("status.organization.unknown")}</dd>
          <dt>${t("status.organization.retry")}</dt><dd>${organization.retryable === null ? t("status.organization.unknown") : organization.retryable ? t("status.organization.yes") : t("status.organization.no")}</dd>
          <dt>${t("status.organization.partial")}</dt><dd>${organization.partialDelivered === null ? t("status.organization.unknown") : organization.partialDelivered ? t("status.organization.yes") : t("status.organization.no")}</dd>
          <dt>${t("status.organization.lastAttempt")}</dt><dd>${detailTime(organization.lastAttemptAt)}</dd>
          <dt>${t("status.organization.sourceSnapshot")}</dt><dd>${organization.sourceGeneration ?? t("status.organization.unknown")} · ${organization.sourceHighWatermark ?? t("status.organization.unknown")}</dd>
          <dt>${t("status.organization.sourceCounts")}</dt><dd>${t("status.organization.sourceCountsValue", {
            pages: organization.sourcePages ?? t("status.organization.unknown"), scanned: organization.sourceScanned ?? t("status.organization.unknown"),
            received: organization.sourceReceived ?? t("status.organization.unknown"), eligible: organization.sourceEligible ?? t("status.organization.unknown"),
            checkpointed: organization.sourceCheckpointed === null ? t("status.organization.unknown") : organization.sourceCheckpointed ? t("status.organization.yes") : t("status.organization.no"),
          })}</dd>
          <dt>${t("status.organization.dailyRound")}</dt><dd>${organization.dailyRound === null ? t("status.organization.unknown") : t("status.organization.dailyRoundValue", {
            date: organization.dailyRound.date, state: organization.dailyRound.state, members: organization.dailyRound.snapshotMembers,
            completed: organization.dailyRound.completedMembers, deferred: organization.dailyRound.deferredMembers,
            watermark: organization.dailyRound.snapshotHighWatermark,
          })}</dd>
          <dt>${t("status.organization.lastError")}</dt><dd>${organization.lastError ?? t("status.organization.unknown")}</dd>
        </dl>
      </details>` : EMPTY_HTML;
    mount(target, html`<p class="state" data-state="${warn ? "warn" : "ok"}" title="${detail}">${ready ? t("status.ok") : t("status.storageTrouble")}${ready ? html`<span class="muted">・${writeText(status, nowMs)}</span>` : EMPTY_HTML}${organizationText}</p>`);
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
