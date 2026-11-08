import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { count, createHome, ui } from "./homeFixtures.mjs";
import { SAMPLE, partsOf, profileFilePath, pushAll } from "./profileHarness.mjs";
import { createSpace, sectionOf } from "./spaceFixtures.mjs";
import { DAY_START, daysAgo, punchContent, seed, startStore } from "./uiHarness.mjs";

const { STRINGS } = ui;
const NOW_MS = Date.parse(DAY_START) + 30 * 3_600_000;
const AGENT = "sw/dev";

// why: the page is only trustworthy if it works on what the real backend sends, so the seed goes through remember and every answer is checked against the contract schema
const backendClient = (backend) => ({
  calls: [],
  async call(method, params, options) {
    this.calls.push({ method, params, options });
    const value = JSON.parse(JSON.stringify(await backend.call(method, params)));
    assert.ok(parseUiResponse(method, value), `the backend answer for ${method} matches its contract schema`);
    return value.ok === true ? { ok: true, value } : { ok: false, superseded: false, attempts: 1, ...ui.describeError(value.code, "plugin") };
  },
});

async function build(t, overrides = {}) {
  const store = startStore(t, { uiNow: () => NOW_MS, ...overrides });
  const rows = [];
  for (let index = 0; index < 24; index += 1) {
    const at = daysAgo(index % 20, (index * 5) % 24);
    const title = index < 8 ? "整理本週工作" : index < 11 ? "檢查結帳流程" : `單次請求 ${index}`;
    rows.push({ agentId: AGENT, projectId: index % 3 === 0 ? "p1" : index % 3 === 1 ? "3f9c2a71-8d44-4c0e-b1aa-0123456789ab" : null, content: punchContent({ startMs: Date.parse(at) - 3_600_000, cli: index % 4 === 0 ? "codex" : "claude", model: index % 4 === 0 ? "gpt-5" : "opus-4", title, body: `成果 ${index}` }), updatedAt: at });
  }
  rows.push({ agentId: "ops/x", projectId: null, content: "另一位 agent 的記憶", updatedAt: daysAgo(1, 4) });
  const made = await seed(store, rows);
  return { store, made };
}

const spaceFor = (backend, agentId = AGENT) => {
  const client = backendClient(backend);
  return { client, ...createSpace({ client, now: () => NOW_MS, agentId }) };
};

test("the page draws the real ui.agentStats answer: counts, names from the table, charts that add up, four representative memories", async (t) => {
  const { store, made } = await build(t);
  await pushAll(store.backend, partsOf(SAMPLE, 2));
  const { targets, open, space, client } = spaceFor(store.backend);
  await open();
  assert.equal(space.view().phase, "ready");
  assert.equal(client.calls.length, 1);
  assert.equal(targets.title.textContent, "開發工程師");
  const mine = made.filter((row) => row.agentId === AGENT);
  assert.ok(targets.meta.textContent.includes(`累積 ${mine.length} 筆`) && targets.meta.textContent.includes("最近寫入 ") && !targets.meta.textContent.includes("部門") && !targets.meta.textContent.includes("職稱"), targets.meta.textContent);
  const body = targets.body.innerHTML;
  const spaces = sectionOf(body, "space-h-spaces");
  const personal = mine.filter((row) => row.projectId === null).length;
  assert.ok(spaces.includes(`${personal} 筆`) && spaces.includes(">第一個專案<"), "a project the table names shows its name");
  assert.ok(spaces.includes(">專案 3f9c2a71<"), "a project the table does not know shows the project word and the id prefix");
  const { stats } = space.view();
  assert.equal(stats.byDay30.reduce((sum, day) => sum + day.count, 0), mine.length, "every seeded memory falls in the 30-day window");
  assert.equal(stats.byHour.reduce((sum, value) => sum + value, 0), mine.length);
  assert.equal(stats.byWeekday.reduce((sum, value) => sum + value, 0), mine.length);
  assert.equal(count(sectionOf(body, "space-h-days"), /<i[ >]/gu), 30);
  assert.ok(sectionOf(body, "space-h-tools").includes("claude / opus-4") && sectionOf(body, "space-h-tools").includes("codex / gpt-5"));
  const repeat = sectionOf(body, "space-h-repeat");
  assert.ok(repeat.includes("整理本週工作") && repeat.includes("8 次") && repeat.includes("檢查結帳流程") && repeat.includes("3 次"));
  assert.equal(count(sectionOf(body, "space-h-rep"), /<article class="rep"/gu), 4);
  assert.ok(sectionOf(body, "space-h-rep").includes("整理本週工作") && sectionOf(body, "space-h-rep").includes("檢查結帳流程"), "the most repeated requests are the representative ones");
  assert.ok(!body.includes(STRINGS["space.sampled"]));
});

