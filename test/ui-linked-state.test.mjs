import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument } from "./fakeDom.mjs";
import { loadUiModule } from "./uiViewHarness.mjs";

const lk = await loadUiModule(
  "state/linked.ts",
  "views/linkedController.ts",
  "views/linkedView.ts",
  "views/linkedEvents.ts",
  "components/drawer.ts",
  "components/dialog.ts",
  "components/dialogFocus.ts",
  "api/errors.ts",
  "api/backendClient.ts",
  "router.ts",
  "dom/html.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/clock.ts",
);

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const hex = (char) => char.repeat(64);
const row = (source, extra = {}) => ({ source, fileId: hex(source.length > 0 ? source.charCodeAt(source.length - 1).toString(16).slice(-1) : "a"), state: "ok", count: 2, sizeBytes: 100, revision: 3, updatedAtMs: NOW - 60_000, ...extra });
const sourcesAnswer = (rows) => ({ ok: true, sources: rows, totals: { sources: rows.length, count: rows.reduce((sum, entry) => sum + entry.count, 0), sizeBytes: 10, corrupt: rows.filter((entry) => entry.state === "corrupt").length }, limits: { items: 2000, bytes: 2097152, sources: 32 } });
const itemRow = (id, extra = {}) => ({ id, snippet: `內容 ${id}`, tags: [], sizeBytes: 10, rev: 1, updatedAtMs: NOW - 1000, expiresAtMs: null, ...extra });
const pageAnswer = (source, items, extra = {}) => ({ ok: true, source, revision: 3, total: items.length, items, nextCursor: null, ...extra });
const ok = (value) => ({ ok: true, value });
const fail = (code) => ({ ok: false, superseded: false, attempts: 1, ...lk.describeError(code) });
const flush = async (turns = 4) => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    of: (method) => calls.filter((call) => call.method === method),
    async call(method, params, options) {
      calls.push({ method, params: { ...params }, options });
      const count = calls.filter((call) => call.method === method).length;
      return handlers[method](params, count);
    },
  };
}

function scene(client) {
  const doc = new FakeDocument();
  const body = doc.createElement("div");
  doc.body.appendChild(body);
  const linked = lk.createLinked({ client, now: () => NOW, document: doc, host: doc.body, backgrounds: () => [body], heading: () => body });
  linked.attach({ body });
  return { doc, body, linked };
}

test("the parsers accept the contract shapes and reject anything else", () => {
  assert.ok(lk.parseSources(sourcesAnswer([row("plugin:a")])));
  assert.equal(lk.parseSources({ ...sourcesAnswer([row("plugin:a")]), ok: false }), null);
  assert.equal(lk.parseSources(sourcesAnswer([{ ...row("plugin:a"), count: -1 }])), null);
  assert.equal(lk.parseSources(sourcesAnswer([{ ...row("plugin:a"), state: "weird" }])), null);
  assert.equal(lk.parseSources(null), null);
  assert.ok(lk.parsePage(pageAnswer("plugin:a", [itemRow("k")])));
  assert.equal(lk.parsePage(pageAnswer("plugin:a", [{ ...itemRow("k"), rev: 0 }])), null);
  assert.equal(lk.parsePage({ ...pageAnswer("plugin:a", []), nextCursor: 5 }), null);
  const detail = { ok: true, source: "plugin:a", revision: 1, item: { id: "k", text: "{}", tags: ["t"], sizeBytes: 2, rev: 1, updatedAtMs: 1, expiresAtMs: null } };
  assert.ok(lk.parseDetail(detail));
  assert.equal(lk.parseDetail({ ...detail, item: { ...detail.item, tags: [1] } }), null);
  assert.equal(lk.isForgetSuccess({ ok: true, forgotten: 1, revision: null }), true);
  assert.equal(lk.isForgetSuccess({ ok: true, forgotten: "1", revision: null }), false);
});

