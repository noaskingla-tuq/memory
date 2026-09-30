import { backendClient } from "./api/backendClient.js";
import { mount } from "./dom/html.js";
import { t } from "./i18n/index.js";
import { parseRoute, type Route } from "./router.js";
import { bindHomeEvents } from "./views/homeEvents.js";
import { createMemorySpace, type SpaceTargets } from "./views/memorySpaceController.js";
import { SPACE_TITLE_ID, spaceShell } from "./views/memorySpaceView.js";
import { bindSpaceEvents } from "./views/spaceEvents.js";
import { createStatusLine } from "./views/statusLine.js";
import { createTeamHome, type HomeTargets, type Preferences } from "./views/teamHomeController.js";
import { homeShell } from "./views/teamHomeView.js";

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

let current: Route | null = null;
let homeScroll = 0;

function showHome(returnedFrom: string | undefined): void {
  mount(view, homeShell());
  home.attach(homeTargets());
  void home.refreshIfStale(HOME_STALE_MS);
  window.scrollTo(0, homeScroll);
  cardOf(returnedFrom)?.focus({ preventScroll: true });
}

function showAgent(agentId: string): void {
  home.attach(null);
  mount(view, spaceShell());
  void space.open(agentId, home.agent(agentId), spaceTargets());
  window.scrollTo(0, 0);
  document.getElementById(SPACE_TITLE_ID)?.focus();
}

function route(): void {
  const next = parseRoute(window.location.hash);
  const previous = current;
  if (previous?.name === next.name && (next.name === "home" || (previous.name === "agent" && previous.agentId === next.agentId))) return;
  if (previous?.name === "home") homeScroll = window.scrollY;
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

element("title").textContent = t("app.title");
element("status").addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-retry]") !== null) void status.refresh();
});
window.addEventListener("hashchange", route);
status.start();
route();
