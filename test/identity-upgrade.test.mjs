import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import {
  CAIRN_COMMIT,
  CairnDataLayout,
} from "../out/adapters/storage/dataLayout.js";
import { KEEP_BACKUPS } from "../out/adapters/storage/upgradeBackup.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(repoRoot, "cairn-pin.json"), "utf8"));
const fixtureRoot = join(repoRoot, "test", "fixtures", "legacy-db");
const FAKE_OLD = "a".repeat(40);
const UNKNOWN = "b".repeat(40);

function fixtureFor(commit) {
  const directory = join(fixtureRoot, commit);
  return {
    directory,
    meta: JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")),
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-upgrade-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function install(base, fixtureCommit, identityCommit) {
  const { directory, meta } = fixtureFor(fixtureCommit);
  const root = join(base, "memory-cairn-v1");
  const agentHash = createHash("sha256").update(meta.agentId).digest("hex");
  const agentRoot = join(root, "agents", agentHash);
  mkdirSync(agentRoot, { recursive: true });
  cpSync(join(directory, "memory.sqlite"), join(agentRoot, "memory.sqlite"));
  const identity = JSON.parse(
    readFileSync(join(directory, "identity.json"), "utf8"),
  );
  identity.cairnCommit = identityCommit;
  writeFileSync(
    join(agentRoot, "identity.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  return {
    root,
    meta,
    agentHash,
    agentRoot,
    identityPath: join(agentRoot, "identity.json"),
    databasePath: join(agentRoot, "memory.sqlite"),
    backupsDir: join(root, "backups", agentHash),
  };
}

function clock(start = Date.UTC(2026, 8, 30, 1, 0, 0)) {
  let tick = 0;
  return () => new Date(start + 1000 * tick++);
}

function completeBackups(dir) {
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => /^\d{8}T\d{9}Z-from-[0-9a-f]{8}$/.test(name)).sort()
    : [];
}

function integrityOf(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  } finally {
    db.close();
  }
}

function startApplication(t, layout) {
  const pool = new CoreHandlePool({ layout, openCore: openCairnCore });
  const application = new MemoryApplication(pool);
  t.after(async () => {
    await application.close();
  });
  return application;
}

function assertMemoriesReadable(layout, meta) {
  const core = openCairnCore(layout.agentDbPath(meta.agentId));
  try {
    for (const memory of meta.memories) {
      const result = core.get({
        namespace: {
          ownerId: meta.agentId,
          scope: memory.scope,
          projectId: memory.scope === "project" ? meta.actor.projectId : null,
        },
        memoryId: memory.id,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.value.memory.content, memory.content);
    }
  } finally {
    core.close();
  }
}

function assertNoTemporaryFiles(installed) {
  assert.deepEqual(
    readdirSync(installed.agentRoot).filter((name) => name.endsWith(".tmp")),
    [],
  );
  if (existsSync(installed.backupsDir)) {
    assert.deepEqual(
      readdirSync(installed.backupsDir).filter((name) => name.startsWith(".partial-")),
      [],
    );
  }
}

test("every accepted Cairn commit has a real legacy database fixture that opens", (t) => {
  assert.ok(pin.accepted.includes(pin.commit));
  assert.equal(CAIRN_COMMIT, pin.commit);
  for (const commit of pin.accepted) {
    const { meta } = fixtureFor(commit);
    assert.equal(meta.cairnCommit, commit);
    const base = scratch(t);
    const installed = install(base, commit, commit);
    const layout = new CairnDataLayout(installed.root, { backupHooks: { now: clock() } });
    assertMemoriesReadable(layout, meta);
    const stored = JSON.parse(readFileSync(installed.identityPath, "utf8"));
    assert.equal(stored.cairnCommit, pin.commit);
    if (commit === pin.commit) assert.deepEqual(completeBackups(installed.backupsDir), []);
    else assert.equal(completeBackups(installed.backupsDir).length, 1);
  }
});

test("accepted older commit is backed up, opened, then identity is rewritten to the current commit", (t) => {
  const base = scratch(t);
  const installed = install(base, pin.commit, FAKE_OLD);
  const beforeIdentity = JSON.parse(readFileSync(installed.identityPath, "utf8"));
  const layout = new CairnDataLayout(installed.root, {
    acceptedCommits: [pin.commit, FAKE_OLD],
    backupHooks: { now: clock() },
  });
  assertMemoriesReadable(layout, installed.meta);

  const backups = completeBackups(installed.backupsDir);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^20260930T010000000Z-from-aaaaaaaa$/);
  const backupDatabase = join(installed.backupsDir, backups[0], "memory.sqlite");
  assert.deepEqual(integrityOf(backupDatabase), ["ok"]);
  const backupIdentity = JSON.parse(readFileSync(join(installed.backupsDir, backups[0], "identity.json"), "utf8"));
  assert.equal(backupIdentity.cairnCommit, FAKE_OLD);
  const backupHandle = new DatabaseSync(backupDatabase, { readOnly: true });
  try {
    assert.equal(backupHandle.prepare("PRAGMA user_version").get().user_version > 0, true);
  } finally {
    backupHandle.close();
  }

  const after = JSON.parse(readFileSync(installed.identityPath, "utf8"));
  assert.equal(after.cairnCommit, pin.commit);
  assert.equal(after.agentHash, installed.agentHash);
  assert.equal(after.createdAt, beforeIdentity.createdAt);
  assert.equal(after.upgradedFromCommit, FAKE_OLD);
  assertNoTemporaryFiles(installed);
});

test("a commit outside accepted is refused as STORAGE_UNSUPPORTED and nothing is touched", async (t) => {
  const base = scratch(t);
  const installed = install(base, pin.commit, UNKNOWN);
  const identityHash = sha256(installed.identityPath);
  const databaseHash = sha256(installed.databasePath);
  const layout = new CairnDataLayout(installed.root, { backupHooks: { now: clock() } });
  assert.throws(
    () => layout.agentDbPath(installed.meta.agentId),
    (error) => error.code === "STORAGE_UNSUPPORTED",
  );
  const application = startApplication(t, layout);
  const outcome = await application.execute("memory_inspect", { scope: "personal", limit: 12 }, installed.meta.actor);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "STORAGE_UNSUPPORTED");
  assert.equal(sha256(installed.identityPath), identityHash);
  assert.equal(sha256(installed.databasePath), databaseHash);
  assert.equal(existsSync(join(installed.root, "backups")), false);

  writeFileSync(installed.identityPath, JSON.stringify({ schemaVersion: 1, agentHash: installed.agentHash }));
  assert.throws(
    () => layout.agentDbPath(installed.meta.agentId),
    (error) => error.code === "STORAGE_UNSUPPORTED",
  );
  assert.equal(existsSync(join(installed.root, "backups")), false);
});

