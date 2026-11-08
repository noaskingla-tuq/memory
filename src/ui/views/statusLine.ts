import type { UiStatus } from "../../contracts/uiContract.js";
import type { BackendClient, BackendResult } from "../api/backendClient.js";
import { EMPTY_HTML, html, mount, type MountTarget, type SafeHtml } from "../dom/html.js";
import { t } from "../i18n/index.js";
import { relativeTime } from "../i18n/relativeTime.js";
import { trialControls, trialDetails } from "./legacyTrial.js";

export const STATUS_POLL_MS = 30_000;

export interface StatusTarget extends MountTarget {
  dataset: { [name: string]: string | undefined };
  readonly ownerDocument?: { readonly activeElement: unknown } | null;
  querySelector?(selectors: string): unknown;
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
  toggle(): void;
  collapse(): void;
  expanded(): boolean;
}

const PANEL_ID = "status-panel";
const TOGGLE_SELECTOR = "[data-status-toggle]";

type Organization = NonNullable<UiStatus["organization"]>;

export const STATUS_WAITING_WARN_MS = 300_000;

function waitingText(organization: Organization): string {
  const ms = organization.waiting?.sinceMs;
  if (ms === undefined) return "";
  return t(ms > STATUS_WAITING_WARN_MS ? "status.organization.waitingLong" : "status.organization.waiting", { n: Math.floor(ms / 1000) });
}

interface StatusView {
  readonly state: "ok" | "warn" | "error";
  readonly content: SafeHtml;
  readonly expandable: boolean;
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
function failureReason(organization: Organization): string {
  if (organization.state !== "error" && organization.state !== "paused") return "";
  // why: a pause caused only by legacy jobs is not a failure and has nothing to explain
  if (organization.state === "paused" && organization.lastError == null && organization.errorPhase == null && organization.hostErrorCode == null && organization.localErrorCode == null) return "";
  const unknown = t("status.organization.unknown");
  const phase = clip(organization.errorPhase ?? unknown);
  // why: a code the plugin decided itself must not read as something the host reported
  if (organization.localErrorCode != null) return t("status.organization.reasonLocal", { phase, code: clip(organization.localErrorCode) });
  return t("status.organization.reason", { phase, code: clip(organization.hostErrorCode ?? unknown) });
}

// why: the compact line keeps the priority the full line always had: storage trouble, then the organization phase, then plain service health
function compactText(status: UiStatus, ready: boolean): string {
  const organization = status.organization;
  const parts = [ready ? (organization === undefined ? t("status.ok") : t(`status.organization.phase.${organization.state}`)) : t("status.storageTrouble").replace(/。$/u, "")];
  // why: a running trial is the one thing that must stay visible while the panel is folded
  if (organization?.trial?.state === "running") parts.push(t("trial.compact", { done: organization.trial.attempted, adopted: organization.trial.adopted }));
  if (organization?.waiting != null) parts.push(waitingText(organization));
  if (organization !== undefined && organization.legacyUnlinked > 0) parts.push(t("status.compact.legacy", { n: organization.legacyUnlinked }));
  return parts.join(" · ");
}

function frame(state: StatusView["state"], text: string, extra: SafeHtml, panel: SafeHtml | null, expanded: boolean): StatusView {
  const open = panel !== null && expanded;
  const label = open ? t("status.compact.collapse") : t("status.compact.expand");
  const toggle = panel === null ? EMPTY_HTML
    : html`<button type="button" class="status-toggle" data-status-toggle aria-expanded="${open ? "true" : "false"}" aria-controls="${PANEL_ID}" aria-label="${label}" title="${label}"><span aria-hidden="true">${open ? "▴" : "▾"}</span></button>`;
  const body = panel === null ? EMPTY_HTML
    : open ? html`<div id="${PANEL_ID}" class="status-panel">${panel}</div>` : html`<div id="${PANEL_ID}" class="status-panel" hidden>${panel}</div>`;
  return { state, expandable: panel !== null, content: html`<div class="status-compact"><p class="state" data-state="${state}" title="${text}"><span class="status-text">${text}</span></p>${extra}${toggle}</div>${body}` };
}

function organizationItems(organization: Organization): SafeHtml {
  const controls = trialControls(organization);
  const legacy = organization.legacyUnlinked > 0 ? html`${t("status.organization.legacy", { n: organization.legacyUnlinked })}` : EMPTY_HTML;
  const jobs = legacy.value === "" && controls === EMPTY_HTML ? EMPTY_HTML : html`<li class="muted">${legacy}${controls}</li>`;
  const skipped = organization.diagnosticsAvailable === true ? t("status.organization.skipped", { n: organization.schemaSkipped ?? 0 }) : t("status.organization.skippedUnknown");
  const summary = t("status.organization.summary", { admitted: organization.admitted ?? t("status.organization.unknown"), pending: organization.pending, replies: organization.replyReady, completed: organization.completed });
  const wait = organization.waiting == null ? EMPTY_HTML : html`<li data-waiting="${organization.waiting.sinceMs > STATUS_WAITING_WARN_MS ? "warn" : "normal"}">${waitingText(organization)}</li>`;
  return html`<li>${t(`status.organization.phase.${organization.state}`)}${failureReason(organization)}</li>${wait}<li class="muted">${summary}</li>${jobs}<li class="muted">${skipped}</li>`;
}

function organizationDetails(organization: Organization): SafeHtml {
  return html`<details class="organization-details">
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
          ${trialDetails(organization)}
        </dl>
      </details>`;
}

// why: the container carries the overall state too, because the real-Electron harness and any outside probe read #status[data-state] rather than its children
function viewOf(result: BackendResult, nowMs: number, expanded: boolean): StatusView {
  if (result.ok && isStatus(result.value)) {
    const status = result.value;
    const ready = status.storage.status === "ready";
    const organization = status.organization;
    const warn = !ready || organization?.state === "paused" || organization?.state === "error" || (organization?.waiting?.sinceMs ?? 0) > STATUS_WAITING_WARN_MS;
    const detail = t("status.detail", { version: status.version, storage: status.storage.status });
    const written = ready ? html`<li class="muted">${writeText(status, nowMs)}</li>` : EMPTY_HTML;
    const panel = html`<ul class="status-items"><li title="${detail}">${ready ? t("status.ok") : t("status.storageTrouble")}</li>${written}${organization === undefined ? EMPTY_HTML : organizationItems(organization)}</ul>${organization === undefined ? EMPTY_HTML : organizationDetails(organization)}`;
    return frame(warn ? "warn" : "ok", compactText(status, ready), EMPTY_HTML, panel, expanded);
  }
  if (result.ok) return frame("error", t("status.malformed"), EMPTY_HTML, null, false);
  const retry = result.retryable ? html`<button type="button" class="btn" data-retry>${t("common.retry")}</button>` : EMPTY_HTML;
  return frame("error", result.message, retry, html`<p class="status-advice">${result.action}</p>`, expanded);
}

export interface StatusToggleRoot {
  addEventListener(type: "click", listener: (event: { readonly target: unknown }) => void): void;
  addEventListener(type: "keydown", listener: (event: { readonly target: unknown; readonly key?: string }) => void): void;
}

function closestToggle(target: unknown): unknown {
  const candidate = target as { closest?: (selector: string) => unknown } | null;
  return typeof candidate?.closest === "function" ? candidate.closest(TOGGLE_SELECTOR) : null;
}

// why: a native button already answers Enter and Space with a click, so only the click and the Escape shortcut are bound here
export function bindStatusToggle(root: StatusToggleRoot, line: Pick<StatusLine, "toggle" | "collapse" | "expanded">): void {
  root.addEventListener("click", (event) => {
    if (closestToggle(event.target) !== null) line.toggle();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && line.expanded()) line.collapse();
  });
}

