import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DAY_MS, DAY_START, agentHashOf, bytesOf, daysAgo, pageAll, punchContent, seed, setTimes, startStore } from "./uiHarness.mjs";

const REQUEST = { tzOffsetMin: 480, dayStartIso: DAY_START };
const PLAN = [
  { agentId: "sw/dev", projectId: null, count: 5 },
  ...[["p1", 4], ["p2", 3], ["p3", 3], ["p4", 2], ["p5", 2], ["p6", 1], ["p7", 1]].map(([projectId, count]) => ({ agentId: "sw/dev", projectId, count })),
  { agentId: "sw/rev", projectId: null, count: 3 },
  { agentId: "ops/x", projectId: null, count: 2 },
];

async function build(t, overrides) {
  const store = startStore(t, overrides);
  const rows = [];
  let serial = 0;
  for (const { agentId, projectId, count } of PLAN) {
    for (let index = 0; index < count; index += 1) {
      const step = serial++;
      const at = daysAgo((step * 3) % 21, (step * 5) % 24);
      rows.push({ agentId, projectId, content: punchContent({ startMs: Date.parse(at) - 3_600_000, title: `任務 ${step}`, body: `結果 ${step}` }), updatedAt: at });
    }
  }
  return { store, made: await seed(store, rows) };
}

const bounds = () => Array.from({ length: 15 }, (_, step) => new Date(Date.parse(DAY_START) + (step - 13) * DAY_MS).toISOString());

function expectedFor(made, agentId) {
  const mine = made.filter((row) => row.agentId === agentId);
  const edges = bounds();
  const bins = edges.slice(0, -1).map((low, index) => mine.filter((row) => row.updatedAt >= low && row.updatedAt < edges[index + 1]).length);
  const newest = [...mine].sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))[0];
  return { mine, bins, newest };
}

test("overview tiles and cards equal a brute-force computation over the seeded rows", async (t) => {
  const { store, made } = await build(t);
  const response = await store.backend.call("ui.overview", REQUEST);
  assert.equal(response.ok, true);
  assert.equal(response.complete, true);
  const all = ["ops/x", "sw/dev", "sw/rev"].map((agentId) => ({ agentId, ...expectedFor(made, agentId) }));
  assert.deepEqual(response.tiles, {
    totalMemories: made.length,
    writtenToday: all.reduce((sum, item) => sum + item.bins[13], 0),
    activeAgents7d: all.filter((item) => item.bins.slice(7).some((count) => count > 0)).length,
    agents: 3,
    lastWriteAt: [...made].map((row) => row.updatedAt).sort().at(-1),
  });
  assert.deepEqual(response.agents.map((card) => card.id), ["ops/x", "sw/dev", "sw/rev"], "sorted by team key, then id");
  assert.deepEqual(response.agents.map((card) => card.team), [{ key: "ops" }, { key: "sw" }, { key: "sw" }]);
  for (const card of response.agents) {
    const expected = all.find((item) => item.agentId === card.id);
    assert.deepEqual(card.spark14, expected.bins, `${card.id} spark`);
    assert.equal(card.lastAt, expected.newest.updatedAt);
    assert.equal(card.counts.total, expected.mine.length);
    assert.equal(card.latest.at, expected.newest.updatedAt);
    assert.ok(expected.newest.content.normalize("NFKC").includes(card.latest.snippet), "the latest snippet is the request title of the newest memory");
    assert.equal("name" in card, false, "no name table yet, so no name");
    assert.equal(typeof card.displayName, "string", "without a name table the card still has a degraded display name");
  }
  const dev = response.agents.find((card) => card.id === "sw/dev");
  assert.equal(dev.counts.personal, 5);
  assert.deepEqual(dev.counts.projects, [
    { projectId: "p1", displayName: "專案 p1", count: 4 },
    { projectId: "p2", displayName: "專案 p2", count: 3 },
    { projectId: "p3", displayName: "專案 p3", count: 3 },
    { projectId: "p4", displayName: "專案 p4", count: 2 },
    { projectId: "p5", displayName: "專案 p5", count: 2 },
  ]);
  assert.equal(dev.counts.otherProjects, 2);
  assert.equal(dev.counts.total, 5 + 4 + 3 + 3 + 2 + 2 + 1 + 1);
  assert.deepEqual(response.profile, { generation: null, receivedAt: null, incomplete: false, corrupt: false, omitted: { agents: 0, teams: 0, projects: 0 } });
  assert.deepEqual(response.storage, { status: "ready", unavailableAgents: 0 });
  assert.equal(response.nextCursor, null);
});

