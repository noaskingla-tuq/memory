import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_ATTRIBUTES, ALLOWED_TAGS, NOW, cardIds, count, createHome, failure, iso, makeAgent, makeOverview, memoryPreferences, pagedBackend, tokenize, ui } from "./homeFixtures.mjs";

const { STRINGS, t } = ui;

const agents100 = Array.from({ length: 100 }, (_, index) => makeAgent(index));

function assertSafe(markup, label) {
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

test("100 agents: the first page is 60 cards, load more brings the other 40 with no duplicate, and every card sits in its department", async () => {
  const backend = pagedBackend(agents100);
  const { home, targets } = createHome({ client: backend });
  await home.start();
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].params.limit, 60);
  assert.equal(backend.calls[0].params.cursor, undefined);
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 60);
  assert.ok(targets.wall.innerHTML.includes('data-act="loadMore"'));
  assert.equal(targets.count.textContent, "已載入 60 位，共 100 位 agent");
  const firstIds = cardIds(targets.wall.innerHTML);
  assert.equal(new Set(firstIds).size, 60);

  const added = await home.loadMore();
  assert.equal(added.length, 40);
  assert.equal(backend.calls[1].params.cursor, "60");
  const ids = cardIds(targets.wall.innerHTML);
  assert.equal(ids.length, 100);
  assert.equal(new Set(ids).size, 100, "no card appears twice");
  assert.deepEqual([...ids].sort(), agents100.map((agent) => agent.id).sort());
  assert.ok(!targets.wall.innerHTML.includes('data-act="loadMore"'), "the button is gone when nothing is left");
  assert.equal(targets.count.textContent, "已載入更多，現在顯示 100 位 agent");
  assert.equal(count(targets.wall.innerHTML, /<section class="team"/gu), 10);
  for (const group of targets.wall.innerHTML.split('<section class="team"').slice(1)) {
    const teams = new Set([...group.matchAll(/data-agent-id="(team\d)\//gu)].map((match) => match[1]));
    assert.equal(teams.size, 1, "a department section holds one team only");
  }
  assert.equal(home.view().hasMore, false);
});

test("a continuation page that overlaps the previous one still yields each card once", async () => {
  const backend = pagedBackend(agents100, { overlap: 7 });
  const { home, targets } = createHome({ client: backend });
  await home.start();
  const added = await home.loadMore();
  assert.equal(added.length, 40, "the seven repeated agents are not reported as new");
  const ids = cardIds(targets.wall.innerHTML);
  assert.equal(ids.length, 100);
  assert.equal(new Set(ids).size, 100);
});

test("the summary tiles, department headers and card facts read the way the design shows them", async () => {
  const few = [makeAgent(1), makeAgent(3, { counts: { personal: 4, projects: [{ projectId: "p1", name: "官網改版", count: 8 }, { projectId: "p2", count: 3 }, { projectId: "p3", count: 2 }], otherProjects: 5, total: 22 } })];
  const { home, targets } = createHome({ client: pagedBackend(few) });
  await home.start();
  const tiles = targets.tiles.innerHTML;
  assert.ok(tiles.includes("<span>累積記憶</span>"));
  assert.ok(tiles.includes("今天寫入") && !tiles.includes("今天新增"));
  assert.ok(tiles.includes("<b>62</b>") && tiles.includes("近 7 天有工作的 agent") && tiles.includes("<b>2 / 2</b>"));
  const wall = targets.wall.innerHTML;
  assert.ok(wall.includes("最近記得：") && wall.includes("最近做的事 3"));
  assert.ok(wall.includes("個人 4") && wall.includes("官網改版 8") && wall.includes("專案 p2 3"));
  assert.ok(wall.includes("＋2 以上"), "three shown projects, two hidden, and more beyond the five");
  assert.equal(count(wall, /<rect/gu), 28, "two 14-day sparklines");
  assert.ok(wall.includes("累積 22 筆") && wall.includes("最近 "));
  assert.ok(wall.includes(`href="#/agent/${encodeURIComponent("team3/agent003")}"`));
  assert.ok(/aria-label="代理3，累積 22 筆，最近寫入 .*，開啟記憶空間"/u.test(wall));
  assert.ok(!/tabindex="-1"/u.test(wall), "cards are ordinary links a keyboard can reach");
  assert.ok(/<a class="acard" href="#\/agent\//u.test(wall), "a card is a real link, so Enter opens it");
  assert.equal(count(wall, /<svg /gu), 2);
  assert.ok(wall.includes('role="img"'));
});

test("names come from the overview when there are any and degrade to the last id segment when there are not", async () => {
  const mixed = [
    makeAgent(1, { id: "sw/developer", name: "開發工程師", team: { key: "sw", name: "軟體開發組" } }),
    makeAgent(2, { id: "sw/tester", team: { key: "sw", name: "軟體開發組" } }),
    makeAgent(3, { id: "lone", name: undefined, team: { key: "" } }),
    makeAgent(4, { id: "hw/layout", team: { key: "hw" }, counts: { personal: 3, projects: [], otherProjects: 0, total: 3 } }),
  ];
  const { home, targets } = createHome({ client: pagedBackend(mixed) });
  await home.start();
  const wall = targets.wall.innerHTML;
  assert.ok(wall.includes('<span class="acard-name">開發工程師</span><span class="acard-id">sw/developer</span>'));
  assert.ok(wall.includes('<span class="acard-name">tester</span><span class="acard-id">sw/tester</span>'), "no name: last id segment, the full id stays below it");
  assert.ok(wall.includes('<span class="acard-name">lone</span>'));
  assert.ok(wall.includes("沒有專案記憶"), "an agent with no project memory says so");
  assert.ok(wall.includes("<b>軟體開發組</b>") && wall.includes("<b>hw</b>") && wall.includes("<b>未分組</b>"));
  assert.ok(targets.tools.innerHTML.includes("軟體開發組（2）") && targets.tools.innerHTML.includes("全部部門（3）"));
});

test("an empty memory explains where memories come from and that project memory needs a project, instead of showing a blank page", async () => {
  const backend = { async call() { return { ok: true, value: makeOverview([], { tiles: { totalMemories: 0, writtenToday: 0, activeAgents7d: 0, agents: 0, lastWriteAt: null } }) }; } };
  const { home, targets } = createHome({ client: backend });
  await home.start();
  const wall = targets.wall.innerHTML;
  assert.ok(wall.includes(STRINGS["home.empty.title"]) && wall.includes(STRINGS["home.empty.body"]));
  assert.ok(wall.includes(STRINGS["home.help.body"]), "how a memory comes about");
  assert.ok(wall.includes(STRINGS["home.projectNote"]), "the project memory note (D9) shows even with nothing to list");
  assert.equal(count(wall, /class="acard"/gu), 0);
  assert.equal(targets.tools.innerHTML, "");
  assert.equal(targets.help.innerHTML, "", "the first-use panel is not stacked on the empty state");
  assert.equal(home.view().phase, "ready");
});

test("the first-use explanation shows once, is remembered when dismissed and can be opened again", async () => {
  const preferences = memoryPreferences();
  const first = createHome({ client: pagedBackend(agents100.slice(0, 5)), preferences });
  await first.home.start();
  assert.ok(first.targets.help.innerHTML.includes("記憶是怎麼來的") && first.targets.help.innerHTML.includes(STRINGS["home.help.body"]));
  assert.ok(first.targets.help.innerHTML.includes('data-act="dismissHelp"'));
  assert.ok(!first.targets.tools.innerHTML.includes("showHelp"));
  first.home.dismissHelp();
  assert.equal(first.targets.help.innerHTML, "");
  assert.ok(first.targets.tools.innerHTML.includes('data-act="showHelp"'));
  assert.equal(preferences.store.get("memory.home.helpDismissed"), "1");
  const second = createHome({ client: pagedBackend(agents100.slice(0, 5)), preferences });
  await second.home.start();
  assert.equal(second.targets.help.innerHTML, "", "a later visit does not show it again");
  second.home.showHelp();
  assert.ok(second.targets.help.innerHTML.includes("記憶是怎麼來的"));
});

test("the project note is on the page whenever there are cards", async () => {
  const { home, targets } = createHome({ client: pagedBackend(agents100.slice(0, 3)) });
  await home.start();
  assert.equal(targets.note.textContent, "專案記憶只在任務有掛上專案時才會出現；沒掛專案的工作都記在「個人」。");
});

test("while the first page is on its way the page shows skeleton tiles and cards, announced as reading", async () => {
  let release;
  const backend = { call: () => new Promise((resolve) => { release = () => resolve({ ok: true, value: makeOverview(agents100.slice(0, 2)) }); }) };
  const { home, targets } = createHome({ client: backend });
  const started = home.start();
  assert.equal(home.view().phase, "loading");
  assert.equal(count(targets.wall.innerHTML, /class="acard skeleton"/gu), 6);
  assert.equal(count(targets.tiles.innerHTML, /card tile skeleton/gu), 3);
  assert.ok(targets.wall.innerHTML.includes('role="status"') && targets.wall.innerHTML.includes("正在讀取記憶…"));
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 0);
  release();
  await started;
  assert.equal(count(targets.wall.innerHTML, /class="acard skeleton"/gu), 0);
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 2);
});

