import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO, loadUiModule } from "./uiHarness.mjs";

const { createBackendClient, DEFAULT_RETRY_DELAYS_MS } = await loadUiModule("api/backendClient.ts");
const errors = await loadUiModule("api/errors.ts");
const { STRINGS } = await loadUiModule("i18n/zhTW.ts");

function transport() {
  const calls = [];
  let running = 0;
  let peak = 0;
  return {
    calls,
    peak: () => peak,
    running: () => running,
    call(method, params) {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise((resolve, reject) => {
        calls.push({
          method,
          params,
          ok: (value) => {
            running -= 1;
            resolve(value);
          },
          fail: (message) => {
            running -= 1;
            reject(new Error(message));
          },
        });
      });
    },
  };
}

function sleeper() {
  const waits = [];
  return {
    waits,
    sleep: (ms) => new Promise((resolve) => waits.push({ ms, wake: resolve })),
  };
}

// why: a wrong queue limit leaves a call waiting for an answer that never comes, so every test carries a timeout instead of hanging the run
const it = (name, body) => test(name, { timeout: 5000 }, body);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const done = { ok: true };

it("at most two calls are in flight and the rest wait in order", async () => {
  const wire = transport();
  const client = createBackendClient({ call: wire.call });
  const methods = ["ui.overview", "ui.list", "ui.get", "ui.search", "ui.agentStats"];
  const pending = methods.map((method) => client.call(method, {}));
  await tick();
  assert.deepEqual(wire.calls.map((entry) => entry.method), ["ui.overview", "ui.list"]);
  assert.deepEqual(client.stats(), { inFlight: 2, queued: 3 });
  wire.calls[0].ok(done);
  await tick();
  assert.deepEqual(wire.calls.map((entry) => entry.method), ["ui.overview", "ui.list", "ui.get"]);
  assert.equal(wire.running(), 2);
  for (let index = 1; index < methods.length; index += 1) {
    wire.calls[index].ok(done);
    await tick();
  }
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.ok === true));
  assert.equal(wire.peak(), 2);
  assert.deepEqual(client.stats(), { inFlight: 0, queued: 0 });
});

it("a queued call is dropped without being sent when a newer call of the same method arrives", async () => {
  const wire = transport();
  const client = createBackendClient({ call: wire.call });
  const holdA = client.call("ui.overview", {});
  const holdB = client.call("ui.status", {});
  const older = client.call("ui.list", { limit: 12 });
  const newer = client.call("ui.list", { limit: 24 });
  const olderResult = await older;
  assert.equal(olderResult.ok, false);
  assert.equal(olderResult.superseded, true);
  assert.equal(olderResult.code, "superseded");
  wire.calls[0].ok(done);
  await tick();
  const sent = wire.calls.filter((entry) => entry.method === "ui.list");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].params, { limit: 24 });
  sent[0].ok({ ok: true, items: [] });
  assert.equal((await newer).ok, true);
  wire.calls[1].ok(done);
  await Promise.all([holdA, holdB]);
});

it("an in-flight call that was overtaken settles as superseded even when the backend answered it", async () => {
  const wire = transport();
  const client = createBackendClient({ call: wire.call });
  const first = client.call("ui.search", { q: "a" });
  const second = client.call("ui.search", { q: "ab" });
  await tick();
  assert.equal(wire.calls.length, 2);
  wire.calls[1].ok({ ok: true, items: ["new"] });
  wire.calls[0].ok({ ok: true, items: ["old"] });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.superseded, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(secondResult.value.items, ["new"]);
});

it("a custom key keeps calls of one method apart, and ui.forget is never dropped", async () => {
  const wire = transport();
  const client = createBackendClient({ call: wire.call });
  const one = client.call("ui.get", { id: 1 }, { key: "drawer" });
  const two = client.call("ui.get", { id: 2 }, { key: "sibling" });
  await tick();
  wire.calls[0].ok({ ok: true, n: 1 });
  wire.calls[1].ok({ ok: true, n: 2 });
  assert.equal((await one).ok, true);
  assert.equal((await two).ok, true);

  const forgetA = client.call("ui.forget", { memoryId: "a" });
  const forgetB = client.call("ui.forget", { memoryId: "b" });
  await tick();
  const forgets = wire.calls.filter((entry) => entry.method === "ui.forget");
  assert.equal(forgets.length, 2);
  forgets[0].ok({ ok: true, forgotten: true });
  forgets[1].ok({ ok: true, forgotten: true });
  assert.equal((await forgetA).ok, true);
  assert.equal((await forgetB).ok, true);
});

