import type { UI_LIMITS, UiRef } from "../../contracts/uiContract.js";
import type { BackendClient } from "../api/backendClient.js";
import { describeError, isCursorReset, type ErrorDescription } from "../api/errors.js";
import { html, mount, type MountTarget } from "../dom/html.js";
import { parseAgentStats } from "../state/memorySpace.js";
import {
  DEFAULT_CLI_OPTIONS,
  isRangeKey,
  itemKey,
  makeQuery,
  mergeItems,
  NO_FILTERS,
  choicesFromStats,
  parsePage,
  queryMethod,
  queryParams,
  withScopeValue,
  type ProjectOption,
  type TimelineFilters,
  type TimelinePage,
  type TimelineQuery,
} from "../state/timeline.js";
import { renderBanner, renderClear, renderCount, renderFilters, renderList, renderSummary, type TimelineView } from "./timelineView.js";

export const TIMELINE_PAGE_SIZE: (typeof UI_LIMITS)["listDefaultLimit"] = 12;
export const QUERY_MAX_CHARS: (typeof UI_LIMITS)["queryMaxChars"] = 100;
export const TIMELINE_STALE_MS = 60_000;
const CALL_KEY = "timeline";
const OPTIONS_KEY = "timeline.options";

export type FilterName = "scope" | "range" | "cli";

export interface TimelineTargets {
  readonly query: { value: string };
  readonly filters: MountTarget;
  readonly clear: MountTarget;
  readonly banner: MountTarget;
  readonly count: { textContent: string | null };
  readonly list: MountTarget;
}

export interface TimelineOpenOptions {
  readonly projects?: readonly ProjectOption[];
  readonly clis?: readonly string[];
}

export interface TimelineDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly now: () => number;
  readonly pageSize?: number;
  readonly onOpenDetail?: (ref: UiRef) => void;
}

export interface Timeline {
  attach(targets: TimelineTargets | null): void;
  open(agentId: string, options?: TimelineOpenOptions): Promise<void>;
  reload(): Promise<void>;
  refreshIfStale(maxAgeMs: number): Promise<void>;
  loadMore(): Promise<readonly string[]>;
  search(text: string): Promise<void>;
  clearSearch(): Promise<void>;
  setFilter(name: FilterName, value: string): Promise<void>;
  clearFilters(): Promise<void>;
  openItem(key: string): void;
  view(): TimelineView;
}

interface Draft {
  readonly q: string | null;
  readonly filters: TimelineFilters;
}

const INITIAL: TimelineView = {
  phase: "loading",
  searching: false,
  query: null,
  normalizedQuery: null,
  filters: NO_FILTERS,
  projects: [],
  cliOptions: DEFAULT_CLI_OPTIONS,
  items: [],
  hasMore: false,
  loadingMore: false,
  complete: true,
  restarted: false,
  error: null,
  notice: null,
  moreError: null,
};

const sameFilters = (left: TimelineFilters, right: TimelineFilters): boolean =>
  left.scope === right.scope && left.projectId === right.projectId && left.range === right.range && left.cli === right.cli;

function isFailure(value: TimelinePage | ErrorDescription): value is ErrorDescription {
  return "code" in value;
}

