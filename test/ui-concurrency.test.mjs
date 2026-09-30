import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { createClock } from "../out/application/ui/timeSlice.js";
import { DAY_START, daysAgo, pageAll, punchContent, seed, startStore } from "./uiHarness.mjs";

const AGENTS = ["conc/one", "conc/two", "conc/three"];
const REQUEST = { tzOffsetMin: 0, dayStartIso: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString() };

async function build(t, overrides) {
  const store = startStore(t, overrides);
  const rows = [];
  for (let index = 0; index < 36; index += 1) {
    rows.push({ agentId: AGENTS[index % 3], projectId: index % 4 === 0 ? "p-c" : null, content: punchContent({ startMs: Date.parse(daysAgo(index % 6)), title: `既有 ${index}`, body: `基底記憶 ${index}` }), updatedAt: daysAgo(index % 6, index % 24) });
  }
  return { store, made: await seed(store, rows) };
}

const write = (store, agentId, tag, count) =>
  store.backend.call("memory.remember@1", {
    actor: { agentId, projectId: null, sessionId: `w-${tag}`, providerId: "codex" },
    ops: Array.from({ length: count }, (_, index) => ({ scope: "personal", content: `並行寫入 ${tag}-${index} 標記`, kind: "context", operationId: `${tag}-${index}` })),
  });

const YIELD_EVERY_STEP = { uiClock: () => createClock({ sliceMs: 0 }) };

for (const [label, overrides] of [["default time slices", {}], ["a yield after every scan step", YIELD_EVERY_STEP]]) {
  test(`ui.* calls interleaved with memory.remember@1 and ui.forget never fail, and every write is visible afterwards (${label})`, async (t) => {
    const { store, made } = await build(t, overrides);
    const errors = [];
    const checked = (method, response) => {
      if (response.ok !== true || !parseUiResponse(method, response)) errors.push(`${method}: ${JSON.stringify(response).slice(0, 160)}`);
      return response;
    };
    const guard = async (label, work) => {
      try {
        return await work();
      } catch (error) {
        errors.push(`${label} threw ${error?.code ?? error?.message}`);
        return undefined;
      }
    };
    let written = 0;
    let forgotten = 0;
    let stop = false;
    const writer = async () => {
      for (let batch = 0; batch < 30 && !stop; batch += 1) {
        const agentId = AGENTS[batch % 3];
        const response = await guard("remember", () => write(store, agentId, `b${batch}`, 4));
        if (response === undefined) continue;
        for (const result of response.results) {
          if (!result.ok) errors.push(`remember: ${JSON.stringify(result.error)}`);
          else written += 1;
        }
        if (batch % 5 === 4) {
          const target = response.results[0].value.memory.id;
          const gone = await guard("forget", () => store.backend.call("ui.forget", { agentId, scope: "personal", projectId: null, memoryId: target, expectedRevision: 1 }));
          if (gone !== undefined && checked("ui.forget", gone).forgotten === true) forgotten += 1;
        }
      }
    };
    const knownId = made[0];
    const readers = [0, 1, 2].map((reader) => async () => {
      for (let round = 0; round < 12 && !stop; round += 1) {
        await guard("overview", async () => checked("ui.overview", await store.backend.call("ui.overview", REQUEST)));
        await guard("list", async () => checked("ui.list", await store.backend.call("ui.list", { limit: 12 })));
        await guard("search", async () => checked("ui.search", await store.backend.call("ui.search", { q: reader === 0 ? "並行寫入" : "基底 記憶", limit: 6 })));
        await guard("stats", async () => checked("ui.agentStats", await store.backend.call("ui.agentStats", { agentId: AGENTS[reader], tzOffsetMin: 0 })));
        await guard("get", async () => checked("ui.get", await store.backend.call("ui.get", { agentId: knownId.agentId, scope: knownId.scope, projectId: knownId.projectId, memoryId: knownId.id })));
        await guard("status", async () => checked("ui.status", await store.backend.call("ui.status", {})));
      }
    });
    await Promise.all([writer(), ...readers.map((run) => run())]);
    stop = true;
    assert.deepEqual(errors, []);
    assert.ok(written >= 100, `only ${written} writes ran`);
    assert.ok(forgotten >= 4);
    const overview = await store.backend.call("ui.overview", REQUEST);
    assert.equal(overview.tiles.totalMemories, made.length + written - forgotten, "the overview counts every write and forget");
    const found = await pageAll((params) => store.backend.call("ui.search", params), { q: "並行寫入 標記", limit: 24 });
    assert.equal(found.flatMap((page) => page.items).length, written - forgotten);
    const list = await pageAll((params) => store.backend.call("ui.list", params), { limit: 24 });
    assert.equal(list.flatMap((page) => page.items).length, made.length + written - forgotten);
  });
}