test("without a name table the page still has a title, a project name and a team, all derived from the ids", async (t) => {
  const { store } = await build(t);
  const { targets, open, space } = spaceFor(store.backend);
  await open();
  assert.equal(space.view().phase, "ready");
  assert.equal(targets.title.textContent, "dev（sw）");
  assert.equal(targets.id.textContent, AGENT);
  assert.ok(targets.meta.textContent.includes("累積 ") && !targets.meta.textContent.includes("部門"), "the header keeps only the total and the last write");
  assert.ok(sectionOf(targets.body.innerHTML, "space-h-spaces").includes(">專案 p1<"));
});

test("an agent the backend has no memory for is the empty state, not an error", async (t) => {
  const { store } = await build(t);
  const { targets, open, space } = spaceFor(store.backend, "nobody/here");
  await open();
  assert.equal(space.view().phase, "empty");
  assert.ok(targets.body.innerHTML.includes(STRINGS["space.empty.title"]));
  assert.equal(targets.title.textContent, "here");
});

test("when the newest part is sampled the page says so", async (t) => {
  const { store } = await build(t, { uiSampleRows: 10 });
  const { targets, open, space } = spaceFor(store.backend);
  await open();
  assert.equal(space.view().stats.sampled, true);
  assert.ok(targets.body.innerHTML.includes(STRINGS["space.sampled"]));
  assert.equal(space.view().stats.byDay30.reduce((sum, day) => sum + day.count, 0), 10);
  assert.ok(targets.meta.textContent.includes("累積 24 筆"), "the header total is the real total, not the sample");
});

test("a damaged name table reaches the home banner from the real ui.overview, and a repaired one clears it", async (t) => {
  const { store } = await build(t);
  await pushAll(store.backend, partsOf(SAMPLE, 1));
  await store.backend.dispose();
  writeFileSync(profileFilePath(store.base), "{ this is not json");
  const revived = store.open();
  const { home, targets } = createHome({ client: backendClient(revived), now: () => NOW_MS });
  await home.start();
  assert.equal(home.view().profile.corrupt, true);
  assert.ok(targets.banner.innerHTML.includes(STRINGS["home.profile.corrupt"]));
  assert.ok(targets.wall.innerHTML.includes("dev（sw）"), "the cards show the degraded names meanwhile");
  await pushAll(revived, partsOf(SAMPLE, 2));
  await home.reload();
  assert.equal(targets.banner.innerHTML, "");
  assert.ok(targets.wall.innerHTML.includes("開發工程師"));
});

test("an incomplete name table reaches the home banner with the counts Core reported", async (t) => {
  const { store } = await build(t);
  await pushAll(store.backend, partsOf({ ...SAMPLE, omitted: { agents: 3, teams: 0, projects: 1 } }, 2));
  const { home, targets } = createHome({ client: backendClient(store.backend), now: () => NOW_MS });
  await home.start();
  assert.equal(home.view().profile.incomplete, true);
  assert.ok(targets.banner.innerHTML.includes("有 3 位 agent、1 個專案 沒收進來"), targets.banner.innerHTML);
});
