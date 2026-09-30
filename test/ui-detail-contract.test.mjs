import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { det, flush } from "./detailFixtures.mjs";
import { FakeDocument } from "./fakeDom.mjs";
import { createTimelineFor, tl } from "./timelineFixtures.mjs";
import { DAY_START, daysAgo, databasePath, punchContent, seed, startStore } from "./uiHarness.mjs";

const AGENT_ID = "sw/developer";
const NOW_MS = Date.parse(DAY_START) + 30 * 3_600_000;
const TOTAL = 6;

const live = [];

afterEach(() => {
  for (const close of live.splice(0)) close();
});

// why: the drawer is only trustworthy if it works on what the real backend sends, so the memories are written through remember and every ui.get and ui.forget here is answered by the real backend and checked against its contract schema
async function build(t) {
  const store = startStore(t);
  const rows = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const at = daysAgo(0, 2 + index);
    rows.push({ agentId: AGENT_ID, projectId: index === 3 ? "proj-x" : null, sessionId: index < 4 ? "S1" : "S2", content: punchContent({ startMs: Date.parse(at) - 3_600_000, title: `第 ${index} 個請求`, body: `成果 zebra${index} 已完成` }), updatedAt: at });
  }
  const made = await seed(store, rows);
  return { store, made };
}

function adapter(store) {
  const client = {
    calls: [],
    async call(method, params, options) {
      client.calls.push({ method, params, options });
      const value = JSON.parse(JSON.stringify(await store.backend.call(method, params)));
      assert.ok(parseUiResponse(method, value), `the backend answer for ${method} matches its contract schema: ${JSON.stringify(value).slice(0, 200)}`);
      if (value.ok === false) return { ok: false, superseded: false, attempts: 1, ...tl.describeError(value.code, "plugin") };
      return { ok: true, value };
    },
  };
  return client;
}

const refOf = (row) => ({ agentId: row.agentId, scope: row.scope, projectId: row.projectId, memoryId: row.id });

// why: the timeline is the real controller over the real ui.list, and its cards are repainted from its own items after every reload, so the focus rules run against what the page would really hold
async function page(t) {
  const { store, made } = await build(t);
  const client = adapter(store);
  const opener = { open: (_ref) => Promise.resolve() };
  const { timeline, open } = createTimelineFor({ client, now: () => NOW_MS, pageSize: 24, onOpenDetail: (ref) => void opener.open(ref) });
  await open(AGENT_ID);
  const doc = new FakeDocument();
  const header = doc.createElement("header");
  const main = doc.createElement("main");
  doc.body.appendChild(header);
  doc.body.appendChild(main);
  const heading = doc.createElement("h2");
  heading.setAttribute("tabindex", "-1");
  main.appendChild(heading);
  const cards = new Map();
  const paint = () => {
    for (const card of cards.values()) card.remove();
    cards.clear();
    for (const item of timeline.view().items) {
      const card = doc.createElement("button");
      card.setAttribute("data-tl-key", det.itemKey(item.ref));
      main.appendChild(card);
      cards.set(det.itemKey(item.ref), card);
    }
  };
  paint();
  const detail = det.createDetail({
    client,
    document: doc,
    host: doc.body,
    schedule: { set: () => 0, clear: () => undefined },
    reloadList: async () => {
      await timeline.reload();
      paint();
    },
    listKeys: () => timeline.view().items.map((item) => det.itemKey(item.ref)),
    cardFor: (key) => cards.get(key) ?? null,
    listHeading: () => heading,
    backgrounds: () => [header, main],
  });
  opener.open = (ref) => detail.open(ref);
  live.push(() => detail.close({ force: true }));
  const all = (tag) => doc.root.querySelectorAll(tag);
  const forgetButton = () => all("button").find((button) => button.getAttribute("data-dt") === "forget");
  const dialogButton = (action) => all("button").find((button) => button.getAttribute("data-dialog-action") === action);
  return {
    store,
    made,
    client,
    timeline,
    detail,
    doc,
    heading,
    card: (row) => cards.get(det.itemKey(refOf(row))),
    body: () => all("aside")[0].children[1].innerHTML,
    async confirm() {
      forgetButton().focus();
      doc.dispatch(detail.element(), "click", { target: { closest: () => ({ dataset: { dt: "forget" } }) } });
      doc.dispatch(dialogButton("forget"), "click", {});
      await flush(6);
    },
  };
}

