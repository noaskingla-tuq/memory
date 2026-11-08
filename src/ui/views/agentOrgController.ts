import type { UiAgentRun } from "../../contracts/uiContract.js";
import type { BackendClient } from "../api/backendClient.js";
import { describeError } from "../api/errors.js";
import { openDialog } from "../components/dialog.js";
import { html, mount, type MountTarget } from "../dom/html.js";
import { t, type StringKey } from "../i18n/index.js";
import { agentOrgSection, type AgentOrgModel } from "./agentOrgView.js";
import type { Scheduler, Visibility } from "./statusLine.js";

export const AGENT_ORG_POLL_MS = 5_000;
export const AGENT_ORG_REQUEST_KEY = "agentOrg";

export interface AgentOrgDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly scheduler: Scheduler;
  readonly visibility: Visibility;
  readonly background?: () => HTMLElement | null;
  readonly document?: Document;
}

export interface AgentOrg {
  attach(target: MountTarget | null, agentId?: string): Promise<void>;
  refresh(): Promise<void>;
  run(): Promise<void>;
  stop(): Promise<void>;
  model(): AgentOrgModel;
}

const BLANK: AgentOrgModel = { phase: "loading", agentId: "", pending: 0, run: null, blocked: null, busy: false, notice: null, error: null };

function parse(value: unknown): { pending: number; blocked: string | null; run: UiAgentRun | null } | null {
  const answer = value as { ok?: unknown; pending?: unknown; blocked?: unknown; run?: unknown } | null;
  if (typeof answer !== "object" || answer === null || answer.ok !== true || typeof answer.pending !== "number") return null;
  const run = answer.run;
  const valid = run === null || (typeof run === "object" && run !== undefined && typeof (run as { state?: unknown }).state === "string");
  if (!valid) return null;
  return { pending: answer.pending, blocked: typeof answer.blocked === "string" ? answer.blocked : null, run: run as UiAgentRun | null };
}

export function createAgentOrg(deps: AgentOrgDeps): AgentOrg {
  let target: MountTarget | null = null;
  let state: AgentOrgModel = BLANK;
  let generation = 0;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const render = (): void => { if (target !== null) mount(target, agentOrgSection(state)); };
  const stopTimer = (): void => { if (timer !== null) { deps.scheduler.clear(timer); timer = null; } };
  const active = (): boolean => state.run?.state === "running" || state.run?.state === "stopping";
  // why: the poll only runs while a run is live and the page is visible, so an idle or hidden page asks the backend for nothing
  const schedule = (): void => {
    stopTimer();
    if (target === null || !active() || !deps.visibility.isVisible()) return;
    timer = deps.scheduler.set(() => { timer = null; void refresh(); }, AGENT_ORG_POLL_MS);
  };

  async function ask(params: { readonly [key: string]: string }, notice: StringKey | null): Promise<void> {
    generation += 1;
    const mine = generation;
    const agentId = state.agentId;
    state = { ...state, busy: true };
    render();
    const result = await deps.client.call("ui.agentOrganization", params, { key: AGENT_ORG_REQUEST_KEY });
    if (mine !== generation || target === null || state.agentId !== agentId) return;
    if (!result.ok) {
      if (!result.superseded) state = { ...state, phase: "ready", busy: false, error: result };
      render();
      return;
    }
    const answer = parse(result.value);
    state = answer === null
      ? { ...state, phase: "ready", busy: false, error: describeError("malformed_response", "client") }
      : { phase: "ready", agentId, pending: answer.pending, blocked: answer.blocked, run: answer.run, busy: false, notice: answer.blocked === null ? notice : null, error: null };
    render();
    schedule();
  }

  async function refresh(): Promise<void> {
    if (target === null || state.agentId === "") return;
    await ask({ action: "status", agentId: state.agentId }, null);
  }

  async function confirm(): Promise<boolean> {
    const body = html`<p>${t("ao.dialog.intro", { n: state.pending })}</p><p>${t("ao.dialog.cost")}</p><p>${t("ao.dialog.safety")}</p>`;
    try {
      const handle = openDialog({
        title: t("ao.dialog.title"), body, initialFocus: "cancel",
        actions: [{ id: "cancel", label: t("ao.dialog.cancel") }, { id: "start", label: t("ao.dialog.start"), kind: "primary" }],
        background: deps.background?.() ?? null, ...(deps.document === undefined ? {} : { document: deps.document }),
      });
      return (await handle.result).action === "start";
    } catch { return false; }
  }

  return {
    async attach(next, agentId) {
      stopTimer();
      unsubscribe?.();
      unsubscribe = null;
      generation += 1;
      target = next;
      state = next === null || agentId === undefined ? BLANK : { ...BLANK, agentId };
      if (next === null) return;
      unsubscribe = deps.visibility.subscribe(() => { if (deps.visibility.isVisible()) void refresh(); else stopTimer(); });
      render();
      await refresh();
    },
    refresh,
    async run() {
      if (target === null || state.busy || state.agentId === "" || !await confirm()) return;
      await ask({ action: "run", agentId: state.agentId }, "ao.started");
    },
    async stop() {
      if (target === null || state.busy) return;
      await ask({ action: "stop" }, "ao.stopRequested");
    },
    model: () => state,
  };
}
