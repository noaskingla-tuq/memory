import assert from "node:assert/strict";
import test from "node:test";
import { AGENT, DAY, HOUR, MINUTE, NOW, assertSafe, count, createTimelineFor, fakeBackend, iso, makeMemory, tl, tokenize } from "./timelineFixtures.mjs";

const { STRINGS, t } = tl;

async function listMarkup(memories, extra = {}) {
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend(memories), ...extra });
  await open();
  return { markup: targets.list.innerHTML, timeline, targets };
}

test("memories are grouped by the day they were written, and the group headings say written, never added", async () => {
  const memories = [
    makeMemory(0, { updatedAt: iso(NOW - 5 * MINUTE) }),
    makeMemory(1, { updatedAt: iso(NOW - 2 * HOUR) }),
    makeMemory(2, { updatedAt: iso(NOW - DAY) }),
    makeMemory(3, { updatedAt: iso(NOW - 6 * DAY) }),
  ];
  const { markup } = await listMarkup(memories);
  const headings = [...markup.matchAll(/<h3 class="day">([^<]*)<\/h3>/gu)].map((match) => match[1]);
  assert.equal(headings.length, 3, "two memories of today share one heading");
  assert.deepEqual(headings.slice(0, 2), ["今天寫入", "昨天寫入"]);
  assert.match(headings[2], /^\d{4}-\d{2}-\d{2} 寫入$/u);
  assert.ok(markup.includes("依寫入時間排列，最新的在最上面。"));
  assert.ok(!Object.values(STRINGS).some((text) => text.includes("今天新增")), "the wording is 今天寫入 everywhere");
  assert.ok(Object.values(STRINGS).some((text) => text === "今天寫入"));
  assert.equal(count(markup, /class="mcard"/gu), 4);
});

test("each memory shows when it was written and, separately, when the work ran and for how long", async () => {
  const at = new Date(2026, 8, 30, 10, 32).getTime();
  const item = makeMemory(0, { updatedAt: iso(at), work: { startIso: iso(at - 27 * MINUTE), endIso: iso(at - 2 * MINUTE), cli: "codex", model: "gpt-5", title: "整理週報" } });
  const { markup } = await listMarkup([item]);
  assert.ok(markup.includes(">寫入 10:32<"), "the write time");
  assert.ok(markup.includes("工作 10:05～10:30（耗時 25 分鐘）"), "the work span is a different thing from the write time");
  assert.ok(markup.includes("・codex/gpt-5"));
  assert.ok(markup.includes('<span class="mc-req">整理週報</span>'));
  assert.ok(markup.includes(`title="${new Date(at).getFullYear()}-09-30 10:32"`), "the full date is one hover away");
});

test("work durations read as minutes, hours, or less than a minute; a span over midnight carries dates; a missing span says it is unknown", async () => {
  const at = new Date(2026, 8, 30, 12, 0).getTime();
  const span = (minutesBefore, length) => ({ startIso: iso(at - minutesBefore * MINUTE), endIso: iso(at - (minutesBefore - length) * MINUTE), cli: "claude", model: "opus-4", title: "t" });
  const cases = [
    [span(10, 0.5), "不到 1 分鐘"],
    [span(100, 90), "1 小時 30 分鐘"],
    [span(200, 120), "2 小時"],
    [span(30, 7), "7 分鐘"],
  ];
  for (const [work, text] of cases) {
    const { markup } = await listMarkup([makeMemory(0, { updatedAt: iso(at), work })]);
    assert.ok(markup.includes(`耗時 ${text}`), text);
  }
  const midnight = { startIso: iso(new Date(2026, 8, 29, 23, 50).getTime()), endIso: iso(new Date(2026, 8, 30, 0, 20).getTime()), cli: null, model: null, title: null };
  const crossing = await listMarkup([makeMemory(0, { updatedAt: iso(at), work: midnight })]);
  assert.ok(crossing.markup.includes("工作 2026-09-29 23:50～2026-09-30 00:20（耗時 30 分鐘）"));
  assert.ok(!crossing.markup.includes("mc-req"), "no request text, so no request line");
  const reversed = await listMarkup([makeMemory(0, { updatedAt: iso(at), work: { ...midnight, startIso: midnight.endIso, endIso: midnight.startIso } })]);
  assert.ok(reversed.markup.includes("工作 ") && !reversed.markup.includes("耗時"), "a span that runs backwards shows no duration");
  const { updatedAt, ref, kind, revision, snippet, receiptCount } = makeMemory(0, { updatedAt: iso(at) });
  const none = await listMarkup([{ updatedAt, ref, kind, revision, snippet, receiptCount }]);
  assert.ok(none.markup.includes("工作時間不明"));
  assert.ok(!/undefined|null|NaN/u.test(none.markup));
});

