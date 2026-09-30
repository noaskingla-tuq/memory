import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { listAgents } from "../out/adapters/ui/agentCatalog.js";
import { actorOf, agentHashOf, cairnListAll, databasePathOf, fillNamespace, installFixture, openStore, rawWrite, scratchDirectory } from "./readerHarness.mjs";

function treeOf(directory) {
  const found = [];
  const visit = (path, prefix) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      found.push(name);
      if (entry.isDirectory()) visit(join(path, entry.name), `${name}/`);
    }
  };
  visit(directory, "");
  return found.sort();
}

async function remember(app, actor, scope, content, id) {
  const result = await app.execute("memory_remember", { scope, kind: "fact", content, operationId: id }, actor);
  assert.equal(result.ok, true);
  return result.value.memory;
}

test("the catalog lists every agent with its namespaces and counts, and leaves out an agent whose memories are all forgotten", async (t) => {
  const base = scratchDirectory(t, "catalog");
  const { app, layout, root } = openStore(base, t);
  const dev = actorOf("sw/developer", "proj-a");
  const devB = actorOf("sw/developer", "proj-b");
  const reviewer = actorOf("sw/reviewer");
  const ghost = actorOf("ops/ghost");
  const halfEmpty = actorOf("ops/half", "proj-z");
  await fillNamespace(app, dev, "personal", 12, "d");
  await fillNamespace(app, dev, "project", 7, "da");
  await fillNamespace(app, devB, "project", 3, "db");
  await fillNamespace(app, reviewer, "personal", 4, "r");
  const doomed = await remember(app, ghost, "personal", "the only memory of ghost", "g-1");
  assert.equal((await app.execute("memory_forget", { scope: "personal", memoryId: doomed.id, expectedRevision: doomed.revision, operationId: "g-2" }, ghost)).ok, true);
  await remember(app, halfEmpty, "personal", "half keeps this personal memory", "h-1");
  const projectMemory = await remember(app, halfEmpty, "project", "half loses this project memory", "h-2");
  assert.equal((await app.execute("memory_forget", { scope: "project", memoryId: projectMemory.id, expectedRevision: projectMemory.revision, operationId: "h-3" }, halfEmpty)).ok, true);

  const before = treeOf(root);
  const catalog = listAgents(layout);
  assert.deepEqual(treeOf(root), before, "listing creates and rewrites nothing");
  assert.deepEqual(catalog.unavailable, []);
  assert.deepEqual(
    catalog.agents.map((agent) => agent.agentId).sort(),
    ["ops/half", "sw/developer", "sw/reviewer"],
    "the agent with 0 memories is excluded",
  );
  const byId = new Map(catalog.agents.map((agent) => [agent.agentId, agent]));
  for (const agent of catalog.agents) assert.equal(agent.agentHash, agentHashOf(agent.agentId));
  assert.deepEqual(byId.get("sw/developer").namespaces, [
    { scope: "personal", projectId: null, count: (await cairnListAll(app, dev, "personal", 12)).length },
    { scope: "project", projectId: "proj-a", count: (await cairnListAll(app, dev, "project", 12)).length },
    { scope: "project", projectId: "proj-b", count: (await cairnListAll(app, devB, "project", 12)).length },
  ]);
  assert.equal(byId.get("sw/developer").total, byId.get("sw/developer").namespaces.reduce((sum, row) => sum + row.count, 0));
  assert.deepEqual(byId.get("sw/reviewer").namespaces, [{ scope: "personal", projectId: null, count: (await cairnListAll(app, reviewer, "personal", 12)).length }]);
  assert.deepEqual(byId.get("ops/half").namespaces, [{ scope: "personal", projectId: null, count: 1 }], "a namespace with 0 memories is dropped from a live agent");
});

test("directories that are not agent databases never appear and never break the listing", async (t) => {
  const base = scratchDirectory(t, "strays");
  const real = installFixture(base);
  const { layout, root } = openStore(base, t);
  mkdirSync(join(root, "agents", "backups"));
  mkdirSync(join(root, "agents", "not-a-hash"));
  mkdirSync(join(root, "backups", agentHashOf("fixture-agent")), { recursive: true });
  cpSync(real.databasePath, join(root, "backups", agentHashOf("fixture-agent"), "memory.sqlite"));
  mkdirSync(join(root, "agents", agentHashOf("identity-only")));
  const entries = layout.listAgentDirectories();
  assert.deepEqual(entries.map((entry) => `${entry.state}`).sort(), ["no_database", "ready"]);
  const catalog = listAgents(layout);
  assert.deepEqual(catalog.agents.map((agent) => agent.agentId), ["fixture-agent"]);
  assert.deepEqual(catalog.unavailable, []);
});

test("a database under the wrong hash, with mixed owners or on another schema version is reported unavailable, not listed", async (t) => {
  const base = scratchDirectory(t, "broken");
  const real = installFixture(base);
  const { layout, root } = openStore(base, t);
  const wrongHash = agentHashOf("somebody-else");
  mkdirSync(join(root, "agents", wrongHash));
  cpSync(real.databasePath, join(root, "agents", wrongHash, "memory.sqlite"));

  const mixed = actorOf("mixed/agent");
  const { app } = openStore(base, t);
  await remember(app, mixed, "personal", "a memory of the mixed agent", "m-1");
  await app.close();
  rawWrite(databasePathOf(root, "mixed/agent"), (db) => db.exec("INSERT INTO namespace_epochs(owner_id, scope, project_id, epoch) VALUES ('intruder', 'personal', '', 2)"));

  const old = actorOf("old/schema");
  const second = openStore(base, t);
  await remember(second.app, old, "personal", "a memory of the old schema agent", "o-1");
  await second.app.close();
  rawWrite(databasePathOf(root, "old/schema"), (db) => db.exec("PRAGMA user_version = 12"));

  const catalog = listAgents(layout);
  assert.deepEqual(catalog.agents.map((agent) => agent.agentId), ["fixture-agent"]);
  assert.deepEqual(
    Object.fromEntries(catalog.unavailable.map((entry) => [entry.agentHash, entry.reason])),
    {
      [wrongHash]: "identity_mismatch",
      [agentHashOf("mixed/agent")]: "owner_conflict",
      [agentHashOf("old/schema")]: "unsupported_schema",
    },
  );
  assert.equal(existsSync(join(root, "agents", wrongHash, "identity.json")), false, "listing does not create an identity file");
});
