import assert from "node:assert/strict";
import test from "node:test";
import { AGENT, DAY, HOUR, NOW, count, createTimelineFor, deferred, drain, expectedIds, failure, fakeBackend, idsIn, iso, keysIn, makeMemories, makeMemory, tl } from "./timelineFixtures.mjs";

const memories100 = makeMemories(100);
test("paging 100 memories 12 at a time shows every memory once, newest first, with nothing left out", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].method, "ui.list");
  assert.equal(backend.calls[0].params.limit, 12);
  assert.equal(backend.calls[0].params.cursor, undefined);
  assert.equal(backend.calls[0].params.agentId, AGENT);
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
  assert.equal(targets.count.textContent, "已載入 12 筆，還有更多");

  const added = await drain(timeline);
  assert.equal(backend.calls.length, 9, "8 full pages and a last page of 4");
  assert.equal(added.length, 88);
  for (let index = 1; index < backend.calls.length; index += 1) {
    assert.equal(typeof backend.calls[index].params.cursor, "string", `page ${index} continues from a cursor`);
    assert.equal(backend.calls[index].params.agentId, AGENT);
    assert.equal(backend.calls[index].params.limit, 12);
  }
  const shown = idsIn(targets.list.innerHTML);
  assert.equal(shown.length, 100);
  assert.equal(new Set(shown).size, 100, "no memory appears twice");
  assert.deepEqual(shown, expectedIds(memories100), "same set, same order as the backend's keyset order");
  assert.ok(!targets.list.innerHTML.includes('data-tl="loadMore"'), "the button is gone when nothing is left");
  assert.equal(timeline.view().hasMore, false);
  assert.equal(targets.count.textContent, "已載入更多，現在共 100 筆");
});

test("every continuation asks for exactly the cursor the previous page returned", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  const seen = [];
  for (let index = 0; index < 3; index += 1) {
    const before = backend.calls.length;
    await timeline.loadMore();
    seen.push(backend.calls[before].params.cursor);
  }
  assert.equal(new Set(seen).size, 3, "the cursor moves on each page");
  assert.ok(seen.every((cursor) => cursor.includes("ui.list")));
});

test("a continuation page that overlaps the previous one still yields each memory once, and only new ones are reported", async () => {
  const backend = fakeBackend(memories100, { overlap: 5 });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  const first = await timeline.loadMore();
  assert.equal(first.length, 7, "the five repeated memories are not reported as new");
  await drain(timeline);
  const shown = idsIn(targets.list.innerHTML);
  assert.equal(shown.length, 100);
  assert.equal(new Set(shown).size, 100);
});

test("ties on the same write time are not lost or repeated across a page boundary", async () => {
  const same = iso(NOW - HOUR);
  const tied = Array.from({ length: 30 }, (_, index) => makeMemory(index, { updatedAt: same }));
  const backend = fakeBackend(tied);
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await drain(timeline);
  assert.deepEqual(idsIn(targets.list.innerHTML), expectedIds(tied));
});

test("an empty page that still carries a cursor keeps the load-more button and does not claim there is nothing", async () => {
  const pages = [
    { ok: true, items: [], nextCursor: "next-1" },
    { ok: true, items: [makeMemory(1)], nextCursor: null },
  ];
  const calls = [];
  const client = { async call(method, params) { if (method === "ui.agentStats") return failure("NOT_FOUND"); calls.push(params); return { ok: true, value: pages[calls.length - 1] }; } };
  const { timeline, targets, open } = createTimelineFor({ client });
  await open();
  assert.ok(targets.list.innerHTML.includes("後面還有資料沒掃完"));
  assert.ok(targets.list.innerHTML.includes('data-tl="loadMore"'));
  assert.ok(!targets.list.innerHTML.includes("還沒有記憶"));
  await timeline.loadMore();
  assert.equal(calls[1].cursor, "next-1");
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 1);
});

test("no memories at all says so in plain words and offers no load-more", async () => {
  const { targets, open } = createTimelineFor({ client: fakeBackend([]) });
  await open();
  assert.ok(targets.list.innerHTML.includes("還沒有記憶") && targets.list.innerHTML.includes("AI 夥伴完成工作後，記憶會自動出現在這裡。"));
  assert.ok(!targets.list.innerHTML.includes('data-tl="loadMore"'));
  assert.equal(targets.count.textContent, "");
});

