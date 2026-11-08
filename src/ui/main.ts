import { backendClient } from "./api/backendClient.js";
import { agentAvatarClient } from "./api/agentAvatarClient.js";
import { aiOptionsClient } from "./api/aiOptionsClient.js";
import { settingsClient, type SettingKey } from "./api/settingsClient.js";
import { openDialog } from "./components/dialog.js";
import { html, mount } from "./dom/html.js";
import { t } from "./i18n/index.js";
import { createSettingsState, type SettingsSnapshot } from "./state/settings.js";
import { itemKey } from "./state/timeline.js";
import { parseRoute, type Route } from "./router.js";
import { createDetail } from "./views/detailController.js";
import { bindHomeEvents } from "./views/homeEvents.js";
import { createMemorySpace, type SpaceTargets } from "./views/memorySpaceController.js";
import { SPACE_ORG_ID, SPACE_TIMELINE_ID, SPACE_TITLE_ID, spaceShell } from "./views/memorySpaceView.js";
import { createAgentOrg } from "./views/agentOrgController.js";
import { bindAgentOrgEvents } from "./views/agentOrgEvents.js";
import { bindSpaceEvents } from "./views/spaceEvents.js";
import { bindStatusToggle, createStatusLine } from "./views/statusLine.js";
import { bindLegacyTrial } from "./views/legacyTrial.js";
import { createLegacyUpgrade } from "./views/legacyUpgrade.js";
import { createTeamHome, type HomeTargets, type Preferences } from "./views/teamHomeController.js";
import { homeShell } from "./views/teamHomeView.js";
import { createTimeline, type TimelineTargets } from "./views/timelineController.js";
import { bindTimelineEvents } from "./views/timelineEvents.js";
import { bindSettingsEvents } from "./views/settingsEvents.js";
import { changeProvider, type AiChoices } from "./views/settingsPicker.js";
import { settingsPage } from "./views/settingsView.js";
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

const home = createTeamHome({ client, now, preferences, agentAvatar: agentAvatarClient() });
const space = createMemorySpace({ client, now });
const settings = createSettingsState(settingsClient());
const aiOptions = aiOptionsClient();
let aiChoices: AiChoices = { status: "pending" };
let aiChoicesLoad = 0;

const agentOrg = createAgentOrg({
  client,
  background: () => view,
  scheduler: { set: (callback, ms) => window.setTimeout(callback, ms), clear: (handle) => window.clearTimeout(handle as number) },
  visibility: {
    isVisible: () => document.visibilityState === "visible",
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  },
});

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
let currentHash = window.location.hash || "#/";

function sameRoute(left: Route, right: Route): boolean {
  return left.name === right.name && (left.name !== "agent" || (right.name === "agent" && left.agentId === right.agentId));
}

function hashOf(route: Route): string {
  if (route.name === "settings") return "#/settings";
  if (route.name === "agent") return `#/agent/${encodeURIComponent(route.agentId)}`;
  return "#/";
}

function updateNavigation(route: Route): void {
  const brand = element("brand-home");
  const nav = element("primary-nav");
  const overview = element("nav-overview");
  const settingsLink = element("nav-settings");
  brand.setAttribute("aria-label", t("nav.brandHome"));
  nav.setAttribute("aria-label", t("nav.label"));
  overview.textContent = t("nav.overview");
  settingsLink.textContent = t("nav.settings");
  overview.removeAttribute("aria-current");
  settingsLink.removeAttribute("aria-current");
  if (route.name === "home") overview.setAttribute("aria-current", "page");
  else if (route.name === "agent") overview.setAttribute("aria-current", "location");
  else settingsLink.setAttribute("aria-current", "page");
}