test("a failed first load says what happened in plain words with one thing to do, and a retry recovers", async () => {
  const outcomes = [failure("STORAGE_BUSY"), { ok: true, value: makeOverview(agents100.slice(0, 2)) }];
  const backend = { async call() { return outcomes.shift(); } };
  const { home, targets } = createHome({ client: backend });
  await home.start();
  const wall = targets.wall.innerHTML;
  assert.equal(home.view().phase, "error");
  assert.ok(wall.includes(STRINGS["error.STORAGE_BUSY.message"]) && wall.includes(STRINGS["error.STORAGE_BUSY.action"]));
  assert.ok(wall.includes('role="alert"') && wall.includes('data-act="reload"') && wall.includes(">重試<"));
  assert.ok(!/STORAGE_BUSY/u.test(wall.replace('data-code="STORAGE_BUSY"', "")), "the raw code is not part of the wording");
  assert.equal(targets.tiles.innerHTML, "");
  await home.reload();
  assert.equal(home.view().phase, "ready");
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 2);
});

test("errors that cannot be retried offer no retry button, and a stale cursor offers a fresh start", async () => {
  for (const code of ["plugin_disabled", "plugin_permission_denied", "backend_method_not_allowed", "STORAGE_UNSUPPORTED"]) {
    const { home, targets } = createHome({ client: { async call() { return failure(code); } } });
    await home.start();
    assert.ok(targets.wall.innerHTML.includes(STRINGS[`error.${code}.message`]), code);
    assert.ok(!targets.wall.innerHTML.includes("<button"), `${code} offers no retry`);
  }
  const backend = pagedBackend(agents100);
  const { home, targets } = createHome({ client: backend });
  await home.start();
  const real = backend.call.bind(backend);
  backend.call = async (method, params, options) => (params.cursor === undefined ? real(method, params, options) : failure("CURSOR_STALE"));
  await home.loadMore();
  assert.ok(targets.wall.innerHTML.includes(STRINGS["error.CURSOR_STALE.message"]));
  assert.ok(targets.wall.innerHTML.includes(STRINGS["common.reloadFromStart"]) && targets.wall.innerHTML.includes('data-act="reload"'));
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 60, "the cards already shown stay");
  await home.reload();
  assert.equal(home.view().moreError, null);
  assert.equal(home.view().hasMore, true, "the reload starts again from page one");
});

