import { describeError, type ErrorDescription } from "../api/errors.js";
import type { BackendClient, BackendParams } from "../api/backendClient.js";
import { mount, type MountTarget } from "../dom/html.js";
import {
  hasTeam,
  isSortKey,
  mergeAgents,
  parseOverview,
  TEAM_OPTION_PREFIX,
  type OverviewAgent,
  type OverviewPage,
  type SortKey,
} from "../state/teamHome.js";
import { renderBanner, renderCount, renderHelp, renderNote, renderTiles, renderTools, renderWall, type HomeView } from "./teamHomeView.js";

export const OVERVIEW_PAGE_SIZE = 60;
export const HELP_DISMISSED_KEY = "memory.home.helpDismissed";

export interface HomeTargets {
  readonly help: MountTarget;
  readonly banner: MountTarget;
  readonly tiles: MountTarget;
  readonly tools: MountTarget;
  readonly count: { textContent: string | null };
  readonly note: { textContent: string | null };
  readonly wall: MountTarget;
}

export interface Preferences {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface TeamHomeDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly now: () => number;
  readonly preferences: Preferences;
  readonly pageSize?: number;
}

export interface TeamHome {
  attach(targets: HomeTargets | null): void;
  start(): Promise<void>;
  reload(): Promise<void>;
  refreshIfStale(maxAgeMs: number): Promise<void>;
  loadMore(): Promise<readonly string[]>;
  setTeam(value: string): void;
  setSort(value: string): void;
  dismissHelp(): void;
  showHelp(): void;
  agent(id: string): OverviewAgent | undefined;
  view(): HomeView;
}

export function createTeamHome(deps: TeamHomeDeps): TeamHome {
  const pageSize = deps.pageSize ?? OVERVIEW_PAGE_SIZE;
  let targets: HomeTargets | null = null;
  let generation = 0;
  let loadedAt = 0;
  let announce = false;
  let state: HomeView = {
    phase: "loading",
    error: null,
    notice: null,
    moreError: null,
    tiles: null,
    agents: [],
    hasMore: false,
    loadingMore: false,
    complete: true,
    unavailableAgents: 0,
    team: null,
    sort: "recent",
    helpOpen: deps.preferences.get(HELP_DISMISSED_KEY) !== "1",
  };
  let cursor: string | null = null;

  function renderResults(): void {
    if (targets === null) return;
    mount(targets.wall, renderWall(state, deps.now()));
    targets.count.textContent = renderCount(state, announce);
    announce = false;
  }

  function renderAll(): void {
    if (targets === null) return;
    mount(targets.help, renderHelp(state));
    mount(targets.banner, renderBanner(state));
    mount(targets.tiles, renderTiles(state));
    mount(targets.tools, renderTools(state));
    targets.note.textContent = renderNote(state);
    renderResults();
  }

  const apply = (change: Partial<HomeView>): void => {
    state = { ...state, ...change };
  };

  function overviewParams(after: string | null): BackendParams {
    const at = new Date(deps.now());
    const dayStart = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    return { tzOffsetMin: -at.getTimezoneOffset() + 0, dayStartIso: dayStart.toISOString(), limit: pageSize, cursor: after ?? undefined };
  }

  function pageOf(value: unknown): OverviewPage | ErrorDescription {
    return parseOverview(value) ?? describeError("malformed_response", "client");
  }

  const isFailure = (value: OverviewPage | ErrorDescription): value is ErrorDescription => "code" in value;

  // why: a team that vanished from the reloaded list would leave the filter selecting nothing, so it falls back to all teams
  const validTeam = (agents: readonly OverviewAgent[], team: string | null): string | null => (team !== null && hasTeam(agents, team) ? team : null);

  async function reload(): Promise<void> {
    generation += 1;
    const mine = generation;
    const hadData = state.agents.length > 0;
    apply(hadData ? { notice: null, moreError: null, loadingMore: false } : { phase: "loading", error: null, notice: null, moreError: null, loadingMore: false });
    renderAll();
    const result = await deps.client.call("ui.overview", overviewParams(null), { key: "overview" });
    if (mine !== generation || (!result.ok && result.superseded)) return;
    const page = result.ok ? pageOf(result.value) : result;
    if (isFailure(page)) {
      apply(hadData ? { notice: page } : { phase: "error", error: page });
      renderAll();
      return;
    }
    cursor = page.nextCursor;
    loadedAt = deps.now();
    apply({
      phase: "ready",
      error: null,
      notice: null,
      tiles: page.tiles,
      agents: page.agents,
      hasMore: page.nextCursor !== null,
      complete: page.complete,
      unavailableAgents: page.unavailableAgents,
      team: validTeam(page.agents, state.team),
    });
    renderAll();
  }

  async function loadMore(): Promise<readonly string[]> {
    if (cursor === null || state.loadingMore || state.phase !== "ready") return [];
    const mine = generation;
    apply({ loadingMore: true, moreError: null });
    renderResults();
    const result = await deps.client.call("ui.overview", overviewParams(cursor), { key: "overview.more" });
    if (mine !== generation || (!result.ok && result.superseded)) return [];
    const page = result.ok ? pageOf(result.value) : result;
    if (isFailure(page)) {
      apply({ loadingMore: false, moreError: page });
      renderResults();
      return [];
    }
    const known = new Set(state.agents.map((agent) => agent.id));
    const added = page.agents.filter((agent) => !known.has(agent.id)).map((agent) => agent.id);
    cursor = page.nextCursor;
    apply({
      loadingMore: false,
      tiles: page.tiles,
      agents: mergeAgents(state.agents, page.agents),
      hasMore: page.nextCursor !== null,
      complete: state.complete && page.complete,
      unavailableAgents: page.unavailableAgents,
    });
    announce = true;
    if (targets !== null) mount(targets.tools, renderTools(state));
    if (targets !== null) mount(targets.banner, renderBanner(state));
    renderResults();
    return added;
  }

  return {
    attach(next) {
      targets = next;
      renderAll();
    },
    start: reload,
    reload,
    async refreshIfStale(maxAgeMs) {
      if (state.phase === "ready" && deps.now() - loadedAt <= maxAgeMs) return;
      await reload();
    },
    loadMore,
    setTeam(value) {
      const team = value.startsWith(TEAM_OPTION_PREFIX) ? value.slice(TEAM_OPTION_PREFIX.length) : null;
      apply({ team: team !== null && hasTeam(state.agents, team) ? team : null });
      renderResults();
    },
    setSort(value) {
      if (!isSortKey(value)) return;
      const sort: SortKey = value;
      apply({ sort });
      renderResults();
    },
    dismissHelp() {
      deps.preferences.set(HELP_DISMISSED_KEY, "1");
      apply({ helpOpen: false });
      renderAll();
    },
    showHelp() {
      apply({ helpOpen: true });
      renderAll();
    },
    agent: (id) => state.agents.find((agent) => agent.id === id),
    view: () => state,
  };
}
