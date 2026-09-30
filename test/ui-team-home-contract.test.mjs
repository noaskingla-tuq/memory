import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { cardIds, count, createHome, ui } from "./homeFixtures.mjs";
import { DAY_START, daysAgo, punchContent, seed, startStore } from "./uiHarness.mjs";

const AGENTS = 100;

// why: the card wall is only trustworthy if it works on what the real backend sends, so the seed goes through remember and the pages come from the real ui.overview
async function build(t) {
  const store = startStore(t);
  const rows = [];
  for (let index = 0; index < AGENTS; index += 1) {
    const agentId = `team${index % 7}/agent${String(index).padStart(3, "0")}`;
    const perAgent = 1 + (index % 3);
    for (let step = 0; step < perAgent; step += 1) {
      const at = daysAgo((index + step * 3) % 20, (index * 5 + step) % 24);
      const projectId = step === 1 ? `proj-${index % 4}` : null;
      rows.push({ agentId, projectId, content: punchContent({ startMs: Date.parse(at) - 3_600_000, title: `第 ${index} 位的請求 ${step}`, body: `成果 ${step}` }), updatedAt: at });
    }
  }
  await seed(store, rows);
  return { store, rows };
}

const backendClient = (store) => ({
  calls: [],
  async call(method, params, options) {
    this.calls.push({ method, params, options });
    const value = JSON.parse(JSON.stringify(await store.backend.call(method, params)));
    assert.ok(parseUiResponse(method, value), `the backend answer for ${method} matches its contract schema`);
    return { ok: true, value };
  },
});

test("the view parses the real ui.overview pages: 100 agents over two pages, every card once, tiles equal to the stored totals", async (t) => {
  const { store, rows } = await build(t);
  const client = backendClient(store);
  const { home, targets } = createHome({ client, now: () => Date.parse(DAY_START) + 30 * 3_600_000, pageSize: 60 });
  await home.start();
  assert.equal(home.view().phase, "ready");
  assert.equal(count(targets.wall.innerHTML, /class="acard"/gu), 60);
  assert.equal(home.view().hasMore, true);
  await home.loadMore();
  const ids = cardIds(targets.wall.innerHTML);
  assert.equal(ids.length, AGENTS);
  assert.equal(new Set(ids).size, AGENTS);
  assert.equal(home.view().hasMore, false);
  assert.equal(home.view().tiles.totalMemories, rows.length);
  assert.equal(home.view().tiles.agents, AGENTS);
  assert.equal(count(targets.wall.innerHTML, /<section class="team"/gu), 7);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].params.cursor.length > 0, true);
  const sample = home.agent("team3/agent003");
  assert.ok(sample.counts.total >= 1 && sample.spark14.length === 14 && sample.latest.snippet.startsWith("第 3 位的請求"));
  assert.ok(targets.wall.innerHTML.includes("<b>team3</b>"), "no name table yet: the department shows its key");
  assert.ok(targets.wall.innerHTML.includes('<span class="acard-name">agent003（team3）</span><span class="acard-id">team3/agent003</span>'));
  assert.ok(ui.parseOverview(await client.call("ui.overview", { tzOffsetMin: 0, dayStartIso: DAY_START }).then((result) => result.value)) !== null);
});