test("a failed load-more keeps the cards, shows a retry, and the retry appends", async () => {
  const backend = pagedBackend(agents100);
  const real = backend.call.bind(backend);
  let fail = true;
  backend.call = async (method, params, options) => (params.cursor !== undefined && fail ? failure("RESOURCE_BUSY") : real(method, params, options));
  const { home, targets } = createHome({ client: backend });
  await home.start();
  await home.loadMore();
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 60);
  assert.ok(targets.wall.innerHTML.includes(STRINGS["home.moreFailed"]) && targets.wall.innerHTML.includes('data-act="loadMore"'));
  fail = false;
  await home.loadMore();
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 100);
  assert.ok(!targets.wall.innerHTML.includes(STRINGS["home.moreFailed"]));
});

test("a response the view cannot read is reported as unreadable, not shown as an empty memory", async () => {
  const { home, targets } = createHome({ client: { async call() { return { ok: true, value: { ok: true, tiles: 5 } }; } } });
  await home.start();
  assert.equal(home.view().phase, "error");
  assert.ok(targets.wall.innerHTML.includes(STRINGS["error.malformed_response.message"]));
});

test("an incomplete overview warns that the numbers may be short, and unreadable agent stores are counted", async () => {
  const backend = { async call() { return { ok: true, value: makeOverview(agents100.slice(0, 3), { complete: false, unavailable: 2 }) }; } };
  const { home, targets } = createHome({ client: backend });
  await home.start();
  assert.ok(targets.banner.innerHTML.includes(STRINGS["overview.incomplete"]));
  assert.ok(targets.banner.innerHTML.includes('data-act="reload"') && targets.banner.innerHTML.includes("重新整理"));
  assert.ok(targets.banner.innerHTML.includes("有 2 位 agent 的記憶庫目前讀不到"));
  const complete = createHome({ client: pagedBackend(agents100.slice(0, 3)) });
  await complete.home.start();
  assert.equal(complete.targets.banner.innerHTML, "");
});

