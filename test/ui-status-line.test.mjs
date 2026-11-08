import assert from "node:assert/strict";
import test from "node:test";
import { MINUTE, NOW, failure, iso, ui } from "./homeFixtures.mjs";

const { createStatusLine, STATUS_POLL_MS, STRINGS } = ui;

function statusValue(overrides = {}) {
  return { ok: true, version: "1.0.3", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: iso(NOW - 44 * MINUTE), uptimeSec: 5, ...overrides };
}

function rig({ visible = true, results = [] } = {}) {
  const calls = [];
  const timers = new Map();
  const listeners = [];
  let serial = 0;
  const state = { visible };
  const target = { innerHTML: "", dataset: {} };
  const client = {
    async call(method, params) {
      calls.push({ method, params });
      const next = results.length > 0 ? results.shift() : { ok: true, value: statusValue() };
      return next;
    },
  };
  const line = createStatusLine({
    client,
    target,
    now: () => NOW,
    scheduler: { set: (callback, ms) => { serial += 1; timers.set(serial, { callback, ms }); return serial; }, clear: (handle) => void timers.delete(handle) },
    visibility: { isVisible: () => state.visible, subscribe: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const setVisible = async (visible) => {
    state.visible = visible;
    for (const listener of [...listeners]) listener();
    await flush();
  };
  const fire = async () => {
    const [entry] = timers.values();
    assert.ok(entry, "a timer is pending");
    timers.clear();
    entry.callback();
    await flush();
  };
  return { line, calls, timers, listeners, target, flush, setVisible, fire, state };
}

test("the status is read at start, then every 30 seconds while the view is visible", async () => {
  const r = rig();
  r.line.start();
  await r.flush();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { method: "ui.status", params: {} });
  assert.equal(STATUS_POLL_MS, 30_000);
  assert.deepEqual([...r.timers.values()].map((timer) => timer.ms), [30_000]);
  await r.fire();
  assert.equal(r.calls.length, 2);
  assert.equal(r.timers.size, 1, "exactly one timer is armed after each poll");
  await r.fire();
  assert.equal(r.calls.length, 3);
  r.line.stop();
});

test("a hidden view stops polling, and becoming visible again reads the status at once and restarts the interval", async () => {
  const r = rig();
  r.line.start();
  await r.flush();
  await r.setVisible(false);
  assert.equal(r.timers.size, 0, "the pending timer is cancelled when the view is hidden");
  assert.equal(r.calls.length, 1);
  await r.flush();
  assert.equal(r.calls.length, 1, "nothing polls while hidden");
  await r.setVisible(true);
  assert.equal(r.calls.length, 2, "an immediate read on return");
  assert.deepEqual([...r.timers.values()].map((timer) => timer.ms), [30_000]);
  r.line.stop();
  assert.equal(r.timers.size, 0);
  assert.equal(r.listeners.length, 0, "stop unsubscribes from visibility changes");
});

test("a view that starts hidden reads once and arms no timer until it is shown", async () => {
  const r = rig({ visible: false });
  r.line.start();
  await r.flush();
  assert.equal(r.calls.length, 1);
  assert.equal(r.timers.size, 0);
  await r.setVisible(true);
  assert.equal(r.calls.length, 2);
  assert.equal(r.timers.size, 1);
  r.line.stop();
});

test("a poll that finishes while the view is hidden does not arm a timer", async () => {
  let release;
  const target = { innerHTML: "", dataset: {} };
  const timers = new Map();
  const listeners = [];
  const state = { visible: true };
  const line = createStatusLine({
    client: { call: () => new Promise((resolve) => { release = () => resolve({ ok: true, value: statusValue() }); }) },
    target,
    now: () => NOW,
    scheduler: { set: (callback, ms) => { timers.set(timers.size + 1, { callback, ms }); return timers.size; }, clear: () => timers.clear() },
    visibility: { isVisible: () => state.visible, subscribe: (listener) => { listeners.push(listener); return () => undefined; } },
  });
  line.start();
  state.visible = false;
  listeners.forEach((listener) => listener());
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0);
});

test("the header says the service is running with the time of the last write and the version in its tooltip", async () => {
  const r = rig();
  r.line.start();
  await r.flush();
  assert.equal(r.target.dataset.state, "ok");
  assert.ok(r.target.innerHTML.includes(STRINGS["status.ok"]));
  assert.ok(r.target.innerHTML.includes("最近寫入 44 分鐘前"));
  assert.ok(r.target.innerHTML.includes('title="版本 1.0.3，儲存狀態 ready"'));
  assert.ok(r.target.innerHTML.includes('data-state="ok"'));
  r.line.stop();
});

test("organization status keeps reply, commit, legacy and unknown source counts distinct with expandable redacted details", async () => {
  const organization = {
    state: "paused", admitted: 12, pending: 5, replyReady: 1, completed: 6, legacyUnlinked: 2,
    schemaSkipped: null, diagnosticsAvailable: false,
    sourceGeneration: "generation-1", sourceHighWatermark: "2026-01-01T02:00:00.000Z",
    sourcePages: 3, sourceScanned: null, sourceReceived: 10, sourceEligible: 8, sourceCheckpointed: false,
    lastError: "RESOURCE_BUSY", errorPhase: "commit", hostErrorCode: "provider_error",
    retryable: true, partialDelivered: true, lastAttemptAt: NOW, updatedAt: NOW,
    dailyRound: { date: "2026-01-01", roundId: "private-round-id", state: "paused", nextResumeAt: NOW + 1000, snapshotHighWatermark: 12, snapshotMembers: 8, completedMembers: 6, deferredMembers: 2 },
  };
  const r = rig({ results: [{ ok: true, value: statusValue({ organization }) }] });
  r.line.start();
  await r.flush();
  assert.equal(r.target.dataset.state, "warn");
  assert.ok(r.target.innerHTML.includes("已收錄 12 · 待整理 5 · 回覆待提交 1 · 整理完成 6"));
  assert.ok(r.target.innerHTML.includes("舊佇列有 2 筆工作不會自動整理（可小量試跑）"));
  assert.ok(r.target.innerHTML.includes("來源略過未知"));
  assert.ok(r.target.innerHTML.includes("<details"));
  assert.ok(r.target.innerHTML.includes("<summary>整理與來源詳情</summary>"));
  assert.ok(r.target.innerHTML.includes("provider_error"));
  assert.equal(r.target.innerHTML.includes("private-round-id"), false);
  assert.equal(r.target.innerHTML.includes("secret transcript"), false);
  r.line.stop();
});

test("no write yet, an unhealthy store and a failed call each get their own plain wording", async () => {
  const none = rig({ results: [{ ok: true, value: statusValue({ lastWriteAt: null }) }] });
  none.line.start();
  await none.flush();
  assert.ok(none.target.innerHTML.includes("還沒有記憶寫入"));
  none.line.stop();

  const trouble = rig({ results: [{ ok: true, value: statusValue({ storage: { status: "storage_busy" } }) }] });
  trouble.line.start();
  await trouble.flush();
  assert.equal(trouble.target.dataset.state, "warn");
  assert.ok(trouble.target.innerHTML.includes(STRINGS["status.storageTrouble"]));
  assert.ok(!trouble.target.innerHTML.includes("最近寫入"));
  trouble.line.stop();

  const broken = rig({ results: [failure("plugin_backend_crashed")] });
  broken.line.start();
  await broken.flush();
  assert.equal(broken.target.dataset.state, "error");
  assert.ok(broken.target.innerHTML.includes(STRINGS["error.plugin_backend_crashed.message"]) && broken.target.innerHTML.includes(STRINGS["error.plugin_backend_crashed.action"]));
  assert.ok(broken.target.innerHTML.includes("data-retry"));
  broken.line.stop();

  const garbage = rig({ results: [{ ok: true, value: { nonsense: true } }] });
  garbage.line.start();
  await garbage.flush();
  assert.equal(garbage.target.dataset.state, "error");
  assert.ok(garbage.target.innerHTML.includes(STRINGS["status.malformed"]));
  garbage.line.stop();
});

test("a failed poll recovers on the next one, and refresh while a call is in flight shares that call", async () => {
  const r = rig({ results: [failure("plugin_backend_unavailable")] });
  r.line.start();
  await r.flush();
  assert.equal(r.target.dataset.state, "error");
  assert.equal(r.timers.size, 1, "polling continues after a failure");
  await r.fire();
  assert.equal(r.target.dataset.state, "ok");
  const first = r.line.refresh();
  const second = r.line.refresh();
  await Promise.all([first, second]);
  assert.equal(r.calls.length, 3, "two refreshes at once made one call");
  r.line.stop();
});

test("a hostile version or message cannot inject markup into the header", async () => {
  const r = rig({ results: [{ ok: true, value: statusValue({ version: '<img src=x onerror=alert(1)>"' }) }] });
  r.line.start();
  await r.flush();
  assert.ok(!r.target.innerHTML.includes("<img"));
  assert.ok(r.target.innerHTML.includes("&lt;img src=x onerror=alert(1)&gt;&quot;"));
  r.line.stop();
});

const failedOrganization = (overrides = {}) => ({
  state: "error", admitted: 3, pending: 2, replyReady: 0, completed: 1, legacyUnlinked: 0,
  schemaSkipped: 0, diagnosticsAvailable: true,
  sourceGeneration: null, sourceHighWatermark: null, sourcePages: null, sourceScanned: null, sourceReceived: null, sourceEligible: null, sourceCheckpointed: null,
  lastError: "MODEL_TIMEOUT", errorPhase: "turn_timeout", hostErrorCode: "stalled",
  retryable: true, partialDelivered: false, lastAttemptAt: NOW, updatedAt: NOW, dailyRound: null,
  ...overrides,
});

async function renderOrganization(organization) {
  const r = rig({ results: [{ ok: true, value: statusValue({ organization }) }] });
  r.line.start();
  await r.flush();
  r.line.stop();
  return r.target.innerHTML;
}

test("an error or paused organization shows its failure phase and host error code in the status line itself", async () => {
  const error = await renderOrganization(failedOrganization());
  assert.ok(error.includes("AI 整理遇到問題（失敗階段 turn_timeout・主程式代碼 stalled）"), error);
  const paused = await renderOrganization(failedOrganization({ state: "paused", lastError: "RESOURCE_BUSY", errorPhase: "session_close", hostErrorCode: "close_timeout" }));
  assert.ok(paused.includes("AI 整理暫停（失敗階段 session_close・主程式代碼 close_timeout）"), paused);
});

test("a failed organization without phase or host code, and a status without those fields, render as unknown and never as undefined", async () => {
  const nulls = await renderOrganization(failedOrganization({ errorPhase: null, hostErrorCode: null }));
  assert.ok(nulls.includes("（失敗階段 未知・主程式代碼 未知）"));
  const legacyShape = failedOrganization();
  delete legacyShape.errorPhase;
  delete legacyShape.hostErrorCode;
  const omitted = await renderOrganization(legacyShape);
  assert.ok(omitted.includes("（失敗階段 未知・主程式代碼 未知）"));
  for (const html of [nulls, omitted]) {
    assert.equal(html.includes("undefined"), false);
    assert.equal(html.includes("null"), false);
  }
});

test("healthy states and a pause caused only by legacy jobs carry no failure wording", async () => {
  for (const organization of [
    failedOrganization({ state: "idle", lastError: null, errorPhase: null, hostErrorCode: null }),
    failedOrganization({ state: "running", lastError: null, errorPhase: null, hostErrorCode: null }),
    failedOrganization({ state: "paused", legacyUnlinked: 4, lastError: null, errorPhase: null, hostErrorCode: null }),
  ]) {
    assert.equal((await renderOrganization(organization)).includes("失敗階段"), false);
  }
});

test("failure wording from the host is escaped", async () => {
  const html = await renderOrganization(failedOrganization({ errorPhase: "<b>x</b>", hostErrorCode: '"><img src=x>' }));
  assert.equal(html.includes("<b>x</b>"), false);
  assert.equal(html.includes("<img"), false);
});

// why: the failure reason lives in the panel item, not in the compact line, so the headline is read from the panel
const headlineOf = (html) => {
  const panel = html.slice(html.indexOf('id="status-panel"'));
  const start = panel.indexOf("AI 整理遇到問題") >= 0 ? panel.indexOf("AI 整理遇到問題") : panel.indexOf("AI 整理暫停");
  return panel.slice(start, panel.indexOf("</li>", start));
};

test("a code the plugin decided itself is labelled as such and never as a host code", async () => {
  const local = await renderOrganization(failedOrganization({ state: "paused", lastError: "RESOURCE_BUSY", errorPhase: "session_close", hostErrorCode: null, localErrorCode: "close_timeout" }));
  assert.ok(headlineOf(local).includes("（失敗階段 session_close・外掛自行判定 close_timeout）"), headlineOf(local));
  assert.equal(headlineOf(local).includes("主程式代碼"), false);
  const hostReported = await renderOrganization(failedOrganization({ state: "paused", lastError: "RESOURCE_BUSY", errorPhase: "session_close", hostErrorCode: "stalled", localErrorCode: null }));
  assert.ok(headlineOf(hostReported).includes("（失敗階段 session_close・主程式代碼 stalled）"), "the phase name alone does not turn a host code into a plugin code");
  const localOnly = await renderOrganization(failedOrganization({ state: "paused", lastError: null, errorPhase: null, hostErrorCode: null, localErrorCode: "close_timeout" }));
  assert.ok(headlineOf(localOnly).includes("外掛自行判定 close_timeout"));
});

test("host strings in the headline are cut to 40 characters, still escaped, and the cut never splits a character", async () => {
  const exact = "p".repeat(40);
  const kept = await renderOrganization(failedOrganization({ errorPhase: exact, hostErrorCode: exact }));
  assert.ok(headlineOf(kept).includes("失敗階段 " + exact + "・主程式代碼 " + exact + "）"), "40 characters are kept whole");

  const long = await renderOrganization(failedOrganization({ errorPhase: "q".repeat(300), hostErrorCode: "<b>" + "x".repeat(500) }));
  const headline = headlineOf(long);
  assert.ok(headline.includes("失敗階段 " + "q".repeat(40) + "…・"), headline);
  assert.equal(headline.includes("q".repeat(41)), false);
  assert.equal(headline.includes("x".repeat(40)), false, "the second string is cut too");
  assert.ok(headline.includes("&lt;b&gt;"), "escape still applies to the cut text");
  assert.equal(headline.includes("<b>"), false);
  assert.ok(headline.length < 400, "the headline stays short: " + headline.length);

  const pairs = await renderOrganization(failedOrganization({ hostErrorCode: "😀".repeat(60) }));
  assert.ok(headlineOf(pairs).includes("😀".repeat(40) + "…"));
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(headlineOf(pairs)), false);

  const local = await renderOrganization(failedOrganization({ hostErrorCode: null, localErrorCode: "c".repeat(200) }));
  assert.equal(headlineOf(local).includes("c".repeat(41)), false);
});
