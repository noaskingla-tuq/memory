import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parsePunchContent } from "../out/application/ui/punchContent.js";
import { agentHashOf, daysAgo, newestFirst, pageAll, punchContent, seed, startStore } from "./uiHarness.mjs";

const AGENTS = ["a/one", "a/two", "b/three", "c/four"];
const WORDS = ["alpha", "Beta", "登入", "驗證", "GAMMA", "Éa"];
const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const folded = (row) => asciiLower(row.content.normalize("NFKC"));
const cliOf = (row) => parsePunchContent(row.content.normalize("NFKC")).work?.cli ?? null;

function specs() {
  const rows = [];
  for (let index = 0; index < 150; index += 1) {
    const group = Math.floor(index / 4);
    const at = daysAgo(group % 20, group % 24);
    const agentId = AGENTS[index % 4];
    const projectId = index % 5 === 0 ? `p-${index % 3}` : null;
    const words = WORDS.filter((_, bit) => (index >> bit) & 1).join(" ");
    const content =
      index % 11 === 0
        ? `plain note ${index} ${words}`
        : punchContent({ startMs: Date.parse(at) - 1_800_000, cli: index % 3 === 0 ? "codex" : "claude", title: `工作 ${index}`, body: `內容 ${words} #${index}` });
    rows.push({ agentId, projectId, content, updatedAt: at });
  }
  rows.push({ agentId: "a/one", projectId: null, content: `${"filler ".repeat(120)}needle${" tail".repeat(60)}`, updatedAt: daysAgo(0, 23) });
  return rows;
}

async function build(t, overrides) {
  const store = startStore(t, overrides);
  return { store, made: await seed(store, specs()) };
}

const call = (store, method) => (params) => store.backend.call(method, params);
const idsOf = (pages) => pages.flatMap((page) => page.items.map((item) => item.ref.memoryId));

function listFilter(made, { agentId, scope, projectId, sinceIso, untilIso, cli, terms = [] }) {
  return made
    .filter((row) => agentId === undefined || row.agentId === agentId)
    .filter((row) => scope === undefined || row.scope === scope)
    .filter((row) => projectId === undefined || row.projectId === projectId)
    .filter((row) => sinceIso === undefined || row.updatedAt >= sinceIso)
    .filter((row) => untilIso === undefined || row.updatedAt < untilIso)
    .filter((row) => cli === undefined || cliOf(row) === cli)
    .filter((row) => terms.every((term) => folded(row).includes(asciiLower(term))))
    .sort(newestFirst)
    .map((row) => row.id);
}

test("paging ui.list with any page size returns every memory once, in (updated_at desc, id) order", async (t) => {
  const { store, made } = await build(t);
  const expected = listFilter(made, {});
  for (const limit of [1, 5, 24]) {
    const pages = await pageAll(call(store, "ui.list"), { limit });
    assert.deepEqual(idsOf(pages), expected, `limit ${limit}`);
    assert.ok(pages.slice(0, -1).every((page) => page.items.length === limit), "every page but the last is full");
  }
  const first = (await store.backend.call("ui.list", { limit: 3 })).items[0];
  assert.deepEqual(first.ref, { agentId: made.find((row) => row.id === expected[0]).agentId, scope: first.ref.scope, projectId: first.ref.projectId, memoryId: expected[0] });
});

test("ui.list filters by agent, scope, project, time window and cli exactly like a brute-force filter", async (t) => {
  const { store, made } = await build(t);
  const since = daysAgo(9, 0);
  const until = daysAgo(2, 0);
  const cases = [
    { agentId: "a/two" },
    { scope: "project" },
    { scope: "personal", agentId: "c/four" },
    { projectId: "p-1" },
    { sinceIso: since },
    { untilIso: until },
    { sinceIso: since, untilIso: until },
    { cli: "codex" },
    { cli: "claude", agentId: "b/three", sinceIso: since },
    { cli: "nobody" },
  ];
  for (const filter of cases) {
    const expected = listFilter(made, filter);
    const pages = await pageAll(call(store, "ui.list"), { ...filter, limit: 6 });
    assert.deepEqual(idsOf(pages), expected, JSON.stringify(filter));
  }
});