test("a failed refresh keeps what is on screen and offers a retry in the banner", async () => {
  const outcomes = [{ ok: true, value: makeOverview(agents100.slice(0, 4)) }, failure("STORAGE_BUSY")];
  const { home, targets } = createHome({ client: { async call() { return outcomes.shift(); } } });
  await home.start();
  await home.reload();
  assert.equal(home.view().phase, "ready");
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 4);
  assert.ok(targets.banner.innerHTML.includes(STRINGS["error.STORAGE_BUSY.message"]) && targets.banner.innerHTML.includes('data-act="reload"'));
});

test("the department filter and the three sort orders act on what is loaded", async () => {
  const { home, targets } = createHome({ client: pagedBackend(agents100), pageSize: 200 });
  await home.start();
  assert.equal(count(targets.tools.innerHTML, /<option/gu), 1 + 10 + 3);
  assert.ok(targets.tools.innerHTML.includes('<option value="" selected>全部部門（10）</option>'));
  assert.ok(targets.tools.innerHTML.includes('value="t:team4"'));
  home.setTeam("t:team4");
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 10);
  assert.ok(cardIds(targets.wall.innerHTML).every((id) => id.startsWith("team4/")));
  assert.equal(count(targets.wall.innerHTML, /<section class="team"/gu), 1);
  assert.equal(targets.count.textContent, "顯示 10 位 agent");
  home.setTeam("t:no-such-team");
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 100, "an unknown department falls back to all");
  home.setTeam("");
  home.setSort("count");
  const totals = [...targets.wall.innerHTML.split('<section class="team"')[1].matchAll(/累積 (\d+) 筆/gu)].map((match) => Number(match[1]));
  assert.deepEqual(totals, [...totals].sort((left, right) => right - left));
  home.setSort("recent");
  const firstTeam = targets.wall.innerHTML.split('<section class="team"')[1];
  const firstIds = cardIds(firstTeam);
  const times = firstIds.map((id) => Date.parse(agents100.find((agent) => agent.id === id).lastAt));
  assert.deepEqual(times, [...times].sort((left, right) => right - left));
  home.setSort("nonsense");
  assert.equal(home.view().sort, "recent", "an unknown sort key is ignored");
  home.setSort("name");
  assert.equal(home.view().sort, "name");
});

test("a reload while a load-more is in flight drops the old answer", async () => {
  const backend = pagedBackend(agents100);
  const real = backend.call.bind(backend);
  let releaseMore;
  backend.call = (method, params, options) => (params.cursor === undefined ? real(method, params, options) : new Promise((resolve) => { releaseMore = () => resolve(real(method, params, options)); }));
  const { home, targets } = createHome({ client: backend });
  await home.start();
  const pending = home.loadMore();
  await home.reload();
  releaseMore();
  const added = await pending;
  assert.deepEqual(added, []);
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 60, "only the reloaded first page is shown");
});

