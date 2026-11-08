import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { defaultBackupHooks } from "../out/adapters/storage/upgradeBackup.js";
import { serializedBytes, UI_RESPONSE_BUDGET_BYTES } from "../out/application/ui/budget.js";
import { parseUiResponse, UI_FAILURE_CODES } from "../out/contracts/uiContract.js";
import { REPO_ROOT } from "./backendHarness.mjs";
import { completedBackups, hashOf, installLegacy, LEGACY_COMMIT, schemaOf, sha256File } from "./legacy-upgrade-harness.mjs";
import { DAY_START, startStore } from "./uiHarness.mjs";

const pin = JSON.parse(readFileSync(join(REPO_ROOT, "cairn-pin.json"), "utf8"));
const OVERVIEW = { tzOffsetMin: 480, dayStartIso: DAY_START };
const hexOf = (character) => character.repeat(64);

test("a legacy fixture database is backed up, upgraded to schema 18, keeps its memories and gets the current pin in identity.json", async (t) => {
  const store = startStore(t);
  const legacy = installLegacy(store.dataRoot);
  const before = schemaOf(legacy.databasePath);
  assert.equal(before.userVersion < 18, true);

  const first = await store.backend.call("ui.overview", OVERVIEW);
  assert.equal(first.storage.unavailableAgents, 1);
  assert.equal(first.storage.upgradableAgents, 1);

  const answer = await store.backend.call("ui.upgradeLegacy", {});
  assert.equal(parseUiResponse("ui.upgradeLegacy", answer), true);
  assert.deepEqual(answer, { ok: true, upgraded: 1, failed: 0, results: [{ agentHash: legacy.agentHash, ok: true }], remaining: 0 });
  assert.ok(serializedBytes(answer) <= UI_RESPONSE_BUDGET_BYTES);

  assert.deepEqual(schemaOf(legacy.databasePath), { userVersion: 18, memories: before.memories });
  assert.equal(completedBackups(store.dataRoot, legacy.agentHash).length, 1);
  const identity = JSON.parse(readFileSync(legacy.identityPath, "utf8"));
  assert.equal(identity.cairnCommit, pin.commit);
  assert.equal(identity.upgradedFromCommit, LEGACY_COMMIT);

  const after = await store.backend.call("ui.overview", OVERVIEW);
  assert.equal(after.storage.unavailableAgents, 0);
  assert.equal("upgradableAgents" in after.storage, false);
  assert.deepEqual(after.agents.map((card) => [card.id, card.counts.total]), [["fixture-agent", before.memories]]);
});

test("a failed backup leaves the database and identity untouched and reports STORAGE_BUSY", async (t) => {
  const store = startStore(t, {
    backupHooks: {
      vacuumInto: () => {
        throw new Error("disk full");
      },
    },
  });
  const legacy = installLegacy(store.dataRoot);
  const databaseHash = sha256File(legacy.databasePath);
  const identityHash = sha256File(legacy.identityPath);
  const answer = await store.backend.call("ui.upgradeLegacy", {});
  assert.equal(parseUiResponse("ui.upgradeLegacy", answer), true);
  assert.deepEqual(answer, { ok: true, upgraded: 0, failed: 1, results: [{ agentHash: legacy.agentHash, ok: false, code: "STORAGE_BUSY" }], remaining: 0 });
  assert.equal(sha256File(legacy.databasePath), databaseHash);
  assert.equal(sha256File(legacy.identityPath), identityHash);
  assert.deepEqual(completedBackups(store.dataRoot, legacy.agentHash), []);
  assert.deepEqual(readdirSync(legacy.agentRoot).sort(), ["identity.json", "memory.sqlite"]);
});

