import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
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
