import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_METHOD_NAMES } from "../out/contracts/uiContract.js";
import { callInspect, callRemember, op, REPO_ROOT, startBackend } from "./backendHarness.mjs";

const template = JSON.parse(readFileSync(join(REPO_ROOT, "plugin", "manifest.template.json"), "utf8"));

test("the manifest template lists exactly the ui.* methods of the contract and no memory.* method", () => {
  assert.deepEqual(template.backendMethods, [...UI_METHOD_NAMES]);
  assert.equal(template.backendMethods.some((method) => !method.startsWith("ui.")), false);
  assert.deepEqual(template.permissions, ["ui:view", "backend:invoke", "agent:avatar-read", "work-records:read", "agent-directory:read", "project-directory:read", "plugin-state:read", "data:legacy-migrate", "settings:plugin", "ai:chat", "program:data:projects:write", "program:data:tasks:write"]);
  assert.equal(template.resources.maxSessions, 4);
});

test("ui.status reports real data that survives a JSON round trip", async (t) => {
  const { backend } = startBackend(t);
  const empty = await backend.call("ui.status", {});
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
  assert.equal(empty.ok, true);
  assert.equal("stub" in empty, false);
  assert.equal(empty.version, JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version);
  assert.equal(empty.cairnCommit, JSON.parse(readFileSync(join(REPO_ROOT, "cairn-pin.json"), "utf8")).commit);
  assert.equal(empty.storage.status, "ready");
  assert.equal(typeof empty.uptimeSec, "number");
  assert.equal(empty.lastWriteAt, null, "nothing was written yet");
  assert.deepEqual(empty.profile, {
    generation: null,
    receivedAt: null,
    agents: 0,
    projects: 0,
    teams: 0,
    incomplete: false,
    corrupt: false,
    omitted: { agents: 0, teams: 0, projects: 0 },
    sink: null,
    sinkReceivedAt: null,
  });
  const written = await callRemember(backend, [op("Something the status must notice.", "op-status-1")]);
  assert.equal(written.results[0].ok, true);
  const after = await backend.call("ui.status", {});
  assert.match(after.lastWriteAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(after.lastWriteAt) - Date.now()) < 60_000);
});

test("every ui.* method rejects a wrong or missing parameter with INVALID_PARAMS and never throws", async (t) => {
  const { backend } = startBackend(t);
  const invalid = {
    "ui.overview": [{}, { tzOffsetMin: 0 }, { tzOffsetMin: 0, dayStartIso: "2026-09-30", limit: 1 }],
    "ui.agentStats": [{}, { agentId: "a/b" }],
    "ui.list": [{ limit: 25 }, { scope: "personal", projectId: "p" }, { extra: 1 }],
    "ui.search": [{}, { q: "" }, { q: "x".repeat(101) }],
    "ui.get": [{}, { agentId: "a/b", scope: "personal", projectId: "p", memoryId: "m" }],
    "ui.forget": [{}, { agentId: "a/b", scope: "personal", projectId: null, memoryId: "m" }],
    "ui.status": [{ extra: true }],
  };
  for (const [method, list] of Object.entries(invalid)) {
    for (const params of list) {
      assert.deepEqual(await backend.call(method, params), { ok: false, code: "INVALID_PARAMS", retryable: false }, `${method} ${JSON.stringify(params)}`);
    }
  }
});

test("on an empty store every read method answers ok with empty data or NOT_FOUND", async (t) => {
  const { backend } = startBackend(t);
  const overview = await backend.call("ui.overview", { tzOffsetMin: 480, dayStartIso: "2026-09-29T16:00:00.000Z" });
  assert.equal(overview.ok, true);
  assert.deepEqual(overview.tiles, { totalMemories: 0, writtenToday: 0, activeAgents7d: 0, agents: 0, lastWriteAt: null });
  assert.deepEqual(overview.agents, []);
  assert.equal(overview.nextCursor, null);
  assert.deepEqual(await backend.call("ui.list", {}), { ok: true, items: [], nextCursor: null });
  const search = await backend.call("ui.search", { q: "  ＡＢＣ   def " });
  assert.equal(search.ok, true);
  assert.equal(search.normalizedQuery, "ABC def");
  assert.equal(search.mode, "literal");
  const ref = { agentId: "no/one", scope: "personal", projectId: null, memoryId: "nothing" };
  assert.deepEqual(await backend.call("ui.get", ref), { ok: false, code: "NOT_FOUND", retryable: false });
  assert.deepEqual(await backend.call("ui.forget", { ...ref, expectedRevision: 1 }), { ok: false, code: "NOT_FOUND", retryable: false });
  assert.deepEqual(await backend.call("ui.agentStats", { agentId: "no/one", tzOffsetMin: 0 }), { ok: false, code: "NOT_FOUND", retryable: false });
});

test("ui.* methods need an object as params", async (t) => {
  const { backend } = startBackend(t);
  for (const params of [null, undefined, [], "x", 1]) {
    assert.deepEqual(await backend.call("ui.status", params), { ok: false, code: "INVALID_PARAMS", retryable: false });
  }
});

test("serving ui.* does not change the memory.* contract methods or unknown method names", async (t) => {
  const { backend } = startBackend(t);
  const written = await callRemember(backend, [op("A memory written next to the UI status call.", "op-ui-1")]);
  assert.equal(written.results[0].ok, true);
  await backend.call("ui.status", {});
  const page = await callInspect(backend, { scope: "personal", limit: 6 });
  assert.equal(page.result.value.memories.length, 1);
  for (const method of ["ui.", "ui.unknown", "UI.status", "ui.status@1", " ui.status"]) {
    await assert.rejects(backend.call(method, {}), (error) => error.code === "unknown_method", method);
  }
});
