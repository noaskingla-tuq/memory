import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { AgentIndex } from "../out/application/ui/agentIndex.js";
import { createClock } from "../out/application/ui/timeSlice.js";
import { PIN_PATH } from "./backendHarness.mjs";
import { agentHashOf, daysAgo, seed, startStore } from "./uiHarness.mjs";

function countingLayout(dataRoot) {
  const layout = new CairnDataLayout(dataRoot, { pinPath: PIN_PATH });
  const calls = { names: 0, inspected: 0 };
  return {
    calls,
    port: {
      listAgentDirectories: () => layout.listAgentDirectories(),
      agentDirectoryNames: () => {
        calls.names += 1;
        return layout.agentDirectoryNames();
      },
      inspectAgentDirectory: (hash) => {
        calls.inspected += 1;
        return layout.inspectAgentDirectory(hash);
      },
      agentsFingerprint: () => layout.agentsFingerprint(),
    },
  };
}

async function build(t) {
  const store = startStore(t);
  const rows = ["idx/one", "idx/two", "idx/three"].map((agentId, index) => ({ agentId, projectId: null, content: `memory of ${agentId}`, updatedAt: daysAgo(index) }));
  await seed(store, rows);
  return store;
}

test("the directory list is built once and reused until agents/ changes or a write touches an unknown agent", async (t) => {
  const store = await build(t);
  const { calls, port } = countingLayout(store.dataRoot);
  const index = new AgentIndex(port);
  const first = await index.snapshot(createClock());
  assert.equal(first.agents.length, 3);
  assert.equal(calls.names, 1);
  assert.equal(calls.inspected, 3);
  await index.snapshot(createClock());
  await index.snapshot(createClock());
  assert.equal(calls.names, 1, "unchanged agents/ means no new walk");
  index.markDirty("idx/one");
  await index.snapshot(createClock());
  assert.equal(calls.names, 1, "a write to a known ready agent keeps the list");
  const written = await store.backend.call("memory.remember@1", {
    actor: { agentId: "idx/new", projectId: null, sessionId: "n", providerId: "claude" },
    ops: [{ scope: "personal", content: "the first memory of a new agent", kind: "fact", operationId: "new-1" }],
  });
  assert.equal(written.results[0].ok, true);
  index.markDirty("idx/new");
  const after = await index.snapshot(createClock());
  assert.equal(after.agents.length, 4, "the new agent is listed");
  assert.equal(calls.names, 2);
});

test("a new agent directory changes the fingerprint even when nobody reports the write", async (t) => {
  const store = await build(t);
  const { calls, port } = countingLayout(store.dataRoot);
  const index = new AgentIndex(port);
  await index.snapshot(createClock());
  const before = port.agentsFingerprint();
  await new Promise((resolve) => setTimeout(resolve, 20));
  mkdirSync(join(store.dataRoot, "agents", agentHashOf("idx/silent")));
  assert.notEqual(port.agentsFingerprint(), before);
  const snapshot = await index.snapshot(createClock());
  assert.equal(calls.names, 2, "the changed fingerprint forces a new walk");
  assert.equal(snapshot.agents.length, 3, "a directory with no database is not an agent");
});

test("lookup finds an agent by its id, misses an unknown or renamed one, and never lists more than it must", async (t) => {
  const store = await build(t);
  const { calls, port } = countingLayout(store.dataRoot);
  const index = new AgentIndex(port);
  const found = index.lookup("idx/two");
  assert.equal(found.kind, "found");
  assert.equal(found.indexed.agent.agentId, "idx/two");
  assert.equal(found.indexed.agent.total, 1);
  assert.equal(found.indexed.latest.head, "memory of idx/two");
  assert.deepEqual(index.lookup("idx/none"), { kind: "missing" });
  assert.equal(calls.names, 0, "a lookup inspects one directory and never walks all of them");
  assert.equal(calls.inspected, 2);
});

test("the version of an entry changes when its agent is written or its file changes, and only then", async (t) => {
  const store = await build(t);
  const { port } = countingLayout(store.dataRoot);
  const index = new AgentIndex(port);
  const versionOf = (agentId) => index.lookup(agentId).indexed.version;
  const one = versionOf("idx/one");
  assert.equal(versionOf("idx/one"), one);
  assert.equal(versionOf("idx/two") === one, false);
  index.markDirty("idx/one");
  assert.notEqual(versionOf("idx/one"), one);
});

test("warmIndex builds the index in the background, is safe to call twice and to dispose while it runs", async (t) => {
  const store = startStore(t);
  const rows = Array.from({ length: 30 }, (_, index) => ({ agentId: `warm/agent-${index}`, projectId: null, content: `warm memory ${index}`, updatedAt: daysAgo(index % 5) }));
  await seed(store, rows);
  const restarted = store.open();
  const warming = restarted.warmIndex();
  assert.equal(restarted.warmIndex(), warming, "one warm-up per backend");
  await warming;
  const overview = await restarted.call("ui.overview", { tzOffsetMin: 0, dayStartIso: daysAgo(0, 0), limit: 200 });
  assert.equal(overview.agents.length, 30);
  const interrupted = store.open();
  const pending = interrupted.warmIndex();
  await interrupted.dispose();
  await pending;
  await assert.rejects(interrupted.call("ui.status", {}), (error) => error.code === "internal");
});

test("warming a store that cannot be opened does nothing and never rejects", async (t) => {
  const store = startStore(t);
  const broken = store.open({ dataRoot: join(store.base, "no", "such", "\0root") });
  await broken.warmIndex();
});