test("a write is visible to the very next ui call, in every method, without waiting for any cache", async (t) => {
  const { store } = await build(t);
  await store.backend.call("ui.overview", REQUEST);
  await store.backend.call("ui.list", { limit: 5 });
  await store.backend.call("ui.agentStats", { agentId: AGENTS[0], tzOffsetMin: 0 });
  let total = (await store.backend.call("ui.overview", REQUEST)).tiles.totalMemories;
  for (let index = 0; index < 12; index += 1) {
    const agentId = AGENTS[index % 3];
    const marker = `即時可見標記${index}`;
    const response = await store.backend.call("memory.remember@1", {
      actor: { agentId, projectId: null, sessionId: `v-${index}`, providerId: "claude" },
      ops: [{ scope: "personal", content: marker, kind: "fact", operationId: `visible-${index}` }],
    });
    assert.equal(response.results[0].ok, true);
    total += 1;
    const overview = await store.backend.call("ui.overview", REQUEST);
    assert.equal(overview.tiles.totalMemories, total, `overview after write ${index}`);
    assert.equal(overview.agents.find((card) => card.id === agentId).latest.snippet, marker);
    const list = await store.backend.call("ui.list", { limit: 1 });
    assert.equal(list.items[0].ref.memoryId, response.results[0].value.memory.id, `list after write ${index}`);
    const search = await store.backend.call("ui.search", { q: marker });
    assert.equal(search.items.length, 1);
    const stats = await store.backend.call("ui.agentStats", { agentId, tzOffsetMin: 0 });
    assert.equal(stats.namespaces.reduce((sum, row) => sum + row.count, 0), overview.agents.find((card) => card.id === agentId).counts.total);
    const status = await store.backend.call("ui.status", {});
    assert.ok(Date.parse(status.lastWriteAt) >= Date.parse(list.items[0].updatedAt));
  }
});

test("a deduplicated write also refreshes the caches, because it raises the revision and the update time", async (t) => {
  const { store, made } = await build(t);
  const row = made.find((entry) => entry.scope === "personal");
  const before = await store.backend.call("ui.get", { agentId: row.agentId, scope: "personal", projectId: null, memoryId: row.id });
  await store.backend.call("ui.list", { limit: 3 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const again = await store.backend.call("memory.remember@1", {
    actor: { agentId: row.agentId, projectId: null, sessionId: "dedupe", providerId: "claude" },
    ops: [{ scope: "personal", content: row.content, kind: "context", operationId: "dedupe-1" }],
  });
  assert.equal(again.results[0].value.deduplicated, true);
  const after = await store.backend.call("ui.get", { agentId: row.agentId, scope: "personal", projectId: null, memoryId: row.id });
  assert.equal(after.memory.revision, before.memory.revision + 1);
  const list = await store.backend.call("ui.list", { limit: 1 });
  assert.equal(list.items[0].ref.memoryId, row.id, "the deduplicated memory is now the newest");
  assert.equal(list.items[0].revision, before.memory.revision + 1);
});