it("plugin_backend_unavailable is retried three times with the configured delays, then the fourth failure is final", async () => {
  const wire = transport();
  const clock = sleeper();
  const client = createBackendClient({ call: wire.call, sleep: clock.sleep });
  assert.deepEqual([...DEFAULT_RETRY_DELAYS_MS], [1000, 2000, 4000]);
  const pending = client.call("ui.overview", {});
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await tick();
    assert.equal(wire.calls.length, attempt);
    wire.calls[attempt - 1].fail("plugin_backend_unavailable");
    await tick();
    assert.equal(clock.waits.length, attempt);
    clock.waits[attempt - 1].wake();
  }
  await tick();
  assert.equal(wire.calls.length, 4);
  wire.calls[3].fail("plugin_backend_unavailable");
  const result = await pending;
  assert.deepEqual(clock.waits.map((entry) => entry.ms), [1000, 2000, 4000]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "plugin_backend_unavailable");
  assert.equal(result.attempts, 4);
  assert.equal(result.source, "platform");
  assert.ok(result.message.length > 0 && result.action.length > 0);
  assert.equal(wire.calls.length, 4);
});

it("a cold start that recovers on the third retry resolves as a success", async () => {
  const wire = transport();
  const clock = sleeper();
  const client = createBackendClient({ call: wire.call, sleep: clock.sleep });
  const pending = client.call("ui.status", {});
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await tick();
    wire.calls[attempt - 1].fail("plugin_backend_unavailable");
    await tick();
    clock.waits[attempt - 1].wake();
  }
  await tick();
  wire.calls[3].ok({ ok: true, version: "1.0.0" });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.value.version, "1.0.0");
  assert.equal(wire.calls.length, 4);
});

it("only plugin_backend_unavailable retries: other platform codes, plugin failures and writes are tried once", async () => {
  for (const code of ["plugin_disabled", "plugin_backend_crashed", "backend_invoke_timeout", "plugin_permission_denied", "backend_invoke_too_large", "backend_method_not_allowed", "plugin_not_installed"]) {
    const wire = transport();
    const client = createBackendClient({ call: wire.call, sleep: () => new Promise(() => undefined) });
    const pending = client.call("ui.list", {});
    await tick();
    wire.calls[0].fail(code);
    const result = await pending;
    assert.equal(result.code, code);
    assert.equal(result.attempts, 1, code);
    assert.equal(wire.calls.length, 1, code);
  }
  const wire = transport();
  const client = createBackendClient({ call: wire.call, sleep: () => new Promise(() => undefined) });
  const busy = client.call("ui.list", {});
  await tick();
  wire.calls[0].ok({ ok: false, code: "STORAGE_BUSY", retryable: true });
  const busyResult = await busy;
  assert.equal(busyResult.ok, false);
  assert.equal(busyResult.code, "STORAGE_BUSY");
  assert.equal(busyResult.source, "plugin");
  assert.equal(busyResult.attempts, 1);
  const write = client.call("ui.forget", {});
  await tick();
  wire.calls[1].fail("plugin_backend_unavailable");
  const writeResult = await write;
  assert.equal(writeResult.code, "plugin_backend_unavailable");
  assert.equal(writeResult.attempts, 1);
  assert.equal(wire.calls.length, 2);
});

it("a call that is overtaken while it waits to retry never goes back to the backend", async () => {
  const wire = transport();
  const clock = sleeper();
  const client = createBackendClient({ call: wire.call, sleep: clock.sleep });
  const old = client.call("ui.list", { limit: 12 });
  await tick();
  wire.calls[0].fail("plugin_backend_unavailable");
  await tick();
  assert.equal(clock.waits.length, 1);
  const newer = client.call("ui.list", { limit: 24 });
  await tick();
  clock.waits[0].wake();
  const oldResult = await old;
  assert.equal(oldResult.superseded, true);
  assert.equal(wire.calls.length, 2);
  assert.deepEqual(wire.calls[1].params, { limit: 24 });
  wire.calls[1].ok({ ok: true, items: [] });
  assert.equal((await newer).ok, true);
});