function renderSettings(snapshot: SettingsSnapshot = settings.view()): void {
  const active = document.activeElement instanceof HTMLElement && view.contains(document.activeElement) ? document.activeElement : null;
  const fieldKey = active?.dataset.settingKey;
  const action = active?.dataset.settingsAction;
  const start = active instanceof HTMLInputElement && active.type === "text" ? active.selectionStart : null;
  const end = active instanceof HTMLInputElement && active.type === "text" ? active.selectionEnd : null;
  mount(view, settingsPage(snapshot, aiChoices));
  if (fieldKey !== undefined) {
    const replacement = view.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting-key="${fieldKey}"]`);
    if (replacement !== null && !replacement.disabled) {
      replacement.focus({ preventScroll: true });
      if (replacement instanceof HTMLInputElement && replacement.type === "text" && start !== null && end !== null) replacement.setSelectionRange(start, end);
      return;
    }
  }
  if (action !== undefined) {
    const replacement = view.querySelector<HTMLElement>(`[data-settings-action="${action}"]`);
    if (replacement !== null && !replacement.hasAttribute("disabled")) {
      replacement.focus({ preventScroll: true });
      return;
    }
  }
  if (active !== null) document.getElementById("settings-title")?.focus({ preventScroll: true });
}

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
  void agentOrg.attach(element(SPACE_ORG_ID), agentId);
  timeline.attach(timelineTargets());
  void timeline.open(agentId, { projects: agent?.counts.projects ?? [] });
  window.scrollTo(0, 0);
  document.getElementById(SPACE_TITLE_ID)?.focus();
}

function loadAiChoices(): void {
  const generation = ++aiChoicesLoad;
  aiChoices = { status: "pending" };
  void aiOptions.load().then((options) => {
    if (generation !== aiChoicesLoad) return;
    aiChoices = options === null ? { status: "unavailable" } : { status: "ready", options };
    if (current?.name === "settings") renderSettings();
  });
}

function showSettings(): void {
  home.attach(null);
  timeline.attach(null);
  void settings.load();
  loadAiChoices();
  renderSettings();
  document.getElementById("settings-title")?.focus();
}

function route(): void {
  const next = parseRoute(window.location.hash);
  const previous = current;
  if (previous !== null && sameRoute(previous, next)) return;
  if (previous?.name === "home") homeScroll = window.scrollY;
  detail.close({ force: true });
  if (previous?.name === "agent") { space.close(); void agentOrg.attach(null); }
  current = next;
  currentHash = hashOf(next);
  updateNavigation(next);
  if (next.name === "agent") showAgent(next.agentId);
  else if (next.name === "settings") showSettings();
  else showHome(previous?.name === "agent" ? previous.agentId : undefined);
}

const legacyUpgrade = createLegacyUpgrade({ client, reload: () => home.reload(), background: () => view });

bindHomeEvents(view, {
  reload: () => void home.reload(),
  upgradeLegacy: (count) => void legacyUpgrade.run(count),
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

bindAgentOrgEvents(view, { run: () => void agentOrg.run(), stop: () => void agentOrg.stop() });

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

const SETTING_STATUS_IDS: Readonly<Record<SettingKey, string>> = {
  organizationEnabled: "settings-enabled-status",
  organizationProvider: "settings-provider-status",
  organizationModel: "settings-model-status",
  organizationContextBudget: "settings-budget-status",
  organizationFrequency: "settings-frequency-status",
  organizationDailyTime: "settings-daily-time-status",
};

const SETTING_KEYS: readonly SettingKey[] = [
  "organizationEnabled",
  "organizationProvider",
  "organizationModel",
  "organizationContextBudget",
  "organizationFrequency",
  "organizationDailyTime",
];

function syncSettingsDraft(snapshot: SettingsSnapshot): void {
  for (const key of SETTING_KEYS) {
    const container = document.getElementById(SETTING_STATUS_IDS[key]);
    if (container === null) continue;
    const status = snapshot.savingKey === key ? "saving" : snapshot.outcomes[key] ?? (snapshot.dirtyKeys.includes(key) ? "dirty" : undefined);
    const statusText = status === "saved" ? t("settings.key.saved")
      : status === "saving" ? t("settings.key.saving")
        : status === "unknown" ? t("settings.key.unknown")
          : status === "failed" ? t("settings.key.failed")
            : status === "conflict" ? t("settings.key.conflict")
              : status === "dirty" ? t("settings.key.dirty") : "";
    let label = container.querySelector<HTMLElement>(".setting-status");
    if (statusText === "") {
      label?.remove();
    } else {
      if (label === null) {
        label = document.createElement("span");
        label.className = "setting-status";
        container.appendChild(label);
      }
      label.textContent = statusText;
      if (status === undefined) label.removeAttribute("data-kind");
      else label.dataset.kind = status;
    }
  }
  const budget = document.getElementById("settings-budget");
  if (budget instanceof HTMLInputElement) {
    budget.setAttribute("aria-invalid", String(snapshot.budgetIssue === "invalid"));
    const issue = document.getElementById("settings-budget-issue");
    if (snapshot.budgetIssue === null) {
      issue?.remove();
      budget.setAttribute("aria-describedby", "settings-budget-help settings-budget-effect settings-budget-status");
    }
  }
  const dailyTime = document.getElementById("settings-daily-time");
  const dailyTimeIssue = document.getElementById("settings-daily-time-issue");
  if (dailyTime instanceof HTMLInputElement) {
    const invalid = snapshot.dailyTimeIssue === "invalid";
    dailyTime.setAttribute("aria-invalid", String(invalid));
    dailyTime.setAttribute("aria-describedby", invalid
      ? "settings-daily-time-help settings-daily-time-effect settings-daily-time-status settings-daily-time-issue"
      : "settings-daily-time-help settings-daily-time-effect settings-daily-time-status");
    if (invalid && dailyTimeIssue === null) {
      const issue = document.createElement("p");
      issue.id = "settings-daily-time-issue";
      issue.className = "setting-note setting-invalid";
      issue.setAttribute("role", "alert");
      issue.textContent = t("settings.dailyTime.invalid");
      dailyTime.closest(".setting-copy")?.appendChild(issue);
    } else if (!invalid) dailyTimeIssue?.remove();
  }
  const feedback = view.querySelector<HTMLElement>(".settings-feedback");
  if (feedback !== null) {
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.textContent = snapshot.dailyTimeIssue === "invalid" ? t("settings.dailyTime.invalid") : snapshot.dirtyKeys.length > 0 ? t("settings.state.dirty") : snapshot.savedCount > 0 ? t("settings.state.saved") : t("settings.state.loaded");
  }
  const save = view.querySelector<HTMLButtonElement>('[data-settings-action="save"]');
  const cancel = view.querySelector<HTMLButtonElement>('[data-settings-action="cancel"]');
  if (save !== null) {
    save.disabled = snapshot.dirtyKeys.length === 0 || snapshot.saving || snapshot.reconciling || snapshot.hasUnknown || snapshot.dailyTimeIssue !== null || Object.values(snapshot.outcomes).includes("conflict");
    save.textContent = snapshot.lastSave === "partial" || snapshot.lastSave === "failed" ? t("settings.action.retrySave") : t("settings.action.save");
  }
  if (cancel !== null) cancel.disabled = snapshot.dirtyKeys.length === 0 || snapshot.saving || snapshot.reconciling || snapshot.hasUnknown;
  const savedNote = view.querySelector<HTMLElement>(".settings-saved-note");
  if (snapshot.savedCount > 0 && snapshot.dirtyKeys.length > 0 && savedNote === null && feedback !== null) {
    const note = document.createElement("p");
    note.className = "settings-saved-note";
    note.textContent = t("settings.note.savedKeys");
    feedback.after(note);
  } else if ((snapshot.savedCount === 0 || snapshot.dirtyKeys.length === 0) && savedNote !== null) savedNote.remove();
}

let previousSettingsSnapshot = settings.view();

function focusFirstUnresolvedSettingsControl(snapshot: SettingsSnapshot): void {
  if (view.hasAttribute("inert") || document.querySelector('[aria-modal="true"]') !== null) return;
  for (const key of SETTING_KEYS) {
    const outcome = snapshot.outcomes[key];
    if (outcome !== "failed" && outcome !== "unknown" && outcome !== "conflict") continue;
    const control = view.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting-key="${key}"]`);
    if (control !== null && !control.disabled) {
      control.focus({ preventScroll: true });
      return;
    }
    const reconcile = view.querySelector<HTMLButtonElement>('[data-settings-action="reconcile"]');
    if (reconcile !== null && !reconcile.disabled) {
      reconcile.focus({ preventScroll: true });
      return;
    }
  }
}

