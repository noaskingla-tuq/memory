import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_STATS, makeItem, makeStats, ui } from "./spaceFixtures.mjs";

const { parseAgentStats, spaceRows, spaceTotals, toolRows, percentText, peakOf, projectTitle, STRINGS } = ui;

const clone = (value) => JSON.parse(JSON.stringify(value));

test("a well-formed agentStats answer parses and keeps every part the page draws", () => {
  const stats = parseAgentStats(clone(makeStats()));
  assert.ok(stats !== null);
  assert.equal(stats.agentId, "sw/developer");
  assert.equal(stats.agent.displayName, "開發工程師");
  assert.equal(stats.namespaces.length, 3);
  assert.equal(stats.byDay30.length, 30);
  assert.equal(stats.byHour.length, 24);
  assert.equal(stats.byWeekday.length, 7);
  assert.equal(stats.representative.length, 4);
  assert.equal(stats.representative[0].work.title, "請求標題 1");
  assert.equal(stats.sampled, false);
});

test("an answer from an older backend without the name fields still parses", () => {
  const raw = clone(makeStats());
  delete raw.agent;
  for (const namespace of raw.namespaces) delete namespace.project;
  for (const item of raw.representative) delete item.names;
  const stats = parseAgentStats(raw);
  assert.ok(stats !== null);
  assert.equal(stats.agent, undefined);
});

test("every structural breakage is refused, so a half-understood answer is never drawn as an empty space", () => {
  const breakages = {
    "not ok": (raw) => ({ ...raw, ok: false }),
    "no agent id": (raw) => ({ ...raw, agentId: "" }),
    "sampled is not a boolean": (raw) => ({ ...raw, sampled: "no" }),
    "23 hours": (raw) => ({ ...raw, byHour: raw.byHour.slice(1) }),
    "6 weekdays": (raw) => ({ ...raw, byWeekday: raw.byWeekday.slice(1) }),
    "negative hour": (raw) => ({ ...raw, byHour: [-1, ...raw.byHour.slice(1)] }),
    "a weekday count that is not a number": (raw) => ({ ...raw, byWeekday: [Number.NaN, ...raw.byWeekday.slice(1)] }),
    "day key of the wrong length": (raw) => ({ ...raw, byDay30: [{ date: "9/30", count: 1 }] }),
    "personal namespace with a project id": (raw) => ({ ...raw, namespaces: [{ scope: "personal", projectId: "p", count: 1, firstAt: null, lastAt: null }] }),
    "project namespace without a project id": (raw) => ({ ...raw, namespaces: [{ scope: "project", projectId: null, count: 1, firstAt: null, lastAt: null }] }),
    "unknown scope": (raw) => ({ ...raw, namespaces: [{ scope: "team", projectId: null, count: 1, firstAt: null, lastAt: null }] }),
    "tool count is text": (raw) => ({ ...raw, tools: [{ cli: "claude", model: null, n: "3" }] }),
    "repeated request without a title": (raw) => ({ ...raw, repeatedRequests: [{ count: 3 }] }),
    "representative item without a ref": (raw) => ({ ...raw, representative: [{ updatedAt: "x", snippet: "y" }] }),
    "representative work without its times": (raw) => ({ ...raw, representative: [makeItem(1, { work: { cli: null, model: null, title: null } })] }),
    "agent names without a team key": (raw) => ({ ...raw, agent: { displayName: "x" } }),
    "project names of the wrong type": (raw) => ({ ...raw, namespaces: [{ scope: "project", projectId: "p", count: 1, firstAt: null, lastAt: null, project: "x" }] }),
  };
  for (const [label, damage] of Object.entries(breakages)) assert.equal(parseAgentStats(damage(clone(makeStats()))), null, label);
  assert.equal(parseAgentStats(null), null);
  assert.equal(parseAgentStats([]), null);
  assert.equal(parseAgentStats({ ok: false, code: "NOT_FOUND" }), null);
});

