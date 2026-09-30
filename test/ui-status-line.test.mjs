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