test("the filters become request parameters, a filter change starts again from page one, and clearing them starts again too", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.loadMore();
  const before = targets.filters.innerHTML;

  await timeline.setFilter("scope", "personal");
  let last = backend.calls[backend.calls.length - 1].params;
  assert.equal(last.cursor, undefined, "a new filter never reuses the old cursor");
  assert.equal(last.scope, "personal");
  assert.equal(last.projectId, undefined);
  assert.ok(timeline.view().items.every((item) => item.ref.scope === "personal"));

  await timeline.setFilter("scope", "p:proj_0abcdefgh");
  last = backend.calls[backend.calls.length - 1].params;
  assert.equal(last.scope, "project");
  assert.equal(last.projectId, "proj_0abcdefgh");

  await timeline.setFilter("scope", "project");
  last = backend.calls[backend.calls.length - 1].params;
  assert.equal(last.scope, "project");
  assert.equal(last.projectId, undefined);

  await timeline.setFilter("cli", "codex");
  last = backend.calls[backend.calls.length - 1].params;
  assert.equal(last.cli, "codex");
  assert.ok(timeline.view().items.every((item) => item.work.cli === "codex"));

  await timeline.setFilter("range", "24h");
  last = backend.calls[backend.calls.length - 1].params;
  assert.equal(last.sinceIso, iso(NOW - DAY));
  assert.ok(timeline.view().items.every((item) => item.updatedAt >= iso(NOW - DAY)));
  assert.ok(targets.clear.innerHTML.includes('data-tl="clearFilters"'), "a clear-filters button shows while any filter is on");
  assert.equal(targets.filters.innerHTML, before, "operating a select does not rewrite the selects, so the keyboard focus stays on it");

  await timeline.clearFilters();
  last = backend.calls[backend.calls.length - 1].params;
  assert.deepEqual(Object.keys(last).sort(), ["agentId", "limit"]);
  assert.equal(targets.clear.innerHTML, "");
  assert.equal(timeline.view().items.length, 12);
  assert.ok(targets.filters.innerHTML.includes('<option value="all" selected>'), "clearing rewrites the selects back to their defaults");
});

test("setting a filter to the value it already has, or to a value nobody offers, sends nothing", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.setFilter("scope", "all");
  await timeline.setFilter("range", "all");
  await timeline.setFilter("range", "nonsense");
  await timeline.setFilter("cli", "");
  await timeline.clearFilters();
  assert.equal(backend.calls.length, 1);
});

test("the since bound is fixed when a query starts, so the pages of one query never disagree even as the clock moves", async () => {
  let clock = NOW;
  const backend = fakeBackend(memories100);
  const { timeline, open } = createTimelineFor({ client: backend, now: () => clock });
  await open();
  await timeline.setFilter("range", "7d");
  const first = backend.calls[backend.calls.length - 1].params.sinceIso;
  clock += 3 * HOUR;
  await timeline.loadMore();
  const next = backend.calls[backend.calls.length - 1].params;
  assert.equal(next.sinceIso, first);
  assert.equal(typeof next.cursor, "string");
  assert.equal(timeline.view().error, null);
  assert.equal(timeline.view().moreError, null);
  assert.equal(timeline.view().restarted, false, "a moving bound would have made the cursor stale");
});

test("the project and tool choices come from what the page supplies, and a chosen one that vanished stays selectable", async () => {
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend(memories100), projects: [{ projectId: "p-1", name: "官網改版" }, { projectId: "p-2" }], clis: ["claude", "codex", "gemini"] });
  await open();
  const markup = targets.filters.innerHTML;
  assert.ok(markup.includes('<option value="p:p-1">專案：官網改版</option>'));
  assert.ok(markup.includes('<option value="p:p-2">專案：專案 p-2</option>'), "a project without a name degrades to its id");
  assert.ok(markup.includes('<option value="gemini">gemini</option>'));
  await timeline.setFilter("scope", "p:gone");
  timeline.attach(targets);
  assert.equal(timeline.view().filters.projectId, "gone");
  assert.ok(targets.filters.innerHTML.includes('<option value="p:gone" selected>專案：專案 gone</option>'));
});

test("searching sends the query to ui.search, highlights the matched words, and shows what was searched", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.search("  成果 12  ");
  const call = backend.calls[backend.calls.length - 1];
  assert.equal(call.method, "ui.search");
  assert.equal(call.params.q, "成果 12", "the query is trimmed");
  assert.equal(call.params.cursor, undefined);
  const view = timeline.view();
  assert.equal(view.searching, true);
  assert.deepEqual(view.items.map((item) => item.ref.memoryId), ["m0012"]);
  assert.ok(targets.list.innerHTML.includes("<mark>成果</mark>") && targets.list.innerHTML.includes("<mark>12</mark>"));
  assert.ok(targets.banner.innerHTML.includes("搜尋「成果 12」的結果"));
  assert.ok(targets.banner.innerHTML.includes('data-tl="clearSearch"'));
  assert.ok(!targets.banner.innerHTML.includes("實際比對的是"), "nothing to say when the backend matched exactly what was typed");
  assert.equal(targets.count.textContent, "找到 1 筆符合的記憶");
});

