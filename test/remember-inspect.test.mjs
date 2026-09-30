import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";

const actor = {
  agentId: "team-a/agent-a",
  projectId: "project-a",
  sessionId: "session-a",
  providerId: "codex",
};

function startApplication(t) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-remember-"));
  const layout = new CairnDataLayout(join(base, "memory-cairn-v1"));
  layout.preflight();
  const pool = new CoreHandlePool({ layout, openCore: openCairnCore });
  const application = new MemoryApplication(pool);
  t.after(async () => {
    await application.close();
    rmSync(base, { recursive: true, force: true });
  });
  return application;
}

const remember = (application, content, operationId, scope = "personal") =>
  application.execute(
    "memory_remember",
    { scope, content, kind: "context", operationId },
    actor,
  );

test("writing the same content again is deduplicated", async (t) => {
  const application = startApplication(t);
  const first = await remember(application, "Same content twice.", "op-a");
  const sameOperation = await remember(application, "Same content twice.", "op-a");
  const otherOperation = await remember(application, "Same content twice.", "op-b");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.deduplicated, false);
  assert.equal(sameOperation.value.deduplicated, true);
  assert.equal(otherOperation.value.deduplicated, true);
  assert.equal(sameOperation.value.memory.id, first.value.memory.id);
});

test("remember lands in the requested namespace and is readable with memory_inspect", async (t) => {
  const application = startApplication(t);
  const personal = await remember(application, "Personal working note for the agent.", "op-personal");
  const project = await remember(application, "Project working note for the agent.", "op-project", "project");
  assert.equal(personal.ok && project.ok, true, JSON.stringify([personal, project]));
  const personalPage = await application.execute("memory_inspect", { scope: "personal", limit: 12 }, actor);
  const projectPage = await application.execute("memory_inspect", { scope: "project", limit: 12 }, actor);
  assert.equal(personalPage.value.memories.length, 1);
  assert.equal(projectPage.value.memories.length, 1);
  assert.equal(personalPage.value.memories[0].id, personal.value.memory.id);
  assert.equal(projectPage.value.memories[0].id, project.value.memory.id);
});

test("project scope without a project id is rejected as PROJECT_UNBOUND", async (t) => {
  const application = startApplication(t);
  const outcome = await application.execute(
    "memory_remember",
    { scope: "project", content: "No project bound.", kind: "context", operationId: "op-x" },
    { ...actor, projectId: null },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "PROJECT_UNBOUND");
});

test("forgotten content cannot be written back and reports MEMORY_SUPPRESSED", async (t) => {
  const application = startApplication(t);
  const written = await remember(application, "Forget me please.", "op-f");
  const { id, revision } = written.value.memory;
  const forgotten = await application.execute(
    "memory_forget",
    { scope: "personal", memoryId: id, expectedRevision: revision, operationId: "forget-1" },
    actor,
  );
  assert.equal(forgotten.ok, true, JSON.stringify(forgotten));
  const again = await remember(application, "Forget me please.", "op-f2");
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "MEMORY_SUPPRESSED");
});
