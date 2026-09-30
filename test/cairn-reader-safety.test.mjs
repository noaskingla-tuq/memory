import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listAgents } from "../out/adapters/ui/agentCatalog.js";
import { readCairn } from "../out/adapters/ui/cairnReader.js";
import { agentHashOf, installFixture, openStore, scratchDirectory } from "./readerHarness.mjs";

const CRASHING_WRITER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA cache_size = 16");
db.exec("BEGIN IMMEDIATE");
db.exec("CREATE TABLE scratch(v TEXT)");
const insert = db.prepare("INSERT INTO scratch(v) VALUES (?)");
for (let i = 0; i < 20000; i += 1) insert.run("x".repeat(500));
process.kill(process.pid, "SIGKILL");
`;

test("a hot journal left by a crashed writer is recovered and read, where a readOnly open would refuse", async (t) => {
  const base = scratchDirectory(t, "hot");
  const { databasePath } = installFixture(base);
  const untouchedSize = statSync(databasePath).size;
  spawnSync(process.execPath, ["-e", CRASHING_WRITER, databasePath], { stdio: "ignore" });
  const journal = `${databasePath}-journal`;
  assert.equal(existsSync(journal) && statSync(journal).size > 0, true, "the crashed writer left a non-empty journal");
  assert.ok(statSync(databasePath).size > untouchedSize, "the crash also left the database file half written");

  const readOnly = new DatabaseSync(databasePath, { readOnly: true });
  assert.throws(() => readOnly.prepare("SELECT count(*) AS n FROM memories").get(), /readonly|read-only/i);
  readOnly.close();
  assert.equal(existsSync(journal), true, "the refused readOnly open did not recover anything");

  const read = readCairn(databasePath, (reader) => reader.namespaces().map((row) => row.count));
  assert.deepEqual(read, { ok: true, value: [1, 1] });
  assert.equal(existsSync(journal), false, "the read-write open rolled the journal back");
  const check = new DatabaseSync(databasePath);
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE name = 'scratch'").all(), [], "the half written table is gone");
  check.close();
});

test("a junction as the agent directory is refused by the layout, the catalog and the reader", async (t) => {
  const base = scratchDirectory(t, "junction");
  const real = installFixture(base);
  const { layout, root } = openStore(base, t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  cpSync(real.databasePath, join(outside, "memory.sqlite"));
  const linkedHash = agentHashOf("linked-agent");
  const link = join(root, "agents", linkedHash);
  symlinkSync(outside, link, "junction");

  const entries = layout.listAgentDirectories();
  assert.deepEqual(
    entries.map(({ agentHash, state, databasePath }) => ({ agentHash, state, hasPath: databasePath !== null })).sort((a, b) => a.agentHash.localeCompare(b.agentHash)),
    [
      { agentHash: agentHashOf("fixture-agent"), state: "ready", hasPath: true },
      { agentHash: linkedHash, state: "unsafe", hasPath: false },
    ].sort((a, b) => a.agentHash.localeCompare(b.agentHash)),
  );
  const catalog = listAgents(layout);
  assert.deepEqual(catalog.agents.map((agent) => agent.agentId), ["fixture-agent"]);
  assert.deepEqual(catalog.unavailable, [{ agentHash: linkedHash, reason: "unsafe_path" }]);
  assert.deepEqual(readCairn(join(link, "memory.sqlite"), () => 1), { ok: false, code: "unsafe_path" });
});

test("a symbolic link as the database file is refused by the layout, the catalog and the reader", async (t) => {
  const base = scratchDirectory(t, "symlink");
  const real = installFixture(base);
  const { layout, root } = openStore(base, t);
  const outside = join(base, "outside.sqlite");
  cpSync(real.databasePath, outside);
  const linkedHash = agentHashOf("linked-file-agent");
  const agentRoot = join(root, "agents", linkedHash);
  mkdirSync(agentRoot);
  const link = join(agentRoot, "memory.sqlite");
  try {
    symlinkSync(outside, link, "file");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("creating a file symbolic link needs a privilege this account lacks");
    throw error;
  }
  const entry = layout.listAgentDirectories().find((item) => item.agentHash === linkedHash);
  assert.deepEqual(entry, { agentHash: linkedHash, databasePath: null, state: "unsafe" });
  assert.deepEqual(listAgents(layout).unavailable, [{ agentHash: linkedHash, reason: "unsafe_path" }]);
  assert.deepEqual(readCairn(link, () => 1), { ok: false, code: "unsafe_path" });
});

test("a symbolic link as a journal sidecar is refused by the reader", async (t) => {
  const base = scratchDirectory(t, "sidecar");
  const { databasePath } = installFixture(base);
  const decoy = join(base, "decoy-journal");
  cpSync(databasePath, decoy);
  try {
    symlinkSync(decoy, `${databasePath}-journal`, "file");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("creating a file symbolic link needs a privilege this account lacks");
    throw error;
  }
  assert.deepEqual(readCairn(databasePath, () => 1), { ok: false, code: "unsafe_path" });
});