test("sources are grouped by identity, ordered newest first with unreadable files last, and a lone source opens at once", () => {
  const loaded = lk.parseSources(sourcesAnswer([
    row("plugin:old", { updatedAtMs: NOW - 5000, fileId: hex("1") }),
    row("plugin:new", { updatedAtMs: NOW - 10, fileId: hex("2") }),
    { source: null, fileId: hex("3"), state: "corrupt", count: 0, sizeBytes: 0, revision: 0, updatedAtMs: null },
    row("core", { updatedAtMs: null, fileId: hex("4") }),
  ]));
  assert.deepEqual(loaded.sources.map((entry) => entry.source), ["plugin:new", "plugin:old", "core", null]);
  const many = lk.applySources(lk.INITIAL_LINKED, loaded);
  assert.deepEqual(Object.keys(many.panels).sort(), ["core", "plugin:new", "plugin:old"]);
  assert.equal(Object.values(many.panels).some((panel) => panel.open), false);
  const single = lk.applySources(lk.INITIAL_LINKED, lk.parseSources(sourcesAnswer([row("plugin:only")])));
  assert.equal(single.panels["plugin:only"].open, true);
  const kept = lk.applySources(lk.withPanel(many, "plugin:old", { open: true, load: "ready" }), loaded);
  assert.equal(kept.panels["plugin:old"].open, true);
  assert.equal(lk.mergeItems([itemRow("a"), itemRow("b")], [itemRow("b"), itemRow("c")]).map((entry) => entry.id).join(), "a,b,c");
  assert.equal(lk.sourceName("core", { core: "核心", plugin: (id) => `外掛 ${id}` }), "核心");
  assert.equal(lk.sourceName("plugin:x.y", { core: "核心", plugin: (id) => `外掛 ${id}` }), "外掛 x.y");
  const labels = { bytes: (n) => `${n} B`, kb: (n) => `${n} KB` };
  assert.equal(lk.sizeText(1023, labels), "1023 B");
  assert.equal(lk.sizeText(1536, labels), "1.5 KB");
});

test("a single source loads its first page at once; several stay closed until opened and are fetched only once", async () => {
  const one = fakeClient({ "ui.linkSources": () => ok(sourcesAnswer([row("plugin:only")])), "ui.linkList": (params) => ok(pageAnswer(params.source, [itemRow("a")])) });
  const first = scene(one);
  await first.linked.reload();
  assert.equal(one.of("ui.linkList").length, 1);
  assert.deepEqual(one.of("ui.linkList")[0].params, { source: "plugin:only", limit: 12 });
  assert.equal(first.linked.view().panels["plugin:only"].load, "ready");

  const two = fakeClient({ "ui.linkSources": () => ok(sourcesAnswer([row("plugin:a", { fileId: hex("a") }), row("plugin:b", { fileId: hex("b") })])), "ui.linkList": (params) => ok(pageAnswer(params.source, [itemRow("x")])) });
  const second = scene(two);
  await second.linked.reload();
  assert.equal(two.of("ui.linkList").length, 0);
  await second.linked.toggle("plugin:a");
  assert.equal(two.of("ui.linkList").length, 1);
  await second.linked.toggle("plugin:a");
  await second.linked.toggle("plugin:a");
  assert.equal(two.of("ui.linkList").length, 1);
  assert.equal(second.linked.view().panels["plugin:b"].open, false);
});

test("load more appends without repeats and a stale cursor restarts from the first page", async () => {
  let listCalls = 0;
  const client = fakeClient({
    "ui.linkSources": () => ok(sourcesAnswer([row("plugin:only")])),
    "ui.linkList": (params) => {
      listCalls += 1;
      if (params.cursor === undefined) return ok(pageAnswer("plugin:only", [itemRow("a"), itemRow("b")], { nextCursor: "c1", total: 5 }));
      if (params.cursor === "c1") return ok(pageAnswer("plugin:only", [itemRow("b"), itemRow("c")], { nextCursor: "c2", total: 5 }));
      return fail("CURSOR_STALE");
    },
  });
  const s = scene(client);
  await s.linked.reload();
  const added = await s.linked.more("plugin:only");
  assert.deepEqual(added, ["c"]);
  assert.deepEqual(s.linked.view().panels["plugin:only"].items.map((entry) => entry.id), ["a", "b", "c"]);
  assert.equal(s.linked.view().panels["plugin:only"].nextCursor, "c2");
  await s.linked.more("plugin:only");
  assert.deepEqual(client.of("ui.linkList").at(-1).params, { source: "plugin:only", limit: 12 });
  assert.deepEqual(s.linked.view().panels["plugin:only"].items.map((entry) => entry.id), ["a", "b"]);
  assert.equal(listCalls, 4);
});

test("a failing first page shows an error for that source only and retry loads it again", async () => {
  const client = fakeClient({
    "ui.linkSources": () => ok(sourcesAnswer([row("plugin:only")])),
    "ui.linkList": (params, count) => (count === 1 ? fail("STORAGE_BUSY") : ok(pageAnswer(params.source, [itemRow("a")]))),
  });
  const s = scene(client);
  await s.linked.reload();
  assert.equal(s.linked.view().panels["plugin:only"].load, "error");
  assert.equal(s.linked.view().phase, "ready");
  await s.linked.retry("plugin:only");
  assert.equal(s.linked.view().panels["plugin:only"].load, "ready");
});

