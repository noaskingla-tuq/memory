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
const statusOf = (org) => ({ ok: true, version: "1.4.7", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 5, organization: org });

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

test("the agent page shows how long the AI has been replying, and switches to the warning style past 300 seconds", () => {
  assert.equal(ui.WAITING_WARN_MS, 300_000);
  const normal = ui.agentOrgSection(model({ run: run(), waitingMs: 42_500 })).value;
  assert.ok(normal.includes('data-ao-waiting="normal"'));
  assert.ok(normal.includes("AI 回覆中，已等待 42 秒"));
  assert.ok(!normal.includes('data-ao-waiting="warn"'));
  const edge = ui.agentOrgSection(model({ run: run(), waitingMs: 300_000 })).value;
  assert.ok(edge.includes('data-ao-waiting="normal"'), "exactly 300 seconds is not yet over the limit");
  const warn = ui.agentOrgSection(model({ run: run(), waitingMs: 301_000 })).value;
  assert.ok(warn.includes('data-ao-waiting="warn"'));
  assert.ok(warn.includes("AI 回覆中，已等待 301 秒，超過 5 分鐘仍沒有結果"));
  assert.ok(!ui.agentOrgSection(model({ run: run() })).value.includes("data-ao-waiting"), "no wait, no line");
  assert.ok(ui.agentOrgSection(model({ waitingMs: 0 })).value.includes("已等待 0 秒"), "zero is a wait, not an absence");
});

test("the status line shows the wait in the folded line and in the panel, and warns past 300 seconds", async () => {
  const calm = await statusMarkup(organization({ waiting: { sinceMs: 12_000 } }));
  assert.ok(calm.html.includes("AI 回覆中，已等待 12 秒"));
  assert.ok(calm.html.includes('data-waiting="normal"'));
  assert.equal(calm.state, "ok");
  const slow = await statusMarkup(organization({ waiting: { sinceMs: 301_000 } }));
  assert.ok(slow.html.includes('data-waiting="warn"'));
  assert.ok(slow.html.includes("AI 回覆已等待 301 秒，超過 5 分鐘，稍後會自動中止"));
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
  const warnAgent = ui.agentOrgSection(model({ run: run(), waitingMs: 301_000 })).value;
  const normalStatus = await statusMarkup(organization({ waiting: { sinceMs: 42_500 } }));
  const warnStatus = await statusMarkup(organization({ waiting: { sinceMs: 301_000 } }));
  const page = `<!DOCTYPE html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><title>AI 整理等待顯示快照</title><style>${css}\nbody{font:14px sans-serif;max-width:720px;margin:16px auto;padding:0 16px}section{margin-bottom:24px;border-top:1px solid #8884}.status-panel{position:static}</style></head><body><div class="ao">${section("agent 頁：一般等待（42 秒）", normalAgent)}${section("agent 頁：警示等待（301 秒）", warnAgent)}</div>${section("狀態列：一般等待（42 秒），data-state=" + normalStatus.state, `<div class="hdr-status">${normalStatus.html}</div>`)}${section("狀態列：警示等待（301 秒），data-state=" + warnStatus.state, `<div class="hdr-status">${warnStatus.html}</div>`)}</body></html>\n`;
  writeFileSync(join(out, "waiting-snapshot.html"), page, "utf8");
  assert.ok(page.includes('data-ao-waiting="warn"') && page.includes('data-waiting="warn"'));
});
