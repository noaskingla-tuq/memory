import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FakeDocument } from "./fakeDom.mjs";
import { UI_ROOT, loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule("views/agentOrgController.ts", "views/agentOrgView.ts", "views/agentOrgEvents.ts", "views/memorySpaceView.ts", "components/dialog.ts", "components/dialogFocus.ts", "api/errors.ts", "dom/html.ts", "i18n/index.ts", "i18n/zhTW.ts", "i18n/agentOrgStrings.ts");
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const AGENT = "sw/dev";

const run = (overrides = {}) => ({ agentId: AGENT, state: "running", total: 20, done: 6, failed: 1, untried: 13, startedAt: 1, endedAt: null, lastError: null, ...overrides });
const answer = (overrides = {}) => ({ ok: true, action: "status", agentId: AGENT, pending: 14, blocked: null, run: null, ...overrides });
const model = (overrides = {}) => ({ phase: "ready", agentId: AGENT, pending: 14, run: null, blocked: null, busy: false, notice: null, error: null, ...overrides });
const render = (overrides) => ui.agentOrgSection(model(overrides)).value;

test("the idle block says how many jobs wait and offers the one button, with the place for the later settings reserved", () => {
  const idle = render();
  assert.ok(idle.includes("這位 agent 有 14 筆工作等待 AI 整理。"));
  assert.ok(idle.includes('<button type="button" class="btn btn-primary" data-ao="run">立即整理</button>'));
  assert.ok(idle.includes('data-ao-state="idle"'));
  assert.ok(idle.includes('data-ao-slot="settings"'), "the slot for the per-agent model and time settings");
  assert.ok(!/ onclick|<script/iu.test(idle), "no inline handler");
  assert.ok(render({ pending: 0 }).includes('data-ao="run" disabled'), "nothing waits: the button is off");
  assert.ok(render({ blocked: "other_running" }).includes("另一位 agent 正在立即整理"));
  assert.ok(render({ blocked: "other_running" }).includes('data-ao="run" disabled'));
  assert.ok(render({ blocked: "disabled" }).includes("AI 整理目前已關閉"));
  assert.ok(render({ phase: "loading" }).includes("正在讀取整理狀態"));
  assert.ok(render({ busy: true }).includes('data-ao="run" disabled'));
});

test("a running block shows the progress and a stop button; a stopping block says it finishes the current job", () => {
  const running = render({ run: run() });
  assert.ok(running.includes("整理中：已處理 7／20 筆（完成 6・失敗 1）"));
  assert.ok(running.includes('<progress class="ao-progress" max="20" value="7"'));
  assert.ok(running.includes('<button type="button" class="btn" data-ao="stop">停止</button>'));
  assert.ok(!running.includes('data-ao="run"'));
  const stopping = render({ run: run({ state: "stopping" }) });
  assert.ok(stopping.includes("正在停止，目前這一筆做完就會停下。"));
  assert.ok(stopping.includes('data-ao="stop" disabled'));
});

test("a finished block gives the counts, hints that failed jobs can be sent again, and lets the user run again", () => {
  const done = render({ run: run({ state: "completed", total: 20, done: 18, failed: 2, untried: 0, endedAt: 9 }), pending: 2 });
  assert.ok(done.includes("整理完成：共 20 筆（完成 18・失敗 2・未處理 0）"));
  assert.ok(done.includes("再按一次「立即整理」就會重送"));
  assert.ok(done.includes('data-ao="run">立即整理'));
  const clean = render({ run: run({ state: "completed", total: 5, done: 5, failed: 0, untried: 0, endedAt: 9 }), pending: 0 });
  assert.ok(clean.includes("整理完成：共 5 筆（完成 5・失敗 0・未處理 0）"));
  assert.ok(!clean.includes("再按一次"));
  const stopped = render({ run: run({ state: "stopped", total: 20, done: 8, failed: 0, untried: 12, endedAt: 9 }), pending: 12 });
  assert.ok(stopped.includes("已停止：共 20 筆（完成 8・失敗 0・未處理 12）"));
});

test("the agent page shell keeps #space-org outside #space-body and before #space-timeline", () => {
  const shell = ui.spaceShell().value;
  const body = shell.indexOf('id="space-body"');
  const org = shell.indexOf('id="space-org"');
  const timeline = shell.indexOf('id="space-timeline"');
  assert.ok(body > 0 && org > body && timeline > org, "order: body, org, timeline");
  assert.ok(shell.slice(shell.indexOf('<div id="space-body"'), shell.indexOf('id="space-org"')).includes('<div id="space-body" class="space-body"></div>'), "the org block is not inside the body");
  assert.equal(ui.SPACE_ORG_ID, "space-org");
});

function scene(answers = []) {
  const doc = new FakeDocument();
  const calls = [];
  const timers = [];
  const target = { innerHTML: "" };
  const client = { async call(method, params, options) { calls.push({ method, params, options }); return { ok: true, value: answers.shift() ?? answer() }; } };
  const org = ui.createAgentOrg({
    client, document: doc,
    scheduler: { set: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clear: (handle) => { if (timers[handle - 1] !== undefined) timers[handle - 1].cleared = true; } },
    visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  const buttons = () => doc.body.querySelectorAll("button");
  const labelled = (text) => buttons().find((button) => button.textContent === text);
  return { doc, calls, timers, target, org, buttons, labelled };
}

test("opening the page reads the status once with the agent id", async () => {
  const s = scene([answer({ pending: 3 })]);
  await s.org.attach(s.target, AGENT);
  assert.deepEqual(s.calls.map((call) => [call.method, call.params]), [["ui.agentOrganization", { action: "status", agentId: AGENT }]]);
  assert.ok(s.target.innerHTML.includes("這位 agent 有 3 筆工作等待 AI 整理。"));
  assert.equal(s.timers.length, 0, "an idle block does not poll");
});

test("the confirm dialog puts focus on cancel, names the model, the one-at-a-time rule and the stop, and sends nothing until the user starts", async () => {
  const s = scene([answer({ pending: 14 }), answer({ run: run(), pending: 14 })]);
  await s.org.attach(s.target, AGENT);
  const asked = s.org.run();
  await flush();
  assert.deepEqual(s.buttons().map((button) => button.textContent), ["取消", "開始整理"]);
  assert.equal(s.doc.activeElement.textContent, "取消", "initial focus is on the harmless choice");
  const text = s.doc.body.children[0].children[0].children[1].innerHTML;
  for (const part of ["14 筆工作", "目前設定的模型", "一次處理一筆", "隨時按「停止」", "目前這一筆做完就會停下"]) assert.ok(text.includes(part), part);
  assert.equal(s.calls.length, 1, "only the status read so far");
  s.doc.dispatch(s.labelled("開始整理"), "click", {});
  await asked;
  assert.deepEqual(s.calls[1], { method: "ui.agentOrganization", params: { action: "run", agentId: AGENT }, options: { key: "agentOrg" } });
  assert.ok(s.target.innerHTML.includes("整理中：已處理 7／20 筆"));
  assert.equal(s.timers.length, 1, "a live run is polled");
  assert.equal(s.timers[0].ms, ui.AGENT_ORG_POLL_MS);
});

test("cancelling the dialog, escape and a second click send nothing", async () => {
  const s = scene();
  await s.org.attach(s.target, AGENT);
  const first = s.org.run();
  await flush();
  const second = s.org.run();
  await second;
  assert.equal(s.buttons().length, 2, "one dialog only");
  s.doc.dispatch(s.labelled("取消"), "click", {});
  await first;
  assert.equal(s.calls.length, 1);
  const again = s.org.run();
  await flush();
  s.doc.key("Escape");
  await again;
  assert.equal(s.calls.length, 1, "escape is a cancel");
});

test("polling follows the run to its end: progress, then the result, then no more timers", async () => {
  const s = scene([answer({ run: run({ done: 2, failed: 0 }) }), answer({ run: run({ done: 9, failed: 1 }) }), answer({ run: run({ state: "completed", done: 19, failed: 1, untried: 0, endedAt: 8 }), pending: 1 })]);
  await s.org.attach(s.target, AGENT);
  assert.ok(s.target.innerHTML.includes("已處理 2／20 筆"));
  assert.equal(s.timers.length, 1);
  s.timers[0].callback();
  await flush();
  assert.ok(s.target.innerHTML.includes("已處理 10／20 筆（完成 9・失敗 1）"));
  assert.equal(s.timers.length, 2);
  s.timers[1].callback();
  await flush();
  assert.ok(s.target.innerHTML.includes("整理完成：共 20 筆（完成 19・失敗 1・未處理 0）"));
  assert.equal(s.timers.length, 2, "a finished run schedules nothing");
});

test("stop asks the backend to stop and shows that it finishes the current job", async () => {
  const s = scene([answer({ run: run() }), answer({ action: "stop", run: run({ state: "stopping" }) })]);
  await s.org.attach(s.target, AGENT);
  await s.org.stop();
  assert.deepEqual(s.calls[1].params, { action: "stop" });
  assert.ok(s.target.innerHTML.includes("正在停止，目前這一筆做完就會停下。"));
});

test("a blocked answer is told in words and a failed call shows the error and keeps the page usable", async () => {
  const blocked = scene([answer({ pending: 4 }), answer({ action: "run", blocked: "other_running", pending: 4 })]);
  await blocked.org.attach(blocked.target, AGENT);
  const asked = blocked.org.run();
  await flush();
  blocked.doc.dispatch(blocked.labelled("開始整理"), "click", {});
  await asked;
  assert.ok(blocked.target.innerHTML.includes("另一位 agent 正在立即整理"));

  const doc = new FakeDocument();
  const target = { innerHTML: "" };
  let fail = false;
  const org = ui.createAgentOrg({
    client: { async call() { return fail ? { ok: false, superseded: false, attempts: 1, code: "STORAGE_BUSY", message: "記憶庫忙碌中。", action: "稍後再試。" } : { ok: true, value: answer() }; } },
    document: doc, scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  await org.attach(target, AGENT);
  fail = true;
  await org.refresh();
  assert.ok(target.innerHTML.includes("記憶庫忙碌中。稍後再試。"));
  fail = false;
  await org.refresh();
  assert.ok(!target.innerHTML.includes("記憶庫忙碌中"));
});

test("a late answer for another agent, or after leaving the page, is dropped", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const target = { innerHTML: "" };
  const org = ui.createAgentOrg({
    client: { async call() { await gate; return { ok: true, value: answer({ pending: 99 }) }; } },
    scheduler: { set: () => 1, clear: () => undefined }, visibility: { isVisible: () => true, subscribe: () => () => undefined },
  });
  const attaching = org.attach(target, AGENT);
  await flush();
  await org.attach(null);
  release();
  await attaching;
  assert.ok(!target.innerHTML.includes("99"), "nothing is drawn after the page was left");
});

test("the click binding runs and stops only through data-ao", () => {
  const seen = [];
  const listeners = [];
  ui.bindAgentOrgEvents({ addEventListener: (_type, listener) => listeners.push(listener) }, { run: () => seen.push("run"), stop: () => seen.push("stop") });
  for (const ao of ["run", "stop", "other", undefined]) listeners[0]({ target: { closest: () => (ao === undefined ? null : { dataset: { ao } }) } });
  listeners[0]({ target: {} });
  assert.deepEqual(seen, ["run", "stop"]);
});

test("every string exists, no forbidden pattern is in the new files, and the styles come from tokens only", () => {
  const { STRINGS, AGENT_ORG_STRINGS } = ui;
  const keys = Object.keys(AGENT_ORG_STRINGS);
  assert.ok(keys.length >= 20);
  for (const key of keys) assert.equal(STRINGS[key], AGENT_ORG_STRINGS[key], key);
  const files = ["views/agentOrgView.ts", "views/agentOrgController.ts", "views/agentOrgEvents.ts", "i18n/agentOrgStrings.ts", "styles/agentOrg.css"];
  for (const file of files) {
    const text = readFileSync(join(UI_ROOT, file), "utf8");
    for (const pattern of [/\beval\s*\(/u, /new\s+Function\b/u, /https?:\/\//u, /\bfetch\s*\(/u, /\bWebSocket\b/u, /<script/iu, /\son[a-z]+\s*=/iu, /javascript:/iu]) assert.ok(!pattern.test(text), file + " " + pattern);
    if (file.endsWith(".ts")) assert.ok(!/\bwindow\.tuqPlugin\b/u.test(text), file + " must not call the backend itself");
  }
  const used = [...readFileSync(join(UI_ROOT, "views/agentOrgView.ts"), "utf8").matchAll(/\bt\(\s*"(ao\.[A-Za-z.]+)"/gu), ...readFileSync(join(UI_ROOT, "views/agentOrgController.ts"), "utf8").matchAll(/\bt\(\s*"(ao\.[A-Za-z.]+)"/gu)].map((match) => match[1]);
  assert.ok(used.length >= 10);
  for (const key of used) assert.ok(key in STRINGS, key);
  for (const reason of ["disabled", "running", "other_running", "no_candidates", "not_running"]) assert.ok(`ao.blocked.${reason}` in STRINGS, reason);
  const css = readFileSync(join(UI_ROOT, "styles/agentOrg.css"), "utf8");
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/iu.test(css), "colors come from tokens only");
  assert.ok(readFileSync(join(UI_ROOT, "styles/app.css"), "utf8").includes('@import "./agentOrg.css";'));
  assert.ok(!/[；;]\s*程序|程序/u.test(JSON.stringify(AGENT_ORG_STRINGS)), "no 程序");
});