test("paging by one card visits every agent once, keeps the tiles, and refuses foreign or forged cursors", async (t) => {
  const { store } = await build(t);
  const whole = await store.backend.call("ui.overview", REQUEST);
  const pages = await pageAll((params) => store.backend.call("ui.overview", params), { ...REQUEST, limit: 1 });
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.flatMap((page) => page.agents.map((card) => card.id)), whole.agents.map((card) => card.id));
  for (const page of pages) assert.deepEqual(page.tiles, whole.tiles);
  const cursor = pages[0].nextCursor;
  assert.deepEqual(await store.backend.call("ui.list", { cursor }), { ok: false, code: "CURSOR_STALE", retryable: false });
  const listCursor = (await store.backend.call("ui.list", { limit: 1 })).nextCursor;
  assert.deepEqual(await store.backend.call("ui.overview", { ...REQUEST, cursor: listCursor }), { ok: false, code: "CURSOR_STALE", retryable: false });
  assert.deepEqual(await store.backend.call("ui.overview", { ...REQUEST, cursor: `${cursor.slice(0, -2)}xx` }), { ok: false, code: "CURSOR_STALE", retryable: false });
  const other = startStore(t);
  assert.deepEqual(await other.backend.call("ui.overview", { ...REQUEST, cursor }), { ok: false, code: "CURSOR_STALE", retryable: false }, "a cursor from another plugin process is refused");
});

test("a remember marks its agent dirty at once, and a change made behind the backend's back is caught by the file mtime", async (t) => {
  const { store, made } = await build(t);
  const utcMidnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
  const today = { tzOffsetMin: 0, dayStartIso: utcMidnight };
  const before = await store.backend.call("ui.overview", today);
  const written = await store.backend.call("memory.remember@1", {
    actor: { agentId: "ops/x", projectId: null, sessionId: "dirty", providerId: "codex" },
    ops: [{ scope: "personal", content: "A memory written after the first overview.", kind: "fact", operationId: "dirty-1" }],
  });
  assert.equal(written.results[0].ok, true);
  const after = await store.backend.call("ui.overview", today);
  assert.equal(after.tiles.totalMemories, before.tiles.totalMemories + 1);
  assert.equal(after.tiles.writtenToday, before.tiles.writtenToday + 1);
  const card = (response) => response.agents.find((item) => item.id === "ops/x");
  assert.equal(card(after).counts.total, card(before).counts.total + 1);
  assert.equal(card(after).latest.snippet, "A memory written after the first overview.");

  const old = made.find((row) => row.agentId === "sw/rev");
  await new Promise((resolve) => setTimeout(resolve, 30));
  setTimes(store.dataRoot, "sw/rev", [[old.id, new Date().toISOString()]]);
  const changed = await store.backend.call("ui.overview", today);
  assert.equal(changed.tiles.writtenToday, after.tiles.writtenToday + (old.updatedAt >= utcMidnight ? 0 : 1), "the file changed without a dirty mark and the index still noticed");
});

test("when time runs out the overview says it is incomplete and the next call finishes from the warm index", async (t) => {
  let remaining = Number.POSITIVE_INFINITY;
  const clock = () => ({ sliceExpired: () => false, timeUp: () => remaining-- <= 0, yieldNow: async () => undefined, yieldIfDue: async () => undefined });
  const { store } = await build(t, { uiClock: clock });
  remaining = 1;
  const partial = await store.backend.call("ui.overview", REQUEST);
  assert.equal(partial.ok, true);
  assert.equal(partial.complete, false);
  assert.ok(partial.agents.length >= 1 && partial.agents.length < 3);
  remaining = Number.POSITIVE_INFINITY;
  const full = await store.backend.call("ui.overview", REQUEST);
  assert.equal(full.complete, true);
  assert.equal(full.agents.length, 3);
});

test("an agent database that cannot be read is counted, not fatal, and the other agents still show", async (t) => {
  const { store } = await build(t);
  const broken = join(store.dataRoot, "agents", agentHashOf("broken/agent"));
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "memory.sqlite"), "this is not a database, only text ".repeat(200));
  const response = await store.backend.call("ui.overview", REQUEST);
  assert.equal(response.ok, true);
  assert.equal(response.agents.length, 3);
  assert.equal(response.storage.unavailableAgents, 1);
  assert.ok(bytesOf(response) <= 56_000);
});
