import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_METHOD_NAMES, parseUiParams, parseUiResponse } from "../out/contracts/uiContract.js";
import { dispatchUi } from "../out/backend/uiDispatch.js";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { FakeDocument } from "./fakeDom.mjs";
import { REPO, UI_ROOT, loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule("views/statusLine.ts", "views/legacyTrial.ts", "components/dialog.ts", "components/dialogFocus.ts", "api/backendClient.ts", "api/errors.ts", "dom/html.ts", "i18n/index.ts", "i18n/zhTW.ts", "i18n/legacyTrialStrings.ts", "i18n/relativeTime.ts");
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const flush = () => new Promise((resolve) => setImmediate(resolve));

const trial = (overrides = {}) => ({
  batchId: "trial-abc-1234", state: "running", requested: 5, adopted: 5, attempted: 2, committed: 1, emptySuccess: 0, skipped: 0, failed: 1, untried: 3,
  startedAt: NOW, endedAt: null, haltReason: null, failures: [{ code: "MODEL_TIMEOUT", phase: "turn_timeout", hostCode: "stalled", localCode: null, count: 1 }], ...overrides,
});
const organization = (overrides = {}) => ({
  state: "paused", admitted: 3, pending: 0, replyReady: 0, completed: 1, legacyUnlinked: 90, legacyTrialCandidates: 80, schemaSkipped: 0, diagnosticsAvailable: true,
  sourceGeneration: null, sourceHighWatermark: null, sourcePages: null, sourceScanned: null, sourceReceived: null, sourceEligible: null, sourceCheckpointed: null,
  lastError: null, errorPhase: null, hostErrorCode: null, retryable: null, partialDelivered: null, lastAttemptAt: null, updatedAt: null, dailyRound: null, trial: null, ...overrides,
});
const statusOf = (org) => ({ ok: true, version: "1.3.7", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 5, organization: org });

async function render(org) {
  const target = { innerHTML: "", dataset: {} };
  const line = ui.createStatusLine({
    client: { async call() { return { ok: true, value: statusOf(org) }; } }, target, now: () => NOW,
    scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  await line.refresh();
  await line.refresh();
  return target.innerHTML;
}

test("C1: a start needs a whole count of 1 to 50 and a requestId, a stop needs a requestId, and nothing else is accepted", async () => {
  const good = { action: "start", requestId: "req-12345678", count: 5 };
  assert.equal(parseUiParams("ui.legacyTrial", good).ok, true);
  assert.equal(parseUiParams("ui.legacyTrial", { action: "stop", requestId: "req-12345678" }).ok, true);
  for (const count of [0, 51, 1.5, "5", -1]) assert.equal(parseUiParams("ui.legacyTrial", { ...good, count }).ok, false, "count " + count);
  assert.equal(parseUiParams("ui.legacyTrial", { action: "start", count: 5 }).ok, false, "no requestId");
  assert.equal(parseUiParams("ui.legacyTrial", { ...good, requestId: "short" }).ok, false);
  assert.equal(parseUiParams("ui.legacyTrial", { ...good, requestId: "x".repeat(65) }).ok, false);
  assert.equal(parseUiParams("ui.legacyTrial", { ...good, extra: true }).ok, false);
  assert.equal(parseUiParams("ui.legacyTrial", { action: "stop", requestId: "req-12345678", count: 5 }).ok, false);
  assert.equal(parseUiParams("ui.legacyTrial", { action: "pause", requestId: "req-12345678" }).ok, false);
  const refused = await dispatchUi("ui.legacyTrial", { ...good, count: 0 }, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, legacyTrial: async () => { throw new Error("must not be reached"); } });
  assert.deepEqual(refused, { ok: false, code: "INVALID_PARAMS", retryable: false });
  const answer = { ok: true, action: "start", requested: 5, adopted: 0, candidates: 0, skippedAmbiguous: 0, blocked: "no_candidates", trial: null };
  assert.equal(parseUiResponse("ui.legacyTrial", answer), true);
  assert.equal(parseUiResponse("ui.legacyTrial", { ...answer, blocked: "elsewhere" }), false);
  assert.equal(parseUiResponse("ui.legacyTrial", { ...answer, extra: 1 }), false);
  const served = await dispatchUi("ui.legacyTrial", good, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, legacyTrial: async () => ({ action: "start", requested: 5, adopted: 0, candidates: 0, skippedAmbiguous: 0, blocked: "no_candidates", trial: null }) });
  assert.deepEqual(served, answer);
  assert.deepEqual(await dispatchUi("ui.legacyTrial", good, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE }), { ok: false, code: "STORAGE_UNSUPPORTED", retryable: false });
  assert.deepEqual(await dispatchUi("ui.legacyTrial", good, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, legacyTrial: async () => { throw new Error("EPERM"); } }), { ok: false, code: "STORAGE_BUSY", retryable: true });
});

