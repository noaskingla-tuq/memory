import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_FAILURE_CODES, UI_METHOD_NAMES, UI_METHOD_SCHEMAS, parseUiParams, parseUiResponse } from "../out/contracts/uiContract.js";
import { REPO_ROOT } from "./backendHarness.mjs";
import { startLink } from "./uiHarness.mjs";

const LINK_METHODS = ["ui.linkSources", "ui.linkList", "ui.linkGet", "ui.linkForget"];
const accepts = (method, params) => parseUiParams(method, params).ok;

test("the four link methods follow the first eight in the contract and the manifest lists all twelve in the same order", () => {
  assert.deepEqual(UI_METHOD_NAMES.slice(-4), LINK_METHODS);
  assert.deepEqual(Object.keys(UI_METHOD_SCHEMAS).sort(), [...UI_METHOD_NAMES].sort());
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "plugin", "manifest.template.json"), "utf8"));
  assert.deepEqual(manifest.backendMethods, [...UI_METHOD_NAMES]);
  assert.equal(UI_FAILURE_CODES.length, 7);
});

test("request schemas are strict and bounded", () => {
  const source = "plugin:x.y";
  assert.equal(accepts("ui.linkSources", {}), true);
  assert.equal(accepts("ui.linkSources", { a: 1 }), false);
  assert.equal(accepts("ui.linkList", { source }), true);
  assert.equal(parseUiParams("ui.linkList", { source }).value.limit, 12);
  assert.equal(accepts("ui.linkList", { source: "core", limit: 24, cursor: "c" }), true);
  for (const bad of [{ source, limit: 0 }, { source, limit: 25 }, { source, limit: 1.5 }, { source, cursor: "" }, { source, cursor: "c".repeat(1025) }, { source, extra: 1 }, { source: "plugin:" }, { source: "plugin:a\u0007" }, { source: "plugin:a\u007f" }, { source: `plugin:${"a".repeat(191)}` }, { source: "Core" }, {}]) {
    assert.equal(accepts("ui.linkList", bad), false, JSON.stringify(bad));
  }
  assert.equal(accepts("ui.linkGet", { source, id: "k" }), true);
  assert.equal(accepts("ui.linkGet", { source, id: "k".repeat(129) }), false);
  assert.equal(accepts("ui.linkGet", { source, id: "" }), false);
  assert.equal(accepts("ui.linkForget", { action: "item", source, id: "k", expectedItemRev: 1 }), true);
  assert.equal(accepts("ui.linkForget", { action: "source", source, expectedRevision: 3 }), true);
  assert.equal(accepts("ui.linkForget", { action: "damaged", fileId: "a".repeat(64) }), true);
  for (const bad of [{ action: "item", source, id: "k" }, { action: "item", source, id: "k", expectedItemRev: 0 }, { action: "source", source, expectedRevision: 0 }, { action: "source", source, expectedRevision: 1, id: "k" }, { action: "damaged", fileId: "A".repeat(64) }, { action: "damaged", fileId: "a".repeat(63) }, { action: "all", source }, { source, id: "k", expectedItemRev: 1 }]) {
    assert.equal(accepts("ui.linkForget", bad), false, JSON.stringify(bad));
  }
});

test("real answers satisfy their success schemas and any extra field is refused", async (t) => {
  const link = startLink(t);
  const call = await link.connect("x.y");
  await call("remember", { payload: { text: "你好" }, key: "k", tags: ["t"], ttlSec: 60 });
  const answers = {
    "ui.linkSources": await link.ui("ui.linkSources", {}),
    "ui.linkList": await link.ui("ui.linkList", { source: "plugin:x.y" }),
    "ui.linkGet": await link.ui("ui.linkGet", { source: "plugin:x.y", id: "k" }),
    "ui.linkForget": await link.ui("ui.linkForget", { action: "item", source: "plugin:x.y", id: "k", expectedItemRev: 1 }),
  };
  for (const method of LINK_METHODS) {
    assert.equal(answers[method].ok, true, method);
    assert.equal(UI_METHOD_SCHEMAS[method].success.safeParse(answers[method]).success, true, method);
    assert.equal(parseUiResponse(method, { ...answers[method], leaked: 1 }), false, `${method} with an extra field`);
    assert.equal(parseUiResponse(method, { ...answers[method], ok: undefined }), false, `${method} without ok`);
  }
  assert.deepEqual(answers["ui.linkGet"].item.tags, ["t"]);
  assert.equal(typeof answers["ui.linkGet"].item.expiresAtMs, "number");
  assert.equal(answers["ui.linkForget"].revision, null);
  assert.equal(parseUiResponse("ui.linkList", { ...answers["ui.linkList"], items: [{ ...answers["ui.linkList"].items[0], extra: 1 }] }), false);
  assert.equal(parseUiResponse("ui.linkSources", { ...answers["ui.linkSources"], sources: Array(33).fill(answers["ui.linkSources"].sources[0]) }), false);
  assert.equal(parseUiResponse("ui.linkList", { ok: false, code: "CURSOR_STALE", retryable: false }), true);
});

test("link failures use only the existing codes", async (t) => {
  const link = startLink(t);
  const failures = [
    await link.ui("ui.linkList", { source: "plugin:none" }),
    await link.ui("ui.linkList", { source: "plugin:none", cursor: "bad" }),
    await link.ui("ui.linkList", { source: "x" }),
    await link.ui("ui.linkSources", {}, { link: undefined }),
  ];
  for (const failure of failures) {
    assert.equal(failure.ok, false);
    assert.ok(UI_FAILURE_CODES.includes(failure.code), failure.code);
  }
});