export function createTimeline(deps: TimelineDeps): Timeline {
  const pageSize = deps.pageSize ?? TIMELINE_PAGE_SIZE;
  let targets: TimelineTargets | null = null;
  let agentId: string | null = null;
  let query: TimelineQuery | null = null;
  let cursor: string | null = null;
  let generation = 0;
  let loadedAt = 0;
  let announce = false;
  let state: TimelineView = INITIAL;

  const apply = (change: Partial<TimelineView>): void => {
    state = { ...state, ...change };
  };

  function renderResults(): void {
    if (targets === null) return;
    mount(targets.banner, html`${renderSummary(state)}${renderBanner(state)}`);
    mount(targets.list, renderList(state, deps.now()));
    targets.count.textContent = renderCount(state, announce);
    announce = false;
  }

  function renderClearButton(): void {
    if (targets !== null) mount(targets.clear, renderClear(state));
  }

  // why: the selects are only rewritten when their option set or the chosen values change from outside, because rewriting a select the user just operated would drop its keyboard focus
  function renderChrome(): void {
    if (targets === null) return;
    mount(targets.filters, renderFilters(state));
    renderClearButton();
  }

  function pageOf(method: "ui.list" | "ui.search", value: unknown): TimelinePage | ErrorDescription {
    return parsePage(method, value) ?? describeError("malformed_response", "client");
  }

  async function run(draft: Draft, keep: boolean, restarted = false): Promise<void> {
    if (agentId === null) return;
    generation += 1;
    const mine = generation;
    const next = makeQuery(agentId, draft.q, draft.filters, deps.now());
    query = next;
    cursor = null;
    const method = queryMethod(next);
    apply({
      phase: keep ? state.phase : "loading",
      searching: next.q !== null,
      query: next.q,
      filters: next.filters,
      normalizedQuery: keep ? state.normalizedQuery : null,
      items: keep ? state.items : [],
      hasMore: keep ? state.hasMore : false,
      loadingMore: false,
      complete: keep ? state.complete : true,
      restarted: false,
      error: null,
      notice: null,
      moreError: null,
    });
    renderResults();
    const result = await deps.client.call(method, queryParams(next, pageSize, null), { key: CALL_KEY });
    // why: a slower answer to an earlier query must never overwrite the list of the query the user is looking at now
    if (mine !== generation || (!result.ok && result.superseded)) return;
    const page = result.ok ? pageOf(method, result.value) : result;
    if (isFailure(page)) {
      apply(keep && state.items.length > 0 ? { phase: "ready", notice: page } : { phase: "error", error: page, items: [], hasMore: false });
      renderResults();
      return;
    }
    cursor = page.nextCursor;
    loadedAt = deps.now();
    apply({
      phase: "ready",
      items: mergeItems([], page.items).items,
      hasMore: page.nextCursor !== null,
      complete: page.complete,
      normalizedQuery: page.normalizedQuery,
      restarted,
    });
    renderResults();
  }

  const draftOf = (): Draft => ({ q: state.query, filters: state.filters });
  const hasData = (): boolean => state.phase === "ready" && state.items.length > 0;

  async function loadMore(): Promise<readonly string[]> {
    if (cursor === null || query === null || state.loadingMore || state.phase !== "ready") return [];
    const mine = generation;
    const current = query;
    const method = queryMethod(current);
    apply({ loadingMore: true, moreError: null, restarted: false });
    renderResults();
    const result = await deps.client.call(method, queryParams(current, pageSize, cursor), { key: CALL_KEY });
    if (mine !== generation || (!result.ok && result.superseded)) return [];
    if (!result.ok && isCursorReset(result.code)) {
      await run({ q: current.q, filters: current.filters }, true, true);
      return [];
    }
    const page = result.ok ? pageOf(method, result.value) : result;
    if (isFailure(page)) {
      apply({ loadingMore: false, moreError: page });
      renderResults();
      return [];
    }
    const merged = mergeItems(state.items, page.items);
    cursor = page.nextCursor;
    apply({
      loadingMore: false,
      items: merged.items,
      hasMore: page.nextCursor !== null,
      complete: state.complete && page.complete,
      normalizedQuery: page.normalizedQuery ?? state.normalizedQuery,
    });
    announce = true;
    renderResults();
    return merged.added;
  }

  const sameChoices = (left: readonly unknown[], right: readonly unknown[]): boolean => JSON.stringify(left) === JSON.stringify(right);

  // why: the timeline asks for the agent's stats itself instead of waiting on the space page's request, so a slow or failed stats call there never blocks the filters, and on failure the supplied fallback choices stay
  async function loadChoices(id: string): Promise<void> {
    const at = new Date(deps.now());
    const result = await deps.client.call("ui.agentStats", { agentId: id, tzOffsetMin: -at.getTimezoneOffset() + 0 }, { key: OPTIONS_KEY });
    if (agentId !== id || !result.ok) return;
    const stats = parseAgentStats(result.value);
    if (stats === null || stats.agentId !== id) return;
    const choices = choicesFromStats(stats);
    const clis = choices.clis.length === 0 ? DEFAULT_CLI_OPTIONS : choices.clis;
    if (sameChoices(choices.projects, state.projects) && sameChoices(clis, state.cliOptions)) return;
    apply({ projects: choices.projects, cliOptions: clis });
    renderChrome();
  }

  async function refreshIfStale(maxAgeMs: number): Promise<void> {
    if (agentId === null || (state.phase === "ready" && deps.now() - loadedAt <= maxAgeMs)) return;
    await run(draftOf(), hasData());
  }

  function filtersAfter(name: FilterName, value: string): TimelineFilters {
    if (name === "scope") return withScopeValue(state.filters, value);
    if (name === "range") return isRangeKey(value) ? { ...state.filters, range: value } : state.filters;
    return { ...state.filters, cli: value === "" ? null : value };
  }

  return {
    attach(next) {
      targets = next;
      if (next === null) return;
      next.query.value = state.query ?? "";
      renderChrome();
      renderResults();
    },
    async open(id, options = {}) {
      if (agentId === id) {
        void loadChoices(id);
        await refreshIfStale(TIMELINE_STALE_MS);
        return;
      }
      agentId = id;
      query = null;
      // why: the supplied choices are only the fallback for a newly opened agent; on a return the choices already taken from its stats stay, so the selects are not rewritten to a shorter list and back
      apply({ filters: NO_FILTERS, query: null, searching: false, projects: options.projects ?? [], cliOptions: options.clis === undefined || options.clis.length === 0 ? DEFAULT_CLI_OPTIONS : options.clis });
      if (targets !== null) targets.query.value = "";
      renderChrome();
      void loadChoices(id);
      await run({ q: null, filters: NO_FILTERS }, false);
    },
    reload: () => run(draftOf(), hasData()),
    refreshIfStale,
    loadMore,
    search(text) {
      const trimmed = text.trim().slice(0, QUERY_MAX_CHARS).trim();
      const q = trimmed === "" ? null : trimmed;
      if (q === null && state.query === null) return Promise.resolve();
      return run({ q, filters: state.filters }, q === state.query && hasData());
    },
    clearSearch() {
      if (targets !== null) targets.query.value = "";
      return run({ q: null, filters: state.filters }, false);
    },
    async setFilter(name, value) {
      const filters = filtersAfter(name, value);
      if (sameFilters(filters, state.filters)) return;
      apply({ filters });
      renderClearButton();
      await run({ q: state.query, filters }, false);
    },
    async clearFilters() {
      if (sameFilters(state.filters, NO_FILTERS)) return;
      apply({ filters: NO_FILTERS });
      renderChrome();
      await run({ q: state.query, filters: NO_FILTERS }, false);
    },
    openItem(key) {
      const found = state.items.find((item) => itemKey(item.ref) === key);
      if (found !== undefined) deps.onOpenDetail?.(found.ref);
    },
    view: () => state,
  };
}
