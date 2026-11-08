import assert from "node:assert/strict";
import test from "node:test";
import { cardIds, count, createHome, makeAgent, makeOverview, ui } from "./homeFixtures.mjs";

const { STRINGS, parseOverview, displayName, projectLabel, renderBanner, profileNotice, HEALTHY_PROFILE, parseProfileHealth } = ui;

const clone = (value) => JSON.parse(JSON.stringify(value));

function scripted(pages) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const page = pages[Math.min(calls.length - 1, pages.length - 1)];
      return { ok: true, value: clone(page) };
    },
  };
}

const profileOf = (extra) => ({ generation: "g1", receivedAt: "2026-09-30T00:00:00.000Z", ...extra });
const bannerOf = async (profile, agents = [makeAgent(1)]) => {
  const { home, targets } = createHome({ client: scripted([makeOverview(agents, { profile })]) });
  await home.start();
  return { home, banner: targets.banner.innerHTML };
};

test("displayName from the backend is what the card shows, then the table name, then the last segment of the id", () => {
  assert.equal(displayName({ id: "sw/dev", displayName: "開發工程師", name: "別名" }), "開發工程師");
  assert.equal(displayName({ id: "sw/dev", displayName: "dev（sw）" }), "dev（sw）", "the backend's degraded display name is used as sent");
  assert.equal(displayName({ id: "sw/dev", displayName: "  ", name: "別名" }), "別名", "a blank display name defers to the name");
  assert.equal(displayName({ id: "sw/dev", name: "別名" }), "別名");
  assert.equal(displayName({ id: "sw/dev" }), "dev", "neither field: the id's last segment, and the whole id stays under it on the card");
  assert.equal(displayName({ id: "sw/dev", displayName: "", name: " " }), "dev");
  assert.equal(displayName({ id: "solo" }), "solo");
});

test("a project chip uses the project's displayName, then its name, then the project word with the id prefix", () => {
  assert.equal(projectLabel({ projectId: "p1", displayName: "官網改版", name: "別名", count: 1 }), "官網改版");
  assert.equal(projectLabel({ projectId: "p1", displayName: "專案 p1", count: 1 }), "專案 p1");
  assert.equal(projectLabel({ projectId: "p1", displayName: " ", name: "有名字", count: 1 }), "有名字");
  assert.equal(projectLabel({ projectId: "3f9c2a71-8d44", count: 1 }), "專案 3f9c2a71");
});

test("parseOverview reads displayName on agents and projects and refuses one of the wrong type", () => {
  const agent = makeAgent(1, { displayName: "顯示名", counts: { personal: 1, projects: [{ projectId: "p1", name: "名", displayName: "專案顯示名", count: 2 }], otherProjects: 0, total: 3 } });
  const page = parseOverview(clone(makeOverview([agent])));
  assert.equal(page.agents[0].displayName, "顯示名");
  assert.equal(page.agents[0].counts.projects[0].displayName, "專案顯示名");
  assert.equal(parseOverview(clone(makeOverview([makeAgent(1, { displayName: 5 })]))), null);
  assert.equal(parseOverview(clone(makeOverview([makeAgent(1, { counts: { personal: 1, projects: [{ projectId: "p", displayName: 5, count: 1 }], otherProjects: 0, total: 1 } })]))), null);
});

test("the card headline and the name sort follow displayName, and the id is still printed under it", async () => {
  const agents = [
    makeAgent(1, { id: "t/alpha", name: undefined, displayName: "alpha（t）", team: { key: "t" } }),
    makeAgent(2, { id: "t/beta", name: "乙", displayName: "beta", team: { key: "t" } }),
    makeAgent(3, { id: "t/gamma", name: undefined, team: { key: "t" } }),
  ];
  const { home, targets } = createHome({ client: scripted([makeOverview(agents)]) });
  await home.start();
  const wall = targets.wall.innerHTML;
  assert.ok(wall.includes('<span class="acard-name">alpha（t）</span><span class="acard-id">t/alpha</span>'));
  assert.ok(wall.includes('<span class="acard-name">beta</span><span class="acard-id">t/beta</span>'));
  assert.ok(wall.includes('<span class="acard-name">gamma</span><span class="acard-id">t/gamma</span>'), "neither field: the id's last segment");
  home.setSort("name");
  assert.deepEqual(cardIds(targets.wall.innerHTML), ["t/alpha", "t/beta", "t/gamma"], "sorted by the shown names: alpha（t）, beta, gamma, not by the table name 乙");
});

test("a healthy or absent name-table stamp shows no notice", async () => {
  for (const [label, profile] of [
    ["stamp with nothing wrong", profileOf({ incomplete: false, corrupt: false, omitted: { agents: 0, teams: 0, projects: 0 } })],
    ["no table received yet", { generation: null, receivedAt: null }],
    ["an older backend without the flags", profileOf({})],
  ]) {
    const { banner } = await bannerOf(profile);
    assert.ok(!banner.includes("data-notice"), label);
    assert.equal(banner, "", label);
  }
  const page = parseOverview(clone({ ...makeOverview([makeAgent(1)]), profile: undefined }));
  assert.deepEqual(page.profile, HEALTHY_PROFILE, "a missing stamp reads as healthy instead of refusing the page");
  assert.equal(page.agents.length, 1);
});

