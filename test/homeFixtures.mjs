import { loadUiModule } from "./uiViewHarness.mjs";

export const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ui = await loadUiModule(
  "state/teamHome.ts",
  "views/teamHomeController.ts",
  "views/teamHomeView.ts",
  "views/memorySpaceView.ts",
  "views/memorySpaceController.ts",
  "views/spaceEvents.ts",
  "state/memorySpace.ts",
  "views/statusLine.ts",
  "views/homeEvents.ts",
  "router.ts",
  "api/errors.ts",
  "dom/html.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/relativeTime.ts",
  "components/avatar.ts",
  "components/sparkline.ts",
);

export const iso = (ms) => new Date(ms).toISOString();

export function makeAgent(index, overrides = {}) {
  const team = `team${index % 10}`;
  const total = 5 + ((index * 7) % 90);
  const personal = Math.ceil(total / 2);
  return {
    id: `${team}/agent${String(index).padStart(3, "0")}`,
    ...(index % 3 === 0 ? { name: `代理${index}` } : {}),
    team: { key: team, ...(index % 10 < 5 ? { name: `部門${index % 10}` } : {}) },
    counts: {
      personal,
      projects: total - personal > 0 ? [{ projectId: `proj_${index}abcdefgh`, count: total - personal }] : [],
      otherProjects: 0,
      total,
    },
    lastAt: iso(NOW - (index + 1) * 7 * MINUTE),
    spark14: Array.from({ length: 14 }, (_, day) => ((index + day) % 4 === 0 ? 0 : (index + day) % 5)),
    latest: { snippet: `最近做的事 ${index}`, at: iso(NOW - (index + 1) * 7 * MINUTE) },
    ...overrides,
  };
}

export function makeTiles(agents, overrides = {}) {
  return {
    totalMemories: agents.reduce((sum, agent) => sum + agent.counts.total, 0),
    writtenToday: 62,
    activeAgents7d: agents.length,
    agents: agents.length,
    lastWriteAt: iso(NOW - 44 * MINUTE),
    ...overrides,
  };
}

const keyOf = (agent) => `${agent.team.key}\u0000${agent.id}`;

export function makeOverview(pageAgents, { all = pageAgents, nextCursor = null, complete = true, unavailable = 0, tiles, profile = {} } = {}) {
  return { ok: true, tiles: tiles ?? makeTiles(all), agents: pageAgents, nextCursor, complete, profile: { generation: null, receivedAt: null, ...profile }, storage: { status: "ready", unavailableAgents: unavailable } };
}

export function failure(code) {
  return { ok: false, superseded: false, attempts: 1, ...ui.describeError(code) };
}

// why: the fake backend pages like the real overview does, by (teamKey, id) keyset, so continuation behaviour is tested rather than assumed
export function pagedBackend(agents, { overlap = 0 } = {}) {
  const sorted = [...agents].sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : 1));
  const calls = [];
  const client = {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options });
      if (method !== "ui.overview") return { ok: true, value: { ok: false, code: "INVALID_PARAMS", retryable: false } };
      const start = params.cursor === undefined ? 0 : Number(params.cursor);
      const from = Math.max(0, start - (params.cursor === undefined ? 0 : overlap));
      const slice = sorted.slice(from, start + params.limit);
      const next = start + params.limit < sorted.length ? String(start + params.limit) : null;
      return { ok: true, value: makeOverview(slice, { all: sorted, nextCursor: next }) };
    },
  };
  return client;
}

export function fakeTargets() {
  return {
    help: { innerHTML: "" },
    banner: { innerHTML: "" },
    tiles: { innerHTML: "" },
    tools: { innerHTML: "" },
    count: { textContent: "" },
    note: { textContent: "" },
    wall: { innerHTML: "" },
  };
}

export function memoryPreferences(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, get: (key) => store.get(key) ?? null, set: (key, value) => void store.set(key, value) };
}

export function createHome({ client, preferences = memoryPreferences(), now = () => NOW, pageSize } = {}) {
  const targets = fakeTargets();
  const home = ui.createTeamHome({ client, now, preferences, ...(pageSize === undefined ? {} : { pageSize }) });
  home.attach(targets);
  return { home, targets, preferences };
}

export const count = (text, pattern) => (text.match(pattern) ?? []).length;
export const cardIds = (markup) => [...markup.matchAll(/data-agent-id="([^"]*)"/gu)].map((match) => match[1]);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'=<>/]+(?:="[^"]*")?)*)\s*(\/?)>/gu;
const ATTRIBUTE = /\s+([^\s"'=<>/]+)(?:="([^"]*)")?/gu;

// why: every < that survives escaping starts a real tag, so removing the recognised tags must leave no angle bracket, and any attribute outside the list would be an injected one
export function tokenize(markup) {
  const tags = [];
  const rest = markup.replace(TAG, (_whole, closing, name, attributes) => {
    tags.push({ closing: closing === "/", name: name.toLowerCase(), attributes: [...attributes.matchAll(ATTRIBUTE)].map((entry) => [entry[1], entry[2] ?? null]) });
    return "";
  });
  return { tags, rest };
}

export const ALLOWED_TAGS = new Set(["a", "b", "br", "button", "div", "h2", "label", "option", "p", "rect", "section", "select", "span", "strong", "svg", "header", "h1"]);
export const ALLOWED_ATTRIBUTES = new Set([
  "aria-hidden", "aria-label", "aria-labelledby", "aria-live", "class", "data-act", "data-agent-id", "data-code", "data-back", "data-role", "disabled", "for", "height", "href", "id", "role", "rx", "selected", "style", "tabindex", "title", "type", "value", "viewBox", "width", "x", "y",
]);
