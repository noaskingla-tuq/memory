import type { UiStatus } from "../../contracts/uiContract.js";
import type { BackendClient } from "../api/backendClient.js";
import { openDialog, type DialogHandle } from "../components/dialog.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { t, type StringKey } from "../i18n/index.js";

type Organization = NonNullable<UiStatus["organization"]>;
type Trial = NonNullable<Organization["trial"]>;

export const TRIAL_CHOICES = [5, 20, 50] as const;

const unknown = (): string => t("status.organization.unknown");

function progress(key: StringKey, trial: Trial): string {
  return t(key, { done: trial.attempted, adopted: trial.adopted, committed: trial.committed, empty: trial.emptySuccess, failed: trial.failed });
}

// why: these controls sit in the always-visible line, not inside <details>, because the status line is redrawn every 30 seconds and a redraw closes the details
export function trialControls(organization: Organization): SafeHtml {
  const trial = organization.trial ?? null;
  if (trial?.state === "running") {
    return html`<span class="trial-controls"><span class="muted">・${progress("trial.running", trial)}</span><button type="button" class="btn" data-trial="stop">${t("trial.stop")}</button></span>`;
  }
  const halted = trial?.state === "halted" ? html`<span class="muted">・${progress("trial.ended.halted", trial)}</span>` : EMPTY_HTML;
  const open = (organization.legacyTrialCandidates ?? 0) > 0 && organization.state !== "disabled"
    ? html`<button type="button" class="btn" data-trial="open" data-trial-n="${organization.legacyUnlinked}">${t("trial.open")}</button>` : EMPTY_HTML;
  return html`<span class="trial-controls">${halted}${open}</span>`;
}

export function trialDetails(organization: Organization): SafeHtml {
  const trial = organization.trial ?? null;
  if (trial === null) return EMPTY_HTML;
  const halt = trial.haltReason === null ? EMPTY_HTML : html`<dt>${t("trial.details.halt")}</dt><dd>${t("trial.details.haltValue", { code: trial.haltReason.code, phase: trial.haltReason.phase ?? unknown(), n: trial.haltReason.consecutive })}</dd>`;
  const failures = trial.failures.length === 0 ? EMPTY_HTML : html`<dt>${t("trial.details.failures")}</dt><dd>${trial.failures.map((group) => html`<span>${t("trial.details.failureLine", { code: group.code, phase: group.phase ?? unknown(), host: group.hostCode ?? unknown(), local: group.localCode ?? unknown(), count: group.count })}</span><br>`)}</dd>`;
  return html`<dt>${t("trial.details.last")}</dt><dd>${progress(trial.state === "running" ? "trial.running" : `trial.ended.${trial.state}`, trial)}</dd>${halt}${failures}`;
}

export interface TrialClickRoot {
  addEventListener(type: "click", listener: (event: { readonly target: unknown }) => void): void;
}

export interface LegacyTrialDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly refresh: () => Promise<void>;
  readonly background?: () => HTMLElement | null;
  readonly document?: Document;
  readonly newRequestId?: () => string;
}

interface Hit {
  readonly dataset: { readonly trial?: string | undefined; readonly trialN?: string | undefined };
}

function closest(target: unknown, selector: string): Hit | null {
  const candidate = target as { closest?: (selector: string) => Hit | null } | null;
  return typeof candidate?.closest === "function" ? candidate.closest(selector) : null;
}

const defaultRequestId = (): string => `trial-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const BLOCKED: Readonly<Record<string, StringKey>> = {
  disabled: "trial.blocked.disabled", trial_running: "trial.blocked.trial_running", no_candidates: "trial.blocked.no_candidates", not_running: "trial.blocked.not_running",
};

function outcomeText(value: unknown): string {
  const answer = value as { ok?: unknown; action?: unknown; adopted?: unknown; blocked?: unknown } | null;
  if (typeof answer !== "object" || answer === null || answer.ok !== true) return t("trial.unreadable");
  if (typeof answer.blocked === "string") return BLOCKED[answer.blocked] === undefined ? t("trial.unreadable") : t(BLOCKED[answer.blocked]!);
  return answer.action === "stop" ? t("trial.result.stopping") : t("trial.result.started", { n: typeof answer.adopted === "number" ? answer.adopted : 0 });
}

export function bindLegacyTrial(root: TrialClickRoot, deps: LegacyTrialDeps): void {
  let busy = false;
  const newId = deps.newRequestId ?? defaultRequestId;
  const show = (title: string, body: SafeHtml, actions: Parameters<typeof openDialog>[0]["actions"], initialFocus: string): DialogHandle | null => {
    try { return openDialog({ title, body, actions, initialFocus, background: deps.background?.() ?? null, ...(deps.document === undefined ? {} : { document: deps.document }) }); } catch { return null; }
  };
  const tell = async (text: string): Promise<void> => {
    const handle = show(t("trial.result.title"), html`<p>${text}</p>`, [{ id: "ok", label: t("trial.result.ok"), kind: "primary" }], "ok");
    if (handle !== null) await handle.result;
  };
  const send = async (params: { readonly [key: string]: string | number }): Promise<void> => {
    const result = await deps.client.call("ui.legacyTrial", params);
    await deps.refresh();
    await tell(result.ok ? outcomeText(result.value) : `${result.message}${result.action}`);
  };
  const choose = async (legacy: number): Promise<void> => {
    const body = html`<p>${t("trial.dialog.intro", { n: legacy })}</p><p>${t("trial.dialog.cost")}</p><p>${t("trial.dialog.safety")}</p>`;
    const actions = [{ id: "cancel", label: t("trial.dialog.cancel") }, ...TRIAL_CHOICES.map((n) => ({ id: `start-${n}`, label: t("trial.dialog.start", { n }), kind: "primary" as const }))];
    const handle = show(t("trial.dialog.title"), body, actions, "cancel");
    if (handle === null) return;
    const { action } = await handle.result;
    const count = TRIAL_CHOICES.find((n) => action === `start-${n}`);
    if (count !== undefined) await send({ action: "start", requestId: newId(), count });
  };
  root.addEventListener("click", (event) => {
    const hit = closest(event.target, "[data-trial]");
    if (hit === null || busy) return;
    busy = true;
    const work = hit.dataset.trial === "stop" ? send({ action: "stop", requestId: newId() }) : hit.dataset.trial === "open" ? choose(Number(hit.dataset.trialN ?? 0)) : Promise.resolve();
    void work.catch(() => undefined).finally(() => { busy = false; });
  });
}