test("one failing database does not stop the others, and a skipped hash is not tried again", async (t) => {
  const failing = hashOf("legacy-b");
  const store = startStore(t, {
    backupHooks: {
      vacuumInto: (databasePath, destination) => {
        if (databasePath.includes(failing)) throw new Error("cannot back up this one");
        defaultBackupHooks.vacuumInto(databasePath, destination);
      },
    },
  });
  const installed = ["legacy-a", "legacy-b", "legacy-c"].map((label) => installLegacy(store.dataRoot, label));
  const answer = await store.backend.call("ui.upgradeLegacy", {});
  assert.equal(parseUiResponse("ui.upgradeLegacy", answer), true);
  assert.equal(answer.upgraded, 2);
  assert.equal(answer.failed, 1);
  assert.equal(answer.remaining, 0);
  assert.deepEqual(answer.results.filter((result) => !result.ok), [{ agentHash: failing, ok: false, code: "STORAGE_BUSY" }]);
  for (const entry of installed) assert.equal(schemaOf(entry.databasePath).userVersion, entry.agentHash === failing ? 13 : 18, entry.agentHash);
  const again = await store.backend.call("ui.upgradeLegacy", { skip: [failing] });
  assert.deepEqual(again, { ok: true, upgraded: 0, failed: 0, results: [], remaining: 0 });
  const retried = await store.backend.call("ui.upgradeLegacy", {});
  assert.equal(retried.failed, 1, "without skip the failed database is still a candidate");
});

test("limit splits the work into calls and reports how many are left", async (t) => {
  const store = startStore(t);
  for (const label of ["l1", "l2", "l3"]) installLegacy(store.dataRoot, label);
  const first = await store.backend.call("ui.upgradeLegacy", { limit: 2 });
  assert.deepEqual([first.upgraded, first.failed, first.remaining], [2, 0, 1]);
  const second = await store.backend.call("ui.upgradeLegacy", { limit: 2 });
  assert.deepEqual([second.upgraded, second.failed, second.remaining], [1, 0, 0]);
});

test("damaged, unaccepted and mislabeled databases are never upgradable and stay byte for byte unchanged", async (t) => {
  const store = startStore(t);
  const damaged = installLegacy(store.dataRoot, "damaged");
  writeFileSync(damaged.databasePath, Buffer.alloc(4096, 0x41));
  const truncated = installLegacy(store.dataRoot, "truncated");
  writeFileSync(truncated.databasePath, readFileSync(truncated.databasePath).subarray(0, 60));
  const unaccepted = installLegacy(store.dataRoot, "unaccepted", "b".repeat(40));
  const mislabeled = installLegacy(store.dataRoot, "mislabeled");
  const identity = JSON.parse(readFileSync(mislabeled.identityPath, "utf8"));
  writeFileSync(mislabeled.identityPath, JSON.stringify({ ...identity, agentHash: hexOf("e") }));
  const files = [damaged, truncated, unaccepted, mislabeled].flatMap((entry) => [entry.databasePath, entry.identityPath]);
  const hashes = files.map(sha256File);

  const overview = await store.backend.call("ui.overview", OVERVIEW);
  assert.equal(overview.storage.unavailableAgents, 4);
  assert.equal("upgradableAgents" in overview.storage, false);
  const answer = await store.backend.call("ui.upgradeLegacy", {});
  assert.deepEqual(answer, { ok: true, upgraded: 0, failed: 0, results: [], remaining: 0 });
  assert.deepEqual(files.map(sha256File), hashes);
  assert.equal(readdirSync(store.dataRoot).includes("backups"), false);
});

test("a damaged database next to a legacy one is left alone while the legacy one is upgraded", async (t) => {
  const store = startStore(t);
  const damaged = installLegacy(store.dataRoot, "damaged");
  writeFileSync(damaged.databasePath, Buffer.alloc(4096, 0x41));
  const damagedHash = sha256File(damaged.databasePath);
  const legacy = installLegacy(store.dataRoot);
  const overview = await store.backend.call("ui.overview", OVERVIEW);
  assert.deepEqual([overview.storage.unavailableAgents, overview.storage.upgradableAgents], [2, 1]);
  const answer = await store.backend.call("ui.upgradeLegacy", {});
  assert.deepEqual([answer.upgraded, answer.failed, answer.remaining], [1, 0, 0]);
  assert.equal(schemaOf(legacy.databasePath).userVersion, 18);
  assert.equal(sha256File(damaged.databasePath), damagedHash);
  const after = await store.backend.call("ui.overview", OVERVIEW);
  assert.deepEqual([after.storage.unavailableAgents, "upgradableAgents" in after.storage], [1, false]);
});

