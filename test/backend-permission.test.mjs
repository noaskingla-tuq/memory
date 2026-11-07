import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readCairn } from "../out/adapters/ui/cairnReader.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { REPO_ROOT } from "./backendHarness.mjs";

const linkType = process.platform === "win32" ? "junction" : "dir";

function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-permission-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function tryLink(target, path) {
  try {
    symlinkSync(target, path, linkType);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return false;
    throw error;
  }
}

test("a trusted base moves the ancestor walk to the data directory", (t) => {
  const base = scratch(t);
  const layout = new CairnDataLayout(join(base, "memory-cairn-v1"), { trustedBase: base });
  layout.preflight();
  assert.equal(existsSync(join(base, "memory-cairn-v1", "agents")), true);
});

test("a redirected directory below the trusted base is still refused", (t) => {
  const base = scratch(t);
  const target = join(base, "elsewhere");
  mkdirSync(target);
  if (!tryLink(target, join(base, "memory-cairn-v1"))) {
    t.diagnostic("directory symlink fixture unavailable on this platform");
    return;
  }
  assert.throws(
    () => new CairnDataLayout(join(base, "memory-cairn-v1"), { trustedBase: base }),
    (error) => error.code === "STORAGE_UNSAFE",
  );
});

test("a redirect above the trusted base is the host's business and does not fail the layout", (t) => {
  const base = scratch(t);
  const target = join(base, "real-data");
  mkdirSync(target);
  const link = join(base, "data-link");
  if (!tryLink(target, link)) {
    t.diagnostic("directory symlink fixture unavailable on this platform");
    return;
  }
  const layout = new CairnDataLayout(join(link, "memory-cairn-v1"), { trustedBase: link });
  layout.preflight();
  assert.equal(existsSync(join(target, "memory-cairn-v1", "agents")), true);
  assert.throws(
    () => new CairnDataLayout(join(link, "memory-cairn-v1")),
    (error) => error.code === "STORAGE_UNSAFE",
  );
});

test("a path outside the trusted base is refused", (t) => {
  const base = scratch(t);
  const other = scratch(t);
  assert.throws(
    () => new CairnDataLayout(join(other, "memory-cairn-v1"), { trustedBase: base }),
    (error) => error.code === "STORAGE_UNSAFE",
  );
});