test("the page totals come from the namespaces: the sum, the earliest first write and the latest last write", () => {
  const stats = parseAgentStats(clone(makeStats()));
  const totals = spaceTotals(stats.namespaces);
  assert.equal(totals.total, 22);
  assert.equal(totals.firstMs, Math.min(...stats.namespaces.map((namespace) => Date.parse(namespace.firstAt))));
  assert.equal(totals.lastMs, Math.max(...stats.namespaces.map((namespace) => Date.parse(namespace.lastAt))));
  assert.deepEqual(spaceTotals([]), { total: 0, firstMs: null, lastMs: null });
  assert.equal(spaceTotals(parseAgentStats(clone(EMPTY_STATS)).namespaces).firstMs, null, "a missing instant is ignored, not turned into a date");
});

test("the rows put the personal space first and always, then the projects by count, each with its best available name", () => {
  const rows = spaceRows(parseAgentStats(clone(makeStats())).namespaces);
  assert.equal(rows.personal.label, STRINGS["space.spaces.personal"]);
  assert.equal(rows.personal.count, 12);
  assert.deepEqual(rows.projects.map((row) => [row.label, row.count, row.projectId]), [
    ["官網改版", 7, "proj-alpha"],
    ["專案 proj-unn", 3, "proj-unnamed-0001"],
  ]);
  assert.equal(rows.peak, 12);
  const projectOnly = spaceRows([{ scope: "project", projectId: "only", count: 5, firstAt: null, lastAt: null }]);
  assert.equal(projectOnly.personal.count, 0, "an agent with project memories only still shows its personal row");
  assert.equal(projectOnly.projects[0].label, "專案 only");
  const none = spaceRows([{ scope: "personal", projectId: null, count: 4, firstAt: null, lastAt: null }]);
  assert.deepEqual(none.projects, [], "no project rows: the view shows the explanation instead");
  const tied = spaceRows([
    { scope: "project", projectId: "b", count: 2, firstAt: null, lastAt: null },
    { scope: "project", projectId: "a", count: 2, firstAt: null, lastAt: null },
  ]);
  assert.deepEqual(tied.projects.map((row) => row.projectId), ["a", "b"], "equal counts are ordered by id so the page does not shuffle");
});

test("a project without a usable name falls back to the project word and the first eight characters of its id", () => {
  assert.equal(projectTitle("3f9c2a71-8d44-4c0e", undefined), "專案 3f9c2a71");
  assert.equal(projectTitle("3f9c2a71-8d44-4c0e", null), "專案 3f9c2a71");
  assert.equal(projectTitle("3f9c2a71-8d44-4c0e", { displayName: "  " }), "專案 3f9c2a71");
  assert.equal(projectTitle("3f9c2a71-8d44-4c0e", { displayName: "", name: "有名字" }), "有名字");
  assert.equal(projectTitle("p", { displayName: "專案 p" }), "專案 p");
});

test("tool shares add up from the counts, label the unknown tool, and never show a used tool as 0%", () => {
  const rows = toolRows(parseAgentStats(clone(makeStats())).tools);
  assert.deepEqual(rows.map((row) => [row.label, row.n]), [["claude / opus-4", 14], ["codex / gpt-5", 6], [STRINGS["space.tools.unknown"], 2]]);
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.percent, 0) - 100) < 1e-9);
  assert.equal(percentText(rows[0].percent), "64%");
  assert.equal(percentText(0.4), STRINGS["space.tools.lessThanOne"]);
  assert.equal(percentText(100), "100%");
  assert.deepEqual(toolRows([]), []);
  assert.deepEqual(toolRows([{ cli: "x", model: null, n: 0 }]), []);
  assert.equal(toolRows([{ cli: "claude", model: null, n: 1 }])[0].label, "claude");
  assert.equal(toolRows([{ cli: null, model: "gpt-5", n: 1 }])[0].label, "gpt-5");
});

test("the peak is the first largest value, and nothing peaks in an all-zero series", () => {
  assert.deepEqual(peakOf([0, 3, 7, 7, 1]), { index: 2, value: 7 });
  assert.equal(peakOf([0, 0, 0]), null);
  assert.equal(peakOf([]), null);
});
