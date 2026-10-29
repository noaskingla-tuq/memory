import assert from "node:assert/strict";
import test from "node:test";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { createCairnModelAdapter } from "../out/adapters/model/cairnModelAdapter.js";
import { currentMemoryInvocation } from "../out/application/modelInvocationScope.js";

test("MemoryApplication carries each capture's original source pair and operation through the async Cairn adapter scope", async () => {
  const seen = [];
  const policy = {
    providerId: "mock", modelId: "allowed", contextWindow: 32768, tokenizerId: "bytes", revision: "test",
    enabled: true, allowedOperations: new Set(["extract"]),
  };
  const port = {
    resolvePolicy: () => policy,
    countTokens: (_policy, text) => Buffer.byteLength(text, "utf8"),
    async invoke(input) {
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(input.invocation);
      return { items: [] };
    },
  };
  const pool = new CoreHandlePool({
    layout: { agentDbPath: (agentId) => agentId },
    openCore: () => { throw new Error("per-agent core expected"); },
    openAgentCore: (_path, agentId) => ({
      async capture(request) {
        const adapter = createCairnModelAdapter(agentId, port);
        const modelRequest = { system: "extract schema", input: { messages: request.messages }, maxOutputTokens: 1024, signal: new AbortController().signal };
        await adapter.extract(modelRequest);
        await adapter.extract(modelRequest);
        return { ok: true, value: { processing: false } };
      },
      close() {},
    }),
  });
  const application = new MemoryApplication(pool);
  const inputFor = (operationId) => ({
    scope: "project",
    operationId,
    messages: [{ id: "message", role: "user", content: "synthetic fixture" }],
  });
  const actorA = { agentId: "sw/a", projectId: "source-project-1", sessionId: "session", providerId: "mock" };
  const actorB = { ...actorA, projectId: "source-project-2" };
  const [resultA, resultB] = await Promise.all([
    application.execute("memory_capture", inputFor("organize:source-1"), actorA),
    application.execute("memory_capture", inputFor("organize:source-2"), actorB),
  ]);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((context) => [context.canonicalAgentId, context.sourceProjectId, context.operationId, context.modelOperation, context.sameRequestOccurrence]), [
    ["sw/a", "source-project-1", "organize:source-1", "extract", 0],
    ["sw/a", "source-project-1", "organize:source-1", "extract", 1],
    ["sw/a", "source-project-2", "organize:source-2", "extract", 0],
    ["sw/a", "source-project-2", "organize:source-2", "extract", 1],
  ]);
  assert.ok(seen.every((context) => /^[a-f0-9]{64}$/u.test(context.operationSystemSha256) && /^[a-f0-9]{64}$/u.test(context.canonicalRequestSha256)));
  await application.close();
});

test("MemoryApplication carries the local-only recovery policy into the model invocation", async () => {
  const actor = { agentId: "sw/a", projectId: "source-project", sessionId: "session", providerId: "mock" };
  const pool = new CoreHandlePool({
    layout: { agentDbPath: (agentId) => agentId },
    openCore: () => { throw new Error("per-agent core expected"); },
    openAgentCore: () => ({
      async capture(request) {
        const invocation = currentMemoryInvocation("extract", "synthetic schema", { messages: request.messages });
        return { ok: true, value: { allowModelSend: invocation?.allowModelSend } };
      },
      close() {},
    }),
  });
  const application = new MemoryApplication(pool);
  const result = await application.execute("memory_capture", {
    scope: "project", operationId: "organize:local-recovery", messages: [{ id: "source", role: "user", content: "synthetic" }],
  }, actor, undefined, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { allowModelSend: false });
  await application.close();
});
