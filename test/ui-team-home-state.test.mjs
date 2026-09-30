import assert from "node:assert/strict";
import test from "node:test";
import { DAY, HOUR, MINUTE, NOW, iso, makeAgent, makeOverview, ui } from "./homeFixtures.mjs";

const { parseOverview, displayName, projectLabel, buildGroups, sortAgents, mergeAgents, avatarHue, avatarLetter, relativeTime, parseRoute, agentHref } = ui;

test("parseOverview accepts the real response shape and keeps optional names optional", () => {
  const agents = [makeAgent(0), makeAgent(1)];
  const page = parseOverview(makeOverview(agents, { nextCursor: "abc", unavailable: 2 }));
  assert.equal(page.agents.length, 2);
  assert.equal(page.nextCursor, "abc");
  assert.equal(page.unavailableAgents, 2);
  assert.equal(page.complete, true);
  assert.equal(page.storageStatus, "ready");
  assert.equal(page.agents[0].name, "代理0");
  assert.equal(page.agents[1].name, undefined);
  assert.equal(page.tiles.agents, 2);
});

test("parseOverview treats a missing complete flag as complete and rejects every malformed shape", () => {
  const good = makeOverview([makeAgent(0)]);
  const { complete: _dropped, ...withoutComplete } = good;
  assert.equal(parseOverview(withoutComplete).complete, true);
  assert.equal(parseOverview({ ...good, complete: false }).complete, false);
  const broken = [
    null,
    [],
    { ...good, ok: false },
    { ...good, tiles: null },
    { ...good, tiles: { ...good.tiles, totalMemories: -1 } },
    { ...good, tiles: { ...good.tiles, writtenToday: "3" } },
    { ...good, agents: "no" },
    { ...good, agents: [{ ...makeAgent(0), spark14: [1, 2, 3] }] },
    { ...good, agents: [{ ...makeAgent(0), id: "" }] },
    { ...good, agents: [{ ...makeAgent(0), team: null }] },
    { ...good, agents: [{ ...makeAgent(0), counts: { ...makeAgent(0).counts, projects: [{ projectId: 1, count: 1 }] } }] },
    { ...good, agents: [{ ...makeAgent(0), latest: { snippet: 5, at: "x" } }] },
    { ...good, agents: [{ ...makeAgent(0), name: 7 }] },
    { ...good, nextCursor: 5 },
    { ...good, complete: "yes" },
    { ...good, storage: { status: "ready" } },
  ];
  broken.forEach((value, index) => assert.equal(parseOverview(value), null, `broken shape ${index}`));
});

test("a card without a name shows the last id segment, whitespace names count as missing, and a lone id stays whole", () => {
  assert.equal(displayName({ id: "sw/developer" }), "developer");
  assert.equal(displayName({ id: "sw/developer", name: "  " }), "developer");
  assert.equal(displayName({ id: "sw/developer", name: " 開發工程師 " }), "開發工程師");
  assert.equal(displayName({ id: "solo" }), "solo");
  assert.equal(displayName({ id: "sw/" }), "sw/");
  assert.equal(displayName({ id: "a/b/c" }), "c");
  assert.equal(projectLabel({ projectId: "proj_6818b64d99", count: 3 }), "專案 proj_681");
  assert.equal(projectLabel({ projectId: "p1", name: "官網改版", count: 3 }), "官網改版");
  assert.equal(projectLabel({ projectId: "p1", name: " ", count: 3 }), "專案 p1");
});

test("groups follow the team key, take the team name from any member that has one, and fall back to the key and to an ungrouped label", () => {
  const agents = [
    makeAgent(0, { team: { key: "sw", name: "軟體開發組" } }),
    makeAgent(1, { team: { key: "sw" } }),
    makeAgent(2, { team: { key: "hw" } }),
    makeAgent(3, { team: { key: "" } }),
  ];
  const groups = buildGroups(agents, "recent");
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
  assert.equal(byKey.sw.label, "軟體開發組");
  assert.equal(byKey.sw.agents.length, 2);
  assert.equal(byKey.hw.label, "hw");
  assert.equal(byKey[""].label, "未分組");
  assert.deepEqual(groups.map((group) => group.total), [...groups.map((group) => group.total)].sort((left, right) => right - left));
  assert.equal(groups.reduce((sum, group) => sum + group.agents.length, 0), 4);
});