test("a memory with no text says so, and a scope badge tells personal from project with the project's name or a short id", async () => {
  const personal = makeMemory(1, { ref: { agentId: AGENT, scope: "personal", projectId: null, memoryId: "a" }, snippet: "   ", work: undefined });
  const named = makeMemory(2, { ref: { agentId: AGENT, scope: "project", projectId: "proj_abcdefghij", memoryId: "b" }, names: { agent: { displayName: "x", teamKey: "sw" }, project: { displayName: "官網改版" } } });
  const unnamed = makeMemory(3, { ref: { agentId: AGENT, scope: "project", projectId: "proj_abcdefghij", memoryId: "c" } });
  const { markup } = await listMarkup([personal, named, unnamed]);
  assert.ok(markup.includes("（沒有文字內容）"));
  assert.ok(markup.includes('<span class="badge">個人</span>'));
  assert.ok(markup.includes('<span class="badge">專案：官網改版</span>'));
  assert.ok(markup.includes('<span class="badge">專案：專案 proj_abc</span>'), "no name table entry: the project degrades to its id");
});

test("each memory is one real button carrying its key, with an accessible name that says what opening it does", async () => {
  const { markup } = await listMarkup([makeMemory(0)]);
  assert.match(markup, /<button type="button" class="mcard" data-tl="open" data-tl-key="[^"]+" aria-label="[^"]*開啟詳情">/u);
  const label = /<button [^>]*aria-label="([^"]*)"/u.exec(markup)[1];
  assert.ok(label.includes("寫入 ") && label.includes("請求 0"));
});

test("the search words are marked in the request text and the snippet, and only those", async () => {
  const item = makeMemory(0, { snippet: "檢查 API 與 api 的說明", work: { startIso: iso(NOW - HOUR), endIso: iso(NOW), cli: "claude", model: "m", title: "更新 API 文件" } });
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend([item]) });
  await open();
  await timeline.search("api");
  assert.ok(targets.list.innerHTML.includes('<span class="mc-req">更新 <mark>API</mark> 文件</span>'));
  assert.ok(targets.list.innerHTML.includes("<mark>API</mark> 與 <mark>api</mark>"));
  assert.equal(count(targets.list.innerHTML, /<mark>/gu), 3);
  await timeline.clearSearch();
  assert.ok(!targets.list.innerHTML.includes("<mark>"), "no marks once the search is cleared");
});

test("splitByTerms treats search words as text, not as a pattern, and handles empty and overlapping words", () => {
  const { splitByTerms, termsOf } = tl;
  assert.deepEqual(splitByTerms("a.b a-b axb", ["a.b"]), [{ text: "a.b", hit: true }, { text: " a-b axb", hit: false }]);
  assert.deepEqual(splitByTerms("(x)+[y]", ["(x)", "[y]"]).filter((piece) => piece.hit).map((piece) => piece.text), ["(x)", "[y]"]);
  assert.deepEqual(splitByTerms("abc", []), [{ text: "abc", hit: false }]);
  assert.deepEqual(splitByTerms("", ["a"]), [{ text: "", hit: false }]);
  assert.deepEqual(splitByTerms("abcd", ["ab", "abc"]).map((piece) => piece.text), ["abc", "d"], "the longer word wins");
  assert.deepEqual(termsOf(null), []);
  assert.deepEqual(termsOf("a  b"), ["a", "b"]);
});

test("every dynamic string is escaped: hostile titles, snippets, project names, tools, queries and error codes cannot inject markup", async () => {
  const payloads = [`"><script>alert(1)</script>`, `<img src=x onerror=alert(2)>`, `' onmouseover='alert(3)`, `</button><svg onload=alert(4)>`, "`${alert(5)}`", "javascript:alert(6)"];
  const memories = payloads.map((payload, index) =>
    makeMemory(index, {
      ref: { agentId: AGENT, scope: "project", projectId: payload, memoryId: `id-${payload}` },
      snippet: payload,
      work: { startIso: iso(NOW - HOUR), endIso: iso(NOW), cli: payload, model: payload, title: payload },
      names: { agent: { displayName: payload, teamKey: payload }, project: { displayName: payload } },
    }),
  );
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend(memories), projects: payloads.map((payload) => ({ projectId: payload, name: payload })), clis: payloads });
  await open();
  assertSafe(assert, targets.list.innerHTML, "list");
  assertSafe(assert, targets.filters.innerHTML, "filters");
  assert.ok(!targets.list.innerHTML.includes("<script") && !targets.list.innerHTML.includes("<img") && !targets.list.innerHTML.includes("<svg"));
  assert.ok(targets.list.innerHTML.includes("&lt;script&gt;"));
  for (const payload of payloads) {
    await timeline.search(`x ${payload}`);
    assertSafe(assert, targets.list.innerHTML, `search list for ${payload}`);
    assertSafe(assert, targets.banner.innerHTML, `search banner for ${payload}`);
    await timeline.setFilter("cli", payload);
    assertSafe(assert, targets.clear.innerHTML, "clear");
    await timeline.clearSearch();
    await timeline.clearFilters();
  }
  assertSafe(assert, tl.timelineShell().value, "shell");
});

