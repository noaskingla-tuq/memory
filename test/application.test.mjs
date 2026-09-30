import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { createCairnModelAdapter } from "../out/adapters/model/cairnModelAdapter.js";
import { CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";
import { MEMORY_TOOL_CONTRACT } from "../out/application/toolContract.js";
import { MemoryServiceError } from "../out/domain/errors.js";

const binding = {
  sessionId: "session-a",
  agentId: "agent-a",
  projectId: "project-a",
  providerId: "codex",
};

test("all tool schemas reject caller-controlled identity and storage fields", () => {
  for (const contract of Object.values(MEMORY_TOOL_CONTRACT)) {
    const parsed = contract.schema.safeParse({
      ownerId: "forged",
      projectId: "forged",
      dbPath: "forged",
      cwd: "forged",
      agent_ref: "forged",
    });
    assert.equal(parsed.success, false);
  }
});

test("capture schema matches Cairn message and aggregate bounds", () => {
  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(index === 23 ? 841 : 833),
  }));
  assert.equal(
    messages.reduce((sum, message) => sum + message.content.length, 0),
    20_000,
  );
  assert.equal(
    MEMORY_TOOL_CONTRACT.memory_capture.schema.safeParse({
      scope: "personal",
      operationId: "capture-limits",
      messages,
    }).success,
    true,
  );
  const invalid = [
    [...messages, { id: "message-24", role: "user", content: "x" }],
    [{ id: "too-long", role: "user", content: "x".repeat(4_001) }],
    [
      { id: "duplicate", role: "user", content: "a" },
      { id: "duplicate", role: "assistant", content: "b" },
    ],
    Array.from({ length: 6 }, (_, index) => ({
      id: `large-${index}`,
      role: "user",
      content: "x".repeat(3_500),
    })),
  ];
  for (const value of invalid) {
    assert.equal(
      MEMORY_TOOL_CONTRACT.memory_capture.schema.safeParse({
        scope: "personal",
        operationId: "capture-invalid",
        messages: value,
      }).success,
      false,
    );
  }
});

test("project recall invokes the core once with personal then project namespaces", async () => {
  const calls = [];
  const core = {
    recall: async (input) => {
      calls.push(input);
      return {
        ok: false,
        error: { code: "model_not_configured", retryable: false },
      };
    },
  };
  const pool = {
    withCore: async (_agentId, work) => work(core),
    close: async () => undefined,
  };
  const application = new MemoryApplication(pool);
  const result = await application.execute(
    "memory_recall",
    { query: "deployment", limit: 4 },
    binding,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MODEL_NOT_CONFIGURED");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].readSet, [
    { ownerId: "agent-a", scope: "personal", projectId: null },
    { ownerId: "agent-a", scope: "project", projectId: "project-a" },
  ]);
});

test("one Cairn database per agent isolates personal and project namespaces", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-test-"));
  const root = join(base, "memory-cairn-v1");
  const layout = new CairnDataLayout(root);
  const pool = new CoreHandlePool({ layout, openCore: openCairnCore });
  const application = new MemoryApplication(pool);
  t.after(async () => {
    await application.close();
    rmSync(base, { recursive: true, force: true });
  });

  const personal = await application.execute(
    "memory_remember",
    {
      scope: "personal",
      content: "Prefer concise answers.",
      kind: "preference",
      operationId: "personal-1",
    },
    binding,
  );
  const project = await application.execute(
    "memory_remember",
    {
      scope: "project",
      content: "Deploy through the release gate.",
      kind: "instruction",
      operationId: "project-1",
    },
    binding,
  );
  assert.equal(personal.ok, true, JSON.stringify(personal));
  assert.equal(project.ok, true, JSON.stringify(project));

  const personalPage = await application.execute(
    "memory_inspect",
    { scope: "personal", limit: 12 },
    binding,
  );
  const projectPage = await application.execute(
    "memory_inspect",
    { scope: "project", limit: 12 },
    binding,
  );
  assert.equal(personalPage.ok, true, JSON.stringify(personalPage));
  assert.equal(projectPage.ok, true, JSON.stringify(projectPage));
  assert.equal(personalPage.value.memories.length, 1);
  assert.equal(projectPage.value.memories.length, 1);
  assert.notEqual(
    personalPage.value.memories[0].id,
    projectPage.value.memories[0].id,
  );
  const personalDetail = await application.execute(
    "memory_inspect",
    {
      scope: "personal",
      memoryId: personalPage.value.memories[0].id,
    },
    binding,
  );
  const projectDetail = await application.execute(
    "memory_inspect",
    {
      scope: "project",
      memoryId: projectPage.value.memories[0].id,
    },
    binding,
  );
  assert.equal(personalDetail.value.memory.content, "Prefer concise answers.");
  assert.equal(
    projectDetail.value.memory.content,
    "Deploy through the release gate.",
  );
  assert.equal(pool.openHandles, 1);
});

