import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { DAY_START, assertWithinCoreLimit, bytesOf, daysAgo, pageAll, punchContent, seed, startStore } from "./uiHarness.mjs";

const LIMIT = 56_000;
const REQUEST = { tzOffsetMin: 480, dayStartIso: DAY_START };
const pad = (value, size = 3) => String(value).padStart(size, "0");

function within(method, response) {
  assert.equal(response.ok, true, `${method} ${JSON.stringify(response).slice(0, 200)}`);
  assert.ok(bytesOf(response) <= LIMIT, `${method} answered ${bytesOf(response)} bytes`);
  assertWithinCoreLimit(response);
  assert.equal(parseUiResponse(method, response), true, `${method} must match its schema`);
  return response;
}

async function wide(t) {
  const store = startStore(t);
  const rows = [];
  for (let agent = 0; agent < 30; agent += 1) {
    const agentId = `團隊${agent % 3}/專家${pad(agent)}`;
    for (let project = -1; project < 6; project += 1) {
      rows.push({
        agentId,
        projectId: project < 0 ? null : `專案${"甲".repeat(146)}${project}`,
        content: punchContent({ startMs: Date.parse(daysAgo(agent % 5)), title: "請求".repeat(50), body: `${"成果文字".repeat(900)}${agent}-${project}` }),
        updatedAt: daysAgo(agent % 7, (agent * 3 + project) % 24),
      });
    }
  }
  return { store, made: await seed(store, rows) };
}

test("with long CJK ids and 3,600-character bodies no ui answer exceeds 56,000 UTF-8 bytes, and truncated pages lose nothing", async (t) => {
  const { store, made } = await wide(t);
  const overview = within("ui.overview", await store.backend.call("ui.overview", { ...REQUEST, limit: 200 }));
  assert.ok(overview.nextCursor !== null && overview.agents.length < 30, "30 rich cards do not fit one page, so the page is cut and continued");
  const pages = await pageAll((params) => store.backend.call("ui.overview", params), { ...REQUEST, limit: 200 });
  for (const page of pages) within("ui.overview", page);
  const seen = pages.flatMap((page) => page.agents.map((card) => card.id));
  assert.equal(new Set(seen).size, 30);
  assert.deepEqual(seen, [...seen].sort((left, right) => (left.split("/")[0] < right.split("/")[0] ? -1 : left.split("/")[0] > right.split("/")[0] ? 1 : left < right ? -1 : 1)));
  for (const card of overview.agents) {
    assert.ok(Array.from(card.latest.snippet).length <= 120);
    assert.ok(card.counts.projects.length <= 5);
  }
  for (const method of ["ui.list", "ui.search"]) {
    const first = method === "ui.list" ? { limit: 24 } : { q: "成果文字", limit: 24 };
    const listing = await pageAll((params) => store.backend.call(method, params), first);
    for (const page of listing) {
      within(method, page);
      for (const item of page.items) assert.ok(Array.from(item.snippet).length <= 160);
    }
    const ids = listing.flatMap((page) => page.items.map((item) => item.ref.memoryId));
    assert.equal(ids.length, made.length, method);
    assert.equal(new Set(ids).size, made.length, method);
  }
  const target = made[0];
  const detail = within("ui.get", await store.backend.call("ui.get", { agentId: target.agentId, scope: target.scope, projectId: target.projectId, memoryId: target.id }));
  assert.ok(Array.from(detail.memory.content).length <= 4000);
  within("ui.agentStats", await store.backend.call("ui.agentStats", { agentId: target.agentId, tzOffsetMin: 480 }));
  within("ui.status", await store.backend.call("ui.status", {}));
});

test("worst-case ids and titles: a list page is cut by bytes, its cursor continues exactly, every page stays under the limit", async (t) => {
  const store = startStore(t);
  const rows = [];
  for (let agent = 0; agent < 6; agent += 1) {
    const agentId = `${"團".repeat(20)}/${"專".repeat(150)}${agent}`;
    for (let index = 0; index < 5; index += 1) {
      rows.push({
        agentId,
        projectId: `${"案".repeat(190)}${index}`,
        sessionId: "S",
        content: punchContent({ startMs: Date.parse(daysAgo(0)), title: "題".repeat(290), body: "字".repeat(2500) + index }),
        updatedAt: daysAgo(agent, index),
      });
    }
  }
  const made = await seed(store, rows);
  const pages = await pageAll((params) => store.backend.call("ui.list", params), { limit: 24 });
  for (const page of pages) within("ui.list", page);
  assert.equal(pages.flatMap((page) => page.items).length, made.length);
  assert.ok(pages.length >= 2 && pages[0].items.length < 24, "the byte budget, not the item limit, ended the first page");
  const searchPages = await pageAll((params) => store.backend.call("ui.search", params), { q: "字", limit: 24 });
  for (const page of searchPages) within("ui.search", page);
  assert.equal(searchPages.flatMap((page) => page.items).length, made.length);
  const sample = made[0];
  within("ui.get", await store.backend.call("ui.get", { agentId: sample.agentId, scope: sample.scope, projectId: sample.projectId, memoryId: sample.id }));
});

test("agentStats cuts its namespace list, not the answer, when hundreds of long project ids would overflow", async (t) => {
  const store = startStore(t);
  const agentId = "統計/專家";
  const rows = Array.from({ length: 160 }, (_, index) => ({
    agentId,
    projectId: `${"專".repeat(195)}${pad(index)}`,
    content: punchContent({ startMs: Date.parse(daysAgo(0)), title: `請求 ${index}`, body: `成果 ${index}` }),
    updatedAt: daysAgo(index % 20, index % 24),
  }));
  await seed(store, rows);
  const stats = within("ui.agentStats", await store.backend.call("ui.agentStats", { agentId, tzOffsetMin: 480 }));
  assert.ok(stats.namespaces.length > 0 && stats.namespaces.length < 150, `kept ${stats.namespaces.length} namespaces`);
});

test("an overview cursor still works when two very long agent ids do not fit a keyset position", async (t) => {
  const store = startStore(t);
  const ids = [0, 1, 2].map((index) => `${"團".repeat(100)}/${"專".repeat(93)}${index}`);
  await seed(store, ids.map((agentId, index) => ({ agentId, projectId: null, content: `memory of agent ${index}`, updatedAt: daysAgo(index) })));
  const pages = await pageAll((params) => store.backend.call("ui.overview", params), { ...REQUEST, limit: 1 });
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.flatMap((page) => page.agents.map((card) => card.id)), ids);
  const stale = await store.backend.call("ui.overview", { ...REQUEST, limit: 1, cursor: `${pages[0].nextCursor.slice(0, -3)}AAA` });
  assert.deepEqual(stale, { ok: false, code: "CURSOR_STALE", retryable: false });
});
