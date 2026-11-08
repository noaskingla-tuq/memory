import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_ROOT, loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule("views/statusLine.ts", "views/legacyTrial.ts", "components/dialog.ts", "components/dialogFocus.ts", "api/backendClient.ts", "api/errors.ts", "dom/html.ts", "i18n/index.ts", "i18n/zhTW.ts", "i18n/legacyTrialStrings.ts", "i18n/relativeTime.ts");
const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const flush = () => new Promise((resolve) => setImmediate(resolve));

const trial = (overrides = {}) => ({
  batchId: "trial-abc-1234", state: "running", requested: 5, adopted: 5, attempted: 3, committed: 2, emptySuccess: 1, skipped: 0, failed: 0, untried: 2,
  startedAt: NOW, endedAt: null, haltReason: null, failures: [], ...overrides,
});
const organization = (overrides = {}) => ({
  state: "paused", admitted: 3, pending: 0, replyReady: 0, completed: 1, legacyUnlinked: 3401, legacyTrialCandidates: 3400, schemaSkipped: 0, diagnosticsAvailable: true,
  sourceGeneration: null, sourceHighWatermark: null, sourcePages: null, sourceScanned: null, sourceReceived: null, sourceEligible: null, sourceCheckpointed: null,
  lastError: null, errorPhase: null, hostErrorCode: null, retryable: null, partialDelivered: null, lastAttemptAt: null, updatedAt: null, dailyRound: null, trial: null, ...overrides,
});
const statusOf = (org, overrides = {}) => ({ ok: true, version: "1.3.7", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 5, ...(org === undefined ? {} : { organization: org }), ...overrides });

// why: a real element loses focus when its markup is replaced, so the fake does too and a redraw has to put focus back by itself
function fakeTarget() {
  const document = { activeElement: null };
  const button = { focus: () => { document.activeElement = button; } };
  let markup = "";
  let writes = 0;
  return {
    dataset: {},
    ownerDocument: document,
    button,
    get writes() { return writes; },
    get innerHTML() { return markup; },
    set innerHTML(value) { writes += 1; markup = value; document.activeElement = null; },
    querySelector: (selector) => (selector === "[data-status-toggle]" && markup.includes("data-status-toggle") ? button : null),
  };
}