test("C2: the contract lists twelve ui methods, the first eight unchanged, in the order the manifest lists them, and the status accepts the new optional fields", () => {
  assert.equal(UI_METHOD_NAMES.length, 12);
  assert.deepEqual(UI_METHOD_NAMES.slice(0, 8), ["ui.overview", "ui.agentStats", "ui.list", "ui.search", "ui.get", "ui.forget", "ui.status", "ui.legacyTrial"]);
  assert.equal(UI_METHOD_NAMES.at(-1), "ui.linkForget");
  const manifest = JSON.parse(readFileSync(join(REPO, "plugin", "manifest.template.json"), "utf8"));
  assert.deepEqual(manifest.backendMethods, [...UI_METHOD_NAMES]);
  assert.equal(parseUiResponse("ui.status", statusOf(organization({ trial: trial() }))), true);
  const { trial: _trial, legacyTrialCandidates: _candidates, ...old } = organization();
  assert.equal(parseUiResponse("ui.status", statusOf(old)), true, "a status without the new fields is still valid");
  assert.equal(parseUiResponse("ui.status", statusOf(organization({ trial: trial({ failures: Array(6).fill(trial().failures[0]) }) }))), false, "at most five failure groups");
});

test("C3: ui.legacyTrial is a write, so a platform failure is neither retried nor dropped", async () => {
  const calls = [];
  const wire = (method, params) => { calls.push(method); return Promise.reject(Object.assign(new Error("plugin_backend_unavailable"), { code: "plugin_backend_unavailable" })); };
  const client = ui.createBackendClient({ call: wire, sleep: () => new Promise(() => undefined) });
  const result = await client.call("ui.legacyTrial", { action: "start", requestId: "req-12345678", count: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "plugin_backend_unavailable");
  assert.equal(result.attempts, 1);
  assert.deepEqual(calls, ["ui.legacyTrial"]);
});

test("U1: the trial controls sit in the status panel outside <details> and are still there after a redraw", async () => {
  const idle = await render(organization());
  const detailsAt = idle.indexOf("<details");
  assert.ok(detailsAt > 0);
  assert.ok(idle.indexOf('data-trial="open"') > 0 && idle.indexOf('data-trial="open"') < detailsAt, "the open button is above the details, not inside them");
  assert.ok(!idle.slice(detailsAt).includes("data-trial="), "nothing that drives the trial is inside the details");
  assert.ok(idle.includes("舊工作 90 筆暫停中（可小量試跑）"));
  assert.ok(idle.includes('data-trial-n="80"'), "the dialog count is the candidate count");

  const running = await render(organization({ trial: trial() }));
  assert.ok(running.indexOf('data-trial="stop"') > 0 && running.indexOf('data-trial="stop"') < running.indexOf("<details"));
  assert.ok(running.includes("試跑 2/5（寫入 1・無需記憶 0・失敗 1）"));
  assert.ok(!running.includes('data-trial="open"'), "no second trial while one runs");
  assert.ok(running.slice(running.indexOf("<details")).includes("MODEL_TIMEOUT"), "the failure groups are in the details");

  const halted = await render(organization({ legacyTrialCandidates: 0, trial: trial({ state: "halted", haltReason: { code: "MODEL_TIMEOUT", phase: "turn_timeout", hostCode: null, localCode: null, consecutive: 3 } }) }));
  assert.ok(halted.includes("試跑已自動停止"));
  assert.ok(!halted.includes("data-trial="), "no candidates and no running trial: no button");
  assert.ok(halted.slice(halted.indexOf("<details")).includes("連續 3 筆"));
  assert.ok(!(await render(organization({ state: "disabled" }))).includes('data-trial="open"'), "AI organization off: no button");
});

function scene(answers = [], trialN = "90") {
  const doc = new FakeDocument();
  const calls = [];
  let refreshed = 0;
  const listeners = [];
  const client = { async call(method, params) { calls.push({ method, params }); return answers.shift() ?? { ok: true, value: { ok: true, action: "start", adopted: 5, blocked: null } }; } };
  ui.bindLegacyTrial({ addEventListener: (_type, listener) => listeners.push(listener) }, { client, document: doc, refresh: async () => { refreshed += 1; }, newRequestId: () => "req-fixed-" + calls.length });
  const click = (kind) => listeners[0]({ target: { closest: () => ({ dataset: { trial: kind, trialN } }) } });
  const buttons = () => doc.body.querySelectorAll("button");
  const labelled = (text) => buttons().find((button) => button.textContent === text);
  return { doc, calls, click, buttons, labelled, refreshed: () => refreshed };
}

test("U2: the dialog focuses cancel, offers 5, 20 and 50, sends one request however often start is clicked, and refreshes when done", async () => {
  const s = scene();
  s.click("open");
  assert.deepEqual(s.buttons().map((button) => button.textContent), ["取消", "試跑 5 筆", "試跑 20 筆", "試跑 50 筆"]);
  assert.equal(s.doc.activeElement.textContent, "取消", "initial focus is on the harmless choice");
  s.click("open");
  assert.equal(s.buttons().length, 4, "a second click on the status button does not open a second dialog");
  const start = s.labelled("試跑 20 筆");
  s.doc.dispatch(start, "click", {});
  s.doc.dispatch(start, "click", {});
  await flush();
  assert.deepEqual(s.calls, [{ method: "ui.legacyTrial", params: { action: "start", requestId: "req-fixed-0", count: 20 } }]);
  assert.equal(s.refreshed(), 1);
  assert.ok(s.labelled("知道了"), "the outcome is shown");
  s.doc.dispatch(s.labelled("知道了"), "click", {});
  await flush();
  assert.equal(s.buttons().length, 0);
  s.click("open");
  assert.equal(s.buttons().length, 4, "the controls work again after the outcome is closed");
  s.doc.dispatch(s.labelled("取消"), "click", {});
  await flush();
});

const dialogText = (s) => s.doc.body.children[0].children[0].children[1].innerHTML;

test("U2b: cancelling sends nothing, stop sends a stop, and a blocked or failed answer is told in plain words", async () => {
  const s = scene([{ ok: true, value: { ok: true, action: "stop", adopted: 5, blocked: "not_running" } }, { ok: false, superseded: false, attempts: 1, code: "STORAGE_BUSY", message: "記憶庫忙碌中。", action: "稍後再試。" }]);
  s.click("open");
  s.doc.dispatch(s.labelled("取消"), "click", {});
  await flush();
  assert.equal(s.calls.length, 0);
  s.click("stop");
  await flush();
  assert.equal(s.calls[0].params.action, "stop");
  assert.ok(dialogText(s).includes("目前沒有進行中的試跑。"));
  s.doc.dispatch(s.labelled("知道了"), "click", {});
  await flush();
  s.click("stop");
  await flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.refreshed(), 2);
  assert.ok(dialogText(s).includes("記憶庫忙碌中。稍後再試。"));
  s.doc.dispatch(s.labelled("知道了"), "click", {});
  await flush();
});

