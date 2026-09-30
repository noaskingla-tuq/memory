import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { activate } from "../out/backend/entry.js";
import { resolvePinPath } from "../out/backend/pinPath.js";
import {
  PIN_PATH,
  REPO_ROOT,
  actor,
  assertContractResponse,
  contract,
  op,
  startBackend,
} from "./backendHarness.mjs";

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const cairnPin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
const vendorDir = join(REPO_ROOT, "vendor", "teamuq-contract");
const lockSha256 = createHash("sha256")
  .update(readFileSync(join(vendorDir, "lock.json"), "utf8").replace(/\r\n/gu, "\n"))
  .digest("hex");

// why: node:test runs t.after hooks in registration order, but open handles must be disposed before their directory is removed
function temporaryDirectory(t) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-entry-"));
  const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, own: (handle) => handles.push(handle) && handle };
}

const context = (dataDir) => ({ pluginId: "teamuq.memory", dataDir, assetPacks: {}, allowAddons: false });

test("diagnose reports the seven contract fields and matches the vendored schema", async (t) => {
  const { backend, base, dataRoot } = startBackend(t);
  const report = assertContractResponse("diagnose", await backend.call("diagnose", {}));
  assert.deepEqual(Object.keys(report).sort(), ["cairn", "contract", "contractLockSha256", "limits", "node", "plugin", "storage"]);
  assert.deepEqual(report.plugin, { id: "teamuq.memory", version: packageJson.version });
  assert.deepEqual(report.contract, { versions: [...contract.MEMORY_CONTRACT_VERSIONS] });
  assert.deepEqual(report.cairn, { commit: cairnPin.commit });
  assert.equal(report.node.version, process.versions.node);
  assert.match(report.node.sqlite, /^\d+\.\d+\.\d+/);
  assert.deepEqual(report.storage, { status: "ready" });
  assert.deepEqual(report.limits, {
    resultMaxBytes: contract.MEMORY_LIMITS.resultMaxBytes,
    inspectBudgetBytes: contract.MEMORY_LIMITS.inspectBudgetBytes,
    maxOps: contract.MEMORY_LIMITS.maxOps,
  });
  assert.equal(report.contractLockSha256, lockSha256);
  const vendorLock = JSON.parse(readFileSync(join(vendorDir, "vendor.lock.json"), "utf8"));
  assert.equal(report.contractLockSha256, vendorLock.coreLockSha256);
  const text = JSON.stringify(report);
  for (const secret of [base, dataRoot, base.replaceAll("\\", "/"), base.replaceAll("\\", "\\\\"), REPO_ROOT]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(/[A-Za-z]:[\\/]/.test(text), false);
});

test("a broken storage layer is reported by diagnose and by per-call error results, then recovers", async (t) => {
  const { base } = temporaryDirectory(t);
  const pinPath = join(base, "cairn-pin.json");
  const { backend } = startBackend(t, { pinPath });

  const broken = assertContractResponse("diagnose", await backend.call("diagnose", {}));
  assert.equal(broken.storage.status, "dependency_incompatible");

  const remembered = assertContractResponse(
    "memory.remember@1",
    await backend.call("memory.remember@1", { actor, ops: [op("Blocked write.", "op-1"), op("Blocked write two.", "op-2")] }),
  );
  assert.equal(remembered.results.length, 2);
  for (const result of remembered.results) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "DEPENDENCY_INCOMPATIBLE");
    assert.equal(result.error.retryable, false);
  }
  const inspected = assertContractResponse("memory.inspect@1", await backend.call("memory.inspect@1", { actor, input: { scope: "personal" } }));
  assert.equal(inspected.result.ok, false);
  assert.equal(inspected.result.error.code, "DEPENDENCY_INCOMPATIBLE");

  copyFileSync(PIN_PATH, pinPath);
  const healed = assertContractResponse("diagnose", await backend.call("diagnose", {}));
  assert.equal(healed.storage.status, "ready");
  const written = assertContractResponse("memory.remember@1", await backend.call("memory.remember@1", { actor, ops: [op("Now it works.", "op-3")] }));
  assert.equal(written.results[0].ok, true);
});

test("an unsafe data root is reported as storage_unsafe and refuses writes without INTERNAL", async (t) => {
  const { base } = temporaryDirectory(t);
  const { backend } = startBackend(t, { dataRoot: join(base, "not-the-memory-root") });
  const report = assertContractResponse("diagnose", await backend.call("diagnose", {}));
  assert.equal(report.storage.status, "storage_unsafe");
  const written = assertContractResponse("memory.remember@1", await backend.call("memory.remember@1", { actor, ops: [op("Nowhere to write.", "op-1")] }));
  assert.equal(written.results[0].error.code, "STORAGE_UNSAFE");
});

test("activate gives back exactly { call, dispose } on <dataDir>/memory-cairn-v1", async (t) => {
  const { base, own } = temporaryDirectory(t);
  const handle = own(await activate(context(base)));
  assert.deepEqual(Object.keys(handle).sort(), ["call", "dispose"]);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(existsSync(join(base, "memory-cairn-v1", "agents")), true);

  const report = assertContractResponse("diagnose", await handle.call("diagnose", {}));
  assert.equal(report.storage.status, "ready");
  const written = assertContractResponse(
    "memory.remember@1",
    await handle.call("memory.remember@1", { actor, ops: [op("Through activate.", "op-1")] }),
  );
  const [result] = written.results;
  assert.equal(result.ok, true);
  const page = assertContractResponse("memory.inspect@1", await handle.call("memory.inspect@1", { actor, input: { scope: "personal" } }));
  assert.deepEqual(page.result.value.memories.map((memory) => memory.id), [result.value.memory.id]);
  await handle.dispose();
  await assert.rejects(handle.call("diagnose", {}), { code: "internal" });
});

test("activate refuses a context without an absolute dataDir", () => {
  for (const bad of [undefined, null, 5, {}, { dataDir: 5 }, { dataDir: "" }, { dataDir: "relative/dir" }]) {
    assert.throws(() => activate(bad), (error) => {
      assert.equal(error.code, "plugin_context_invalid");
      assert.match(error.code, /^[a-z0-9_]{3,96}$/);
      return true;
    });
  }
});

test("data written before a restart is read back by a new activation", async (t) => {
  const { base, own } = temporaryDirectory(t);
  const first = await activate(context(base));
  const written = await first.call("memory.remember@1", { actor, ops: [op("Survives a restart.", "op-1")] });
  await first.dispose();
  const second = own(await activate(context(base)));
  const page = await second.call("memory.inspect@1", { actor, input: { scope: "personal" } });
  assert.deepEqual(page.result.value.memories.map((memory) => memory.id), [written.results[0].value.memory.id]);
  const again = await second.call("memory.remember@1", { actor, ops: [op("Survives a restart.", "op-2")] });
  assert.equal(again.results[0].value.deduplicated, true);
});

test("the pin file is found next to a packaged backend and two levels up in the source layout", (t) => {
  const { base } = temporaryDirectory(t);
  const packaged = join(base, "backend.mjs");
  assert.equal(resolvePinPath(pathToFileURL(packaged).href), resolve(base, "..", "..", "cairn-pin.json"));
  writeFileSync(join(base, "cairn-pin.json"), readFileSync(PIN_PATH));
  assert.equal(resolvePinPath(pathToFileURL(packaged).href), join(base, "cairn-pin.json"));
  const built = pathToFileURL(join(REPO_ROOT, "out", "backend", "entry.js")).href;
  assert.equal(resolvePinPath(built), PIN_PATH);
});