async function listIds(store) {
  const ids = [];
  let cursor;
  for (let guard = 0; guard < 10; guard += 1) {
    const response = await store.backend.call("ui.list", { agentId: AGENT_ID, limit: 24, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...response.items.map((item) => item.ref.memoryId));
    if (response.nextCursor === null) return ids;
    cursor = response.nextCursor;
  }
  throw new Error("list did not finish");
}

test("the drawer shows what the real ui.get returns: the request, the result, the receipt and the other memories of the same session", async (t) => {
  const { detail, made, body, client } = await page(t);
  const row = made[1];
  await detail.open(refOf(row));
  assert.equal(detail.view().phase, "ready");
  assert.ok(body().includes("第 1 個請求") && body().includes("成果 zebra1 已完成"));
  assert.ok(body().includes("claude・對話 S1・"), "the receipt of the seeding write");
  const siblings = [...body().matchAll(/data-dt="sibling"/gu)].length;
  assert.equal(siblings, 3, "the other three memories of S1 of the same agent");
  assert.deepEqual(client.calls.filter((call) => call.method === "ui.get").map((call) => call.params), [refOf(row)]);
});

test("forgetting through the drawer removes the memory from the real ui.get, ui.list, ui.search and the timeline, and the same content is refused afterwards", async (t) => {
  const { store, made, detail, timeline, body, confirm, card, doc } = await page(t);
  const target = made[2];
  card(target).focus();
  await detail.open(refOf(target));
  assert.ok(body().includes("zebra2"));
  assert.equal((await listIds(store)).length, TOTAL);
  await confirm();
  assert.equal(detail.isOpen(), false);
  assert.deepEqual(await store.backend.call("ui.get", refOf(target)), { ok: false, code: "NOT_FOUND", retryable: false });
  const ids = await listIds(store);
  assert.equal(ids.includes(target.id), false);
  assert.equal(ids.length, TOTAL - 1);
  assert.equal((await store.backend.call("ui.search", { agentId: AGENT_ID, q: "zebra2" })).items.length, 0);
  assert.equal((await store.backend.call("ui.search", { agentId: AGENT_ID, q: "zebra3" })).items.length, 1, "the neighbours are untouched");
  const timelineIds = timeline.view().items.map((item) => item.ref.memoryId);
  assert.equal(timelineIds.includes(target.id), false, "the timeline was reloaded");
  assert.equal(timelineIds.length, TOTAL - 1);
  assert.ok(doc.activeElement !== doc.body, "focus landed on a card or the list title");
  const raw = new DatabaseSync(databasePath(store.dataRoot, AGENT_ID));
  try {
    assert.deepEqual({ ...raw.prepare("SELECT deleted, content FROM memories WHERE id = ?").get(target.id) }, { deleted: 1, content: null });
    assert.equal(raw.prepare("SELECT count(*) AS n FROM receipts WHERE memory_id = ?").get(target.id).n, 0, "the receipts went with it");
    assert.equal(raw.prepare("SELECT count(*) AS n FROM suppressed").get().n, 1);
  } finally {
    raw.close();
  }
  const again = await store.backend.call("memory.remember@1", {
    actor: { agentId: AGENT_ID, projectId: null, sessionId: "again", providerId: "claude" },
    ops: [{ scope: "personal", content: target.content, kind: "context", operationId: "rewrite-1" }],
  });
  assert.equal(again.results[0].ok, false);
  assert.equal(again.results[0].error.code, "MEMORY_SUPPRESSED");
});

test("focus after a real forget lands on the card that took its place", async (t) => {
  const { made, detail, timeline, confirm, card, doc } = await page(t);
  const order = timeline.view().items.map((item) => item.ref.memoryId);
  const target = made.find((row) => row.id === order[2]);
  card(target).focus();
  await detail.open(refOf(target));
  await confirm();
  const after = timeline.view().items.map((item) => det.itemKey(item.ref));
  const focused = doc.activeElement.getAttribute("data-tl-key");
  assert.equal(focused, after[2], "the third card is now the one that followed the forgotten one");
  assert.equal(JSON.parse(focused)[3], order[3]);
});

test("a memory that was written again between opening and forgetting conflicts for real, the drawer re-reads it, and forgetting again works", async (t) => {
  const { store, made, detail, timeline, body, confirm, card } = await page(t);
  const target = made[4];
  card(target).focus();
  await detail.open(refOf(target));
  assert.equal(detail.view().data.revision, 1);
  const rewritten = await store.backend.call("memory.remember@1", {
    actor: { agentId: AGENT_ID, projectId: null, sessionId: "S9", providerId: "codex" },
    ops: [{ scope: "personal", content: target.content, kind: "context", operationId: "dup-1" }],
  });
  assert.equal(rewritten.results[0].value.deduplicated, true);
  await confirm();
  assert.equal(detail.isOpen(), true, "the conflict kept the drawer open");
  assert.equal(detail.view().data.revision, 2, "the drawer holds the latest revision");
  assert.ok(body().includes('data-dt-notice="conflict"'));
  assert.ok(body().includes("codex・對話 S9・"), "the new receipt is on screen");
  assert.equal((await store.backend.call("ui.get", refOf(target))).ok, true, "nothing was forgotten by the conflict");
  assert.equal((await listIds(store)).length, TOTAL);
  await confirm();
  assert.equal(detail.isOpen(), false);
  assert.equal((await store.backend.call("ui.get", refOf(target))).code, "NOT_FOUND");
  assert.equal((await listIds(store)).length, TOTAL - 1);
  assert.equal(timeline.view().items.some((item) => item.ref.memoryId === target.id), false);
});

test("a memory forgotten somewhere else while the drawer is open closes the drawer and leaves the list without it", async (t) => {
  const { store, made, detail, timeline, confirm, card } = await page(t);
  const target = made[0];
  card(target).focus();
  await detail.open(refOf(target));
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(target), expectedRevision: 1 }), { ok: true, forgotten: true });
  await confirm();
  assert.equal(detail.isOpen(), false);
  assert.equal(timeline.view().items.some((item) => item.ref.memoryId === target.id), false);
});