export function createStatusLine(deps: StatusLineDeps): StatusLine {
  let timer: unknown = null;
  let running = false;
  let unsubscribe: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let shown = false;
  let latest: BackendResult | null = null;
  let expanded = false;
  let expandable = false;
  let markup = "";

  function toggleButton(): { focus?: () => void } | null {
    const found = deps.target.querySelector?.(TOGGLE_SELECTOR);
    return typeof found === "object" && found !== null ? (found as { focus?: () => void }) : null;
  }

  // why: an unchanged redraw is skipped so open details, focus and the screen reader are left alone every 30 seconds, and a redraw that does happen puts focus back on the toggle
  function paint(content: SafeHtml): void {
    if (content.value === markup) return;
    const active = deps.target.ownerDocument?.activeElement ?? null;
    const refocus = active !== null && active === toggleButton();
    mount(deps.target, content);
    markup = content.value;
    if (refocus) toggleButton()?.focus?.();
  }

  function draw(): void {
    if (latest === null) return;
    const view = viewOf(latest, deps.now(), expanded);
    deps.target.dataset.state = view.state;
    expandable = view.expandable;
    paint(view.content);
  }

  function setExpanded(next: boolean): void {
    if (!expandable || expanded === next) return;
    expanded = next;
    draw();
    toggleButton()?.focus?.();
  }

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
      paint(html`<p class="state" data-state="loading">${t("status.loading")}</p>`);
    }
    inFlight = (async () => {
      const result = await deps.client.call("ui.status", {});
      inFlight = null;
      if (!result.ok && result.superseded) {
        schedule();
        return;
      }
      shown = true;
      latest = result;
      draw();
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
    toggle: () => setExpanded(!expanded),
    collapse: () => setExpanded(false),
    expanded: () => expanded,
  };
}