it("a call waiting to retry does not hold a slot", async () => {
  const wire = transport();
  const clock = sleeper();
  const client = createBackendClient({ call: wire.call, sleep: clock.sleep, maxInFlight: 1 });
  const stuck = client.call("ui.overview", {});
  const other = client.call("ui.status", {});
  await tick();
  wire.calls[0].fail("plugin_backend_unavailable");
  await tick();
  assert.equal(wire.calls.length, 2);
  assert.equal(wire.calls[1].method, "ui.status");
  wire.calls[1].ok({ ok: true });
  assert.equal((await other).ok, true);
  clock.waits[0].wake();
  await tick();
  assert.equal(wire.calls.length, 3);
  wire.calls[2].ok({ ok: true });
  assert.equal((await stuck).ok, true);
});

it("params drop undefined members and a malformed answer becomes a plain failure", async () => {
  const wire = transport();
  const client = createBackendClient({ call: wire.call });
  const first = client.call("ui.list", { agentId: undefined, limit: 12, cursor: undefined });
  await tick();
  assert.deepEqual(wire.calls[0].params, { limit: 12 });
  wire.calls[0].ok("nonsense");
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed_response");
  assert.equal(result.source, "client");
  const second = client.call("ui.list", {});
  await tick();
  wire.calls[1].ok(null);
  assert.equal((await second).code, "malformed_response");
});

const REQUIRED_PLATFORM = ["plugin_disabled", "plugin_backend_unavailable", "plugin_backend_crashed", "backend_invoke_timeout", "plugin_permission_denied", "plugin_not_installed", "backend_invoke_too_large", "backend_method_not_allowed"];
const REQUIRED_PLUGIN = ["STORAGE_BUSY", "RESOURCE_BUSY", "REVISION_CONFLICT", "NOT_FOUND"];

it("every platform code, every plugin code and every reserved code has a plain message and one suggested action", () => {
  const all = [...errors.PLATFORM_CODES, ...errors.PLUGIN_CODES, ...errors.CLIENT_CODES];
  for (const code of [...REQUIRED_PLATFORM, ...REQUIRED_PLUGIN]) assert.ok(all.includes(code), `${code} is listed`);
  const seen = new Set();
  for (const code of all) {
    assert.ok(!seen.has(code), `${code} is listed once`);
    seen.add(code);
    const entry = errors.describeError(code);
    assert.equal(entry.known, true, code);
    assert.ok(entry.message.length >= 6, `${code} message`);
    assert.ok(entry.action.length >= 4, `${code} action`);
    assert.notEqual(entry.message, entry.action, code);
    assert.ok(!/[A-Za-z]+_[A-Za-z_]+/u.test(`${entry.message}${entry.action}`), `${code} shows no raw code to the user`);
    assert.ok(`error.${code}.message` in STRINGS && `error.${code}.action` in STRINGS, `${code} strings`);
  }
});

it("the plugin failure codes declared by the UI contract are all covered", () => {
  const source = readFileSync(join(REPO, "src", "contracts", "uiContract.ts"), "utf8");
  const block = /UI_FAILURE_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/u.exec(source);
  assert.ok(block !== null, "UI_FAILURE_CODES is declared");
  const declared = [...block[1].matchAll(/"([A-Za-z_]+)"/gu)].map((match) => match[1]);
  assert.ok(declared.length >= 8);
  for (const code of declared) assert.equal(errors.describeError(code).known, true, `${code} has a plain-language entry`);
});

it("cursor failures ask for a restart from the first page and unknown codes fall back to a generic message", () => {
  for (const code of ["INVALID_CURSOR", "CURSOR_STALE"]) {
    assert.equal(errors.isCursorReset(code), true);
    assert.equal(errors.describeError(code).actionKind, "restartList");
  }
  assert.equal(errors.isCursorReset("NOT_FOUND"), false);
  const unknown = errors.describeError("SOMETHING_NEW");
  assert.equal(unknown.known, false);
  assert.equal(unknown.code, "SOMETHING_NEW");
  assert.ok(unknown.message.length > 0 && unknown.action.length > 0);
  assert.equal(errors.describeError("REVISION_CONFLICT").retryable, false);
  assert.equal(errors.describeError("STORAGE_BUSY").retryable, true);
});

it("the platform code is found inside the wrapper Electron puts around an ipc rejection", () => {
  assert.equal(errors.codeFromThrown(new Error("plugin_backend_unavailable")), "plugin_backend_unavailable");
  assert.equal(errors.codeFromThrown(new Error("Error invoking remote method 'plugin-view:backend-invoke': Error: backend_invoke_timeout")), "backend_invoke_timeout");
  assert.equal(errors.codeFromThrown(new Error("boom")), "unknown");
  assert.equal(errors.codeFromThrown(undefined), "unknown");
  assert.equal(errors.codeFromThrown("plugin_disabled"), "plugin_disabled");
});
