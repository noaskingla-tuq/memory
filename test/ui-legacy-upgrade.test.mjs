import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument } from "./fakeDom.mjs";
import { ui as home } from "./homeFixtures.mjs";
import { loadUiModule } from "./uiViewHarness.mjs";

const upgrade = await loadUiModule("views/legacyUpgrade.ts", "components/dialog.ts", "components/dialogFocus.ts", "dom/html.ts", "i18n/index.ts", "i18n/zhTW.ts");
const { renderBanner, parseOverview, bindHomeEvents } = home;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const hex = (character) => character.repeat(64);

const view = (overrides = {}) => ({
  phase: "ready", error: null, notice: null, moreError: null, tiles: null, agents: [], hasMore: false, loadingMore: false, complete: true,
  unavailableAgents: 0, profile: home.HEALTHY_PROFILE, team: null, sort: "recent", helpOpen: false, ...overrides,
});

test("the banner offers the upgrade only for the legacy databases and keeps the old wording for the rest", () => {
  const legacyOnly = renderBanner(view({ unavailableAgents: 3, upgradableAgents: 3 })).value;
  assert.ok(legacyOnly.includes("有 3 位 agent 的記憶是舊格式，升級後才看得到。"));
  assert.ok(legacyOnly.includes('data-act="upgradeLegacy"'));
  assert.ok(legacyOnly.includes('data-legacy-n="3"'));
  assert.equal(legacyOnly.includes("目前讀不到"), false);

  const mixed = renderBanner(view({ unavailableAgents: 5, upgradableAgents: 3 })).value;
  assert.ok(mixed.includes("有 3 位 agent 的記憶是舊格式"));
  assert.ok(mixed.includes("有 2 位 agent 的記憶庫目前讀不到，畫面上不含他們。"));

  const damaged = renderBanner(view({ unavailableAgents: 2, upgradableAgents: 0 })).value;
  assert.ok(damaged.includes("有 2 位 agent 的記憶庫目前讀不到，畫面上不含他們。"));
  assert.equal(damaged.includes("upgradeLegacy"), false);
  assert.equal(renderBanner(view({ unavailableAgents: 2 })).value.includes("upgradeLegacy"), false, "an older backend never sends the field");
  assert.equal(renderBanner(view({ unavailableAgents: 1, upgradableAgents: 4 })).value.includes("有 4 位"), false, "the legacy count can never exceed the unreadable count");
});

test("the overview parser keeps the optional upgradable count and treats a missing or odd one as zero", () => {
  const page = (storage) => ({ ok: true, tiles: { totalMemories: 0, writtenToday: 0, activeAgents7d: 0, agents: 0, lastWriteAt: null }, agents: [], nextCursor: null, storage });
  assert.equal(parseOverview(page({ status: "ready", unavailableAgents: 4, upgradableAgents: 3 })).upgradableAgents, 3);
  assert.equal(parseOverview(page({ status: "ready", unavailableAgents: 4 })).upgradableAgents, 0);
  assert.equal(parseOverview(page({ status: "ready", unavailableAgents: 4, upgradableAgents: "3" })).upgradableAgents, 0);
});

test("clicking the upgrade button hands the count to the action and other clicks do not", () => {
  const log = [];
  const handlers = {};
  bindHomeEvents({ addEventListener: (type, listener) => (handlers[type] = listener) }, {
    reload: () => log.push("reload"), loadMore: () => undefined, dismissHelp: () => undefined, showHelp: () => undefined, setTeam: () => undefined, setSort: () => undefined,
    upgradeLegacy: (count) => log.push(`upgrade:${count}`),
  });
  handlers.click({ target: { closest: () => ({ dataset: { act: "upgradeLegacy", legacyN: "17" } }) } });
  handlers.click({ target: { closest: () => ({ dataset: { act: "reload" } }) } });
  assert.deepEqual(log, ["upgrade:17", "reload"]);
});

