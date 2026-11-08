import type { UiAgentRun } from "../../contracts/uiContract.js";
import type { ErrorDescription } from "../api/errors.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { t, type StringKey } from "../i18n/index.js";

export type AgentOrgPhase = "loading" | "ready";

export interface AgentOrgModel {
  readonly phase: AgentOrgPhase;
  readonly agentId: string;
  readonly pending: number;
  readonly run: UiAgentRun | null;
  readonly blocked: string | null;
  readonly busy: boolean;
  readonly notice: StringKey | null;
  readonly error: ErrorDescription | null;
  readonly waitingMs?: number | null;
  readonly syncing?: boolean;
  readonly pauseReason?: string | null;
  readonly stallCount?: number | null;
}

export const AGENT_ORG_ID = "space-org";
export const WAITING_WARN_MS = 270_000;

export type AgentOrgState = "loading" | "idle" | "running" | "stopping" | "completed" | "stopped";

export function agentOrgState(model: AgentOrgModel): AgentOrgState {
  if (model.phase === "loading") return "loading";
  return model.run === null ? "idle" : model.run.state;
}

const BLOCKED: Readonly<Record<string, StringKey>> = {
  disabled: "ao.blocked.disabled", running: "ao.blocked.running", other_running: "ao.blocked.other_running",
  no_candidates: "ao.blocked.no_candidates", not_running: "ao.blocked.not_running",
};

function counts(run: UiAgentRun): Record<string, number> {
  return { total: run.total, done: run.done, failed: run.failed, untried: run.untried, handled: run.done + run.failed };
}

function line(model: AgentOrgModel, state: AgentOrgState): string {
  const run = model.run;
  if (state === "loading") return t("ao.loading");
  // why: a run that cannot start yet must not read as 0 of N in progress
  if (model.syncing === true && (state === "running" || state === "idle")) return t("ao.syncing");
  if (run !== null && state === "running") return t("ao.running", counts(run));
  if (run !== null && state === "stopping") return t("ao.stopping", counts(run));
  if (run !== null && state === "completed") return t("ao.done", counts(run));
  if (run !== null && state === "stopped") return t("ao.stopped", counts(run));
  return model.pending === 0 ? t("ao.idle.none") : t("ao.idle", { n: model.pending });
}

function waitingLine(model: AgentOrgModel): SafeHtml {
  const ms = model.waitingMs ?? null;
  if (ms === null) return EMPTY_HTML;
  const n = Math.floor(ms / 1000);
  return ms > WAITING_WARN_MS
    ? html`<p class="ao-wait" data-ao-waiting="warn" role="status">${t("ao.waiting.long", { n })}</p>`
    : html`<p class="ao-wait" data-ao-waiting="normal" role="status">${t("ao.waiting", { n })}</p>`;
}

function note(model: AgentOrgModel, state: AgentOrgState): SafeHtml {
  const parts: SafeHtml[] = [];
  if (model.error !== null) parts.push(html`<p class="ao-note" data-ao-note="error">${model.error.message}${model.error.action}</p>`);
  else if (model.notice !== null) parts.push(html`<p class="ao-note" data-ao-note="notice">${t(model.notice)}</p>`);
  else if (model.blocked !== null && BLOCKED[model.blocked] !== undefined && state !== "running" && state !== "stopping") parts.push(html`<p class="ao-note" data-ao-note="blocked">${t(BLOCKED[model.blocked]!)}</p>`);
  if (model.pauseReason === "stall" && model.stallCount != null && state !== "running" && state !== "stopping") parts.push(html`<p class="ao-note" data-ao-note="stalled">${t("ao.stalled", { n: model.stallCount })}</p>`);
  if ((state === "completed" || state === "stopped") && model.run !== null && (model.run.failed > 0 || model.run.untried > 0)) parts.push(html`<p class="ao-note" data-ao-note="hint">${t("ao.failedHint")}</p>`);
  return parts.length === 0 ? EMPTY_HTML : html`${parts}`;
}

function actions(model: AgentOrgModel, state: AgentOrgState): SafeHtml {
  if (state === "loading") return EMPTY_HTML;
  if (state === "stopping" || state === "running" && model.busy) return html`<button type="button" class="btn" data-ao="stop" disabled>${t("ao.stop")}</button>`;
  if (state === "running") return html`<button type="button" class="btn" data-ao="stop">${t("ao.stop")}</button>`;
  const blocked = model.blocked === "disabled" || model.blocked === "other_running" || model.pending === 0;
  if (model.busy || blocked) return html`<button type="button" class="btn btn-primary" data-ao="run" disabled>${t("ao.run")}</button>`;
  return html`<button type="button" class="btn btn-primary" data-ao="run">${t("ao.run")}</button>`;
}

function meter(model: AgentOrgModel, state: AgentOrgState): SafeHtml {
  const run = model.run;
  if (run === null || state === "loading" || state === "idle" || model.syncing === true) return EMPTY_HTML;
  return html`<progress class="ao-progress" max="${run.total}" value="${run.done + run.failed}" aria-label="${t("ao.progress")}"></progress>`;
}

// why: the empty ao-slot keeps the place where the per-agent model and time settings go, so adding them later does not move the buttons
export function agentOrgSection(model: AgentOrgModel): SafeHtml {
  const state = agentOrgState(model);
  return html`<section class="card ao-card" aria-labelledby="ao-title" data-ao-state="${state}"><h3 id="ao-title">${t("ao.title")}</h3><p class="ao-line" role="status" aria-live="polite">${line(model, state)}</p>${meter(model, state)}${waitingLine(model)}${note(model, state)}<p class="ao-actions">${actions(model, state)}</p><div class="ao-slot" data-ao-slot="settings"></div></section>`;
}