test("a schema newer than 18 is not offered for upgrade", async (t) => {
  const store = startStore(t);
  const entry = installLegacy(store.dataRoot, "newer");
  const db = new DatabaseSync(entry.databasePath);
  db.exec("PRAGMA user_version = 19");
  db.close();
  const answer = await store.backend.call("ui.upgradeLegacy", {});
  assert.equal(answer.upgraded + answer.failed + answer.remaining, 0);
  assert.equal(schemaOf(entry.databasePath).userVersion, 19);
});

test("request limits and failure codes come from the contract", async (t) => {
  const store = startStore(t);
  const bad = [{ limit: 0 }, { limit: 11 }, { skip: ["short"] }, { skip: Array.from({ length: 201 }, () => hexOf("a")) }, { extra: 1 }];
  for (const params of bad) {
    assert.deepEqual(await store.backend.call("ui.upgradeLegacy", params), { ok: false, code: "INVALID_PARAMS", retryable: false });
  }
  assert.ok(UI_FAILURE_CODES.includes("STORAGE_BUSY") && UI_FAILURE_CODES.includes("STORAGE_UNSUPPORTED"));
});

test("the upgrade runs under node --permission with only the repository and the data directory", (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-legacy-permission-"));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dataDir = join(base, "plugins", "data", "teamuq.memory");
  const dataRoot = join(dataDir, "memory-cairn-v1");
  mkdirSync(dataRoot, { recursive: true });
  const legacy = installLegacy(dataRoot);
  const before = schemaOf(legacy.databasePath);
  const script = join(base, "probe.mjs");
  const entry = pathToFileURL(join(REPO_ROOT, "out", "backend", "entry.js")).href;
  const overviewParams = JSON.stringify({ tzOffsetMin: 0, dayStartIso: DAY_START });
  writeFileSync(script, [
    `import { activate } from ${JSON.stringify(entry)};`,
    `const handle = activate({ pluginId: "teamuq.memory", dataDir: ${JSON.stringify(dataDir)}, assetPacks: {}, allowAddons: false });`,
    `const overview = await handle.call("ui.overview", ${overviewParams});`,
    'const upgrade = await handle.call("ui.upgradeLegacy", {});',
    `const after = await handle.call("ui.overview", ${overviewParams});`,
    "await handle.dispose();",
    "process.stderr.write(JSON.stringify({ permission: typeof process.permission, before: overview.storage, upgrade, after: after.storage }));",
  ].join("\n"));
  const result = spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${REPO_ROOT}`, `--allow-fs-read=${script}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`, script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stderr.split("\n").filter((line) => line.startsWith("{")).at(-1));
  assert.equal(report.permission, "object");
  assert.equal(report.before.upgradableAgents, 1);
  assert.deepEqual(report.upgrade, { ok: true, upgraded: 1, failed: 0, results: [{ agentHash: legacy.agentHash, ok: true }], remaining: 0 });
  assert.equal(report.after.unavailableAgents, 0);
  assert.deepEqual(schemaOf(legacy.databasePath), { userVersion: 18, memories: before.memories });
  assert.equal(completedBackups(dataRoot, legacy.agentHash).length, 1);
});

test("every database the upgrade touches is marked dirty, failures included", async () => {
  const { runUpgradeLegacy } = await import("../out/application/ui/legacyUpgrade.js");
  const { createClock } = await import("../out/application/ui/timeSlice.js");
  const { MemoryServiceError } = await import("../out/domain/errors.js");
  const marked = [];
  const hashes = [hexOf("1"), hexOf("2"), hexOf("3")];
  const services = {
    index: {
      snapshot: async () => ({ agents: [], complete: true, unavailable: hashes.map((agentHash) => ({ agentHash, reason: "unsupported_schema" })) }),
      markDirtyHash: (hash) => marked.push(hash),
    },
    legacy: {
      legacyCandidate: () => true,
      upgradeLegacy: (hash) => {
        if (hash === hashes[1]) throw new MemoryServiceError("STORAGE_BUSY", "backup failed");
      },
    },
  };
  const answer = await runUpgradeLegacy({ skip: [], limit: 5 }, services, createClock());
  assert.deepEqual([answer.upgraded, answer.failed], [2, 1]);
  assert.deepEqual(marked, hashes);
});