test("when the backend normalises the query it says what it actually matched", async () => {
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend([makeMemory(1, { snippet: "檢查 ABC 系統" })]) });
  await open();
  await timeline.search("ＡＢＣ");
  assert.ok(targets.banner.innerHTML.includes("實際比對的是「ABC」"));
  assert.ok(targets.list.innerHTML.includes("<mark>ABC</mark>"));
});

test("search pages continue with the same query and the same filters, and never repeat a memory", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.setFilter("cli", "claude");
  await timeline.search("整理了");
  await drain(timeline);
  const searchCalls = backend.calls.filter((call) => call.method === "ui.search");
  assert.ok(searchCalls.length >= 2);
  for (const call of searchCalls) {
    assert.equal(call.params.q, "整理了");
    assert.equal(call.params.cli, "claude");
  }
  const expected = memories100.filter((item) => item.work.cli === "claude");
  assert.deepEqual(idsIn(targets.list.innerHTML), expectedIds(expected));
  assert.equal(new Set(idsIn(targets.list.innerHTML)).size, expected.length);
  assert.equal(targets.count.textContent, `已載入更多，現在共 ${expected.length} 筆`);
});

test("a search with no matches says so, names the text-not-meaning limit, and offers a way back", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.search("完全不存在的詞");
  assert.equal(timeline.view().phase, "ready");
  assert.equal(timeline.view().items.length, 0);
  assert.ok(targets.list.innerHTML.includes("找不到符合的記憶"));
  assert.ok(targets.list.innerHTML.includes("比對文字（關鍵字），不是語意"));
  assert.ok(targets.list.innerHTML.includes('data-tl="clearSearch"'));
  assert.ok(!targets.list.innerHTML.includes('data-tl="loadMore"'));
  assert.equal(targets.count.textContent, "");
  await timeline.clearSearch();
  assert.equal(targets.query.value, "");
  assert.equal(timeline.view().searching, false);
  assert.equal(backend.calls[backend.calls.length - 1].method, "ui.list");
  assert.equal(timeline.view().items.length, 12);
});

test("an empty box does not search, a whitespace-only box after a search returns to the list, and a long query is cut to the limit", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.search("");
  await timeline.search("   ");
  assert.equal(backend.calls.length, 1, "nothing to search for and nothing to go back from");
  await timeline.search("x".repeat(150));
  assert.equal(backend.calls[backend.calls.length - 1].params.q.length, 100);
  await timeline.search("  ");
  assert.equal(backend.calls[backend.calls.length - 1].method, "ui.list");
  assert.equal(timeline.view().searching, false);
});

test("filters chosen before a search still apply after the search is cleared, and the other way round", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.setFilter("scope", "personal");
  await timeline.search("整理了");
  assert.equal(backend.calls[backend.calls.length - 1].params.scope, "personal");
  await timeline.clearSearch();
  const last = backend.calls[backend.calls.length - 1];
  assert.equal(last.method, "ui.list");
  assert.equal(last.params.scope, "personal");
  await timeline.search("整理了");
  await timeline.setFilter("cli", "codex");
  const again = backend.calls[backend.calls.length - 1];
  assert.equal(again.method, "ui.search");
  assert.equal(again.params.q, "整理了");
  assert.equal(again.params.cli, "codex");
});

test("a search that did not scan everything warns that it may be incomplete, keeps warning while paging, and stops after a complete search", async () => {
  const backend = fakeBackend(memories100, { complete: ({ index }) => index !== 2 });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.search("整理了");
  assert.equal(timeline.view().complete, true);
  assert.ok(!targets.banner.innerHTML.includes("可能不完整"));
  await timeline.loadMore();
  assert.equal(timeline.view().complete, false);
  assert.ok(targets.banner.innerHTML.includes("搜尋結果可能不完整"));
  assert.ok(targets.banner.innerHTML.includes('data-tl-notice="incomplete"') && targets.banner.innerHTML.includes('role="status"'));
  assert.ok(targets.banner.innerHTML.includes(">重新搜尋<") && targets.banner.innerHTML.includes('data-tl="reload"'));
  await timeline.loadMore();
  assert.equal(timeline.view().complete, false, "one incomplete page keeps the whole result marked incomplete");
  await timeline.setFilter("cli", "claude");
  await timeline.search("請求");
  assert.equal(timeline.view().complete, true, "a new search starts complete again");
  assert.ok(!targets.banner.innerHTML.includes("可能不完整"));
});

test("an incomplete search with no matches shows both the empty answer and the warning", async () => {
  const backend = fakeBackend(memories100, { complete: () => false });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.search("完全不存在的詞");
  assert.ok(targets.list.innerHTML.includes("找不到符合的記憶"));
  assert.ok(targets.banner.innerHTML.includes("搜尋結果可能不完整"));
});

test("the plain list never claims to be incomplete", async () => {
  const { targets, open } = createTimelineFor({ client: fakeBackend(memories100, { complete: () => false }) });
  await open();
  assert.ok(!targets.banner.innerHTML.includes("可能不完整"));
});