function scene(answers) {
  const doc = new FakeDocument();
  const calls = [];
  const order = [];
  const gates = [];
  const client = {
    async call(method, params) {
      calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
      order.push("call");
      const gate = gates.shift();
      if (gate !== undefined) await gate;
      return answers.shift();
    },
  };
  const flow = upgrade.createLegacyUpgrade({ client, document: doc, reload: async () => { order.push("reload"); } });
  const buttons = () => doc.body.querySelectorAll("button");
  const labelled = (text) => buttons().find((button) => button.textContent === text);
  const dialogBody = () => doc.body.children[0].children[0].children[1].innerHTML;
  return { doc, calls, order, gates, flow, buttons, labelled, dialogBody };
}

const batch = (upgraded, failed, remaining, failedHashes = []) => ({
  ok: true,
  value: {
    ok: true, upgraded, failed, remaining,
    results: [...Array.from({ length: upgraded }, (_, index) => ({ agentHash: hex(String(index + 1)), ok: true })), ...failedHashes.map((agentHash) => ({ agentHash, ok: false, code: "STORAGE_BUSY" }))],
  },
});

test("the confirm dialog explains the backup, focuses cancel, and cancelling sends and reloads nothing", async () => {
  const s = scene([]);
  const running = s.flow.run(17);
  assert.deepEqual(s.buttons().map((button) => button.textContent), ["取消", "升級 17 位"]);
  assert.equal(s.doc.activeElement.textContent, "取消");
  assert.ok(s.dialogBody().includes("17 位"));
  assert.ok(s.dialogBody().includes("先自動備份"));
  s.doc.dispatch(s.labelled("取消"), "click", {});
  await running;
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.order, []);
  assert.equal(s.buttons().length, 0);
});

test("confirming shows progress while the backend works, then the counts, and reloads the overview", async () => {
  const failed = hex("f");
  const s = scene([batch(2, 1, 1, [failed]), batch(1, 0, 0)]);
  let release = () => undefined;
  s.gates.push(Promise.resolve(), new Promise((resolve) => { release = resolve; }));
  const running = s.flow.run(4);
  s.doc.dispatch(s.labelled("升級 4 位"), "click", {});
  await flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.buttons().length, 0, "the progress dialog has no button and cannot be dismissed");
  assert.ok(s.dialogBody().includes("已處理 3 / 4 位（成功 2、失敗 1）"));
  s.doc.key("Escape");
  assert.equal(s.doc.body.children.length, 1, "Escape does not close the progress dialog");
  release();
  await flush();
  assert.deepEqual(s.calls.map((call) => call.params), [{ skip: [], limit: 5 }, { skip: [failed], limit: 5 }], "a failed hash is skipped on the next call");
  assert.ok(s.dialogBody().includes("成功 3 位，失敗 1 位。"));
  assert.ok(s.dialogBody().includes("沒有被改動"));
  assert.deepEqual(s.order, ["call", "call", "reload"], "the overview is reloaded after the last call");
  s.doc.dispatch(s.labelled("知道了"), "click", {});
  await running;
  assert.equal(s.buttons().length, 0);
});

test("a backend failure in the middle stops the loop, says why, and still reloads", async () => {
  const s = scene([batch(2, 0, 3), { ok: false, superseded: false, attempts: 1, code: "STORAGE_BUSY", message: "記憶庫忙碌中。", action: "稍後再試。" }]);
  const running = s.flow.run(5);
  s.doc.dispatch(s.labelled("升級 5 位"), "click", {});
  await flush();
  assert.equal(s.calls.length, 2);
  assert.ok(s.dialogBody().includes("成功 2 位，失敗 0 位。"));
  assert.ok(s.dialogBody().includes("記憶庫忙碌中。稍後再試。"));
  assert.deepEqual(s.order.at(-1), "reload");
  s.doc.dispatch(s.labelled("知道了"), "click", {});
  await running;
});

test("an unreadable answer is not counted as success and a second click while running is ignored", async () => {
  const s = scene([{ ok: true, value: { ok: true, upgraded: "many" } }]);
  const running = s.flow.run(2);
  void s.flow.run(2);
  assert.equal(s.buttons().length, 2, "only one confirm dialog opens");
  s.doc.dispatch(s.labelled("升級 2 位"), "click", {});
  await flush();
  assert.ok(s.dialogBody().includes("成功 0 位，失敗 0 位。"));
  assert.ok(s.dialogBody().includes("讀不懂"));
  s.doc.dispatch(s.labelled("知道了"), "click", {});
  await running;
});
