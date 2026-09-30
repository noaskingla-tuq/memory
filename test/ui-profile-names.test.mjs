import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { degradedAgentName, degradedProjectName } from "../out/application/ui/names.js";
import { SAMPLE, agentEntry, partsOf, pushAll } from "./profileHarness.mjs";
import { DAY_START, bytesOf, daysAgo, punchContent, seed, startStore } from "./uiHarness.mjs";

const OVERVIEW = { tzOffsetMin: 480, dayStartIso: DAY_START };
const LONG_PROJECT = "3f9c2a71-8d44-4c0e-b1aa-0123456789ab";

async function build(t) {
  const store = startStore(t);
  const at = (hour) => daysAgo(0, hour);
  const made = await seed(store, [
    { agentId: "sw/dev", projectId: null, sessionId: "S1", content: punchContent({ startMs: Date.parse(at(1)), title: "Alpha job", body: "alpha result" }), updatedAt: at(5) },
    { agentId: "sw/dev", projectId: "p1", sessionId: "S1", content: "project note in p1", updatedAt: at(6) },
    { agentId: "sw/dev", projectId: LONG_PROJECT, sessionId: "S1", content: "project note in a long id project", updatedAt: at(7) },
    { agentId: "ops/x", projectId: null, sessionId: "S2", content: "ops note", updatedAt: at(8) },
    { agentId: "1997-factory/old-timer", projectId: null, sessionId: "S3", content: "an agent that left the registry", updatedAt: at(9) },
    { agentId: "loner", projectId: null, sessionId: "S4", content: "an agent without a team", updatedAt: at(10) },
  ]);
  return { store, made, byPrefix: (prefix) => made.find((row) => row.content.startsWith(prefix)) };
}

const cardOf = (overview, id) => overview.agents.find((card) => card.id === id);
const refOf = (row) => ({ agentId: row.agentId, scope: row.scope, projectId: row.projectId, memoryId: row.id });
const conforms = (method, response) => assert.equal(parseUiResponse(method, response), true, `${method} ${JSON.stringify(response).slice(0, 400)}`);

test("the degraded names follow the rules: agent id last segment plus team key, project word plus the first 8 characters of the id", () => {
  assert.equal(degradedAgentName("sw/dev", "sw"), "dev（sw）");
  assert.equal(degradedAgentName("1997-factory/old-timer", "1997-factory"), "old-timer（1997-factory）");
  assert.equal(degradedAgentName("a/b/c", "a"), "c（a）");
  assert.equal(degradedAgentName("loner", ""), "loner");
  assert.equal(degradedAgentName("sw/", "sw"), "sw（sw）");
  assert.equal(degradedProjectName(LONG_PROJECT), "專案 3f9c2a71");
  assert.equal(degradedProjectName("p1"), "專案 p1");
  assert.equal(degradedProjectName("專案編號一二三四五六七八九"), "專案 專案編號一二三四");
});

test("without a name table every ui method still shows a degraded name", async (t) => {
  const { store, byPrefix } = await build(t);
  const overview = await store.backend.call("ui.overview", OVERVIEW);
  conforms("ui.overview", overview);
  const dev = cardOf(overview, "sw/dev");
  assert.equal("name" in dev, false);
  assert.equal(dev.displayName, "dev（sw）");
  assert.deepEqual(dev.team, { key: "sw" });
  assert.equal(cardOf(overview, "loner").displayName, "loner");
  assert.deepEqual(cardOf(overview, "loner").team, { key: "" });
  assert.deepEqual(dev.counts.projects.map((project) => project.displayName).sort(), ["專案 3f9c2a71", "專案 p1"]);
  const list = await store.backend.call("ui.list", { limit: 24 });
  conforms("ui.list", list);
  const item = list.items.find((entry) => entry.ref.projectId === LONG_PROJECT);
  assert.deepEqual(item.names, { agent: { displayName: "dev（sw）", teamKey: "sw" }, project: { displayName: "專案 3f9c2a71" } });
  assert.equal(list.items.find((entry) => entry.ref.agentId === "ops/x").names.project, null, "a personal memory has no project");
  const got = await store.backend.call("ui.get", refOf(byPrefix("project note in p1")));
  conforms("ui.get", got);
  assert.deepEqual(got.names, { agent: { displayName: "dev（sw）", teamKey: "sw" }, project: { displayName: "專案 p1" } });
  const stats = await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 });
  conforms("ui.agentStats", stats);
  assert.deepEqual(stats.agent, { displayName: "dev（sw）", teamKey: "sw" });
  assert.deepEqual(stats.namespaces.filter((namespace) => namespace.scope === "project").map((namespace) => namespace.project.displayName).sort(), ["專案 3f9c2a71", "專案 p1"]);
  assert.equal(stats.namespaces.find((namespace) => namespace.scope === "personal").project, null);
  const search = await store.backend.call("ui.search", { q: "note" });
  conforms("ui.search", search);
  assert.ok(search.items.every((entry) => typeof entry.names.agent.displayName === "string"));
});

