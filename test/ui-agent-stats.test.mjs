import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { parsePunchContent } from "../out/application/ui/punchContent.js";
import { newestFirst, punchContent, seed, startStore } from "./uiHarness.mjs";

const NOW = Date.parse("2026-09-30T05:00:00.000Z");
const TZ = 480;
const AGENT = "sw/stat";

function plan() {
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    const at = new Date(Date.UTC(2026, 8, 5 + (index % 25), (index * 5) % 24, 10)).toISOString();
    const title = index < 6 ? "重複請求" : index < 9 ? "另一項" : `單次 ${index}`;
    const project = index % 4 === 0 ? "p-a" : null;
    const content =
      index % 5 === 4
        ? `plain memory ${index}`
        : punchContent({ startMs: Date.parse(at) - 600_000, cli: index % 3 === 0 ? "codex" : "claude", model: index % 3 === 0 ? "gpt-5" : "opus-4", title, body: `內容 ${index}` });
    rows.push({ agentId: AGENT, projectId: project, content, updatedAt: at });
  }
  return rows;
}

const localOf = (iso) => new Date(Date.parse(iso) + TZ * 60_000);

test("agentStats aggregates the sample exactly like a brute-force pass over the seeded rows", async (t) => {
  const store = startStore(t, { uiNow: () => NOW });
  const made = await seed(store, plan());
  const response = await store.backend.call("ui.agentStats", { agentId: AGENT, tzOffsetMin: TZ });
  assert.equal(parseUiResponse("ui.agentStats", response), true, JSON.stringify(response).slice(0, 400));
  assert.equal(response.ok, true);
  assert.equal(response.sampled, false);
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const byDate = new Map();
  for (const row of made) {
    const local = localOf(row.updatedAt);
    byHour[local.getUTCHours()] += 1;
    byWeekday[local.getUTCDay()] += 1;
    const date = local.toISOString().slice(0, 10);
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }
  assert.deepEqual(response.byHour, byHour);
  assert.deepEqual(response.byWeekday, byWeekday);
  assert.equal(response.byDay30.length, 30);
  assert.equal(response.byDay30.at(-1).date, "2026-09-30", "the window ends on the caller's local today");
  assert.equal(response.byDay30[0].date, "2026-09-01");
  for (const { date, count } of response.byDay30) assert.equal(count, byDate.get(date) ?? 0, date);
  assert.deepEqual(response.namespaces.map(({ scope, projectId, count }) => ({ scope, projectId, count })), [
    { scope: "personal", projectId: null, count: made.filter((row) => row.scope === "personal").length },
    { scope: "project", projectId: "p-a", count: made.filter((row) => row.scope === "project").length },
  ].sort((left, right) => right.count - left.count));
  const parsed = made.map((row) => parsePunchContent(row.content.normalize("NFKC")));
  const tools = new Map();
  for (const item of parsed) {
    const key = `${item.work?.cli ?? ""}|${item.work?.model ?? ""}`;
    tools.set(key, (tools.get(key) ?? 0) + 1);
  }
  assert.deepEqual(new Map(response.tools.map((tool) => [`${tool.cli ?? ""}|${tool.model ?? ""}`, tool.n])), tools);
  assert.equal(response.tools.reduce((sum, tool) => sum + tool.n, 0), made.length);
  assert.ok(response.tools.every((tool, index) => index === 0 || response.tools[index - 1].n >= tool.n), "sorted by count");
  const titles = new Map();
  for (const item of parsed) if (item.work?.title) titles.set(item.work.title, (titles.get(item.work.title) ?? 0) + 1);
  const repeated = [...titles.entries()].filter(([, count]) => count >= 2).sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  assert.deepEqual(response.repeatedRequests, repeated.map(([title, count]) => ({ title, count })));
  assert.equal(response.representative.length, 4);
  assert.deepEqual(response.representative.slice(0, 2).map((item) => item.work.title), ["重複請求", "另一項"], "the most repeated requests come first");
  for (const item of response.representative.slice(0, 2)) {
    const sameTitle = made.filter((row) => parsePunchContent(row.content.normalize("NFKC")).work?.title === item.work.title).sort(newestFirst);
    assert.equal(item.ref.memoryId, sameTitle[0].id, "the newest memory of that request");
    assert.equal(item.receiptCount, 1);
  }
  assert.equal(new Set(response.representative.map((item) => item.ref.memoryId)).size, 4);
});

test("only the newest sampleRows memories are aggregated, sampled says so, and a write refreshes the cached answer", async (t) => {
  const store = startStore(t, { uiNow: () => NOW, uiSampleRows: 10 });
  const made = await seed(store, plan());
  const request = { agentId: AGENT, tzOffsetMin: TZ };
  const first = await store.backend.call("ui.agentStats", request);
  assert.equal(first.sampled, true);
  assert.equal(first.tools.reduce((sum, tool) => sum + tool.n, 0), 10);
  assert.equal(first.byHour.reduce((sum, count) => sum + count, 0), 10);
  const newest = [...made].sort(newestFirst).slice(0, 10);
  const expectedHours = new Array(24).fill(0);
  for (const row of newest) expectedHours[localOf(row.updatedAt).getUTCHours()] += 1;
  assert.deepEqual(first.byHour, expectedHours);
  assert.equal(first.namespaces.reduce((sum, row) => sum + row.count, 0), 30, "namespace totals are exact, not sampled");
  assert.deepEqual(await store.backend.call("ui.agentStats", request), first, "the cached answer is identical");
  const written = await store.backend.call("memory.remember@1", { actor: { agentId: AGENT, projectId: null, sessionId: "w", providerId: "codex" }, ops: [{ scope: "personal", content: "A fresh memory written after the first stats call.", kind: "fact", operationId: "fresh-1" }] });
  assert.equal(written.results[0].ok, true);
  const second = await store.backend.call("ui.agentStats", request);
  assert.equal(second.namespaces.reduce((sum, row) => sum + row.count, 0), 31);
  assert.equal(second.tools.reduce((sum, tool) => sum + tool.n, 0), 10);
  assert.ok(second.tools.some((tool) => tool.cli === null && tool.n >= 1));
});

test("the day, hour and weekday views follow the caller's timezone", async (t) => {
  const store = startStore(t, { uiNow: () => NOW });
  await seed(store, [{ agentId: AGENT, projectId: null, content: "a memory written at a border hour", updatedAt: "2026-09-29T23:30:00.000Z" }]);
  const east = await store.backend.call("ui.agentStats", { agentId: AGENT, tzOffsetMin: 480 });
  const west = await store.backend.call("ui.agentStats", { agentId: AGENT, tzOffsetMin: -300 });
  assert.equal(east.byDay30.find((day) => day.count > 0).date, "2026-09-30");
  assert.equal(west.byDay30.find((day) => day.count > 0).date, "2026-09-29");
  assert.equal(east.byHour[7], 1);
  assert.equal(west.byHour[18], 1);
  assert.equal(east.byWeekday[3], 1, "2026-09-30 is a Wednesday");
  assert.equal(west.byWeekday[2], 1, "2026-09-29 is a Tuesday");
});
