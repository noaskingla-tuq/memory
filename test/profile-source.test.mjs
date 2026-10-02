import assert from "node:assert/strict";
import test from "node:test";
import { readMemoryProfile } from "../out/application/profileSource.js";
import { refreshMemoryProfile } from "../out/application/profileRefresh.js";

const agent = (overrides = {}) => ({ id: "sw/developer", name: "開發工程師", teamKey: "sw", teamName: "軟體團隊", title: "Developer", enabled: true, ...overrides });
const project = (overrides = {}) => ({ id: "teamuq-electron", name: "TeamUQ", archived: false, ...overrides });

test("profile reads preserve canonical ids and team display names", async () => {
  const result = await readMemoryProfile({
    async readAgents() { return { generation: "agents-1", entries: [agent()] }; },
    async readProjects() { return { generation: "projects-1", entries: [project()] }; },
  });
  assert.equal(result.kind, "available");
  assert.deepEqual(result.sourceGenerations, { agents: "agents-1", projects: "projects-1" });
  assert.deepEqual(result.snapshot.teams, [{ key: "sw", name: "軟體團隊" }]);
  assert.equal(result.snapshot.agents[0].id, "sw/developer");
  assert.equal(result.snapshot.projects[0].id, "teamuq-electron");
});

test("directory read failure and empty agent registry never produce an empty replacement", async () => {
  const unavailable = await readMemoryProfile({ async readAgents() { throw new Error("offline"); }, async readProjects() { return { generation: "p", entries: [] }; } });
  const empty = await readMemoryProfile({ async readAgents() { return { generation: "a", entries: [] }; }, async readProjects() { return { generation: "p", entries: [project()] }; } });
  assert.deepEqual(unavailable, { kind: "unavailable", reason: "Error" });
  assert.deepEqual(empty, { kind: "unavailable", reason: "directory_empty" });
});

test("team label selection is deterministic when an inconsistent snapshot repeats a key", async () => {
  const result = await readMemoryProfile({
    async readAgents() { return { generation: "a", entries: [agent({ teamName: "Zulu" }), agent({ id: "other", teamName: "Alpha" })] }; },
    async readProjects() { return { generation: "p", entries: [] }; },
  });
  assert.equal(result.kind, "available");
  assert.deepEqual(result.snapshot.teams, [{ key: "sw", name: "Alpha" }]);
});

test("profile refresh leaves the current table untouched when a directory is unavailable", async () => {
  let writes = 0;
  const result = await refreshMemoryProfile({
    directory: { async readAgents() { throw new Error("offline"); }, async readProjects() { return { generation: "p", entries: [] }; } },
    sink: { accept() { writes += 1; return { accepted: true, generation: "unused", complete: true }; } },
  });
  assert.equal(result.kind, "unavailable");
  assert.equal(writes, 0);
});

test("profile refresh sends the full canonical snapshot through the plugin-owned sink", async () => {
  const calls = [];
  const result = await refreshMemoryProfile({
    directory: { async readAgents() { return { generation: "a", entries: [agent()] }; }, async readProjects() { return { generation: "p", entries: [project()] }; } },
    sink: { accept(request) { calls.push(request); return { accepted: true, generation: request.generation, complete: true }; } },
    sinkStatus: () => ({ pending: 2, lastWrittenAtMs: 1727581320000 }),
  });
  assert.equal(result.kind, "synced");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agents[0].id, "sw/developer");
  assert.equal(calls[0].teams[0].name, "軟體團隊");
  assert.equal(calls[0].projects[0].id, "teamuq-electron");
  assert.equal(calls[0].sink.pending, 2);
});
