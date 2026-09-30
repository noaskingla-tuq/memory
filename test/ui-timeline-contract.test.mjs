import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { count, createTimelineFor, idsIn, tl } from "./timelineFixtures.mjs";
import { DAY_MS, DAY_START, daysAgo, punchContent, seed, startStore } from "./uiHarness.mjs";

const AGENT_ID = "sw/developer";
const OTHER_ID = "sw/reviewer";
const NOW_MS = Date.parse(DAY_START) + 30 * 3_600_000;
const TOTAL = 40;

// why: the timeline is only trustworthy if it works on what the real backend sends, so the seed goes through remember and every page comes from the real ui.list and ui.search
async function build(t) {
  const store = startStore(t);
  const rows = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const at = daysAgo((index * 2) % 20, (index * 5) % 24);
    rows.push({
      agentId: AGENT_ID,
      projectId: index % 4 === 0 ? `proj-${index % 8}` : null,
      content: punchContent({ startMs: Date.parse(at) - 3_600_000, cli: index % 3 === 0 ? "codex" : "claude", title: `第 ${index} 個請求`, body: `成果${index % 2 === 0 ? "甲" : "乙"}：處理第 ${index} 份資料` }),
      updatedAt: at,
      index,
    });
  }
  rows.push({ agentId: OTHER_ID, projectId: null, content: punchContent({ startMs: Date.parse(daysAgo(1)), title: "別人的請求", body: "別人的成果" }), updatedAt: daysAgo(1) });
  const made = await seed(store, rows);
  return { store, made: made.filter((row) => row.agentId === AGENT_ID) };
}

function backendClient(store, mutate) {
  const client = {
    calls: [],
    statsCalls: [],
    async call(method, params, options) {
      const sent = method === "ui.agentStats" || mutate === undefined ? params : mutate(method, params, client.calls.length);
      (method === "ui.agentStats" ? client.statsCalls : client.calls).push({ method, params: sent, options });
      const value = JSON.parse(JSON.stringify(await store.backend.call(method, sent)));
      assert.ok(parseUiResponse(method, value), `the backend answer for ${method} matches its contract schema`);
      if (value.ok === false) return { ok: false, superseded: false, attempts: 1, ...tl.describeError(value.code, "plugin") };
      return { ok: true, value };
    },
  };
  return client;
}

const newestFirst = (left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.id < right.id ? -1 : 1);

async function drain(timeline) {
  for (let guard = 0; guard < 30 && timeline.view().hasMore; guard += 1) await timeline.loadMore();
}

test("the view pages the real ui.list: 40 memories in pages of 12, each once, newest first, the other agent's memory absent", async (t) => {
  const { store, made } = await build(t);
  const client = backendClient(store);
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open(AGENT_ID);
  assert.equal(timeline.view().phase, "ready");
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
  assert.equal(timeline.view().hasMore, true);
  await drain(timeline);
  assert.equal(client.calls.length, 4);
  const shown = idsIn(targets.list.innerHTML);
  assert.equal(shown.length, TOTAL);
  assert.equal(new Set(shown).size, TOTAL);
  assert.deepEqual(shown, [...made].sort(newestFirst).map((row) => row.id));
  assert.ok(!targets.list.innerHTML.includes("別人的"));
  assert.match(targets.list.innerHTML, /<span class="mc-req">第 \d+ 個請求<\/span>/u, "the request titles come out of the work record");
  assert.match(targets.list.innerHTML, /工作 \d{2}:\d{2}～\d{2}:\d{2}（耗時 \d+ 分鐘）/u, "the work span is parsed from the record");
});

test("the filters are accepted by the real backend and select exactly the matching memories across pages", async (t) => {
  const { store, made } = await build(t);
  const client = backendClient(store);
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open(AGENT_ID);
  const idsFor = async () => {
    await drain(timeline);
    assert.equal(timeline.view().phase, "ready");
    return idsIn(targets.list.innerHTML).sort();
  };
  const ids = (rows) => rows.map((row) => row.id).sort();

  await timeline.setFilter("scope", "personal");
  assert.deepEqual(await idsFor(), ids(made.filter((row) => row.projectId === null)));

  await timeline.setFilter("scope", "project");
  assert.deepEqual(await idsFor(), ids(made.filter((row) => row.projectId !== null)));

  await timeline.setFilter("scope", "p:proj-4");
  assert.deepEqual(await idsFor(), ids(made.filter((row) => row.projectId === "proj-4")));

  await timeline.clearFilters();
  await timeline.setFilter("cli", "codex");
  assert.deepEqual(await idsFor(), ids(made.filter((row) => row.index % 3 === 0)));

  await timeline.clearFilters();
  await timeline.setFilter("range", "7d");
  const since = new Date(NOW_MS - 7 * DAY_MS).toISOString();
  assert.deepEqual(await idsFor(), ids(made.filter((row) => row.updatedAt >= since)));
  assert.ok(made.some((row) => row.updatedAt < since), "the seed has memories older than the window");
  assert.equal(timeline.view().error, null);
});

