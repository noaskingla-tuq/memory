import { loadUiModule } from "./uiViewHarness.mjs";

export const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const AGENT = "sw/developer";

export const tl = await loadUiModule(
  "state/timeline.ts",
  "state/memorySpace.ts",
  "views/memorySpaceView.ts",
  "views/timelineController.ts",
  "views/timelineView.ts",
  "views/timelineEvents.ts",
  "api/errors.ts",
  "dom/html.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/clock.ts",
  "i18n/relativeTime.ts",
);

export const iso = (ms) => new Date(ms).toISOString();

export function makeMemory(index, overrides = {}) {
  const updated = NOW - index * 37 * MINUTE;
  const project = index % 4 === 0;
  return {
    ref: { agentId: AGENT, scope: project ? "project" : "personal", projectId: project ? `proj_${index % 8}abcdefgh` : null, memoryId: `m${String(index).padStart(4, "0")}` },
    kind: "context",
    revision: 1,
    updatedAt: iso(updated),
    snippet: `成果 ${index}：整理了第 ${index} 份資料`,
    work: { startIso: iso(updated - 2 * MINUTE - 25 * MINUTE), endIso: iso(updated - 2 * MINUTE), cli: index % 3 === 0 ? "codex" : "claude", model: "opus-4", title: `請求 ${index}` },
    receiptCount: 1,
    ...overrides,
  };
}

export const makeMemories = (count) => Array.from({ length: count }, (_, index) => makeMemory(index));

const order = (left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.ref.memoryId < right.ref.memoryId ? -1 : 1);

function matches(item, params) {
  if (params.scope !== undefined && item.ref.scope !== params.scope) return false;
  if (params.projectId !== undefined && item.ref.projectId !== params.projectId) return false;
  if (params.sinceIso !== undefined && item.updatedAt < params.sinceIso) return false;
  if (params.cli !== undefined && item.work?.cli !== params.cli) return false;
  if (params.q !== undefined) {
    const text = `${item.work?.title ?? ""} ${item.snippet}`.toLowerCase();
    return params.q.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase().split(" ").every((term) => text.includes(term));
  }
  return true;
}

const filterKey = (method, params) => JSON.stringify([method, params.agentId, params.scope, params.projectId, params.sinceIso, params.cli, params.q]);

export function failure(code) {
  return { ok: false, superseded: false, attempts: 1, ...tl.describeError(code) };
}