test("activate serves remember and inspect when node --permission allows only the repository and the data directory", (t) => {
  const base = scratch(t);
  const dataDir = join(base, "plugins", "data", "teamuq.memory");
  mkdirSync(dataDir, { recursive: true });
  const script = join(base, "probe.mjs");
  const entry = pathToFileURL(join(REPO_ROOT, "out", "backend", "entry.js")).href;
  writeFileSync(
    script,
    [
      `import { activate } from ${JSON.stringify(entry)};`,
      `const handle = activate({ pluginId: "teamuq.memory", dataDir: ${JSON.stringify(dataDir)}, assetPacks: {}, allowAddons: false });`,
      'const actor = { agentId: "a/b", projectId: null, sessionId: "s", providerId: "codex" };',
      'const op = { scope: "personal", content: "permission probe", kind: "context", operationId: "punch:00000000000000000000000000000001" };',
      'const first = await handle.call("memory.remember@1", { actor, ops: [op] });',
      'const second = await handle.call("memory.remember@1", { actor, ops: [{ ...op, operationId: "punch:00000000000000000000000000000002" }] });',
      'const listed = await handle.call("memory.inspect@1", { actor, input: { scope: "personal" } });',
      'const diagnose = await handle.call("diagnose", {});',
      "await handle.dispose();",
      "process.stderr.write(JSON.stringify({ first: first.results[0], second: second.results[0], listed: listed.result, storage: diagnose.storage, permission: typeof process.permission }));",
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${REPO_ROOT}`, `--allow-fs-read=${script}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`, script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stderr.split("\n").filter((line) => line.startsWith("{")).at(-1));
  assert.equal(report.permission, "object");
  assert.deepEqual(report.storage, { status: "ready" });
  assert.equal(report.first.ok, true);
  assert.equal(report.first.value.deduplicated, false);
  assert.equal(report.second.ok, true);
  assert.equal(report.second.value.deduplicated, true);
  assert.equal(report.second.value.memory.id, report.first.value.memory.id);
  assert.deepEqual(report.listed.value.memories.map((memory) => memory.id), [report.first.value.memory.id]);
});

test("the link round trip and its data directories work when node --permission allows only the repository and the data directory", (t) => {
  const base = scratch(t);
  const dataDir = join(base, "plugins", "data", "teamuq.memory");
  mkdirSync(dataDir, { recursive: true });
  const script = join(base, "link-probe.mjs");
  const entry = pathToFileURL(join(REPO_ROOT, "out", "backend", "entry.js")).href;
  writeFileSync(
    script,
    [
      `import { activate } from ${JSON.stringify(entry)};`,
      `const handle = activate({ pluginId: "teamuq.memory", dataDir: ${JSON.stringify(dataDir)}, assetPacks: {}, allowAddons: false });`,
      'const who = { source: { kind: "plugin", pluginId: "probe.plugin" }, category: "teamuq.memory@1" };',
      'const group = { id: "memory-store" };',
      'await handle.link.open({ linkId: "l1", who, group, mode: "call", channel: { closed: false, emit: async () => undefined } });',
      'const call = (id, method, ...args) => handle.link.call({ id, method, args, who, group, linkId: "l1" });',
      'const remembered = await call("1", "remember", { payload: { text: "probe" }, key: "k" });',
      'const recalled = await call("2", "recall", { limit: 5 });',
      'const sources = await handle.call("ui.linkSources", {});',
      'const forgotten = await call("3", "forget", { all: true });',
      "await handle.dispose();",
      "process.stderr.write(JSON.stringify({ remembered: remembered.value, recalled: recalled.value.items.length, sources: sources.sources.length, forgotten: forgotten.value }));",
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${REPO_ROOT}`, `--allow-fs-read=${script}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`, script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stderr.split("\n").filter((line) => line.startsWith("{")).at(-1));
  assert.deepEqual(report.remembered, { id: "k", created: true });
  assert.equal(report.recalled, 1);
  assert.equal(report.sources, 1);
  assert.deepEqual(report.forgotten, { forgotten: 1 });
  assert.equal(existsSync(join(dataDir, "memory-cairn-v1")), true);
});

function permissionChild(base, dataDir, body) {
  const script = join(base, "open-probe.mjs");
  const adapter = pathToFileURL(join(REPO_ROOT, "out", "adapters", "cairn", "cairnCoreAdapter.js")).href;
  writeFileSync(script, [`import { openCairnCore } from ${JSON.stringify(adapter)};`, ...body].join("\n"));
  return spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${REPO_ROOT}`, `--allow-fs-read=${script}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`, script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
}

function schemaOf(path) {
  const db = new DatabaseSync(path);
  try {
    return { applicationId: db.prepare("PRAGMA application_id").get().application_id, userVersion: db.prepare("PRAGMA user_version").get().user_version };
  } finally {
    db.close();
  }
}

test("a new agent database is created at schema 18 under node --permission without --allow-child-process", (t) => {
  const base = scratch(t);
  const dataDir = join(base, "data");
  mkdirSync(dataDir);
  const databasePath = join(dataDir, "memory.sqlite");
  const result = permissionChild(base, dataDir, [
    `const core = openCairnCore(${JSON.stringify(databasePath)});`,
    "core.close();",
    'process.stderr.write(JSON.stringify({ permission: typeof process.permission, child: process.permission.has("child") }));',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stderr.split("\n").filter((line) => line.startsWith("{")).at(-1));
  assert.deepEqual(report, { permission: "object", child: false });
  assert.deepEqual(schemaOf(databasePath), { applicationId: 0x43414952, userVersion: 18 });
});

test("an empty database file is no database yet for the listing and the reader, and Cairn initialises it under node --permission", (t) => {
  const base = scratch(t);
  const layout = new CairnDataLayout(join(base, "memory-cairn-v1"), { trustedBase: base });
  const databasePath = layout.agentDbPath("a/b");
  const agentHash = createHash("sha256").update("a/b").digest("hex");
  writeFileSync(databasePath, "", { flag: "wx" });
  assert.deepEqual(layout.inspectAgentDirectory(agentHash), { agentHash, databasePath: null, state: "no_database" });
  assert.deepEqual(readCairn(databasePath, () => 0), { ok: false, code: "not_found" });
  const dataDir = join(base, "memory-cairn-v1");
  const result = permissionChild(base, dataDir, [`openCairnCore(${JSON.stringify(databasePath)}).close();`]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(schemaOf(databasePath), { applicationId: 0x43414952, userVersion: 18 });
  assert.equal(layout.inspectAgentDirectory(agentHash).state, "ready");
  assert.equal(readCairn(databasePath, () => 0).ok, true);
});