test("the view searches the real ui.search: all words must appear, pages continue, empty results say so, and nothing is marked incomplete", async (t) => {
  const { store, made } = await build(t);
  const client = backendClient(store);
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open(AGENT_ID);

  await timeline.search("成果甲 處理");
  await drain(timeline);
  const even = made.filter((row) => row.index % 2 === 0);
  assert.deepEqual(idsIn(targets.list.innerHTML).sort(), even.map((row) => row.id).sort());
  assert.ok(targets.list.innerHTML.includes("<mark>成果甲</mark>") && targets.list.innerHTML.includes("<mark>處理</mark>"));
  assert.equal(timeline.view().complete, true);
  assert.ok(!targets.banner.innerHTML.includes("可能不完整"));
  assert.ok(client.calls.filter((call) => call.method === "ui.search").length >= 2, "the 20 matches took more than one page");

  await timeline.search("完全不存在的詞");
  assert.equal(timeline.view().items.length, 0);
  assert.ok(targets.list.innerHTML.includes("找不到符合的記憶"));

  await timeline.search("ＡＢＣ");
  assert.equal(timeline.view().normalizedQuery, "ABC", "the backend's NFKC answer is what the view reports");
  assert.ok(targets.banner.innerHTML.includes("實際比對的是「ABC」"));
});

test("a cursor the real backend rejects as CURSOR_STALE restarts the list from page one, tells the user, and paging then completes", async (t) => {
  const { store, made } = await build(t);
  const client = backendClient(store, (method, params, index) => (index === 1 ? { ...params, cursor: `${params.cursor}x` } : params));
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open(AGENT_ID);
  await timeline.loadMore();
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[2].params.cursor, undefined);
  assert.equal(timeline.view().restarted, true);
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
  assert.ok(targets.banner.innerHTML.includes("已從第一頁重新載入"));
  await drain(timeline);
  assert.deepEqual(idsIn(targets.list.innerHTML), [...made].sort(newestFirst).map((row) => row.id));
});

test("a query the real backend refuses is shown as an error with the plain message, not as an empty result", async (t) => {
  const { store } = await build(t);
  const client = backendClient(store);
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open(AGENT_ID);
  await timeline.search(Array.from({ length: 20 }, (_, index) => `w${index}`).join(" "));
  assert.equal(timeline.view().phase, "error");
  assert.equal(timeline.view().error.code, "INVALID_PARAMS");
  assert.ok(targets.list.innerHTML.includes("這個畫面送出的條件不正確。"));
  assert.ok(!targets.list.innerHTML.includes("找不到符合的記憶"));
});

test("an agent with no memory shows the first-use message, not an error", async (t) => {
  const { store } = await build(t);
  const client = backendClient(store);
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open("hw/nobody");
  assert.equal(timeline.view().phase, "ready");
  assert.ok(targets.list.innerHTML.includes("還沒有記憶"));
});

test("the real ui.agentStats supplies the project and tool choices: every project of the agent and only the tools it used", async (t) => {
  const { store } = await build(t);
  const client = backendClient(store);
  const { timeline, targets, open } = createTimelineFor({ client, now: () => NOW_MS });
  await open(AGENT_ID);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.statsCalls.length, 1);
  assert.equal(client.statsCalls[0].params.agentId, AGENT_ID);
  assert.equal(timeline.view().projects.length, 2);
  assert.ok(targets.filters.innerHTML.includes('value="p:proj-0"') && targets.filters.innerHTML.includes('value="p:proj-4"'));
  assert.ok(targets.filters.innerHTML.includes('<option value="claude">claude</option>') && targets.filters.innerHTML.includes('<option value="codex">codex</option>'));
  assert.ok(!client.calls.some((call) => call.method === "ui.agentStats"), "the stats call is kept apart from the list calls");
});
