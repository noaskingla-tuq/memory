import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FakeDocument } from "./fakeDom.mjs";
import { tokenize } from "./timelineFixtures.mjs";
import { REPO, loadUiModule } from "./uiViewHarness.mjs";

const lk = await loadUiModule(
  "state/linked.ts",
  "views/linkedController.ts",
  "views/linkedView.ts",
  "views/linkedEvents.ts",
  "components/drawer.ts",
  "components/dialog.ts",
  "components/dialogFocus.ts",
  "api/errors.ts",
  "dom/html.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/clock.ts",
);

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const TAGS = new Set(["b", "button", "div", "h2", "h3", "li", "p", "pre", "section", "span", "strong", "ul"]);
const ATTRIBUTES = new Set(["aria-controls", "aria-disabled", "aria-expanded", "aria-hidden", "aria-label", "aria-labelledby", "aria-live", "class", "data-code", "data-lk", "data-lk-file", "data-lk-id", "data-lk-notice", "data-lk-source", "id", "role", "tabindex", "title", "type"]);
const CANARIES = ["<img src=x onerror=alert(1)>", '"><script>alert(2)</script>', "<b onmouseover=x>", "'; drop table"];

function assertSafe(markup, label) {
  const { tags, rest } = tokenize(markup);
  assert.ok(!/[<>]/u.test(rest), `${label}: a raw angle bracket survived outside the recognised tags: ${rest.match(/.{0,30}[<>].{0,30}/u)?.[0]}`);
  for (const tag of tags) {
    assert.ok(TAGS.has(tag.name), `${label}: unexpected tag <${tag.name}>`);
    for (const [name, value] of tag.attributes) {
      assert.ok(ATTRIBUTES.has(name), `${label}: unexpected attribute ${name} on <${tag.name}>`);
      assert.ok(value === null || !/[<>"]/u.test(value), `${label}: attribute ${name} carries a raw bracket or quote`);
    }
  }
}

const hex = (char) => char.repeat(64);
const sourceRow = (source, extra = {}) => ({ source, fileId: hex("a"), state: "ok", count: 2, sizeBytes: 2048, revision: 3, updatedAtMs: NOW - 3 * 60_000, ...extra });
const itemRow = (id, extra = {}) => ({ id, snippet: `內容 ${id}`, tags: [], sizeBytes: 10, rev: 1, updatedAtMs: NOW - 1000, expiresAtMs: null, ...extra });
const detailOf = (source, id, extra = {}) => ({ ok: true, source, revision: 3, item: { id, text: `{\n  "v": "${id}"\n}`, tags: ["標籤"], sizeBytes: 9, rev: 1, updatedAtMs: NOW - 1000, expiresAtMs: NOW + 86_400_000, ...extra } });
const ok = (value) => ({ ok: true, value });
const fail = (code) => ({ ok: false, superseded: false, attempts: 1, ...lk.describeError(code) });
const flush = async (turns = 4) => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function readyView(overrides = {}) {
  const sources = overrides.sources ?? [sourceRow("plugin:a.b")];
  let view = lk.applySources(lk.INITIAL_LINKED, { sources, totals: { sources: sources.length, count: 2, sizeBytes: 2048, corrupt: sources.filter((entry) => entry.state === "corrupt").length } });
  for (const [source, change] of Object.entries(overrides.panels ?? {})) view = lk.withPanel(view, source, change);
  return { ...view, ...(overrides.view ?? {}) };
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
  const header = doc.createElement("header");
  const main = doc.createElement("main");
  const body = doc.createElement("div");
  doc.body.appendChild(header);
  doc.body.appendChild(main);
  main.appendChild(body);
  const title = doc.createElement("h2");
  title.setAttribute("tabindex", "-1");
  main.appendChild(title);
  const linked = lk.createLinked({ client, now: () => NOW, document: doc, host: doc.body, backgrounds: () => [header, main], heading: () => title });
  linked.attach({ body });
  const find = (tag, predicate) => doc.root.querySelectorAll(tag).find(predicate);
  return {
    doc,
    body,
    title,
    linked,
    drawer: () => find("aside", (element) => element.getAttribute("role") === "dialog"),
    dialog: () => find("div", (element) => element.getAttribute("role") === "alertdialog"),
    dialogButton: (action) => find("button", (button) => button.getAttribute("data-dialog-action") === action),
    click: (element, extra = {}) => doc.dispatch(element, "click", extra),
    clickDrawer: (lkAction) => doc.dispatch(linked.drawerElement(), "click", { target: { closest: () => ({ dataset: { lk: lkAction } }) } }),
  };
}

function singleSourceClient(overrides = {}) {
  return fakeClient({
    "ui.linkSources": () => ok({ ok: true, sources: [sourceRow("plugin:a.b")], totals: { sources: 1, count: 2, sizeBytes: 2048, corrupt: 0 }, limits: { items: 2000, bytes: 2097152, sources: 32 } }),
    "ui.linkList": (params) => ok({ ok: true, source: params.source, revision: 3, total: 2, items: [itemRow("k1"), itemRow("k2")], nextCursor: null }),
    "ui.linkGet": (params) => ok(detailOf(params.source, params.id)),
    "ui.linkForget": () => ok({ ok: true, forgotten: 1, revision: 4 }),
    ...overrides,
  });
}

test("the shell has a focusable page title, the one-line explanation and a body mount", () => {
  const markup = lk.linkedShell().value;
  assert.ok(markup.includes('<h2 id="linked-title" class="lk-h" tabindex="-1">外掛記憶</h2>'));
  assert.ok(markup.includes("其他外掛經你授權存放在這裡的記憶，只存在本機。刪除後，該外掛就讀取不到。"));
  assert.ok(markup.includes('<div id="linked-body"></div>'));
});

test("a source section shows its name, summary, expand state and a delete-all button, and the first source can be expanded", () => {
  const view = readyView({ sources: [sourceRow("plugin:a.b"), sourceRow("core", { fileId: hex("b"), updatedAtMs: null })], panels: {} });
  const closed = lk.renderLinkedBody(view, NOW).value;
  assertSafe(closed, "closed");
  assert.ok(closed.includes("<b>外掛 a.b</b>"));
  assert.ok(closed.includes("<b>TeamUQ 核心</b>"));
  assert.ok(closed.includes("2 筆・2.0 KB・最後更新 3 分鐘前"));
  assert.ok(closed.includes("2 筆・2.0 KB</span>"), "a source without a last update leaves that part out");
  assert.equal(closed.match(/aria-expanded="false"/gu).length, 2);
  assert.ok(closed.includes('aria-controls="lk-p-0"') && closed.includes('id="lk-p-0"'));
  assert.ok(closed.includes("刪除全部"));
  assert.ok(closed.includes('<div class="tiles">'));
  const opened = lk.renderLinkedBody(readyView({ panels: { "plugin:a.b": { open: true, load: "ready", items: [itemRow("k1", { tags: ["x"], expiresAtMs: NOW + 60_000 })], total: 1, revision: 3 } } }), NOW).value;
  assertSafe(opened, "opened");
  assert.ok(opened.includes('aria-expanded="true"'));
  assert.ok(opened.includes('data-lk="open" data-lk-source="plugin:a.b" data-lk-id="k1"'));
  assert.ok(opened.includes("內容 k1") && opened.includes('<span class="chip">x</span>') && opened.includes("到期"));
});

test("the empty page, the loading page, an error with retry, load more and a failed source all render", () => {
  const empty = lk.renderLinkedBody(readyView({ sources: [] }), NOW).value;
  assert.ok(empty.includes("目前沒有任何外掛把記憶存放在這裡。"));
  assertSafe(empty, "empty");
  assertSafe(lk.renderLinkedBody(lk.INITIAL_LINKED, NOW).value, "loading");
  const error = lk.renderLinkedBody({ ...lk.INITIAL_LINKED, phase: "error", error: lk.describeError("STORAGE_BUSY") }, NOW).value;
  assert.ok(error.includes('data-lk="reload"'));
  assertSafe(error, "error");
  const more = lk.renderLinkedBody(readyView({ panels: { "plugin:a.b": { open: true, load: "ready", items: [itemRow("k1")], nextCursor: "c1", total: 5, revision: 3 } } }), NOW).value;
  assert.ok(more.includes('data-lk="more"') && more.includes("載入更多"));
  const broken = lk.renderLinkedBody(readyView({ panels: { "plugin:a.b": { open: true, load: "error", error: lk.describeError("STORAGE_BUSY") } } }), NOW).value;
  assert.ok(broken.includes('data-lk="retry"'));
  assertSafe(more, "more");
  assertSafe(broken, "broken");
});

test("an unreadable file is a card of its own with the short id and a remove button", () => {
  const view = readyView({ sources: [sourceRow("plugin:ok"), { source: null, fileId: `1234abcd${"0".repeat(56)}`, state: "corrupt", count: 0, sizeBytes: 0, revision: 0, updatedAtMs: null }] });
  const markup = lk.renderLinkedBody(view, NOW).value;
  assertSafe(markup, "damaged");
  assert.ok(markup.includes("無法讀取的資料檔（1234abcd）"));
  assert.ok(markup.includes(`data-lk="removeDamaged" data-lk-file="1234abcd${"0".repeat(56)}"`));
  assert.ok(markup.includes("移除此檔"));
});

test("content from other plugins is escaped everywhere: page, drawer and dialogs", () => {
  for (const canary of CANARIES) {
    const source = `plugin:${canary}`;
    const view = readyView({
      sources: [sourceRow(source)],
      panels: { [source]: { open: true, load: "ready", items: [itemRow(canary, { snippet: canary, tags: [canary] })], total: 1, revision: 3 } },
      view: { notice: { kind: "text", text: canary } },
    });
    const page = lk.renderLinkedBody(view, NOW).value;
    assertSafe(page, `page ${canary}`);
    assert.ok(!page.includes("<img") && !page.includes("<script") && !page.includes("onerror=alert(1)>"), "no live element came out of the canary");
    const drawerView = { phase: "ready", source, id: canary, detail: detailOf(source, canary, { text: canary, tags: [canary] }), error: null, notice: null, forgetting: false };
    const drawer = lk.renderDrawerBody(drawerView).value + lk.renderDrawerFoot(drawerView).value;
    assertSafe(drawer, `drawer ${canary}`);
    assert.ok(!drawer.includes("<img") && !drawer.includes("<script"));
    const dialogs = lk.renderConfirmSource(lk.nameOf(source), 3).value + lk.renderConfirmDamaged(canary).value + lk.renderConfirmItem().value;
    assertSafe(dialogs, `dialogs ${canary}`);
    assert.ok(!dialogs.includes("<img") && !dialogs.includes("<script"));
  }
});

test("the drawer shows the memory, puts focus on its title, and deleting asks first with the cancel button focused", async () => {
  const client = singleSourceClient();
  const s = scene(client);
  await s.linked.reload();
  await s.linked.open("plugin:a.b", "k1");
  const drawer = s.drawer();
  assert.ok(drawer);
  assert.equal(s.doc.activeElement.tagName, "H2");
  assert.equal(drawer.getAttribute("aria-modal"), "true");
  const view = s.linked.drawer();
  assert.equal(view.phase, "ready");
  const body = lk.renderDrawerBody(view).value;
  assertSafe(body, "drawer");
  assert.ok(body.includes('<pre class="dr-txt lk-text">') && body.includes("&quot;v&quot;: &quot;k1&quot;"));
  s.clickDrawer("forgetItem");
  await flush();
  const dialog = s.dialog();
  assert.ok(dialog);
  assert.ok(s.doc.activeElement === s.dialogButton("cancel"), "focus starts on the safe choice");
  const markup = lk.renderConfirmItem().value;
  assert.ok(markup.includes("永久刪除，無法復原。") && markup.includes("存入這筆記憶的外掛之後讀不到它。") && markup.includes("不影響其他外掛，也不影響 agent 的記憶。"));
  s.click(s.dialogButton("cancel"));
  await flush();
  assert.equal(client.of("ui.linkForget").length, 0);
  assert.ok(s.drawer(), "declining leaves the drawer open");
});

test("confirming sends one delete with the item revision, closes the drawer, tells the user and reloads the lists", async () => {
  let listCalls = 0;
  const client = singleSourceClient({ "ui.linkList": (params) => { listCalls += 1; return ok({ ok: true, source: params.source, revision: 3, total: 1, items: [itemRow("k2")], nextCursor: null }); } });
  const s = scene(client);
  await s.linked.reload();
  await s.linked.open("plugin:a.b", "k1");
  s.clickDrawer("forgetItem");
  await flush();
  s.click(s.dialogButton("confirm"));
  s.clickDrawer("forgetItem");
  await flush(8);
  assert.equal(client.of("ui.linkForget").length, 1);
  assert.deepEqual(client.of("ui.linkForget")[0].params, { action: "item", source: "plugin:a.b", id: "k1", expectedItemRev: 1 });
  assert.equal(s.drawer(), undefined);
  assert.equal(s.linked.view().notice.text, "已刪除。");
  assert.ok(listCalls >= 2);
  assert.equal(s.linked.view().busy, false);
});

test("a stale item revision shows the conflict notice with fresh content and deletes nothing", async () => {
  let gets = 0;
  const client = singleSourceClient({
    "ui.linkGet": (params) => ok(detailOf(params.source, params.id, { rev: ++gets === 1 ? 1 : 2, text: gets === 1 ? "old" : "newer" })),
    "ui.linkForget": () => fail("REVISION_CONFLICT"),
  });
  const s = scene(client);
  await s.linked.reload();
  await s.linked.open("plugin:a.b", "k1");
  s.clickDrawer("forgetItem");
  await flush();
  s.click(s.dialogButton("confirm"));
  await flush(8);
  const view = s.linked.drawer();
  assert.equal(view.detail.item.rev, 2);
  assert.equal(view.notice.kind, "conflict");
  assert.ok(lk.renderDrawerBody(view).value.includes("剛剛被更新過"));
  assert.ok(s.drawer());
});

test("an item that is already gone closes the drawer and refreshes the list", async () => {
  const client = singleSourceClient({ "ui.linkForget": () => fail("NOT_FOUND") });
  const s = scene(client);
  await s.linked.reload();
  await s.linked.open("plugin:a.b", "k1");
  s.clickDrawer("forgetItem");
  await flush();
  s.click(s.dialogButton("confirm"));
  await flush(8);
  assert.equal(s.drawer(), undefined);
  assert.ok(client.of("ui.linkSources").length >= 2);
});

test("a retryable failure while deleting keeps the drawer, reports it and lets the user try again", async () => {
  const client = singleSourceClient({ "ui.linkForget": () => fail("STORAGE_BUSY") });
  const s = scene(client);
  await s.linked.reload();
  await s.linked.open("plugin:a.b", "k1");
  s.clickDrawer("forgetItem");
  await flush();
  s.click(s.dialogButton("confirm"));
  await flush(8);
  const view = s.linked.drawer();
  assert.equal(view.forgetting, false);
  assert.equal(view.notice.kind, "failed");
  assertSafe(lk.renderDrawerBody(view).value, "failed");
});

test("deleting a whole source names it and its current count in the confirmation, and removing an unreadable file asks too", async () => {
  const client = singleSourceClient({
    "ui.linkSources": () => ok({ ok: true, sources: [sourceRow("plugin:a.b"), { source: null, fileId: `9f8e7d6c${"0".repeat(56)}`, state: "corrupt", count: 0, sizeBytes: 0, revision: 0, updatedAtMs: null }], totals: { sources: 2, count: 2, sizeBytes: 2048, corrupt: 1 }, limits: { items: 2000, bytes: 2097152, sources: 32 } }),
  });
  const s = scene(client);
  await s.linked.reload();
  s.linked.forgetSource("plugin:a.b");
  await flush();
  const text = s.dialog().children.map((child) => child.textContent).join(" ");
  assert.ok(text.includes("要刪除 外掛 a.b 的全部記憶嗎？"), text);
  const confirmBody = lk.renderConfirmSource("外掛 a.b", 2).value;
  assert.ok(confirmBody.includes("目前有 2 筆，會全部永久刪除，無法復原。"));
  s.click(s.dialogButton("cancel"));
  await flush();
  assert.equal(client.of("ui.linkForget").length, 0);
  void s.linked.removeDamaged(`9f8e7d6c${"0".repeat(56)}`);
  await flush();
  assert.ok(s.dialog());
  s.click(s.dialogButton("confirm"));
  await flush(8);
  assert.deepEqual(client.of("ui.linkForget")[0].params, { action: "damaged", fileId: `9f8e7d6c${"0".repeat(56)}` });
});

test("the delete controls are marked disabled while a delete is running", () => {
  const busy = lk.renderLinkedBody(readyView({ view: { busy: true } }), NOW).value;
  assert.ok(busy.includes('data-lk="forgetSource"') && busy.includes('aria-disabled="true"'));
  const forgetting = lk.renderDrawerFoot({ phase: "ready", source: "core", id: "k", detail: detailOf("core", "k"), error: null, notice: null, forgetting: true }).value;
  assert.ok(forgetting.includes('aria-disabled="true"') && forgetting.includes("正在刪除…"));
});

test("clicks are routed by data-lk attributes only", () => {
  const seen = [];
  const handlers = {};
  const root = { addEventListener: (type, listener) => { handlers[type] = listener; } };
  const actions = Object.fromEntries(["reload", "toggle", "more", "retry", "open", "forgetSource", "removeDamaged"].map((name) => [name, (...args) => seen.push([name, ...args])]));
  lk.bindLinkedEvents(root, actions);
  const hit = (dataset) => handlers.click({ target: { closest: () => ({ dataset }) } });
  hit({ lk: "toggle", lkSource: "core" });
  hit({ lk: "open", lkSource: "core", lkId: "k" });
  hit({ lk: "removeDamaged", lkFile: "f" });
  hit({ lk: "open", lkSource: "core" });
  hit({ tl: "open" });
  handlers.click({ target: {} });
  assert.deepEqual(seen, [["toggle", "core"], ["open", "core", "k"], ["removeDamaged", "f"]]);
});

test("the page is wired into the header navigation, the router, the styles and the manifest order", () => {
  const index = readFileSync(join(REPO, "plugin", "ui", "index.html"), "utf8");
  assert.ok(index.indexOf('id="nav-overview"') < index.indexOf('id="nav-linked"') && index.indexOf('id="nav-linked"') < index.indexOf('id="nav-settings"'));
  assert.ok(index.includes('<a id="nav-linked" href="#/linked">外掛記憶</a>'));
  const main = readFileSync(join(REPO, "src", "ui", "main.ts"), "utf8");
  assert.ok(main.includes('linkedLink.setAttribute("aria-current", "page")'));
  assert.ok(main.includes('next.name === "linked"'));
  assert.ok(readFileSync(join(REPO, "src", "ui", "styles", "app.css"), "utf8").includes('@import "./linked.css";'));
  assert.equal(lk.STRINGS["nav.linked"], "外掛記憶");
});