test("profile.corrupt tells the reader the names could not be read, that ids are shown instead, and that the memories are fine", async () => {
  const { banner, home } = await bannerOf(profileOf({ corrupt: true, incomplete: false, omitted: { agents: 0, teams: 0, projects: 0 } }));
  assert.ok(banner.includes('data-notice="profile"') && banner.includes('role="status"'));
  assert.ok(banner.includes(STRINGS["home.profile.corrupt"]));
  assert.ok(STRINGS["home.profile.corrupt"].includes("代號") && STRINGS["home.profile.corrupt"].includes("記憶不受影響"));
  assert.equal(home.view().profile.corrupt, true);
  assert.equal(count(banner, /<div class="notice"/gu), 1);
});

test("profile.incomplete names how many agents, departments and projects lost their names, only the non-zero ones", async () => {
  const cases = [
    [{ agents: 3, teams: 1, projects: 2 }, "3 位 agent、1 個部門、2 個專案"],
    [{ agents: 0, teams: 0, projects: 4 }, "4 個專案"],
    [{ agents: 1200, teams: 0, projects: 0 }, "1,200 位 agent"],
  ];
  for (const [omitted, detail] of cases) {
    const { banner } = await bannerOf(profileOf({ incomplete: true, corrupt: false, omitted }));
    assert.ok(banner.includes(`有 ${detail} 沒收進來`), `${detail} in ${banner}`);
    assert.ok(banner.includes("先用代號顯示"));
    assert.ok(banner.includes('data-notice="profile"'));
  }
});

test("an incomplete table with no counts, or counts without the flag, still gives the reader a sentence", async () => {
  const vague = await bannerOf(profileOf({ incomplete: true, omitted: { agents: 0, teams: 0, projects: 0 } }));
  assert.ok(vague.banner.includes(STRINGS["home.profile.incompleteUnknown"]));
  const counted = await bannerOf(profileOf({ incomplete: false, omitted: { agents: 2, teams: 0, projects: 0 } }));
  assert.ok(counted.banner.includes("有 2 位 agent 沒收進來"), "omitted above zero means incomplete whatever the flag says");
});

test("a damaged table outranks an incomplete one: one sentence, the damaged one", async () => {
  const { banner } = await bannerOf(profileOf({ corrupt: true, incomplete: true, omitted: { agents: 5, teams: 0, projects: 0 } }));
  assert.equal(count(banner, /data-notice="profile"/gu), 1);
  assert.ok(banner.includes(STRINGS["home.profile.corrupt"]) && !banner.includes("沒收進來"));
});

test("a garbled stamp degrades to healthy and never blocks the cards", () => {
  for (const garbled of [null, "x", 5, [], { corrupt: "yes", omitted: "all" }, { incomplete: 1, omitted: { agents: -2, teams: "3", projects: null } }]) {
    const health = parseProfileHealth(garbled);
    assert.deepEqual(health, HEALTHY_PROFILE, JSON.stringify(garbled));
  }
  assert.equal(profileNotice(HEALTHY_PROFILE), "");
});

test("the notice follows the latest page: it goes away when a refresh brings a healthy table, and a later page can raise it", async () => {
  const agents = Array.from({ length: 4 }, (_, index) => makeAgent(index));
  const client = scripted([
    makeOverview(agents, { profile: profileOf({ corrupt: true }) }),
    makeOverview(agents, { profile: profileOf({}) }),
    makeOverview(agents, { profile: profileOf({ incomplete: true, omitted: { agents: 1, teams: 0, projects: 0 } }) }),
  ]);
  const { home, targets } = createHome({ client });
  await home.start();
  assert.ok(targets.banner.innerHTML.includes(STRINGS["home.profile.corrupt"]));
  await home.reload();
  assert.equal(targets.banner.innerHTML, "", "the table healed");
  await home.reload();
  assert.ok(targets.banner.innerHTML.includes("有 1 位 agent 沒收進來"));

  const paged = scripted([makeOverview(agents.slice(0, 2), { all: agents, nextCursor: "2", profile: profileOf({}) }), makeOverview(agents.slice(2), { all: agents, profile: profileOf({ corrupt: true }) })]);
  const second = createHome({ client: paged, pageSize: 2 });
  await second.home.start();
  assert.equal(second.targets.banner.innerHTML, "");
  await second.home.loadMore();
  assert.ok(second.targets.banner.innerHTML.includes(STRINGS["home.profile.corrupt"]), "a continuation page carries the stamp too");
});

test("the notice sits with the other banner notices, after them, and is not shown while the page is loading or failed", async () => {
  const view = { phase: "ready", error: null, notice: null, moreError: null, tiles: null, agents: [], hasMore: false, loadingMore: false, complete: false, unavailableAgents: 2, profile: parseProfileHealth({ corrupt: true }), team: null, sort: "recent", helpOpen: false };
  const markup = renderBanner(view).value;
  assert.ok(markup.indexOf(STRINGS["overview.incomplete"]) < markup.indexOf("讀不到") && markup.indexOf("讀不到") < markup.indexOf(STRINGS["home.profile.corrupt"]));
  assert.equal(renderBanner({ ...view, phase: "loading" }).value, "");
  assert.equal(renderBanner({ ...view, phase: "error" }).value, "");
});