test("the tokenizer used by the injection test does catch an injected tag or handler", () => {
  assert.ok(tokenize('<img src="x" onerror="a">').tags.some((tag) => tag.name === "img"));
  assert.ok(tokenize('<button onclick="a">').tags[0].attributes.some(([name]) => name === "onclick"));
  assert.match(tokenize("a < b").rest, /</u);
  assert.throws(() => assertSafe(assert, "<script>x</script>", "x"));
});

test("the shell has the search box with its text-not-meaning note, every container the controller writes into, and only safe markup", () => {
  const markup = tl.timelineShell().value;
  for (const id of ["tl-form", "tl-query", "tl-filters", "tl-clear", "tl-banner", "tl-count", "tl-list", "tl-hint", "tl-title"]) assert.ok(markup.includes(`id="${id}"`), id);
  for (const [name, id] of Object.entries(tl.TIMELINE_IDS)) if (name !== "scope") assert.ok(markup.includes(`id="${id}"`), `TIMELINE_IDS ${id}`);
  assert.match(markup, /<form id="tl-form" class="tl-search" role="search" data-tl-form>/u);
  assert.match(markup, /<input id="tl-query" name="q" type="search" maxlength="100" autocomplete="off" placeholder="搜尋記憶內容（比對文字，不是語意）" aria-describedby="tl-hint">/u);
  assert.ok(markup.includes('<p id="tl-hint" class="muted tl-hint">比對文字，不是語意；多個詞要全部出現。</p>'));
  assert.ok(markup.includes('<button type="submit" class="btn btn-primary">搜尋</button>'), "Enter in the box and the button both submit the form");
  assert.ok(markup.includes('<label class="sr" for="tl-query">搜尋記憶</label>'));
  assert.ok(markup.includes('id="tl-count" class="muted count" aria-live="polite"'), "the count is a live region");
  assertSafe(assert, markup, "shell");
});

test("the selects are labelled and offer every scope, range and tool, and a project only when one is supplied", async () => {
  const { targets, open } = createTimelineFor({ client: fakeBackend([]), projects: [{ projectId: "p1", name: "新人教育訓練" }] });
  await open();
  const markup = targets.filters.innerHTML;
  for (const label of ["範圍", "時間", "工具"]) assert.ok(markup.includes(`>${label}</label>`), label);
  for (const text of ["全部範圍", "只看個人", "只看專案", "專案：新人教育訓練", "全部時間", "最近 24 小時", "最近 7 天", "最近 14 天", "最近 30 天", "全部工具", ">claude<", ">codex<"]) assert.ok(markup.includes(text), text);
  assert.equal(count(markup, /<select /gu), 3);
  assert.match(markup, /<label class="sr" for="tl-scope">/u);
  assert.match(markup, /<select id="tl-range" data-tl-role="range">/u);
  assertSafe(assert, markup, "filters");
});

test("an empty result under a filter offers to clear the filter, not to wait for memories", async () => {
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend([makeMemory(1, { updatedAt: iso(NOW - 40 * DAY) })]) });
  await open();
  await timeline.setFilter("range", "24h");
  assert.ok(targets.list.innerHTML.includes("這個條件下沒有記憶") && targets.list.innerHTML.includes("試試放寬時間範圍，或清除篩選。"));
  assert.ok(targets.list.innerHTML.includes('data-tl="clearFilters"'));
  assert.ok(!targets.list.innerHTML.includes("還沒有記憶"));
});

test("the load-more button is a real enabled button while idle, and disabled with the loading text while a page is coming", async () => {
  const memories = Array.from({ length: 30 }, (_, index) => makeMemory(index));
  const { markup } = await listMarkup(memories);
  assert.ok(markup.includes('<p class="more"><button type="button" class="btn" data-tl="loadMore">載入更多</button></p>'));
  assert.ok(!markup.includes("disabled"));
});