settings.subscribe((snapshot) => {
  const previous = previousSettingsSnapshot;
  previousSettingsSnapshot = snapshot;
  if (current?.name !== "settings") return;
  const completedSave = previous.saving && !snapshot.saving;
  const completedReconcile = previous.reconciling && !snapshot.reconciling;
  const newErrorResult = (completedSave || completedReconcile)
    && Object.values(snapshot.outcomes).some((outcome) => outcome === "failed" || outcome === "unknown" || outcome === "conflict");
  const active = document.activeElement;
  if (!newErrorResult && active instanceof HTMLInputElement && view.contains(active) && (active.type === "text" || active.type === "range" || active.type === "time") && snapshot.phase === "ready" && !snapshot.saving && !snapshot.reconciling && !snapshot.hasUnknown) {
    syncSettingsDraft(snapshot);
    return;
  }
  renderSettings(snapshot);
  if (newErrorResult) focusFirstUnresolvedSettingsControl(snapshot);
});

bindSettingsEvents(view, {
  update: (key, value) => settings.update(key, value),
  changeProvider: (value) => changeProvider(settings, aiChoices, value),
  save: () => void settings.save(),
  cancel: () => void settings.cancel(),
  retryLoad: () => void settings.load(),
  reconcile: () => void settings.reconcile(),
});