test("sorting by recent, count and name is stable and puts agents without a time last", () => {
  const agents = [
    makeAgent(0, { id: "t/c", name: "丙", counts: { personal: 1, projects: [], otherProjects: 0, total: 5 }, lastAt: iso(NOW - HOUR) }),
    makeAgent(1, { id: "t/a", name: "甲", counts: { personal: 1, projects: [], otherProjects: 0, total: 50 }, lastAt: iso(NOW - DAY) }),
    makeAgent(2, { id: "t/b", name: "乙", counts: { personal: 1, projects: [], otherProjects: 0, total: 50 }, lastAt: null, latest: null }),
    makeAgent(3, { id: "t/d", name: "丁", counts: { personal: 1, projects: [], otherProjects: 0, total: 9 }, lastAt: iso(NOW - MINUTE) }),
  ];
  assert.deepEqual(sortAgents(agents, "recent").map((agent) => agent.id), ["t/d", "t/c", "t/a", "t/b"]);
  assert.deepEqual(sortAgents(agents, "count").map((agent) => agent.id), ["t/a", "t/b", "t/d", "t/c"]);
  assert.deepEqual(sortAgents(agents, "name").map((agent) => agent.id), ["t/c", "t/d", "t/a", "t/b"].sort((left, right) => displayName(agents.find((agent) => agent.id === left)).localeCompare(displayName(agents.find((agent) => agent.id === right)), "zh-Hant")));
  assert.deepEqual(agents.map((agent) => agent.id), ["t/c", "t/a", "t/b", "t/d"], "the input is not reordered");
});

test("mergeAgents keeps the first-seen order, replaces a repeated id in place and never duplicates", () => {
  const first = [makeAgent(0), makeAgent(1), makeAgent(2)];
  const later = [makeAgent(2, { latest: null }), makeAgent(3)];
  const merged = mergeAgents(first, later);
  assert.deepEqual(merged.map((agent) => agent.id), first.map((agent) => agent.id).concat(later[1].id));
  assert.equal(merged[2].latest, null);
});

test("the avatar colour depends on the id alone and the letter is the first letter, CJK character or digit", () => {
  assert.equal(avatarHue("sw/developer"), avatarHue("sw/developer"));
  const hues = new Set(Array.from({ length: 200 }, (_, index) => avatarHue(`team/agent${index}`)));
  assert.ok(hues.size > 60, `hue spread ${hues.size}`);
  for (const hue of hues) assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
  assert.equal(avatarLetter("developer"), "D");
  assert.equal(avatarLetter("開發工程師"), "開");
  assert.equal(avatarLetter("__7x"), "7");
  assert.equal(avatarLetter("😀"), "😀");
  assert.equal(avatarLetter(""), "?");
  assert.equal(avatarLetter("ßeta"), "S");
});

test("relative time reads as just now, minutes, hours, days and then a date, and never negative", () => {
  const at = (ms) => relativeTime(iso(NOW - ms), NOW);
  assert.equal(at(20_000), "剛剛");
  assert.equal(at(-5 * MINUTE), "剛剛");
  assert.equal(at(MINUTE), "1 分鐘前");
  assert.equal(at(44 * MINUTE + 30_000), "44 分鐘前");
  assert.equal(at(59 * MINUTE), "59 分鐘前");
  assert.equal(at(60 * MINUTE), "1 小時前");
  assert.equal(at(23 * HOUR + 59 * MINUTE), "23 小時前");
  assert.equal(at(24 * HOUR), "1 天前");
  assert.equal(at(29 * DAY), "29 天前");
  assert.match(at(45 * DAY), /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(relativeTime(null, NOW), "時間不明");
  assert.equal(relativeTime("not a date", NOW), "時間不明");
});

test("the route for an agent round-trips every kind of id, and anything else is the home page", () => {
  for (const id of ["sw/developer", "團隊/小Q", "a b/c#d?e%f", "x/'\"<>&", "😀/🙂"]) {
    const href = agentHref(id);
    assert.ok(/^#\/agent\/[A-Za-z0-9%._~!*'()-]+$/u.test(href), href);
    assert.deepEqual(parseRoute(href), { name: "agent", agentId: id });
  }
  assert.deepEqual(parseRoute(""), { name: "home" });
  assert.deepEqual(parseRoute("#/"), { name: "home" });
  assert.deepEqual(parseRoute("#/agent/"), { name: "home" });
  assert.deepEqual(parseRoute("#/agent/%E0%A4%A"), { name: "home" });
  assert.deepEqual(parseRoute("#/elsewhere"), { name: "home" });
  assert.ok(agentHref("a\ud800b").includes("%EF%BF%BD"), "a lone surrogate is replaced instead of throwing");
});