test("a source that disappears (NOT_FOUND) triggers a fresh source list", async () => {
  let sources = 0;
  const client = fakeClient({
    "ui.linkSources": () => ok(sourcesAnswer(++sources === 1 ? [row("plugin:a", { fileId: hex("a") }), row("plugin:b", { fileId: hex("b") })] : [row("plugin:b", { fileId: hex("b") })])),
    "ui.linkList": (params) => (params.source === "plugin:a" ? fail("NOT_FOUND") : ok(pageAnswer(params.source, [itemRow("x")]))),
  });
  const s = scene(client);
  await s.linked.reload();
  await s.linked.toggle("plugin:a");
  await flush();
  assert.deepEqual(s.linked.view().sources.map((entry) => entry.source), ["plugin:b"]);
});

test("deleting a whole source sends one request even when asked twice, and conflict, gone and failure each reload or report", async () => {
  const gate = deferred();
  let forgets = 0;
  const outcomes = [() => ok({ ok: true, forgotten: 2, revision: null }), () => fail("REVISION_CONFLICT"), () => fail("NOT_FOUND"), () => fail("STORAGE_BUSY")];
  const client = fakeClient({
    "ui.linkSources": () => ok(sourcesAnswer([row("plugin:only")])),
    "ui.linkList": (params) => ok(pageAnswer(params.source, [itemRow("a"), itemRow("b")])),
    "ui.linkForget": async () => {
      const mine = forgets;
      forgets += 1;
      if (mine === 0) await gate.promise;
      return outcomes[mine]();
    },
  });
  const s = scene(client);
  await s.linked.reload();
  const confirmButton = () => s.doc.root.querySelectorAll("button").find((button) => button.getAttribute("data-dialog-action") === "confirm");
  const first = s.linked.forgetSource("plugin:only");
  await flush();
  assert.ok(confirmButton(), "a confirmation comes first");
  const dialogBody = s.doc.root.querySelectorAll("div").find((element) => element.getAttribute("role") === "alertdialog");
  assert.ok(dialogBody.children.length > 0);
  const click = (element) => s.doc.dispatch(element, "click", {});
  click(confirmButton());
  await flush();
  assert.equal(s.linked.view().busy, true);
  await s.linked.forgetSource("plugin:only");
  assert.equal(client.of("ui.linkForget").length, 1, "a second request while busy is ignored");
  gate.resolve();
  await first;
  assert.deepEqual(client.of("ui.linkForget")[0].params, { action: "source", source: "plugin:only", expectedRevision: 3 });
  assert.equal(s.linked.view().busy, false);
  assert.equal(s.linked.view().notice.kind, "text");

  for (const expected of ["text", "text", "error"]) {
    const next = s.linked.forgetSource("plugin:only");
    await flush();
    click(confirmButton());
    await next;
    assert.equal(s.linked.view().notice.kind, expected);
  }
  assert.equal(client.of("ui.linkSources").length, 4, "success, conflict and gone each reload the sources");
});

test("declining the confirmation sends nothing", async () => {
  const client = fakeClient({ "ui.linkSources": () => ok(sourcesAnswer([row("plugin:only")])), "ui.linkList": (params) => ok(pageAnswer(params.source, [itemRow("a")])), "ui.linkForget": () => ok({ ok: true, forgotten: 1, revision: null }) });
  const s = scene(client);
  await s.linked.reload();
  const asked = s.linked.forgetSource("plugin:only");
  await flush();
  s.doc.dispatch(s.doc.root.querySelectorAll("button").find((button) => button.getAttribute("data-dialog-action") === "cancel"), "click", {});
  await asked;
  assert.equal(client.of("ui.linkForget").length, 0);
});

test("ui.linkForget is never retried and never dropped as stale, while reads are retried", async () => {
  const seen = [];
  const backend = lk.createBackendClient({
    call: async (method) => {
      seen.push(method);
      throw new Error("Error invoking remote method 'x': Error: plugin_backend_unavailable");
    },
    retryDelaysMs: [0, 0, 0],
    sleep: async () => undefined,
  });
  const forgotten = await backend.call("ui.linkForget", { action: "damaged", fileId: hex("a") });
  assert.equal(forgotten.ok, false);
  assert.equal(seen.filter((method) => method === "ui.linkForget").length, 1);
  await backend.call("ui.linkList", { source: "core" });
  assert.equal(seen.filter((method) => method === "ui.linkList").length, 4);
});

test("the router knows the linked page", () => {
  assert.deepEqual(lk.parseRoute("#/linked"), { name: "linked" });
  assert.deepEqual(lk.parseRoute("#/settings"), { name: "settings" });
  assert.deepEqual(lk.parseRoute(""), { name: "home" });
});
