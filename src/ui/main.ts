import { backendClient } from "./api/backendClient.js";
import { mount } from "./dom/html.js";
import { t } from "./i18n/index.js";
import { itemKey } from "./state/timeline.js";
import { parseRoute, type Route } from "./router.js";
import { createDetail } from "./views/detailController.js";
import { bindHomeEvents } from "./views/homeEvents.js";
import { createMemorySpace, type SpaceTargets } from "./views/memorySpaceController.js";
import { SPACE_TIMELINE_ID, SPACE_TITLE_ID, spaceShell } from "./views/memorySpaceView.js";
import { bindSpaceEvents } from "./views/spaceEvents.js";
import { createStatusLine } from "./views/statusLine.js";
import { createTeamHome, type HomeTargets, type Preferences } from "./views/teamHomeController.js";
import { homeShell } from "./views/teamHomeView.js";
import { createTimeline, type TimelineTargets } from "./views/timelineController.js";
import { bindTimelineEvents } from "./views/timelineEvents.js";
import { TIMELINE_IDS, timelineShell } from "./views/timelineView.js";

const HOME_STALE_MS = 60_000;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

const preferences: Preferences = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      return;
    }
  },
};

const client = backendClient();
const now = (): number => Date.now();
const view = element("view");

const status = createStatusLine({
  client,
  target: element("status"),
  now,
  scheduler: { set: (callback, ms) => window.setTimeout(callback, ms), clear: (handle) => window.clearTimeout(handle as number) },
  visibility: {
    isVisible: () => document.visibilityState === "visible",
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  },
});

const home = createTeamHome({ client, now, preferences });
const space = createMemorySpace({ client, now });

const timeline = createTimeline({ client, now, onOpenDetail: (ref) => void detail.open(ref) });

// why: the drawer makes the whole page inert while it is open, and a card is found again by its key because the list is re-rendered after a forget
const detail = createDetail({
  client,
  reloadList: () => timeline.reload(),
  listKeys: () => timeline.view().items.map((item) => itemKey(item.ref)),
  cardFor: (key) => itemButton(key),
  listHeading: () => document.getElementById(TIMELINE_IDS.title),
  backgrounds: () => [document.querySelector<HTMLElement>("header.hdr"), document.querySelector<HTMLElement>("main")].filter((found): found is HTMLElement => found !== null),
});

function homeTargets(): HomeTargets {
  return {
    help: element("home-help"),
    banner: element("home-banner"),
    tiles: element("home-tiles"),
    tools: element("home-tools"),
    count: element("home-count"),
    note: element("home-note"),
    wall: element("home-wall"),
  };
}

function spaceTargets(): SpaceTargets {
  return { avatar: element("space-avatar"), title: element("space-title"), id: element("space-id"), meta: element("space-meta"), body: element("space-body") };
}

function cardOf(agentId: string | undefined): HTMLElement | null {
  if (agentId === undefined) return null;
  return Array.from(document.querySelectorAll<HTMLElement>("[data-agent-id]")).find((card) => card.dataset.agentId === agentId) ?? null;
}

function timelineTargets(): TimelineTargets {
  return {
    query: element(TIMELINE_IDS.query) as HTMLInputElement,
    filters: element(TIMELINE_IDS.filters),
    clear: element(TIMELINE_IDS.clear),
    banner: element(TIMELINE_IDS.banner),
    count: element(TIMELINE_IDS.count),
    list: element(TIMELINE_IDS.list),
  };
}

function itemButton(key: string | undefined): HTMLElement | null {
  if (key === undefined) return null;
  return Array.from(document.querySelectorAll<HTMLElement>("[data-tl-key]")).find((button) => button.dataset.tlKey === key) ?? null;
}

let current: Route | null = null;
let homeScroll = 0;

function showHome(returnedFrom: string | undefined): void {
  timeline.attach(null);
  mount(view, homeShell());
  home.attach(homeTargets());
  void home.refreshIfStale(HOME_STALE_MS);
  window.scrollTo(0, homeScroll);
  cardOf(returnedFrom)?.focus({ preventScroll: true });
}

function showAgent(agentId: string): void {
  home.attach(null);
  const agent = home.agent(agentId);
  mount(view, spaceShell());
  mount(element(SPACE_TIMELINE_ID), timelineShell());
  void space.open(agentId, agent, spaceTargets());
  timeline.attach(timelineTargets());
  void timeline.open(agentId, { projects: agent?.counts.projects ?? [] });
  window.scrollTo(0, 0);
  document.getElementById(SPACE_TITLE_ID)?.focus();
}

function route(): void {
  const next = parseRoute(window.location.hash);
  const previous = current;
  if (previous?.name === next.name && (next.name === "home" || (previous.name === "agent" && previous.agentId === next.agentId))) return;
  if (previous?.name === "home") homeScroll = window.scrollY;
  detail.close({ force: true });
  if (previous?.name === "agent") space.close();
  current = next;
  if (next.name === "agent") showAgent(next.agentId);
  else showHome(previous?.name === "agent" ? previous.agentId : undefined);
}

bindHomeEvents(view, {
  reload: () => void home.reload(),
  loadMore: () =>
    void home.loadMore().then((added) => {
      cardOf(added[0])?.focus();
    }),
  dismissHelp() {
    home.dismissHelp();
    document.querySelector<HTMLElement>("[data-act='showHelp']")?.focus();
  },
  showHelp() {
    home.showHelp();
    document.getElementById("help-title")?.focus();
  },
  setTeam: (value) => home.setTeam(value),
  setSort: (value) => home.setSort(value),
});

bindSpaceEvents(view, {
  retry() {
    void space.retry();
    document.getElementById(SPACE_TITLE_ID)?.focus();
  },
});

bindTimelineEvents(view, {
  search: (text) => void timeline.search(text),
  clearSearch() {
    void timeline.clearSearch();
    element(TIMELINE_IDS.query).focus();
  },
  clearFilters() {
    void timeline.clearFilters();
    element(TIMELINE_IDS.scope).focus();
  },
  reload: () => void timeline.reload(),
  loadMore: () =>
    void timeline.loadMore().then((added) => {
      (itemButton(added[0]) ?? document.querySelector<HTMLElement>("[data-tl='loadMore']"))?.focus();
    }),
  setFilter: (name, value) => void timeline.setFilter(name, value),
  openItem: (key) => timeline.openItem(key),
});

element("title").textContent = t("app.title");
element("status").addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-retry]") !== null) void status.refresh();
});
window.addEventListener("hashchange", route);
status.start();
route();