test("a listed item carries its work info, a body snippet and its receipt count", async (t) => {
  const { store, made } = await build(t);
  const target = made.find((row) => cliOf(row) === "codex");
  const page = await store.backend.call("ui.list", { agentId: target.agentId, scope: target.scope, ...(target.projectId === null ? {} : { projectId: target.projectId }), limit: 24 });
  const item = page.items.find((entry) => entry.ref.memoryId === target.id);
  assert.ok(item !== undefined);
  assert.equal(item.work.cli, "codex");
  assert.match(item.work.title, /^工作 \d+$/u);
  assert.ok(item.snippet.startsWith("內容"));
  assert.equal(item.receiptCount, 1);
  const plain = made.find((row) => row.content.startsWith("plain note"));
  const plainItem = await findItem(store, plain);
  assert.equal("work" in plainItem, false);
  assert.ok(plainItem.snippet.startsWith("plain note"));
});

async function findItem(store, row) {
  const pages = await pageAll(call(store, "ui.list"), { agentId: row.agentId, limit: 24 });
  return pages.flatMap((page) => page.items).find((entry) => entry.ref.memoryId === row.id);
}

test("ui.search needs every term, folds ASCII case and NFKC, and pages exactly like the brute-force result", async (t) => {
  const { store, made } = await build(t);
  const queries = [
    { q: "alpha", terms: ["alpha"] },
    { q: "ALPHA 登入", terms: ["alpha", "登入"] },
    { q: "  ＡＬＰＨＡ　　登入  ", terms: ["alpha", "登入"], normalized: "ALPHA 登入" },
    { q: "beta gamma", terms: ["beta", "gamma"] },
    { q: "驗證", terms: ["驗證"] },
    { q: "alpha alpha 登入", terms: ["alpha", "登入"] },
    { q: "Éa", terms: ["Éa"] },
    { q: "éa", terms: ["éa"] },
    { q: "nomatchzz", terms: ["nomatchzz"] },
  ];
  for (const { q, terms, normalized } of queries) {
    const expected = listFilter(made, { terms });
    for (const limit of [4, 24]) {
      const pages = await pageAll(call(store, "ui.search"), { q, limit });
      assert.deepEqual(idsOf(pages), expected, `${q} limit ${limit}`);
      for (const page of pages) {
        assert.equal(page.mode, "literal");
        assert.equal(page.scanned.complete, true);
        assert.equal(page.normalizedQuery, normalized ?? q.normalize("NFKC").replace(/\s+/gu, " ").trim());
      }
    }
  }
  assert.ok(listFilter(made, { terms: ["éa"] }).length === 0 && listFilter(made, { terms: ["Éa"] }).length > 0, "non-ASCII letters keep their case");
  const filtered = { q: "alpha", cli: "codex", scope: "personal", sinceIso: daysAgo(12, 0) };
  const pages = await pageAll(call(store, "ui.search"), { ...filtered, limit: 3 });
  assert.deepEqual(idsOf(pages), listFilter(made, { terms: ["alpha"], cli: "codex", scope: "personal", sinceIso: daysAgo(12, 0) }));
});

test("a search snippet is centred on the first hit and never longer than 160 code points", async (t) => {
  const { store, made } = await build(t);
  const target = made.find((row) => row.content.includes("needle"));
  const response = await store.backend.call("ui.search", { q: "NEEDLE", limit: 5 });
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].ref.memoryId, target.id);
  const { snippet } = response.items[0];
  assert.ok(snippet.includes("needle"));
  assert.ok(snippet.startsWith("…"));
  assert.ok(Array.from(snippet).length <= 160);
  const shortHit = await store.backend.call("ui.search", { q: "alpha", limit: 1 });
  assert.ok(Array.from(shortHit.items[0].snippet).length <= 160);
});

test("bad search queries are INVALID_PARAMS, not an empty page", async (t) => {
  const { store } = await build(t);
  const bad = ["   ", "　　", Array.from({ length: 17 }, (_, index) => `t${index}`).join(" ")];
  for (const q of bad) assert.deepEqual(await store.backend.call("ui.search", { q }), { ok: false, code: "INVALID_PARAMS", retryable: false });
  const many = await store.backend.call("ui.search", { q: Array.from({ length: 16 }, (_, index) => `t${index}`).join(" ") });
  assert.equal(many.ok, true);
});