test("names from the table appear in overview, list, search, get and agentStats, and team names come from teams[]", async (t) => {
  const { store, byPrefix } = await build(t);
  await pushAll(store.backend, partsOf(SAMPLE, 2));
  const overview = await store.backend.call("ui.overview", OVERVIEW);
  conforms("ui.overview", overview);
  const dev = cardOf(overview, "sw/dev");
  assert.deepEqual([dev.name, dev.displayName, dev.title, dev.team], ["開發工程師", "開發工程師", "寫程式的人", { key: "sw", name: "軟體組" }]);
  assert.deepEqual(dev.counts.projects.find((project) => project.projectId === "p1"), { projectId: "p1", name: "第一個專案", displayName: "第一個專案", count: 1 });
  assert.equal(dev.counts.projects.find((project) => project.projectId === LONG_PROJECT).displayName, "專案 3f9c2a71", "a project the table does not know is degraded");
  const ops = cardOf(overview, "ops/x");
  assert.deepEqual([ops.name, ops.team], ["維運小幫手", { key: "ops", name: "維運組" }]);
  const solo = cardOf(overview, "loner");
  assert.deepEqual([solo.displayName, solo.team], ["loner", { key: "" }], "an agent the table does not know is degraded");
  const stranger = cardOf(overview, "1997-factory/old-timer");
  assert.deepEqual([stranger.displayName, stranger.team], ["old-timer（1997-factory）", { key: "1997-factory" }]);
  assert.equal(overview.profile.generation, partsOf(SAMPLE, 1)[0].generation);

  const list = await store.backend.call("ui.list", { agentId: "sw/dev", limit: 24 });
  conforms("ui.list", list);
  const inP1 = list.items.find((entry) => entry.ref.projectId === "p1");
  assert.deepEqual(inP1.names, { agent: { displayName: "開發工程師", name: "開發工程師", teamKey: "sw", teamName: "軟體組" }, project: { displayName: "第一個專案", name: "第一個專案" } });
  const search = await store.backend.call("ui.search", { q: "ops note" });
  assert.deepEqual(search.items[0].names.agent, { displayName: "維運小幫手", name: "維運小幫手", teamKey: "ops", teamName: "維運組" });
  const got = await store.backend.call("ui.get", refOf(byPrefix("project note in p1")));
  conforms("ui.get", got);
  assert.equal(got.names.agent.name, "開發工程師");
  assert.equal(got.names.project.name, "第一個專案");
  assert.ok(got.sameSession.every((item) => item.names.agent.name === "開發工程師"));
  const stats = await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 });
  conforms("ui.agentStats", stats);
  assert.deepEqual(stats.agent, { displayName: "開發工程師", name: "開發工程師", title: "寫程式的人", teamKey: "sw", teamName: "軟體組" });
  assert.equal(stats.namespaces.find((namespace) => namespace.projectId === "p1").project.name, "第一個專案");
  assert.ok(stats.representative.every((item) => item.names.agent.name === "開發工程師"));
});

test("a team key that only the id prefix supplies still gets its name from teams[]", async (t) => {
  const { store } = await build(t);
  await pushAll(store.backend, partsOf({ agents: [], teams: [{ key: "1997-factory", name: "舊工廠" }], projects: [] }, 1));
  const overview = await store.backend.call("ui.overview", OVERVIEW);
  const old = cardOf(overview, "1997-factory/old-timer");
  assert.deepEqual([old.displayName, old.team], ["old-timer（1997-factory）", { key: "1997-factory", name: "舊工廠" }]);
  const list = await store.backend.call("ui.list", { agentId: "1997-factory/old-timer" });
  assert.deepEqual(list.items[0].names.agent, { displayName: "old-timer（1997-factory）", teamKey: "1997-factory", teamName: "舊工廠" });
});