test("data layout rejects redirected ancestors and unsafe agent files", (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-layout-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const tryLink = (target, path, type) => {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return false;
      throw error;
    }
  };

  const ancestorTarget = join(base, "ancestor-target");
  const ancestorLink = join(base, "ancestor-link");
  mkdirSync(ancestorTarget);
  if (tryLink(ancestorTarget, ancestorLink, linkType)) {
    assert.throws(
      () => new CairnDataLayout(join(ancestorLink, "memory-cairn-v1")),
      (error) => error.code === "STORAGE_UNSAFE",
    );
  } else {
    t.diagnostic("directory symlink fixture unavailable on this platform");
  }

  const identityRoot = join(base, "identity", "memory-cairn-v1");
  const identityLayout = new CairnDataLayout(identityRoot);
  const agentHash = createHash("sha256").update("unsafe-agent").digest("hex");
  const identityAgentRoot = join(identityRoot, "agents", agentHash);
  mkdirSync(join(identityAgentRoot, "identity.json"), { recursive: true });
  assert.throws(
    () => identityLayout.agentDbPath("unsafe-agent"),
    (error) => error.code === "STORAGE_UNSAFE",
  );

  const databaseRoot = join(base, "database", "memory-cairn-v1");
  const databaseLayout = new CairnDataLayout(databaseRoot);
  const databasePath = databaseLayout.agentDbPath("unsafe-database-agent");
  mkdirSync(databasePath);
  assert.throws(
    () => databaseLayout.agentDbPath("unsafe-database-agent"),
    (error) => error.code === "STORAGE_UNSAFE",
  );

  const linkedAgentRoot = join(base, "agent-link", "memory-cairn-v1");
  const linkedAgentLayout = new CairnDataLayout(linkedAgentRoot);
  const linkedAgentHash = createHash("sha256")
    .update("linked-agent")
    .digest("hex");
  const externalAgent = join(base, "external-agent");
  mkdirSync(externalAgent);
  if (
    tryLink(
      externalAgent,
      join(linkedAgentRoot, "agents", linkedAgentHash),
      linkType,
    )
  ) {
    assert.throws(
      () => linkedAgentLayout.agentDbPath("linked-agent"),
      (error) => error.code === "STORAGE_UNSAFE",
    );
  }

  const fileLinkRoot = join(base, "file-link", "memory-cairn-v1");
  const fileLinkLayout = new CairnDataLayout(fileLinkRoot);
  const fileDatabase = fileLinkLayout.agentDbPath("file-link-agent");
  const externalFile = join(base, "external.sqlite");
  writeFileSync(externalFile, "not a database");
  if (tryLink(externalFile, fileDatabase, "file")) {
    assert.throws(
      () => fileLinkLayout.agentDbPath("file-link-agent"),
      (error) => error.code === "STORAGE_UNSAFE",
    );
  } else {
    t.diagnostic("file symlink fixture unavailable on this platform");
  }
});

test("Cairn wrapper preserves stable model policy failures", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-model-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  for (const expected of ["MODEL_POLICY_DENIED", "MODEL_NOT_CONFIGURED"]) {
    const layout = new CairnDataLayout(join(base, expected, "memory-cairn-v1"));
    const port = {
      resolvePolicy: () => ({
        providerId: "synthetic",
        modelId: "synthetic",
        contextWindow: 8192,
        tokenizerId: "synthetic",
        revision: "1",
        enabled: true,
        allowedOperations:
          expected === "MODEL_POLICY_DENIED"
            ? new Set()
            : new Set(["select", "rank"]),
      }),
      countTokens: () => 1,
      invoke: async () => {
        throw new MemoryServiceError(
          "MODEL_NOT_CONFIGURED",
          "Synthetic model is unavailable",
        );
      },
    };
    const pool = new CoreHandlePool({
      layout,
      openCore: (path) =>
        openCairnCore(path, { agentId: binding.agentId, port }),
    });
    const application = new MemoryApplication(pool);
    const result = await application.execute(
      "memory_recall",
      { query: "release" },
      binding,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, expected);
    await application.close();
  }
});

test("Cairn model adapter exposes callbacks without provider client or key", async () => {
  const calls = [];
  const port = {
    apiKey: "must-not-cross",
    providerClient: { secret: true },
    resolvePolicy: () => ({
      providerId: "synthetic",
      modelId: "synthetic",
      contextWindow: 8192,
      tokenizerId: "synthetic",
      revision: "1",
      enabled: true,
      allowedOperations: new Set(["select"]),
    }),
    countTokens: (_policy, text) => text.length,
    invoke: async (input) => {
      calls.push(input);
      return { selected: [] };
    },
  };
  const adapter = createCairnModelAdapter("agent-a", port);
  assert.equal("apiKey" in adapter, false);
  assert.equal("providerClient" in adapter, false);
  assert.equal(adapter.countTokens("abc"), 3);
  await adapter.select({
    system: "s",
    input: {},
    maxOutputTokens: 1024,
    signal: new AbortController().signal,
  });
  assert.equal(calls[0].agentId, "agent-a");
  assert.equal(calls[0].operation, "select");
  await assert.rejects(
    adapter.rank({}),
    (error) => error.code === "MODEL_POLICY_DENIED",
  );
});

test("valid capture reaches model-not-configured instead of input rejection", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-capture-test-"));
  const layout = new CairnDataLayout(join(base, "memory-cairn-v1"));
  const pool = new CoreHandlePool({ layout, openCore: openCairnCore });
  const application = new MemoryApplication(pool);
  t.after(async () => {
    await application.close();
    rmSync(base, { recursive: true, force: true });
  });
  const result = await application.execute(
    "memory_capture",
    {
      scope: "personal",
      operationId: "capture-valid",
      messages: [{ id: "message-1", role: "user", content: "Remember the release gate." }],
    },
    binding,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MODEL_NOT_CONFIGURED");
});