// why: the fake pages like the real ui.list does, by (updatedAt desc, id asc) keyset with a cursor bound to the filters, so continuation and CURSOR_STALE are exercised rather than assumed
export function fakeBackend(items, options = {}) {
  const sorted = [...items].sort(order);
  const calls = [];
  const statsCalls = [];
  const client = {
    calls,
    statsCalls,
    async call(method, params, callOptions) {
      if (method === "ui.agentStats") {
        statsCalls.push({ params: { ...params }, options: callOptions });
        if (options.statsBefore !== undefined) await options.statsBefore({ params });
        return options.stats === undefined ? failure("NOT_FOUND") : { ok: true, value: options.stats };
      }
      const index = calls.length;
      calls.push({ method, params: { ...params }, options: callOptions });
      if (options.before !== undefined) await options.before({ method, params, index });
      if (options.fail !== undefined) {
        const verdict = options.fail({ method, params, index });
        if (verdict === "malformed") return { ok: true, value: { ok: true, items: "nope" } };
        if (verdict !== undefined && verdict !== null) return failure(verdict);
      }
      const pool = sorted.filter((item) => matches(item, params));
      let from = 0;
      if (params.cursor !== undefined) {
        const [key, updatedAt, id] = JSON.parse(params.cursor);
        if (key !== filterKey(method, params)) return failure("CURSOR_STALE");
        from = pool.findIndex((item) => item.updatedAt < updatedAt || (item.updatedAt === updatedAt && item.ref.memoryId > id));
        if (from < 0) from = pool.length;
        from = Math.max(0, from - (options.overlap ?? 0));
      }
      const page = pool.slice(from, from + params.limit);
      const last = page[page.length - 1];
      const more = from + params.limit < pool.length && last !== undefined;
      const nextCursor = more ? JSON.stringify([filterKey(method, params), last.updatedAt, last.ref.memoryId]) : null;
      if (method === "ui.search") {
        const complete = options.complete?.({ params, index }) ?? true;
        return { ok: true, value: { ok: true, items: page, nextCursor, scanned: { namespaces: 3, complete }, normalizedQuery: params.q.normalize("NFKC").replace(/\s+/gu, " ").trim(), mode: "literal" } };
      }
      return { ok: true, value: { ok: true, items: page, nextCursor } };
    },
  };
  return client;
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function fakeTargets() {
  return {
    query: { value: "" },
    filters: { innerHTML: "" },
    clear: { innerHTML: "" },
    banner: { innerHTML: "" },
    count: { textContent: "" },
    list: { innerHTML: "" },
  };
}

export function createTimelineFor({ client, now = () => NOW, pageSize, onOpenDetail, projects, clis } = {}) {
  const targets = fakeTargets();
  const timeline = tl.createTimeline({ client, now, ...(pageSize === undefined ? {} : { pageSize }), ...(onOpenDetail === undefined ? {} : { onOpenDetail }) });
  timeline.attach(targets);
  return { timeline, targets, open: (agentId = AGENT) => timeline.open(agentId, { ...(projects === undefined ? {} : { projects }), ...(clis === undefined ? {} : { clis }) }) };
}

export const count = (text, pattern) => (text.match(pattern) ?? []).length;
export const keysIn = (markup) => [...markup.matchAll(/data-tl-key="([^"]*)"/gu)].map((match) => match[1].replaceAll("&quot;", '"'));
export const idsIn = (markup) => keysIn(markup).map((key) => JSON.parse(key)[3]);

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

export const ALLOWED_TAGS = new Set(["b", "button", "div", "form", "h2", "h3", "input", "label", "mark", "option", "p", "section", "select", "span", "strong"]);
export const ALLOWED_ATTRIBUTES = new Set([
  "aria-describedby", "aria-hidden", "aria-label", "aria-labelledby", "aria-live", "autocomplete", "class", "data-code", "data-tl", "data-tl-form", "data-tl-key", "data-tl-notice", "data-tl-role", "disabled", "for", "id", "maxlength", "name", "placeholder", "role", "selected", "tabindex", "title", "type", "value",
]);

export function assertSafe(assert, markup, label) {
  const { tags, rest } = tokenize(markup);
  assert.ok(!/[<>]/u.test(rest), `${label}: a raw angle bracket survived outside the recognised tags: ${rest.match(/.{0,30}[<>].{0,30}/u)?.[0]}`);
  for (const tag of tags) {
    assert.ok(ALLOWED_TAGS.has(tag.name), `${label}: unexpected tag <${tag.name}>`);
    for (const [name, value] of tag.attributes) {
      assert.ok(ALLOWED_ATTRIBUTES.has(name), `${label}: unexpected attribute ${name} on <${tag.name}>`);
      assert.ok(value === null || !/[<>"]/u.test(value), `${label}: attribute ${name} carries a raw bracket or quote`);
    }
  }
}

export const expectedIds = (list) => [...list].sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.ref.memoryId < right.ref.memoryId ? -1 : 1)).map((item) => item.ref.memoryId);

export async function drain(timeline) {
  const added = [];
  for (let guard = 0; guard < 50 && timeline.view().hasMore; guard += 1) added.push(...(await timeline.loadMore()));
  return added;
}

export function makeStats(agentId, { projects = [], tools = [{ cli: "claude", model: "opus-4", n: 5 }] } = {}) {
  return {
    ok: true,
    agentId,
    namespaces: [
      { scope: "personal", projectId: null, count: 3, firstAt: iso(NOW - DAY), lastAt: iso(NOW) },
      ...projects.map((project) => ({ scope: "project", projectId: project.id, count: 2, firstAt: iso(NOW - DAY), lastAt: iso(NOW), ...(project.names === undefined ? {} : { project: project.names }) })),
    ],
    byDay30: [],
    byHour: Array.from({ length: 24 }, () => 0),
    byWeekday: Array.from({ length: 7 }, () => 0),
    tools,
    repeatedRequests: [],
    representative: [],
    sampled: false,
  };
}