test("cursors: page size may change, a changed filter or a restarted plugin makes the cursor CURSOR_STALE", async (t) => {
  const { store, made } = await build(t);
  const expected = listFilter(made, {});
  const first = await store.backend.call("ui.list", { limit: 5 });
  const second = await store.backend.call("ui.list", { limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.ref.memoryId), expected.slice(5, 8));
  const stale = { ok: false, code: "CURSOR_STALE", retryable: false };
  assert.deepEqual(await store.backend.call("ui.list", { limit: 5, agentId: "a/one", cursor: first.nextCursor }), stale);
  assert.deepEqual(await store.backend.call("ui.search", { q: "alpha", cursor: first.nextCursor }), stale);
  const search = await store.backend.call("ui.search", { q: "alpha", limit: 2 });
  assert.deepEqual(await store.backend.call("ui.search", { q: "beta", limit: 2, cursor: search.nextCursor }), stale);
  assert.deepEqual(await store.backend.call("ui.search", { q: "  alpha ", limit: 2, cursor: search.nextCursor }).then((response) => response.ok), true, "the same normalized query keeps the cursor valid");
  const restarted = store.open();
  assert.deepEqual(await restarted.call("ui.list", { limit: 5, cursor: first.nextCursor }), stale);
  const fresh = await restarted.call("ui.list", { limit: 5 });
  assert.deepEqual(fresh.items.map((item) => item.ref.memoryId), expected.slice(0, 5));
});

function flakyClock(state) {
  return () => {
    let calls = 0;
    const limit = state.limit;
    return { sliceExpired: () => false, timeUp: () => (calls += 1) > limit, yieldNow: async () => undefined, yieldIfDue: async () => undefined };
  };
}

test("a call that runs out of time returns an exact prefix, and following the cursors still yields every row once", async (t) => {
  const state = { limit: Number.POSITIVE_INFINITY };
  const { store, made } = await build(t, { uiClock: flakyClock(state) });
  const cases = [
    { method: "ui.list", params: { limit: 7 }, expected: listFilter(made, {}) },
    { method: "ui.list", params: { limit: 4, scope: "project" }, expected: listFilter(made, { scope: "project" }) },
    { method: "ui.search", params: { q: "alpha", limit: 5 }, expected: listFilter(made, { terms: ["alpha"] }) },
    { method: "ui.search", params: { q: "nomatchzz", limit: 5 }, expected: [] },
  ];
  let cutShort = 0;
  for (const { method, params, expected } of cases) {
    const seen = [];
    let cursor;
    for (let round = 0; round < 600; round += 1) {
      state.limit = 5 + ((round * 7) % 41);
      let response = await store.backend.call(method, cursor === undefined ? params : { ...params, cursor });
      if (response.ok === false) {
        assert.deepEqual(response, { ok: false, code: "RESOURCE_BUSY", retryable: true }, "only an index that cannot be built in time may fail");
        state.limit = Number.POSITIVE_INFINITY;
        response = await store.backend.call(method, cursor === undefined ? params : { ...params, cursor });
      }
      assert.equal(response.ok, true);
      if (response.items.length < params.limit && response.nextCursor !== null) cutShort += 1;
      if (method === "ui.search" && response.nextCursor !== null && response.items.length < params.limit) assert.equal(response.scanned.complete, false, "a cut-short page says it is incomplete");
      seen.push(...response.items.map((item) => item.ref.memoryId));
      if (response.nextCursor === null) break;
      cursor = response.nextCursor;
      assert.ok(round < 599, "the cursors must make progress");
    }
    assert.deepEqual(seen, expected, `${method} ${JSON.stringify(params)}`);
  }
  assert.ok(cutShort > 0, "the fake clock really cut pages short");
});

test("an unreadable agent makes a search report complete:false while list and the other agents keep working", async (t) => {
  const { store, made } = await build(t);
  const broken = join(store.dataRoot, "agents", agentHashOf("broken/agent"));
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "memory.sqlite"), "not sqlite ".repeat(500));
  const search = await store.backend.call("ui.search", { q: "alpha", limit: 24 });
  assert.equal(search.ok, true);
  assert.equal(search.scanned.complete, false);
  assert.ok(search.items.length > 0);
  const listed = await pageAll(call(store, "ui.list"), { limit: 24 });
  assert.deepEqual(idsOf(listed), listFilter(made, {}));
});