test("the overview request carries the local day start and the offset east of UTC", async () => {
  const backend = pagedBackend(agents100.slice(0, 3));
  const { home } = createHome({ client: backend });
  await home.start();
  const { params, options } = backend.calls[0];
  const start = new Date(2026, 8, 30);
  assert.equal(params.dayStartIso, start.toISOString());
  assert.equal(Date.parse(params.dayStartIso) % 1000, 0);
  assert.equal(params.tzOffsetMin, -start.getTimezoneOffset() + 0);
  assert.equal(options.key, "overview");
  assert.ok(Object.is(params.tzOffsetMin, 0) || params.tzOffsetMin !== 0, "no negative zero");
});

test("refreshIfStale reloads only after the data is older than the limit", async () => {
  let now = NOW;
  const backend = pagedBackend(agents100.slice(0, 3));
  const { home } = createHome({ client: backend, now: () => now });
  await home.start();
  now += 30_000;
  await home.refreshIfStale(60_000);
  assert.equal(backend.calls.length, 1);
  now += 40_000;
  await home.refreshIfStale(60_000);
  assert.equal(backend.calls.length, 2);
});

test("every dynamic string is escaped: hostile names, ids, snippets, project and department names cannot inject markup", async () => {
  const hostile = [
    `<img src=x onerror=alert(1)>`,
    `"><script>alert(2)</script>`,
    `' onmouseover='alert(3)`,
    `</a><svg onload=alert(4)>`,
    "`${1+1}`&amp;",
    "javascript:alert(5)",
  ];
  const evil = hostile.map((payload, index) =>
    makeAgent(index, {
      id: `${payload}/${payload}`,
      name: payload,
      team: { key: payload, name: payload },
      title: payload,
      counts: { personal: 1, projects: [{ projectId: payload, name: payload, count: 2 }, { projectId: payload + "2", count: 1 }], otherProjects: 0, total: 3 },
      latest: { snippet: payload, at: iso(NOW) },
    }),
  );
  const { home, targets } = createHome({ client: { async call() { return { ok: true, value: makeOverview(evil) }; } } });
  await home.start();
  for (const [name, markup] of [["wall", targets.wall.innerHTML], ["tools", targets.tools.innerHTML], ["tiles", targets.tiles.innerHTML], ["banner", targets.banner.innerHTML], ["help", targets.help.innerHTML]]) assertSafe(markup, name);
  const wall = targets.wall.innerHTML;
  assert.equal(count(wall, /class="acard"/gu), 6);
  assert.ok(wall.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(wall.includes("&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"));
  assert.ok(!wall.includes("<script") && !/<img\b[^>]*\bonerror=/iu.test(wall) && !wall.includes("<svg onload"));
  assert.ok(!targets.tools.innerHTML.includes("<script") && !targets.tools.innerHTML.includes("<img"));
  const failed = createHome({ client: { async call() { return { ok: false, superseded: false, attempts: 1, code: `<b>"x"</b>`, known: false, source: "client", message: `<i>m</i>`, action: `<u>a</u>`, actionKind: "report", retryable: false }; } } });
  await failed.home.start();
  assertSafe(failed.targets.wall.innerHTML, "error wall");
  assert.ok(failed.targets.wall.innerHTML.includes("&lt;i&gt;m&lt;/i&gt;"));
});

test("the tokenizer used by the injection test does catch an injected tag or handler", () => {
  assert.ok(tokenize('<a class="x" onclick="y">t</a>').tags[0].attributes.some(([name]) => name === "onclick"));
  assert.ok(/[<>]/u.test(tokenize("<a>t</a><script").rest));
  assert.throws(() => assertSafe('<a class="x" onclick="y">t</a>', "mutant"));
  assert.throws(() => assertSafe("<b>t</b><img src=x>", "mutant"));
  assert.throws(() => assertSafe("<a>1 < 2</a>", "mutant"));
});

test("the department label uses the department name, and a card never shows raw JSON or undefined", async () => {
  const { home, targets } = createHome({ client: pagedBackend(agents100), pageSize: 200 });
  await home.start();
  for (const markup of [targets.wall.innerHTML, targets.tools.innerHTML, targets.tiles.innerHTML]) {
    assert.ok(!/undefined|null|NaN|\[object/u.test(markup), markup.match(/.{0,20}(undefined|null|NaN|\[object).{0,20}/u)?.[0]);
  }
  assert.ok(targets.wall.innerHTML.includes("<b>部門0</b>"));
  assert.ok(t("home.team.summary", { agents: 10, count: 500 }).includes("10 位"));
});