test("a backup failure returns STORAGE_BUSY, never INTERNAL, and leaves data and identity untouched", async (t) => {
  const failures = {
    "vacuum error": {
      vacuumInto: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    },
    "not enough free space": { freeBytes: () => 0 },
    "backup fails integrity_check": {
      vacuumInto: (_source, destination) => writeFileSync(destination, "not a database"),
    },
  };
  for (const [label, hooks] of Object.entries(failures)) {
    const base = scratch(t);
    const installed = install(base, pin.commit, FAKE_OLD);
    const identityHash = sha256(installed.identityPath);
    const databaseHash = sha256(installed.databasePath);
    const layout = new CairnDataLayout(installed.root, {
      acceptedCommits: [pin.commit, FAKE_OLD],
      backupHooks: { now: clock(), ...hooks },
    });
    assert.throws(
      () => layout.agentDbPath(installed.meta.agentId),
      (error) => error.code === "STORAGE_BUSY" && error.retryable === true,
      label,
    );
    const application = startApplication(t, layout);
    const outcome = await application.execute("memory_inspect", { scope: "personal", limit: 12 }, installed.meta.actor);
    assert.equal(outcome.ok, false, label);
    assert.equal(outcome.error.code, "STORAGE_BUSY", label);
    assert.equal(sha256(installed.identityPath), identityHash, label);
    assert.equal(sha256(installed.databasePath), databaseHash, label);
    assert.deepEqual(completeBackups(installed.backupsDir), [], label);
    assertNoTemporaryFiles(installed);
  }
});

