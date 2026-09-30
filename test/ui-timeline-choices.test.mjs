import assert from "node:assert/strict";
import test from "node:test";
import { AGENT, NOW, assertSafe, createTimelineFor, deferred, fakeBackend, makeMemories, makeStats, tl } from "./timelineFixtures.mjs";

const memories = makeMemories(30);
const eightProjects = Array.from({ length: 8 }, (_, index) => ({ id: `proj-${index}-abcdefgh`, ...(index % 2 === 0 ? { names: { displayName: `專案名稱${index}`, name: `專案名稱${index}` } } : {}) }));

test("choicesFromStats lists every project once with its name or short id, and the tools that occur, most used first, without null or empty ones", () => {
  const stats = makeStats(AGENT, {
    projects: [...eightProjects, eightProjects[0]],
    tools: [{ cli: "codex", model: "a", n: 2 }, { cli: "claude", model: "a", n: 9 }, { cli: "claude", model: "b", n: 4 }, { cli: null, model: null, n: 50 }, { cli: "", model: "x", n: 40 }, { cli: "gemini", model: null, n: 2 }],
  });
  const parsed = tl.parseAgentStats(stats);
  const choices = tl.choicesFromStats(parsed);
  assert.equal(choices.projects.length, 8, "a project that appears in two namespaces is listed once");
  assert.equal(choices.projects[0].name, "專案名稱0");
  assert.equal(choices.projects[1].name, "專案 proj-1-a", "no name: the short id");
  assert.deepEqual(choices.clis, ["claude", "codex", "gemini"], "by use, ties by name");
  assert.deepEqual(tl.choicesFromStats(tl.parseAgentStats(makeStats(AGENT, { tools: [] }))).clis, []);
});

test("opening a timeline asks ui.agentStats for the agent and offers all of its projects and tools, not just the five the overview knew", async () => {
  const backend = fakeBackend(memories, { stats: makeStats(AGENT, { projects: eightProjects, tools: [{ cli: "codex", model: "m", n: 3 }, { cli: "claude", model: "m", n: 7 }] }) });
  const fallback = eightProjects.slice(0, 5).map((project) => ({ projectId: project.id }));
  const { timeline, targets, open } = createTimelineFor({ client: backend, projects: fallback, clis: ["claude"] });
  await open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.statsCalls.length, 1);
  assert.equal(backend.statsCalls[0].params.agentId, AGENT);
  assert.equal(typeof backend.statsCalls[0].params.tzOffsetMin, "number");
  assert.equal(backend.statsCalls[0].options.key, "timeline.options");
  const markup = targets.filters.innerHTML;
  for (const project of eightProjects) assert.ok(markup.includes(`value="p:${project.id}"`), project.id);
  assert.ok(markup.includes("專案：專案名稱0") && markup.includes("專案：專案 proj-1-a"));
  assert.ok(markup.includes('<option value="codex">codex</option>') && !markup.includes("gemini"));
  assert.ok(markup.indexOf('value="claude"') < markup.indexOf('value="codex"'), "most used tool first");
  assertSafe(assert, markup, "filters");
  await timeline.setFilter("scope", `p:${eightProjects[7].id}`);
  assert.equal(backend.calls[backend.calls.length - 1].params.projectId, eightProjects[7].id, "a project beyond the fifth can be chosen and is sent");
});

test("when the stats cannot be read the timeline keeps the supplied fallback choices and still works", async () => {
  const backend = fakeBackend(memories);
  const { timeline, targets, open } = createTimelineFor({ client: backend, projects: [{ projectId: "p-1", name: "官網改版" }] });
  await open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.statsCalls.length, 1);
  assert.ok(targets.filters.innerHTML.includes("專案：官網改版"));
  assert.ok(targets.filters.innerHTML.includes(">claude<") && targets.filters.innerHTML.includes(">codex<"), "default tools");
  assert.equal(timeline.view().phase, "ready");
});

test("stats that arrive for an agent the user has already left do not change the choices, and a stats answer that does not parse is ignored", async () => {
  const gate = deferred();
  const late = makeStats("a/one", { projects: eightProjects });
  const backend = fakeBackend(memories, { stats: late, statsBefore: async ({ params }) => (params.agentId === "a/one" ? gate.promise : undefined) });
  const { timeline, targets, open } = createTimelineFor({ client: backend });
  await open("a/one");
  await open("a/two");
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!targets.filters.innerHTML.includes("proj-0-abcdefgh"));
  assert.equal(timeline.view().projects.length, 0);

  const wrong = fakeBackend(memories, { stats: makeStats("someone/else", { projects: eightProjects }) });
  const second = createTimelineFor({ client: wrong });
  await second.open("a/one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.timeline.view().projects.length, 0, "stats of a different agent are not used");
  const broken = fakeBackend(memories, { stats: { ok: true, agentId: "a/one" } });
  const third = createTimelineFor({ client: broken });
  await third.open("a/one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(third.timeline.view().projects.length, 0);
});

test("the selects are only rewritten when the choices really changed, so coming back does not drop the keyboard focus", async () => {
  const backend = fakeBackend(memories, { stats: makeStats(AGENT, { projects: eightProjects.slice(0, 2) }) });
  const { targets, open } = createTimelineFor({ client: backend, now: () => NOW });
  await open();
  await new Promise((resolve) => setImmediate(resolve));
  let writes = 0;
  let markup = targets.filters.innerHTML;
  Object.defineProperty(targets.filters, "innerHTML", { get: () => markup, set: (value) => { writes += 1; markup = value; } });
  await open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.statsCalls.length, 2, "asked again on return");
  assert.equal(writes, 0, "unchanged stats do not rewrite the selects");
});
