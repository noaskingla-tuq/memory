import type { OrganizationResumeState } from "./punchDataPorts.js";
import { phaseOf, type Job } from "./organizationJobState.js";
export type AgentRunState = "running" | "stopping" | "completed" | "stopped";

export interface AgentRunSummary {
  readonly agentId: string;
  readonly state: AgentRunState;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly untried: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly lastError: string | null;
}

export type AgentRunOutcome = "done" | "failed" | "blocked";

interface Run {
  readonly agentId: string;
  readonly startedAt: number;
  readonly total: number;
  readonly waiting: Set<string>;
  state: AgentRunState;
  done: number;
  failed: number;
  endedAt: number | null;
  lastError: string | null;
}

// why: the run only lives in memory; a restart must not spend model quota nobody asked for, and the jobs themselves are already saved, so nothing is lost by forgetting the run
export function createAgentRun() {
  let run: Run | null = null;
  let generation = 0;
  const live = (): Run | null => run !== null && (run.state === "running" || run.state === "stopping") ? run : null;
  return {
    active: (): boolean => live() !== null,
    generation: (): number => generation,
    agentId: (): string | null => live()?.agentId ?? null,
    begin(agentId: string, punchIds: readonly string[], at: number): void {
      generation += 1;
      run = { agentId, startedAt: at, total: punchIds.length, waiting: new Set(punchIds), state: "running", done: 0, failed: 0, endedAt: null, lastError: null };
    },
    // why: a member leaves the waiting set when it is attempted, so a pass never meets the same member twice
    has: (punchId: string): boolean => live()?.waiting.has(punchId) === true,
    hasWaiting: (): boolean => (live()?.waiting.size ?? 0) > 0,
    wantsStop: (): boolean => live()?.state === "stopping",
    requestStop(): boolean {
      const current = live();
      if (current === null) return false;
      current.state = "stopping";
      return true;
    },
    record(punchId: string, outcome: AgentRunOutcome, error: string | null = null): void {
      const current = live();
      if (current === null || !current.waiting.delete(punchId)) return;
      if (outcome === "done") current.done += 1;
      else if (outcome === "failed") { current.failed += 1; current.lastError = error; }
    },
    // why: members that were skipped by a stop, or blocked by another pair's recovery, stay pending in the queue and simply count as untried
    finish(at: number, force = false): void {
      const current = live();
      if (current === null) return;
      if (current.state === "stopping") { current.state = "stopped"; current.endedAt = at; }
      else if (current.waiting.size === 0 || force) { current.state = "completed"; current.endedAt = at; }
    },
    summary(): AgentRunSummary | null {
      if (run === null) return null;
      return {
        agentId: run.agentId, state: run.state, total: run.total, done: run.done, failed: run.failed,
        untried: run.total - run.done - run.failed, startedAt: run.startedAt, endedAt: run.endedAt, lastError: run.lastError,
      };
    },
  };
}

export type AgentOrganizationRequest =
  | { readonly action: "run"; readonly agentId: string }
  | { readonly action: "stop" }
  | { readonly action: "status"; readonly agentId: string };

export type AgentOrganizationBlocked = "disabled" | "running" | "other_running" | "no_candidates" | "not_running";

export interface AgentOrganizationResponse {
  readonly action: "run" | "stop" | "status";
  readonly agentId: string;
  readonly pending: number;
  readonly blocked: AgentOrganizationBlocked | null;
  readonly run: AgentRunSummary | null;
}

export interface AgentOrganizationDeps {
  readonly run: ReturnType<typeof createAgentRun>;
  readonly rows: () => Promise<ReadonlyArray<{ readonly job: Job }>>;
  readonly state: () => Promise<OrganizationResumeState | null>;
  readonly enabled: () => boolean;
  readonly now: () => number;
  readonly wake: () => void;
}

// why: requests are answered one after another, so two quick presses can never both find no run and both start one
export function createAgentOrganization(deps: AgentOrganizationDeps): (request: AgentOrganizationRequest) => Promise<AgentOrganizationResponse> {
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const answer = queue.then(async (): Promise<AgentOrganizationResponse> => {
      const rows = await deps.rows();
      const state = await deps.state();
      const candidates = (agentId: string): string[] => rows
        .filter(({ job }) => job.state === "pending" && job.resumeDisposition !== "legacy_unlinked" && job.actor.agentId === agentId
          && phaseOf(state, job, deps.now()).phase !== "operator_reconcile")
        .map(({ job }) => job.punchId);
      const reply = (agentId: string, blocked: AgentOrganizationBlocked | null): AgentOrganizationResponse => {
        const summary = deps.run.summary();
        const mine = summary !== null && summary.agentId === agentId ? summary : null;
        return { action: request.action, agentId, pending: candidates(agentId).length, blocked, run: mine ?? (request.action === "stop" ? summary : null) };
      };
      if (request.action === "stop") {
        const running = deps.run.agentId();
        if (running === null) return reply(deps.run.summary()?.agentId ?? "", "not_running");
        deps.run.requestStop();
        return reply(running, null);
      }
      const running = deps.run.agentId();
      if (request.action === "status") return reply(request.agentId, !deps.enabled() ? "disabled" : running !== null && running !== request.agentId ? "other_running" : null);
      if (!deps.enabled()) return reply(request.agentId, "disabled");
      if (running !== null) return reply(request.agentId, running === request.agentId ? "running" : "other_running");
      const members = candidates(request.agentId);
      if (members.length === 0) return reply(request.agentId, "no_candidates");
      deps.run.begin(request.agentId, members, deps.now());
      deps.wake();
      return reply(request.agentId, null);
    });
    queue = answer.catch(() => undefined);
    return answer;
  };
}