function openNavigationDialog(options: Parameters<typeof openDialog>[0]): ReturnType<typeof openDialog> | null {
  try {
    return openDialog({ ...options, background: element("view") });
  } catch {
    return null;
  }
}

function settingsNavigationBlocked(): "saving" | "unknown" | "dirty" | null {
  const snapshot = settings.view();
  if (snapshot.saving) return "saving";
  if (snapshot.hasUnknown || snapshot.reconciling) return "unknown";
  if (settings.hasUnsavedChanges()) return "dirty";
  return null;
}

function blockNavigation(kind: "saving" | "unknown", fromHashChange: boolean, opener?: HTMLElement): void {
  const saving = kind === "saving";
  const handle = openNavigationDialog({
    title: t(saving ? "settings.savingDialog.title" : "settings.leave.blockedTitle"),
    body: html`<p>${t(saving ? "settings.state.savingWait" : "settings.state.unknownWait")}</p>`,
    actions: saving
      ? [{ id: "return", label: t("settings.savingDialog.return") }]
      : [{ id: "reconcile", label: t("settings.leave.reconcile"), kind: "primary" }, { id: "return", label: t("settings.leave.return") }],
    initialFocus: "return",
    dismissible: false,
    returnFocusTo: opener ?? element("nav-settings"),
  });
  if (handle === null) {
    if (fromHashChange && window.location.hash !== currentHash) window.location.hash = currentHash;
    return;
  }
  void handle.result.then(({ action }) => {
    if (fromHashChange && window.location.hash !== currentHash) window.location.hash = currentHash;
    if (action === "reconcile" && !saving) void settings.reconcile();
  });
}

function confirmLeave(targetHash: string, fromHashChange: boolean, opener?: HTMLElement): void {
  const snapshot = settings.view();
  const handle = openNavigationDialog({
    title: t("settings.leave.title"),
    body: html`<p>${t(snapshot.savedCount > 0 ? "settings.leave.partial" : "settings.leave.dirty")}</p>`,
    actions: [
      { id: "stay", label: t("settings.leave.stay") },
      { id: "discard", label: t("settings.leave.discard"), kind: "primary" },
    ],
    initialFocus: "stay",
    returnFocusTo: opener ?? element("nav-settings"),
  });
  if (handle === null) {
    if (fromHashChange && window.location.hash !== currentHash) window.location.hash = currentHash;
    return;
  }
  void handle.result.then(({ action }) => {
    if (action !== "discard") {
      if (fromHashChange && window.location.hash !== currentHash) window.location.hash = currentHash;
      return;
    }
    if (!settings.cancel()) {
      if (fromHashChange && window.location.hash !== currentHash) window.location.hash = currentHash;
      return;
    }
    if (fromHashChange) route();
    else if (window.location.hash !== targetHash) window.location.hash = targetHash;
  });
}

function onHashChange(): void {
  const next = parseRoute(window.location.hash);
  if (current?.name === "settings" && !sameRoute(current, next)) {
    const kind = settingsNavigationBlocked();
    if (kind === "saving" || kind === "unknown") {
      blockNavigation(kind, true);
      return;
    }
    if (kind === "dirty") {
      confirmLeave(window.location.hash, true);
      return;
    }
  }
  route();
}

function onInternalClick(event: MouseEvent): void {
  if (current?.name !== "settings" || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest<HTMLAnchorElement>('a[href^="#/"]');
  if (anchor === null) return;
  const targetHash = anchor.getAttribute("href");
  if (targetHash === null || sameRoute(current, parseRoute(targetHash))) return;
  const kind = settingsNavigationBlocked();
  if (kind === null) return;
  event.preventDefault();
  if (kind === "saving" || kind === "unknown") blockNavigation(kind, false, anchor);
  else confirmLeave(targetHash, false, anchor);
}

element("title").textContent = t("app.title");
element("brand-home").setAttribute("aria-label", t("nav.brandHome"));
element("primary-nav").setAttribute("aria-label", t("nav.label"));
element("nav-overview").textContent = t("nav.overview");
element("nav-settings").textContent = t("nav.settings");
element("status").addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-retry]") !== null) void status.refresh();
});
bindStatusToggle(element("status"), status);
bindLegacyTrial(element("status"), { client, refresh: status.refresh, background: () => view });
document.addEventListener("click", onInternalClick, true);
window.addEventListener("hashchange", onHashChange);
status.start();
route();