test("U3: every trial string exists, reads as Taiwan Traditional Chinese, and the new view files hold nothing a CSP forbids", async () => {
  const { STRINGS, TRIAL_STRINGS } = ui;
  const keys = Object.keys(TRIAL_STRINGS);
  assert.ok(keys.length >= 20);
  for (const key of keys) assert.equal(STRINGS[key], TRIAL_STRINGS[key], key);
  for (const file of ["views/legacyTrial.ts", "i18n/legacyTrialStrings.ts", "styles/trial.css"]) {
    const text = readFileSync(join(UI_ROOT, file), "utf8");
    for (const pattern of [/\beval\s*\(/u, /new\s+Function\b/u, /https?:\/\//u, /\bfetch\s*\(/u, /\bWebSocket\b/u, /<script/iu, /\son[a-z]+\s*=/iu, /javascript:/iu]) assert.ok(!pattern.test(text), file + " " + pattern);
  }
  const used = [...readFileSync(join(UI_ROOT, "views/legacyTrial.ts"), "utf8").matchAll(/\bt\(\s*"(trial\.[A-Za-z.]+)"/gu)].map((match) => match[1]);
  assert.ok(used.length >= 10);
  for (const key of used) assert.ok(key in STRINGS, key + " is used but missing");
  for (const reason of ["disabled", "trial_running", "no_candidates", "not_running"]) assert.ok(`trial.blocked.${reason}` in STRINGS, reason);
  for (const kind of ["completed", "halted", "stopped"]) assert.ok(`trial.ended.${kind}` in STRINGS, kind);
  const css = readFileSync(join(UI_ROOT, "styles/trial.css"), "utf8");
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/iu.test(css), "colors come from tokens only");
  assert.ok(readFileSync(join(UI_ROOT, "styles/app.css"), "utf8").includes('@import "./trial.css";'));
});

test("R2: the count in the confirm dialog is the number that can be tried, not every paused legacy job", async () => {
  const idle = await render(organization({ legacyUnlinked: 90, legacyTrialCandidates: 80 }));
  assert.ok(idle.includes("舊工作 90 筆暫停中"), "the status line still counts every paused job");
  assert.ok(idle.includes('data-trial-n="80"') && !idle.includes('data-trial-n="90"'), "the button carries the candidate count");
  const s = scene([], "80");
  s.click("open");
  const shown = dialogText(s);
  assert.ok(shown.includes("80 筆舊工作可以試跑"), "the dialog states the number the button carried");
  assert.ok(!shown.includes("暫停中"), "the dialog no longer calls the number the paused total");
  s.doc.dispatch(s.labelled("取消"), "click", {});
  await flush();
});