function rig(first) {
  const target = fakeTarget();
  let current = first;
  const line = ui.createStatusLine({
    client: { async call() { return current; } }, target, now: () => NOW,
    scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  return { target, line, next: (value) => { current = value; } };
}

async function shown(value) {
  const r = rig({ ok: true, value });
  await r.line.refresh();
  return r;
}

const compactOf = (markup) => /<span class="status-text">([^<]*)<\/span>/u.exec(markup)?.[1] ?? null;
const panelOf = (markup) => {
  const found = /<div id="status-panel" class="status-panel"( hidden)?>/u.exec(markup);
  assert.ok(found !== null, "the panel exists");
  return { hidden: found[1] !== undefined, inner: markup.slice(found.index) };
};
const toggleOf = (markup) => /<button type="button" class="status-toggle"[^>]*>/u.exec(markup)?.[0] ?? null;
const expandedOf = (markup) => /aria-expanded="([a-z]+)"/u.exec(toggleOf(markup) ?? "")?.[1] ?? null;

test("S1: the compact line says the one thing that matters in each state", async () => {
  const idle = await shown(statusOf(organization({ state: "idle", legacyUnlinked: 0, legacyTrialCandidates: 0, pending: 4 })));
  assert.equal(compactOf(idle.target.innerHTML), "AI 整理已啟用");
  assert.equal(idle.target.dataset.state, "ok");

  const paused = await shown(statusOf(organization()));
  assert.equal(compactOf(paused.target.innerHTML), "AI 整理暫停 · 舊工作 3401 筆");
  assert.equal(paused.target.dataset.state, "warn");

  const errored = await shown(statusOf(organization({ state: "error", legacyUnlinked: 0, legacyTrialCandidates: 0, lastError: "MODEL_TIMEOUT", errorPhase: "turn_timeout", hostErrorCode: "stalled" })));
  assert.equal(compactOf(errored.target.innerHTML), "AI 整理遇到問題");
  assert.equal(errored.target.dataset.state, "warn");
  assert.ok(panelOf(errored.target.innerHTML).inner.includes("（失敗階段 turn_timeout・主程式代碼 stalled）"), "the reason moved into the panel, it did not disappear");

  const running = await shown(statusOf(organization({ state: "running", trial: trial() })));
  assert.equal(compactOf(running.target.innerHTML), "AI 正在整理 · 試跑 3/5 · 舊工作 3401 筆");
  assert.equal(expandedOf(running.target.innerHTML), "false", "the progress is readable while the panel is folded");
  assert.equal(panelOf(running.target.innerHTML).hidden, true);
});

test("S2: the other states keep the priority the full line had, and a failed call is still an error", async () => {
  const disabled = await shown(statusOf(organization({ state: "disabled", legacyUnlinked: 0, legacyTrialCandidates: 0 })));
  assert.equal(compactOf(disabled.target.innerHTML), "AI 整理關閉");
  const plain = await shown(statusOf(undefined));
  assert.equal(compactOf(plain.target.innerHTML), "記憶服務運作中");
  const trouble = await shown(statusOf(organization({ state: "idle" }), { storage: { status: "storage_busy" } }));
  assert.equal(compactOf(trouble.target.innerHTML), "記憶庫目前無法正常讀寫，請稍後再試 · 舊工作 3401 筆", "storage trouble outranks the organization phase");
  assert.equal(trouble.target.dataset.state, "warn");

  const broken = rig({ ok: false, superseded: false, attempts: 1, code: "plugin_backend_crashed", message: "記憶服務停了。", action: "請稍後再試。", retryable: true });
  await broken.line.refresh();
  assert.equal(broken.target.dataset.state, "error");
  assert.equal(compactOf(broken.target.innerHTML), "記憶服務停了。");
  assert.ok(broken.target.innerHTML.includes("data-retry"), "retry stays in the folded line");
  assert.ok(panelOf(broken.target.innerHTML).inner.includes("請稍後再試。"));

  const garbage = rig({ ok: true, value: { nonsense: true } });
  await garbage.line.refresh();
  assert.equal(compactOf(garbage.target.innerHTML), ui.STRINGS["status.malformed"]);
  assert.equal(toggleOf(garbage.target.innerHTML), null, "nothing to unfold, so no toggle");
  garbage.line.toggle();
  assert.equal(garbage.line.expanded(), false);
});

test("S3: the legacy count appears only when there is something to count", async () => {
  const none = await shown(statusOf(organization({ legacyUnlinked: 0, legacyTrialCandidates: 0 })));
  assert.equal(compactOf(none.target.innerHTML), "AI 整理暫停");
  assert.equal(compactOf(none.target.innerHTML).includes("舊工作"), false);
  assert.equal(panelOf(none.target.innerHTML).inner.includes("舊工作"), false);
  const some = await shown(statusOf(organization({ legacyUnlinked: 1, legacyTrialCandidates: 1 })));
  assert.equal(compactOf(some.target.innerHTML), "AI 整理暫停 · 舊工作 1 筆");
});

test("S4: the toggle is a button whose aria-expanded follows the panel, and the panel stays unfolded across redraws", async () => {
  const r = await shown(statusOf(organization()));
  const markup = () => r.target.innerHTML;
  const button = toggleOf(markup());
  assert.ok(button.startsWith('<button type="button"'), "a real button, so Enter and Space work");
  assert.ok(button.includes('aria-controls="status-panel"'));
  assert.equal(expandedOf(markup()), "false");
  assert.equal(panelOf(markup()).hidden, true);
  assert.ok(button.includes('aria-label="展開狀態與詳情"'));

  r.line.toggle();
  assert.equal(r.line.expanded(), true);
  assert.equal(expandedOf(markup()), "true");
  assert.equal(panelOf(markup()).hidden, false);
  assert.ok(toggleOf(markup()).includes('aria-label="收合狀態與詳情"'));
  assert.equal(r.target.ownerDocument.activeElement, r.target.button, "focus stays on the toggle after it is pressed");

  r.next({ ok: true, value: statusOf(organization({ pending: 9 })) });
  await r.line.refresh();
  assert.equal(expandedOf(markup()), "true", "a poll redraw does not fold the panel");
  assert.ok(panelOf(markup()).inner.includes("待整理 9"));
  assert.equal(r.target.ownerDocument.activeElement, r.target.button, "and does not drop focus");

  r.line.toggle();
  assert.equal(r.line.expanded(), false);
  assert.equal(expandedOf(markup()), "false");
  assert.equal(panelOf(markup()).hidden, true);
});

test("S5: the trial button and the details are in the panel, and only an open panel shows them", async () => {
  const r = await shown(statusOf(organization()));
  const folded = panelOf(r.target.innerHTML);
  assert.equal(folded.hidden, true);
  assert.ok(folded.inner.includes('data-trial="open"'), "the button is rendered inside the folded panel, not beside the compact line");
  assert.ok(!r.target.innerHTML.slice(0, r.target.innerHTML.indexOf('<div id="status-panel"')).includes("data-trial="), "nothing outside the panel drives the trial");
  r.line.toggle();
  const open = panelOf(r.target.innerHTML);
  assert.equal(open.hidden, false);
  assert.ok(open.inner.includes('data-trial="open" data-trial-n="3400"'));
  assert.ok(open.inner.includes("小量試跑…"));
  assert.ok(open.inner.includes("<summary>整理與來源詳情</summary>"));
  for (const text of ["記憶服務運作中", "還沒有記憶寫入", "AI 整理暫停", "已收錄 3 · 待整理 0 · 回覆待提交 0 · 整理完成 1", "舊佇列有 3401 筆工作不會自動整理（可小量試跑）", "來源略過 0"]) assert.ok(open.inner.includes(text), text);

  const running = await shown(statusOf(organization({ state: "running", trial: trial() })));
  running.line.toggle();
  assert.ok(panelOf(running.target.innerHTML).inner.includes('data-trial="stop"'));
});

test("S6: an unchanged poll does not redraw, so open details and focus survive it", async () => {
  const r = await shown(statusOf(organization()));
  const before = r.target.writes;
  await r.line.refresh();
  await r.line.refresh();
  assert.equal(r.target.writes, before, "identical markup is not written again");
  r.next({ ok: true, value: statusOf(organization({ pending: 1 })) });
  await r.line.refresh();
  assert.equal(r.target.writes, before + 1);
});

test("S7: clicking the toggle toggles, Escape folds it, and nothing else does", async () => {
  const r = await shown(statusOf(organization()));
  const listeners = {};
  ui.bindStatusToggle({ addEventListener: (type, listener) => { listeners[type] = listener; } }, r.line);
  const onToggle = { closest: (selector) => (selector === "[data-status-toggle]" ? {} : null) };
  const elsewhere = { closest: () => null };
  listeners.click({ target: elsewhere });
  listeners.click({ target: null });
  assert.equal(r.line.expanded(), false);
  listeners.click({ target: onToggle });
  assert.equal(expandedOf(r.target.innerHTML), "true");
  listeners.keydown({ target: elsewhere, key: "Enter" });
  assert.equal(r.line.expanded(), true);
  listeners.keydown({ target: elsewhere, key: "Escape" });
  assert.equal(expandedOf(r.target.innerHTML), "false");
  assert.equal(r.target.ownerDocument.activeElement, r.target.button, "Escape returns focus to the toggle");
  const writes = r.target.writes;
  listeners.keydown({ target: elsewhere, key: "Escape" });
  assert.equal(r.target.writes, writes, "Escape on a folded panel does nothing");
});

test("S8: the compact line is ellipsised in one row, the settings cards use the width, and the new files hold nothing a CSP forbids", () => {
  const read = (file) => readFileSync(join(UI_ROOT, file), "utf8");
  const status = read("styles/status.css");
  assert.ok(read("styles/app.css").includes('@import "./status.css";'));
  const text = /\.status-compact \.state \{([^}]*)\}/u.exec(status)?.[1] ?? "";
  for (const declaration of ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap", "min-width: 0"]) assert.ok(text.includes(declaration), declaration);
  assert.ok(/\.hdr-status \{[^}]*flex: 1 1 0;[^}]*min-width: 0;/u.test(status), "the status area shrinks instead of wrapping the header");
  const settings = read("styles/settings.css");
  assert.ok(/\.settings-page \{[^}]*width: 100%;[^}]*max-width: 1200px;/u.test(settings));
  assert.ok(!settings.includes("48rem;\n  margin: 0 auto"), "the narrow 48rem cap is gone");
  assert.ok(/main:has\(\.settings-page\) \{[^}]*max-width: calc\(1200px/u.test(settings), "main no longer clips the settings page below 1200px");
  assert.ok(/\.setting-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(18rem, 1fr\);/u.test(settings), "copy and control columns are balanced");
  for (const file of ["views/statusLine.ts", "styles/status.css"]) {
    const source = read(file);
    for (const pattern of [/\beval\s*\(/u, /new\s+Function\b/u, /https?:\/\//u, /\bfetch\s*\(/u, /\bWebSocket\b/u, /<script/iu, /\son[a-z]+\s*=/iu, /javascript:/iu]) assert.ok(!pattern.test(source), file + " " + pattern);
  }
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/iu.test(status.replace(/rgba\(0, 0, 0, [0-9.]+\)/gu, "")), "colours come from tokens only");
  for (const key of ["status.compact.legacy", "status.compact.expand", "status.compact.collapse", "trial.compact"]) assert.ok(key in ui.STRINGS, key);
});