test("an agent listed without a team keeps the id-prefix team, and a listed team key wins over the prefix", async (t) => {
  const { store } = await build(t);
  await pushAll(
    store.backend,
    partsOf({ agents: [agentEntry("sw/dev", "開發工程師", null), agentEntry("ops/x", "維運小幫手", "night-shift")], teams: [{ key: "night-shift", name: "夜班" }], projects: [] }, 1),
  );
  const overview = await store.backend.call("ui.overview", OVERVIEW);
  assert.deepEqual(cardOf(overview, "sw/dev").team, { key: "sw" });
  assert.deepEqual(cardOf(overview, "ops/x").team, { key: "night-shift", name: "夜班" });
  assert.deepEqual(
    overview.agents.map((card) => card.team.key),
    ["", "1997-factory", "night-shift", "sw"],
    "cards are ordered by the team key the table gave, and the id-prefix team key for the agent the table lists without a team",
  );
});

test("a new generation replaces the names everywhere, including agentStats answers cached for the old generation", async (t) => {
  const { store } = await build(t);
  await pushAll(store.backend, partsOf(SAMPLE, 1));
  const first = await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 });
  assert.equal(first.agent.name, "開發工程師");
  const renamed = { ...SAMPLE, agents: SAMPLE.agents.map((entry) => (entry.id === "sw/dev" ? { ...entry, name: "資深開發" } : entry)) };
  await pushAll(store.backend, partsOf(renamed, 1));
  const second = await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 });
  assert.equal(second.agent.name, "資深開發");
  assert.equal(cardOf(await store.backend.call("ui.overview", OVERVIEW), "sw/dev").name, "資深開發");
});

test("ui.status carries the sink and the incompleteness while ui.overview and the other methods stay within budget", async (t) => {
  const { store } = await build(t);
  await pushAll(store.backend, partsOf({ ...SAMPLE, omitted: { agents: 2, teams: 1, projects: 0 } }, 2, { sink: { pending: 7, lastWrittenAtMs: 1_700_000_000_000 } }));
  const status = await store.backend.call("ui.status", {});
  conforms("ui.status", status);
  assert.deepEqual(status.profile.sink, { pending: 7, lastWrittenAtMs: 1_700_000_000_000 });
  assert.equal(status.profile.incomplete, true);
  const overview = await store.backend.call("ui.overview", OVERVIEW);
  assert.equal(overview.profile.incomplete, true);
  for (const response of [status, overview, await store.backend.call("ui.list", { limit: 24 }), await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 })]) {
    assert.ok(bytesOf(response) <= 56_000);
  }
});

test("names of the largest allowed length keep every answer within the response budget", async (t) => {
  const { store } = await build(t);
  const wide = (text) => text.repeat(60).slice(0, 120);
  await pushAll(
    store.backend,
    partsOf(
      {
        agents: ["sw/dev", "ops/x", "loner", "1997-factory/old-timer"].map((id, index) => agentEntry(id, wide(`名${index}`), index === 2 ? null : "sw", wide("職")) ),
        teams: [{ key: "sw", name: wide("部") }],
        projects: [{ id: "p1", name: "專".repeat(200), archived: false }, { id: LONG_PROJECT, name: "案".repeat(200), archived: false }],
      },
      1,
    ),
  );
  for (const [method, params] of [
    ["ui.overview", OVERVIEW],
    ["ui.list", { limit: 24 }],
    ["ui.search", { q: "note", limit: 24 }],
    ["ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 }],
  ]) {
    const response = await store.backend.call(method, params);
    conforms(method, response);
    assert.ok(bytesOf(response) <= 56_000, method);
  }
  const first = (await store.backend.call("ui.list", { limit: 1 })).items[0];
  const got = await store.backend.call("ui.get", first.ref);
  conforms("ui.get", got);
  assert.ok(bytesOf(got) <= 56_000);
});
