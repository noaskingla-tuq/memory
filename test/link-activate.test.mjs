import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../out/backend/entry.js";
import { LINK_MAX_SESSIONS } from "../out/link/linkRuntime.js";
import { actor, assertContractResponse, op } from "./backendHarness.mjs";
import { DAY_START } from "./uiHarness.mjs";

const channel = { closed: false, emit: async () => undefined };
const GROUP = { id: "memory-store" };
let counter = 0;

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-link-activate-"));
  const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    start(context) {
      const handle = activate(context);
      handles.push(handle);
      return handle;
    },
  };
}

const context = (dataDir, extra = {}) => ({ pluginId: "teamuq.memory", dataDir, assetPacks: {}, allowAddons: false, ...extra });

async function connect(handle, pluginId) {
  counter += 1;
  const linkId = `act-${counter}`;
  const who = { source: { kind: "plugin", pluginId }, category: "teamuq.memory@1" };
  await handle.link.open({ linkId, who, group: GROUP, mode: "call", channel });
  let sequence = 0;
  const call = (method, ...args) => handle.link.call({ id: `a${counter}-${(sequence += 1)}`, method, args, who, group: GROUP, linkId });
  call.linkId = linkId;
  return call;
}

const snapshotOf = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort().map((name) => `${name}:${statSync(join(dir, name)).isFile() ? statSync(join(dir, name)).size : "dir"}`) : []);

test("T-3: activate gives back a frozen { call, dispose, link } and the old paths still work", async (t) => {
  const { base, start } = sandbox(t);
  const handle = start(context(base));
  assert.deepEqual(Object.keys(handle).sort(), ["call", "dispose", "link"]);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(typeof handle.link.open, "function");
  assert.deepEqual(Object.keys(handle.link.categories()), ["teamuq.memory@1"]);
  assert.equal(handle.link.categories()["teamuq.memory@1"].dataClass, "local");

  const report = assertContractResponse("diagnose", await handle.call("diagnose", {}));
  assert.deepEqual(Object.keys(report).sort(), ["cairn", "contract", "contractLockSha256", "limits", "node", "plugin", "storage"]);
  assert.equal(report.plugin.version, JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version);
  const written = assertContractResponse("memory.remember@1", await handle.call("memory.remember@1", { actor, ops: [op("Still lands in Cairn.", "op-1")] }));
  assert.equal(written.results[0].ok, true);
  assert.equal(existsSync(join(base, "memory-cairn-v1", "agents")), true);
});

test("T-3: link writes and the ui.link* methods never touch memory-cairn-v1 and leave ui.overview as it was", async (t) => {
  const { base, start } = sandbox(t);
  const handle = start(context(base));
  await handle.call("memory.remember@1", { actor, ops: [op("A Cairn memory.", "op-1")] });
  const overviewParams = { tzOffsetMin: 480, dayStartIso: DAY_START };
  const overviewBefore = await handle.call("ui.overview", overviewParams);
  const cairnBefore = snapshotOf(join(base, "memory-cairn-v1"));
  const call = await connect(handle, "other.plugin");
  await call("remember", { payload: { text: "from a plugin" }, key: "k", tags: ["t"] });
  await call("recall", { limit: 5 });
  await call("forget", { ids: ["nothing"] });
  const sources = await handle.call("ui.linkSources", {});
  assert.equal(sources.ok, true);
  assert.deepEqual(sources.sources.map((row) => [row.source, row.count]), [["plugin:other.plugin", 1]]);
  const listed = await handle.call("ui.linkList", { source: "plugin:other.plugin" });
  assert.equal(listed.items[0].id, "k");
  assert.equal((await handle.call("ui.linkGet", { source: "plugin:other.plugin", id: "k" })).ok, true);
  const removed = await handle.call("ui.linkForget", { action: "item", source: "plugin:other.plugin", id: "k", expectedItemRev: listed.items[0].rev });
  assert.equal(removed.ok, true);
  assert.equal((await call("recall", { limit: 5 })).value.items.length, 0);
  assert.deepEqual(snapshotOf(join(base, "memory-cairn-v1")), cairnBefore);
  assert.deepEqual(await handle.call("ui.overview", overviewParams), overviewBefore);
  assert.equal(existsSync(join(base, "memory-link-v1")), true);
});

test("T-3: after dispose the link refuses calls and writes nothing", async (t) => {
  const { base, start } = sandbox(t);
  const handle = start(context(base));
  const call = await connect(handle, "late.plugin");
  await call("remember", { payload: 1, key: "k" });
  const before = snapshotOf(join(base, "memory-link-v1"));
  await handle.dispose();
  await assert.rejects(call("remember", { payload: 2, key: "later" }));
  await assert.rejects(call("recall", { limit: 1 }));
  assert.deepEqual(snapshotOf(join(base, "memory-link-v1")), before);
  assert.equal(existsSync(join(base, "teamuq-capability-files")), false);
  await assert.rejects(handle.call("ui.linkSources", {}), { code: "internal" });
});

test("the link uses the manifest's session count and refuses a fifth connection", async (t) => {
  const { base, start } = sandbox(t);
  const handle = start(context(base));
  assert.equal(LINK_MAX_SESSIONS, 4);
  for (let index = 0; index < LINK_MAX_SESSIONS; index += 1) await connect(handle, `p${index}`);
  await assert.rejects(connect(handle, "p-extra"), { code: "capability_busy" });
});

test("the offline acceptance hooks reroute the data directory and expose the file service, and stay off in normal use", async (t) => {
  const { base, start } = sandbox(t);
  const plain = start(context(base));
  assert.equal("conformance" in plain, false);
  const rootDir = join(base, "conformance-root");
  let clock = 5_000;
  const hooked = start({ pluginId: "teamuq.memory", assetPacks: {}, allowAddons: false, conformance: { rootDir, now: () => clock, fileControl: {} } });
  assert.deepEqual(Object.keys(hooked.conformance), ["files"]);
  const call = await connect(hooked, "hook.plugin");
  await call("remember", { payload: "x", key: "k", ttlSec: 10 });
  assert.equal(readdirSync(join(rootDir, "memory-link-v1")).length, 1);
  assert.equal(existsSync(join(rootDir, "teamuq-capability-files")), true);
  clock += 10_000;
  assert.equal((await call("recall", { limit: 5 })).value.items.length, 0);
});

test("activate still refuses a context without a usable data directory", () => {
  for (const bad of [undefined, null, 5, {}, { dataDir: 5 }, { dataDir: "" }, { dataDir: "relative/dir" }, { conformance: { rootDir: "relative" } }]) {
    assert.throws(() => activate(bad), (error) => error.code === "plugin_context_invalid", JSON.stringify(bad));
  }
});
