import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_METHOD_NAMES } from "../out/contracts/uiContract.js";
import { callInspect, callRemember, op, REPO_ROOT, startBackend } from "./backendHarness.mjs";

const template = JSON.parse(readFileSync(join(REPO_ROOT, "plugin", "manifest.template.json"), "utf8"));

test("the manifest template lists exactly the ui.* methods of the contract and no memory.* method", () => {
  assert.deepEqual(template.backendMethods, [...UI_METHOD_NAMES]);
  assert.equal(template.backendMethods.some((method) => !method.startsWith("ui.")), false);
  assert.deepEqual(template.permissions, ["ui:view", "backend:invoke"]);
  assert.equal(template.resources.maxSessions, 4);
});

test("ui.status answers with placeholder data that survives a JSON round trip", async (t) => {
  const { backend } = startBackend(t);
  const status = await backend.call("ui.status", {});
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  assert.equal(status.ok, true);
  assert.equal(status.stub, true);
  assert.equal(status.version, JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version);
  assert.equal(status.storage.status, "ready");
  assert.equal(typeof status.uptimeSec, "number");
  assert.equal(status.lastWriteAt, null);
});

test("the other six ui.* methods answer NOT_IMPLEMENTED instead of throwing", async (t) => {
  const { backend } = startBackend(t);
  for (const method of UI_METHOD_NAMES.filter((name) => name !== "ui.status")) {
    assert.deepEqual(await backend.call(method, {}), { ok: false, code: "NOT_IMPLEMENTED", retryable: false }, method);
  }
});

test("ui.* methods need an object as params", async (t) => {
  const { backend } = startBackend(t);
  for (const params of [null, undefined, [], "x", 1]) {
    assert.deepEqual(await backend.call("ui.status", params), { ok: false, code: "INVALID_PARAMS", retryable: false });
  }
});

test("serving ui.* does not change the memory.* contract methods or unknown method names", async (t) => {
  const { backend } = startBackend(t);
  const written = await callRemember(backend, [op("A memory written next to the UI status call.", "op-ui-1")]);
  assert.equal(written.results[0].ok, true);
  await backend.call("ui.status", {});
  const page = await callInspect(backend, { scope: "personal", limit: 6 });
  assert.equal(page.result.value.memories.length, 1);
  for (const method of ["ui.", "ui.unknown", "UI.status", "ui.status@1", " ui.status"]) {
    await assert.rejects(backend.call(method, {}), (error) => error.code === "unknown_method", method);
  }
});
