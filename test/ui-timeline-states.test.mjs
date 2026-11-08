import assert from "node:assert/strict";
import test from "node:test";
import { AGENT, DAY, HOUR, NOW, count, createTimelineFor, deferred, drain, expectedIds, failure, fakeBackend, idsIn, iso, keysIn, makeMemories, makeMemory, tl } from "./timelineFixtures.mjs";

const memories100 = makeMemories(100);

test("CURSOR_STALE while paging reloads from the first page, tells the user, and paging then continues without gaps or repeats", async () => {
  const backend = fakeBackend(memories100, { fail: ({ index, params }) => (index === 1 && params.cursor !== undefined ? "CURSOR_STALE" : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  const added = await timeline.loadMore();
  assert.deepEqual(added, [], "nothing was appended by the stale page");
  assert.equal(backend.calls.length, 3, "first page, the stale continuation, the restart");
  assert.equal(backend.calls[2].params.cursor, undefined, "the restart is page one");
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
  assert.deepEqual(idsIn(targets.list.innerHTML), expectedIds(memories100).slice(0, 12));
  assert.equal(timeline.view().restarted, true);
  assert.ok(targets.banner.innerHTML.includes("已從第一頁重新載入") && targets.banner.innerHTML.includes('data-tl-notice="restarted"'));
  assert.equal(timeline.view().moreError, null, "the stale error itself is not shown as a failure to retry");
  assert.ok(targets.list.innerHTML.includes('data-tl="loadMore"'));

  await drain(timeline);
  assert.deepEqual(idsIn(targets.list.innerHTML), expectedIds(memories100));
  assert.ok(!targets.banner.innerHTML.includes("已從第一頁重新載入"), "the notice goes away once the user pages on");
});

test("a cursor that keeps going stale restarts once per attempt and never loops", async () => {
  const backend = fakeBackend(memories100, { fail: ({ params }) => (params.cursor !== undefined ? "CURSOR_STALE" : undefined) });
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.loadMore();
  assert.equal(backend.calls.length, 3);
  await timeline.loadMore();
  assert.equal(backend.calls.length, 5);
  assert.equal(timeline.view().items.length, 12);
});

test("a restart that itself fails keeps the old list, shows the error, and its retry starts from the first page", async () => {
  let restartFails = true;
  const backend = fakeBackend(memories100, {
    fail: ({ index, params }) => {
      if (index === 1) return "CURSOR_STALE";
      return index === 2 && restartFails && params.cursor === undefined ? "STORAGE_BUSY" : undefined;
    },
  });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.loadMore();
  assert.equal(timeline.view().notice.code, "STORAGE_BUSY");
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12, "what was on screen stays");
  assert.ok(targets.banner.innerHTML.includes('role="alert"') && targets.banner.innerHTML.includes('data-tl="reload"'));
  restartFails = false;
  await timeline.reload();
  assert.equal(backend.calls[backend.calls.length - 1].params.cursor, undefined);
  assert.equal(timeline.view().notice, null);
});

test("the answer to a query the user has already replaced is dropped, however late it arrives", async () => {
  const fruit = Array.from({ length: 20 }, (_, index) => makeMemory(index, { snippet: index % 2 === 0 ? "蘋果的整理結果" : "香蕉的整理結果" }));
  const gate = deferred();
  const backend = fakeBackend(fruit, { before: async ({ index }) => (index === 1 ? gate.promise : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  const slow = timeline.search("蘋果");
  const fast = timeline.search("香蕉");
  await fast;
  const afterFast = targets.list.innerHTML;
  const bananas = fruit.filter((item) => item.snippet.startsWith("香蕉")).map((item) => item.ref.memoryId);
  assert.deepEqual(timeline.view().items.map((item) => item.ref.memoryId).sort(), bananas.slice(0, 10).sort());
  gate.resolve();
  await slow;
  assert.equal(timeline.view().query, "香蕉");
  assert.ok(timeline.view().items.every((item) => item.snippet.startsWith("香蕉")), "the late answer for the apple search did not replace the list");
  assert.equal(targets.list.innerHTML, afterFast);
  assert.ok(targets.banner.innerHTML.includes("搜尋「香蕉」的結果"));
});

test("a late answer is dropped when the filter changed, and when the agent changed", async () => {
  const gate = deferred();
  const backend = fakeBackend(memories100, { before: async ({ index }) => (index === 1 ? gate.promise : undefined) });
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  const slow = timeline.setFilter("scope", "personal");
  const fast = timeline.setFilter("cli", "codex");
  await fast;
  gate.resolve();
  await slow;
  assert.equal(timeline.view().filters.scope, "personal");
  assert.equal(timeline.view().filters.cli, "codex");
  assert.ok(timeline.view().items.every((item) => item.work.cli === "codex"));

  const gateTwo = deferred();
  const second = fakeBackend(memories100, { before: async ({ index }) => (index === 1 ? gateTwo.promise : undefined) });
  const other = createTimelineFor({ client: second });
  await other.open("a/one");
  const slowAgent = other.timeline.open("a/two");
  assert.equal(other.timeline.view().phase, "loading");
  const fastAgent = other.timeline.open("a/three");
  await fastAgent;
  gateTwo.resolve();
  await slowAgent;
  assert.equal(second.calls[second.calls.length - 1].params.agentId, "a/three");
  assert.equal(other.timeline.view().phase, "ready");
});

test("a load-more answer that arrives after the query changed is not appended to the new list", async () => {
  const gate = deferred();
  const backend = fakeBackend(memories100, { before: async ({ index }) => (index === 1 ? gate.promise : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  const more = timeline.loadMore();
  assert.equal(timeline.view().loadingMore, true);
  assert.ok(targets.list.innerHTML.includes("<button type=\"button\" class=\"btn\" disabled>載入中…</button>"));
  await timeline.setFilter("cli", "codex");
  const shown = idsIn(targets.list.innerHTML);
  gate.resolve();
  assert.deepEqual(await more, []);
  assert.deepEqual(idsIn(targets.list.innerHTML), shown);
  assert.equal(timeline.view().loadingMore, false);
});

test("while a refresh of the list is in flight, load-more does not pair the old cursor with the refreshed query", async () => {
  const gate = deferred();
  let clock = NOW;
  const backend = fakeBackend(memories100, { before: async ({ index }) => (index === 2 ? gate.promise : undefined) });
  const { timeline, open } = createTimelineFor({ client: backend, now: () => clock });
  await open();
  await timeline.setFilter("range", "30d");
  clock += HOUR;
  const refresh = timeline.reload();
  assert.deepEqual(await timeline.loadMore(), []);
  assert.equal(backend.calls.length, 3, "no continuation request went out while the refresh was pending");
  gate.resolve();
  await refresh;
  assert.equal(timeline.view().restarted, false);
  assert.equal(timeline.view().items.length, 12);
});

test("loading more twice at once sends one request", async () => {
  const gate = deferred();
  const backend = fakeBackend(memories100, { before: async ({ index }) => (index === 1 ? gate.promise : undefined) });
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  const first = timeline.loadMore();
  const second = await timeline.loadMore();
  assert.deepEqual(second, []);
  gate.resolve();
  await first;
  assert.equal(backend.calls.length, 2);
});

test("an answer the backend client marked superseded changes nothing", async () => {
  let calls = 0;
  const client = {
    async call(method) {
      if (method === "ui.agentStats") return failure("NOT_FOUND");
      calls += 1;
      return calls === 1 ? { ok: false, superseded: true, attempts: 1, ...tl.describeError("superseded") } : { ok: true, value: { ok: true, items: [makeMemory(1)], nextCursor: null } };
    },
  };
  const { timeline, open } = createTimelineFor({ client });
  const first = open();
  await first;
  assert.equal(timeline.view().phase, "loading", "a superseded answer leaves the state to whoever superseded it");
  await timeline.reload();
  assert.equal(timeline.view().phase, "ready");
});

test("while the first page loads the list says it is reading, and a search says it is searching", async () => {
  const gate = deferred();
  const backend = fakeBackend(memories100, { before: async ({ index }) => (index === 0 ? gate.promise : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  const opening = open();
  assert.equal(timeline.view().phase, "loading");
  assert.ok(targets.list.innerHTML.includes("讀取中…") && targets.list.innerHTML.includes('role="status"'));
  assert.ok(!targets.list.innerHTML.includes('class="mcard"'), "skeleton cards are not memories");
  gate.resolve();
  await opening;
  const gateTwo = deferred();
  const searchBackend = fakeBackend(memories100, { before: async ({ method }) => (method === "ui.search" ? gateTwo.promise : undefined) });
  const second = createTimelineFor({ client: searchBackend });
  await second.open();
  const searching = second.timeline.search("請求");
  assert.ok(second.targets.list.innerHTML.includes("搜尋中…"));
  gateTwo.resolve();
  await searching;
  assert.ok(!second.targets.list.innerHTML.includes("搜尋中…"));
});

test("a failed first load says what happened in plain words with one thing to do, and the retry recovers", async () => {
  let broken = true;
  const backend = fakeBackend(memories100, { fail: () => (broken ? "STORAGE_BUSY" : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  assert.equal(timeline.view().phase, "error");
  assert.ok(targets.list.innerHTML.includes("記憶庫正忙著寫入。") && targets.list.innerHTML.includes("請稍等幾秒後再試一次。"));
  assert.ok(targets.list.innerHTML.includes('data-code="STORAGE_BUSY"') && targets.list.innerHTML.includes('role="alert"'));
  assert.ok(targets.list.innerHTML.includes('data-tl="reload"') && targets.list.innerHTML.includes(">重試<"));
  assert.ok(!targets.list.innerHTML.includes("還沒有記憶"), "an error is not shown as an empty timeline");
  broken = false;
  await timeline.reload();
  assert.equal(timeline.view().phase, "ready");
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
});

test("errors that cannot be retried offer no retry button", async () => {
  for (const code of ["plugin_disabled", "plugin_permission_denied", "backend_method_not_allowed", "STORAGE_UNSUPPORTED"]) {
    const { targets, open } = createTimelineFor({ client: fakeBackend(memories100, { fail: () => code }) });
    await open();
    assert.ok(targets.list.innerHTML.includes(`data-code="${code}"`), code);
    assert.ok(!targets.list.innerHTML.includes("data-tl="), `${code} has no button`);
  }
});

test("a failed load-more keeps the list, shows a retry, and the retry appends", async () => {
  let broken = true;
  const backend = fakeBackend(memories100, { fail: ({ params }) => (broken && params.cursor !== undefined ? "RESOURCE_BUSY" : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.loadMore();
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
  assert.ok(targets.list.innerHTML.includes("後面的記憶載入失敗。") && targets.list.innerHTML.includes("記憶服務目前很忙。"));
  assert.ok(targets.list.innerHTML.includes('data-code="RESOURCE_BUSY"'));
  assert.equal((targets.list.innerHTML.match(/data-tl="loadMore"/gu) ?? []).length, 2, "the retry button and the load-more button");
  broken = false;
  const added = await timeline.loadMore();
  assert.equal(added.length, 12);
  assert.equal(timeline.view().moreError, null);
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 24);
});

test("an answer the view cannot read is reported as unreadable, never shown as an empty timeline", async () => {
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend(memories100, { fail: () => "malformed" }) });
  await open();
  assert.equal(timeline.view().phase, "error");
  assert.equal(timeline.view().error.code, "malformed_response");
  assert.ok(targets.list.innerHTML.includes("記憶服務回傳了看不懂的內容。"));
  assert.ok(!targets.list.innerHTML.includes("還沒有記憶"));
});

test("a failed reload keeps what is on screen and shows the error in the banner with a retry", async () => {
  let broken = false;
  const backend = fakeBackend(memories100, { fail: () => (broken ? "STORAGE_BUSY" : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  broken = true;
  await timeline.reload();
  assert.equal(timeline.view().phase, "ready");
  assert.equal(count(targets.list.innerHTML, /class="mcard"/gu), 12);
  assert.ok(targets.banner.innerHTML.includes("重新整理失敗") && targets.banner.innerHTML.includes('data-tl="reload"'));
  broken = false;
  await timeline.reload();
  assert.equal(timeline.view().notice, null);
});

test("a search that fails says so in the list area and the retry repeats the same search", async () => {
  let broken = true;
  const backend = fakeBackend(memories100, { fail: ({ method }) => (broken && method === "ui.search" ? "INVALID_PARAMS" : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.search("x y");
  assert.equal(timeline.view().phase, "error");
  assert.ok(targets.list.innerHTML.includes("這個畫面送出的條件不正確。"));
  broken = false;
  await timeline.reload();
  assert.equal(backend.calls[backend.calls.length - 1].params.q, "x y");
  assert.equal(timeline.view().phase, "ready");
});

test("clicking a memory hands its reference to the detail hook and nothing else; an unknown key does nothing", async () => {
  const opened = [];
  const { timeline, targets, open } = createTimelineFor({ client: fakeBackend(memories100), onOpenDetail: (ref) => opened.push(ref) });
  await open();
  const [key] = keysIn(targets.list.innerHTML);
  timeline.openItem(key);
  timeline.openItem("[]");
  timeline.openItem("not json");
  assert.deepEqual(opened, [{ agentId: AGENT, scope: "project", projectId: "proj_0abcdefgh", memoryId: "m0000" }]);
  const { timeline: bare, open: openBare } = createTimelineFor({ client: fakeBackend(memories100) });
  await openBare();
  assert.doesNotThrow(() => bare.openItem(key), "the hook is optional");
});

test("coming back to the same agent keeps the list unless it is old, and a different agent starts clean", async () => {
  let clock = NOW;
  const backend = fakeBackend(memories100);
  const { timeline, targets, open } = createTimelineFor({ client: backend, now: () => clock });
  await open();
  await timeline.setFilter("scope", "personal");
  await timeline.search("整理了");
  const calls = backend.calls.length;
  clock += 10_000;
  await open();
  assert.equal(backend.calls.length, calls, "fresh data is shown as it was");
  assert.equal(timeline.view().query, "整理了");
  clock += 5 * 60_000;
  await open();
  assert.equal(backend.calls.length, calls + 1, "old data is refreshed");
  assert.equal(backend.calls[backend.calls.length - 1].params.q, "整理了");
  assert.equal(timeline.view().items.length > 0, true);
  await timeline.open("hw/layout");
  assert.equal(timeline.view().query, null);
  assert.equal(timeline.view().filters.scope, "all");
  assert.equal(targets.query.value, "");
  assert.equal(backend.calls[backend.calls.length - 1].params.agentId, "hw/layout");
  assert.equal(backend.calls[backend.calls.length - 1].params.scope, undefined);
});

test("the requests use one backend key, so the client drops an older timeline request when a newer one starts", async () => {
  const backend = fakeBackend(memories100);
  const { timeline, open } = createTimelineFor({ client: backend });
  await open();
  await timeline.loadMore();
  await timeline.search("請求");
  assert.ok(backend.calls.every((call) => call.options?.key === "timeline"));
});

test("leaving the page detaches the targets so a late answer writes nowhere, and coming back paints the current state", async () => {
  const gate = deferred();
  const backend = fakeBackend(memories100, { before: async ({ index }) => (index === 0 ? gate.promise : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  const opening = open();
  timeline.attach(null);
  const untouched = targets.list.innerHTML;
  gate.resolve();
  await opening;
  assert.equal(targets.list.innerHTML, untouched);
  const fresh = { query: { value: "stale" }, filters: { innerHTML: "" }, clear: { innerHTML: "" }, banner: { innerHTML: "" }, count: { textContent: "" }, list: { innerHTML: "" } };
  timeline.attach(fresh);
  assert.equal(count(fresh.list.innerHTML, /class="mcard"/gu), 12);
  assert.equal(fresh.query.value, "");
  assert.ok(fresh.filters.innerHTML.includes('id="tl-scope"'));
});

test("failure() in the fixture is a real error description, so the tests above exercise the shipped messages", () => {
  const described = failure("CURSOR_STALE");
  assert.equal(described.actionKind, "restartList");
  assert.equal(tl.isCursorReset("CURSOR_STALE"), true);
  assert.equal(tl.isCursorReset("STORAGE_BUSY"), false);
});