test("opening a memory that has already been forgotten shows the real NOT_FOUND in plain words, and closing refreshes the list", async (t) => {
  const { store, made, detail, timeline, body, card, doc } = await page(t);
  const target = made[5];
  await store.backend.call("ui.forget", { ...refOf(target), expectedRevision: 1 });
  assert.equal(timeline.view().items.some((item) => item.ref.memoryId === target.id), true, "the list on screen is stale");
  card(target).focus();
  await detail.open(refOf(target));
  assert.equal(detail.view().phase, "error");
  assert.ok(body().includes("找不到這筆記憶"));
  doc.dispatch(detail.element(), "click", { target: { closest: () => ({ dataset: { dt: "closeReload" } }) } });
  await flush(6);
  assert.equal(detail.isOpen(), false);
  assert.equal(timeline.view().items.some((item) => item.ref.memoryId === target.id), false);
});

test("a project memory opens with its scope and the same-session list stays inside the one agent", async (t) => {
  const { made, detail, body } = await page(t);
  const project = made[3];
  await detail.open(refOf(project));
  assert.ok(body().includes("專案：") && body().includes("proj-x"));
  assert.equal(detail.view().data.ref.scope, "project");
  assert.equal(detail.view().data.sameSession.every((item) => item.ref.agentId === AGENT_ID), true);
});

test("a click on a timeline card reaches the drawer through the timeline's own hook, and closing returns focus to that card", async (t) => {
  const { made, detail, timeline, card, doc, body } = await page(t);
  const row = made[2];
  card(row).focus();
  timeline.openItem(det.itemKey(refOf(row)));
  await flush(6);
  assert.equal(detail.isOpen(), true);
  assert.ok(body().includes("zebra2"));
  doc.key("Escape");
  assert.equal(detail.isOpen(), false);
  assert.equal(doc.activeElement, card(row));
});