test("a database that cannot be backed up for real is reported as STORAGE_BUSY", (t) => {
  const base = scratch(t);
  const installed = install(base, pin.commit, FAKE_OLD);
  writeFileSync(installed.databasePath, Buffer.alloc(4096, 7));
  const databaseHash = sha256(installed.databasePath);
  const identityHash = sha256(installed.identityPath);
  const layout = new CairnDataLayout(installed.root, {
    acceptedCommits: [pin.commit, FAKE_OLD],
    backupHooks: { now: clock() },
  });
  assert.throws(
    () => layout.agentDbPath(installed.meta.agentId),
    (error) => error.code === "STORAGE_BUSY",
  );
  assert.equal(sha256(installed.databasePath), databaseHash);
  assert.equal(sha256(installed.identityPath), identityHash);
  assertNoTemporaryFiles(installed);
});

test("only the most recent two backups are kept per agent", (t) => {
  const base = scratch(t);
  const installed = install(base, pin.commit, FAKE_OLD);
  const now = clock();
  const layout = new CairnDataLayout(installed.root, {
    acceptedCommits: [pin.commit, FAKE_OLD],
    backupHooks: { now },
  });
  mkdirSync(join(installed.backupsDir, ".partial-stale"), { recursive: true });
  const seen = [];
  for (let round = 0; round < 4; round += 1) {
    const stored = JSON.parse(readFileSync(installed.identityPath, "utf8"));
    stored.cairnCommit = FAKE_OLD;
    writeFileSync(installed.identityPath, JSON.stringify(stored));
    layout.agentDbPath(installed.meta.agentId);
    seen.push(completeBackups(installed.backupsDir));
  }
  assert.equal(KEEP_BACKUPS, 2);
  assert.deepEqual(seen.map((names) => names.length), [1, 2, 2, 2]);
  const kept = completeBackups(installed.backupsDir);
  assert.match(kept[0], /^20260930T010002000Z-from-aaaaaaaa$/);
  assert.match(kept[1], /^20260930T010003000Z-from-aaaaaaaa$/);
  for (const name of kept) {
    assert.deepEqual(integrityOf(join(installed.backupsDir, name, "memory.sqlite")), ["ok"]);
  }
  assert.equal(existsSync(join(installed.backupsDir, ".partial-stale")), false);
});

test("after the upgrade the old exact-match logic refuses the database", (t) => {
  const base = scratch(t);
  const installed = install(base, pin.commit, FAKE_OLD);
  new CairnDataLayout(installed.root, {
    acceptedCommits: [pin.commit, FAKE_OLD],
    backupHooks: { now: clock() },
  }).agentDbPath(installed.meta.agentId);

  const stored = JSON.parse(readFileSync(installed.identityPath, "utf8"));
  assert.notEqual(stored.cairnCommit, FAKE_OLD);
  const previousPlugin = new CairnDataLayout(installed.root, {
    currentCommit: FAKE_OLD,
    acceptedCommits: [FAKE_OLD],
  });
  assert.throws(
    () => previousPlugin.agentDbPath(installed.meta.agentId),
    (error) => error.code === "STORAGE_UNSUPPORTED",
  );
});

test("an accepted commit with no database file only rewrites identity", (t) => {
  const base = scratch(t);
  const installed = install(base, pin.commit, FAKE_OLD);
  rmSync(installed.databasePath);
  new CairnDataLayout(installed.root, {
    acceptedCommits: [pin.commit, FAKE_OLD],
    backupHooks: { now: clock() },
  }).agentDbPath(installed.meta.agentId);
  assert.equal(JSON.parse(readFileSync(installed.identityPath, "utf8")).cairnCommit, pin.commit);
  assert.deepEqual(completeBackups(installed.backupsDir), []);
});

test("an unusable Cairn pin fails closed as DEPENDENCY_INCOMPATIBLE", (t) => {
  const base = scratch(t);
  const root = join(base, "memory-cairn-v1");
  const cases = {
    missing: undefined,
    "accepted lacks commit": { commit: pin.commit, accepted: [FAKE_OLD] },
    "accepted not an array": { commit: pin.commit, accepted: "nope" },
    "commit malformed": { commit: "abc", accepted: ["abc"] },
  };
  for (const [label, content] of Object.entries(cases)) {
    const pinPath = join(base, `${label.replaceAll(" ", "-")}.json`);
    if (content !== undefined) writeFileSync(pinPath, JSON.stringify(content));
    assert.throws(
      () => new CairnDataLayout(root, { pinPath }),
      (error) => error.code === "DEPENDENCY_INCOMPATIBLE",
      label,
    );
  }
});
