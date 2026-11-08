import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { UI_ROOT, loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule("views/agentOrgController.ts", "views/agentOrgView.ts", "views/statusLine.ts", "views/legacyTrial.ts", "components/dialog.ts", "api/errors.ts", "dom/html.ts", "i18n/index.ts", "i18n/zhTW.ts", "i18n/agentOrgStrings.ts");
const AGENT = "sw/dev";
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const model = (overrides = {}) => ({ phase: "ready", agentId: AGENT, pending: 14, run: null, blocked: null, busy: false, notice: null, error: null, waitingMs: null, ...overrides });
const run = (overrides = {}) => ({ agentId: AGENT, state: "running", total: 20, done: 6, failed: 1, untried: 13, startedAt: 1, endedAt: null, lastError: null, ...overrides });
const organization = (overrides = {}) => ({
  state: "running", admitted: 3, pending: 5, replyReady: 0, completed: 3, legacyUnlinked: 0, schemaSkipped: 0, diagnosticsAvailable: true,
  sourceGeneration: null, sourceHighWatermark: null, sourcePages: null, sourceScanned: null, sourceReceived: null, sourceEligible: null, sourceCheckpointed: null,
  lastError: null, errorPhase: null, hostErrorCode: null, retryable: null, partialDelivered: null, lastAttemptAt: null, updatedAt: null, dailyRound: null, ...overrides,
});
const statusOf = (org) => ({ ok: true, version: "1.4.8", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 5, organization: org });

async function statusMarkup(org, expanded = true) {
  const target = { innerHTML: "", dataset: {} };
  const line = ui.createStatusLine({
    client: { async call() { return { ok: true, value: statusOf(org) }; } }, target, now: () => 1_000,
    scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  line.start();
  await flush();
  if (expanded) { line.toggle(); await flush(); }
  return { html: target.innerHTML, state: target.dataset.state };
}

test("the agent page shows how long the AI has been replying, and switches to the warning style past 270 seconds", () => {
  assert.equal(ui.WAITING_WARN_MS, 270_000);
  const normal = ui.agentOrgSection(model({ run: run(), waitingMs: 42_500 })).value;
  assert.ok(normal.includes('data-ao-waiting="normal"'));
  assert.ok(normal.includes("AI 回覆中，已等待 42 秒"));
  assert.ok(!normal.includes('data-ao-waiting="warn"'));
  const edge = ui.agentOrgSection(model({ run: run(), waitingMs: 270_000 })).value;
  assert.ok(edge.includes('data-ao-waiting="normal"'), "exactly 270 seconds is not yet over the limit");
  const warn = ui.agentOrgSection(model({ run: run(), waitingMs: 271_000 })).value;
  assert.ok(warn.includes('data-ao-waiting="warn"'));
  assert.ok(warn.includes("AI 已等 271 秒，超過 270 秒，稍後自動中止"));
  assert.ok(!ui.agentOrgSection(model({ run: run() })).value.includes("data-ao-waiting"), "no wait, no line");
  assert.ok(ui.agentOrgSection(model({ waitingMs: 0 })).value.includes("已等待 0 秒"), "zero is a wait, not an absence");
});

test("the status line shows the wait in the folded line and in the panel, and warns past 270 seconds", async () => {
  const calm = await statusMarkup(organization({ waiting: { sinceMs: 12_000 } }));
  assert.ok(calm.html.includes("AI 回覆中，已等待 12 秒"));
  assert.ok(calm.html.includes('data-waiting="normal"'));
  assert.equal(calm.state, "ok");
  const slow = await statusMarkup(organization({ waiting: { sinceMs: 271_000 } }));
  assert.ok(slow.html.includes('data-waiting="warn"'));
  assert.ok(slow.html.includes("AI 已等 271 秒，超過 270 秒，稍後自動中止"));
  assert.equal(slow.state, "warn");
  const none = await statusMarkup(organization({ waiting: null }));
  assert.ok(!none.html.includes("data-waiting") && !none.html.includes("已等待"));
  const absent = await statusMarkup(organization());
  assert.ok(!absent.html.includes("已等待"));
});

test("a stall pause reads as a paused organization with the existing code and the plugin's own reason", async () => {
  const paused = await statusMarkup(organization({ state: "paused", lastError: "RESOURCE_BUSY", errorPhase: "turn_timeout", hostErrorCode: "turn_backstop", localErrorCode: "stall_paused", retryable: true }));
  assert.ok(paused.html.includes("AI 整理暫停"));
  assert.ok(paused.html.includes("外掛自行判定 stall_paused"));
  assert.equal(paused.state, "warn");
});

test("the controller reads the wait from the answer, keeps polling while a wait is shown, and the contract accepts the optional field", async () => {
  assert.equal(parseUiResponse("ui.agentOrganization", { ok: true, action: "status", agentId: AGENT, pending: 1, blocked: null, run: null, waiting: { sinceMs: 5 } }), true);
  assert.equal(parseUiResponse("ui.agentOrganization", { ok: true, action: "status", agentId: AGENT, pending: 1, blocked: null, run: null, waiting: null }), true);
  assert.equal(parseUiResponse("ui.agentOrganization", { ok: true, action: "status", agentId: AGENT, pending: 1, blocked: null, run: null }), true);
  assert.equal(parseUiResponse("ui.agentOrganization", { ok: true, action: "status", agentId: AGENT, pending: 1, blocked: null, run: null, waiting: { sinceMs: -1 } }), false);
  const timers = [];
  const answers = [{ ok: true, action: "status", agentId: AGENT, pending: 2, blocked: null, run: null, waiting: { sinceMs: 61_000 } }];
  const target = { innerHTML: "" };
  const org = ui.createAgentOrg({
    client: { async call() { return { ok: true, value: answers.shift() ?? { ok: true, action: "status", agentId: AGENT, pending: 2, blocked: null, run: null, waiting: null } }; } },
    scheduler: { set: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clear: () => undefined },
    visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  await org.attach(target, AGENT);
  assert.equal(org.model().waitingMs, 61_000);
  assert.ok(target.innerHTML.includes("AI 回覆中，已等待 61 秒"));
  assert.equal(timers.length, 1, "a visible wait is polled so the number moves");
  timers[0].callback();
  await flush();
  assert.equal(org.model().waitingMs, null);
  assert.ok(!target.innerHTML.includes("已等待"));
});

test("the new strings live in i18n and the new rules are token-only styles", () => {
  const { STRINGS, AGENT_ORG_STRINGS } = ui;
  for (const key of ["ao.waiting", "ao.waiting.long"]) assert.equal(STRINGS[key], AGENT_ORG_STRINGS[key]);
  for (const key of ["status.organization.waiting", "status.organization.waitingLong"]) assert.ok(key in STRINGS, key);
  for (const file of ["styles/agentOrg.css", "styles/status.css"]) {
    const css = readFileSync(join(UI_ROOT, file), "utf8");
    assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/iu.test(css.replace(/hsl\(var\(--h\)[^)]*\)/gu, "")), file + " colors come from tokens");
  }
  assert.match(readFileSync(join(UI_ROOT, "styles/agentOrg.css"), "utf8"), /data-ao-waiting="warn"\] \{\s*color: var\(--warning-strong\)/u);
});

test("snapshot: write the waiting displays as HTML when asked", async (t) => {
  const out = process.env.WAITING_SNAPSHOT_DIR;
  if (out === undefined) { t.skip("WAITING_SNAPSHOT_DIR is not set"); return; }
  mkdirSync(out, { recursive: true });
  const css = ["styles/tokens.css", "styles/app.css", "styles/agentOrg.css", "styles/status.css"].map((file) => readFileSync(join(UI_ROOT, file), "utf8").replace(/@import[^;]*;/gu, "")).join("\n");
  const section = (title, markup) => `<section><h2>${title}</h2>${markup}</section>`;
  const normalAgent = ui.agentOrgSection(model({ run: run(), waitingMs: 42_500 })).value;
  const warnAgent = ui.agentOrgSection(model({ run: run(), waitingMs: 271_000 })).value;
  const normalStatus = await statusMarkup(organization({ waiting: { sinceMs: 42_500 } }));
  const warnStatus = await statusMarkup(organization({ waiting: { sinceMs: 271_000 } }));
  const page = `<!DOCTYPE html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><title>AI 整理等待顯示快照</title><style>${css}\nbody{font:14px sans-serif;max-width:720px;margin:16px auto;padding:0 16px}section{margin-bottom:24px;border-top:1px solid #8884}.status-panel{position:static}</style></head><body><div class="ao">${section("agent 頁：一般等待（42 秒）", normalAgent)}${section("agent 頁：警示等待（301 秒）", warnAgent)}</div>${section("狀態列：一般等待（42 秒），data-state=" + normalStatus.state, `<div class="hdr-status">${normalStatus.html}</div>`)}${section("狀態列：警示等待（301 秒），data-state=" + warnStatus.state, `<div class="hdr-status">${warnStatus.html}</div>`)}</body></html>\n`;
  writeFileSync(join(out, "waiting-snapshot.html"), page, "utf8");
  assert.ok(page.includes('data-ao-waiting="warn"') && page.includes('data-waiting="warn"'));
});

test("both screens warn at the same threshold: 270 seconds after the send, which is before the 330 second backstop", async () => {
  assert.equal(ui.WAITING_WARN_MS, 270_000);
  assert.equal(ui.STATUS_WAITING_WARN_MS, 270_000);
  const { TURN_BACKSTOP_MS } = await import("../out/adapters/model/turnLimits.js");
  assert.ok(ui.WAITING_WARN_MS + 30_000 < TURN_BACKSTOP_MS, "the warning is visible for a while before the backstop frees the turn");
  const edge = await statusMarkup(organization({ waiting: { sinceMs: 270_000 } }));
  assert.ok(edge.html.includes('data-waiting="normal"'));
  const over = await statusMarkup(organization({ waiting: { sinceMs: 270_001 } }));
  assert.ok(over.html.includes('data-waiting="warn"'));
});

test("a stall pause says how many stalls in a row, and both ways to resume, on the status line and on the agent page", async () => {
  const stalled = organization({ state: "paused", pauseReason: "stall", stall: { count: 3, limit: 3 }, lastError: "RESOURCE_BUSY", errorPhase: "turn_timeout", hostErrorCode: "turn_backstop", localErrorCode: "stall_paused", retryable: true });
  const open = await statusMarkup(stalled);
  assert.ok(open.html.includes("連續卡住 3 次"), open.html);
  assert.ok(open.html.includes("按「立即整理」試一筆"));
  assert.ok(open.html.includes("關掉再打開整理"));
  const folded = await statusMarkup(stalled, false);
  assert.ok(folded.html.includes("AI 整理已暫停（連續卡住 3 次）"));
  const page = ui.agentOrgSection(model({ pauseReason: "stall", stallCount: 3 })).value;
  assert.ok(page.includes('data-ao-note="stalled"'));
  assert.ok(page.includes("連續卡住 3 次，已暫停") && page.includes("試一筆") && page.includes("關掉整理再打開"));
  assert.ok(!ui.agentOrgSection(model()).value.includes("data-ao-note=\"stalled\""), "no stall, no note");
  const older = await statusMarkup(organization({ state: "paused", lastError: "RESOURCE_BUSY", errorPhase: "turn_timeout", hostErrorCode: "turn_backstop", localErrorCode: "stall_paused" }));
  assert.ok(older.html.includes("AI 整理暫停"), "an answer without the new fields reads as before");
});

test("an old error and the legacy job count read as neutral notes: no pause wording and no warning colour", async () => {
  const real = await statusMarkup(organization({ state: "idle", lastError: "RESOURCE_BUSY", errorPhase: "session_resume", retryable: true, legacyUnlinked: 3398, legacyTrialCandidates: 3207, pending: 7406 }));
  assert.equal(real.state, "ok");
  assert.ok(real.html.includes("先前遇到 RESOURCE_BUSY，輪到時會自動重試"), real.html);
  assert.ok(real.html.includes("舊工作 3398 筆不會自動整理"));
  assert.ok(!real.html.includes("暫停"), "nothing in the status line says paused");
  const folded = await statusMarkup(organization({ state: "idle", lastError: "RESOURCE_BUSY", legacyUnlinked: 3398 }), false);
  assert.ok(!folded.html.includes("暫停"));
  const error = await statusMarkup(organization({ state: "error", lastError: "STORAGE_BUSY", errorPhase: "commit" }));
  assert.ok(!error.html.includes("先前遇到"), "a real error keeps its own wording");
});

test("while the work records are syncing, the status line and the agent page say so instead of showing a run at 0 of N", async () => {
  const folded = await statusMarkup(organization({ state: "idle", syncing: true }), false);
  assert.ok(folded.html.includes("同步工作紀錄中"), folded.html);
  assert.ok(!folded.html.includes("AI 整理已啟用"));
  const open = await statusMarkup(organization({ state: "idle", syncing: true, pending: 0 }));
  assert.ok(open.html.includes("data-syncing"));
  assert.ok(!open.html.includes("待整理 0"), "the counts are not known yet, so they are not shown");
  const page = ui.agentOrgSection(model({ run: run({ done: 0, failed: 0, untried: 23, total: 23 }), syncing: true })).value;
  assert.ok(page.includes("同步工作紀錄中"));
  assert.ok(!page.includes("整理中 0／23") && !page.includes("<progress"), page);
  const idle = ui.agentOrgSection(model({ syncing: true })).value;
  assert.ok(idle.includes("同步工作紀錄中"));
  assert.ok(ui.agentOrgSection(model({ run: run() })).value.includes("整理中 7／20"), "without syncing the run reads as before");
});

test("the controller reads syncing, pauseReason and stall from the agent answer", async () => {
  const answers = [{ ok: true, action: "status", agentId: AGENT, pending: 23, blocked: null, run: run({ total: 23, done: 0, failed: 0, untried: 23 }), syncing: true, waiting: null }];
  const org = ui.createAgentOrg({
    client: { async call() { return { ok: true, value: answers[0] }; } },
    scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  const target = { innerHTML: "" };
  await org.attach(target, AGENT);
  assert.equal(org.model().syncing, true);
  assert.ok(target.innerHTML.includes("同步工作紀錄中"));
  assert.equal(parseUiResponse("ui.agentOrganization", answers[0]), true);
});