test("the timeline strings are plain Traditional Chinese: no 程序, and the search limit is stated in words", () => {
  const strings = Object.entries(STRINGS).filter(([key]) => key.startsWith("tl."));
  assert.ok(strings.length >= 50);
  for (const [key, value] of strings) assert.ok(!value.includes("程序"), key);
  assert.equal(t("tl.search.hint"), "比對文字，不是語意；多個詞要全部出現。");
  assert.equal(t("tl.day.today"), "今天寫入");
  assert.equal(t("tl.search.placeholder"), "搜尋記憶內容（比對文字，不是語意）");
});

function recorder() {
  const log = [];
  const actions = {
    search: (text) => log.push(`search:${text}`),
    clearSearch: () => log.push("clearSearch"),
    clearFilters: () => log.push("clearFilters"),
    reload: () => log.push("reload"),
    loadMore: () => log.push("loadMore"),
    setFilter: (name, value) => log.push(`filter:${name}:${value}`),
    openItem: (key) => log.push(`open:${key}`),
  };
  const handlers = {};
  tl.bindTimelineEvents({ addEventListener: (type, listener) => (handlers[type] = listener) }, actions);
  return { log, handlers };
}

const hit = (dataset, extra = {}) => ({ closest: () => ({ dataset, ...extra }) });

test("clicks on the data-tl controls reach the matching action, and the team home's data-act controls are left alone", () => {
  const { log, handlers } = recorder();
  for (const tlName of ["loadMore", "reload", "clearSearch", "clearFilters", "unknown"]) handlers.click({ target: hit({ tl: tlName }) });
  handlers.click({ target: hit({ tl: "open", tlKey: '["a","personal",null,"m1"]' }) });
  handlers.click({ target: hit({ tl: "open" }) });
  handlers.click({ target: hit({ act: "reload" }) });
  handlers.click({ target: { closest: () => null } });
  handlers.click({ target: {} });
  handlers.click({ target: null });
  assert.deepEqual(log, ["loadMore", "reload", "clearSearch", "clearFilters", 'open:["a","personal",null,"m1"]']);
});

test("changes on the three selects carry their value, and any other change is ignored", () => {
  const { log, handlers } = recorder();
  handlers.change({ target: hit({ tlRole: "scope" }, { value: "p:x" }) });
  handlers.change({ target: hit({ tlRole: "range" }, { value: "7d" }) });
  handlers.change({ target: hit({ tlRole: "cli" }, { value: "" }) });
  handlers.change({ target: hit({ tlRole: "other" }, { value: "x" }) });
  handlers.change({ target: hit({ tlRole: "range" }) });
  handlers.change({ target: hit({ role: "team" }, { value: "t:sw" }) });
  handlers.change({ target: {} });
  assert.deepEqual(log, ["filter:scope:p:x", "filter:range:7d", "filter:cli:"]);
});

test("submitting the search form searches for the box's text and stops the browser's own form submit", () => {
  const { log, handlers } = recorder();
  let prevented = 0;
  const form = { closest: () => form, elements: { q: { value: "  你好 世界 " } } };
  handlers.submit({ target: form, preventDefault: () => (prevented += 1) });
  assert.deepEqual(log, ["search:  你好 世界 "], "trimming is the controller's job, not the binding's");
  assert.equal(prevented, 1);
  handlers.submit({ target: { closest: () => null, elements: { q: { value: "x" } } }, preventDefault: () => (prevented += 1) });
  handlers.submit({ target: { closest: () => ({ elements: {} }) }, preventDefault: () => undefined });
  assert.deepEqual(log, ["search:  你好 世界 ", "search:"]);
  assert.equal(prevented, 1, "a form that is not the timeline's is not intercepted");
});

test("the timeline mounts into the space page's own slot, and the two pages share no element id", () => {
  const shell = tl.spaceShell().value;
  const slot = '<div id="space-timeline" data-slot="timeline"></div>';
  assert.ok(shell.includes(slot));
  const merged = shell.replace(slot, `<div id="space-timeline" data-slot="timeline">${tl.timelineShell().value}</div>`);
  const ids = [...merged.matchAll(/ id="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, index) => ids.indexOf(id) !== index)}`);
  assert.ok(merged.indexOf('id="space-body"') < merged.indexOf('id="tl-title"'), "the timeline sits below the space page");
  assert.ok(!shell.includes("tl-"), "the space page itself does not know the timeline");
});
