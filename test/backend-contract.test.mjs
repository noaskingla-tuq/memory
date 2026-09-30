import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { contractErrorCode, projectFailure } from "../out/backend/contractErrors.js";
import { MEMORY_ERROR_CODES as DOMAIN_ERROR_CODES } from "../out/domain/errors.js";
import {
  REPO_ROOT,
  actor,
  assertContractResponse,
  callInspect,
  callRemember,
  contract,
  op,
  rememberParams,
  startBackend,
} from "./backendHarness.mjs";

const FIXTURES = join(REPO_ROOT, "vendor", "teamuq-contract", "fixtures");
const lock = JSON.parse(readFileSync(join(REPO_ROOT, "vendor", "teamuq-contract", "lock.json"), "utf8"));

function readFixtures(kind) {
  return readdirSync(join(FIXTURES, kind))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURES, kind, name), "utf8")));
}

const requestFixtures = readFixtures("requests");
const responseFixtures = readFixtures("responses");
const CALL_ERROR_CODES = new Set(contract.MEMORY_CALL_ERROR_CODES);

test("every fixture the vendored lock lists is exercised", () => {
  const listed = (kind) => Object.keys(lock.files).filter((file) => file.startsWith(`fixtures/${kind}/`)).length;
  assert.equal(requestFixtures.length, listed("requests"));
  assert.equal(responseFixtures.length, listed("responses"));
  assert.ok(requestFixtures.length >= 12 && responseFixtures.length >= 15);
});

const PROFILE_SYNC = contract.MEMORY_PLUGIN_METHODS.profileSync;

for (const fixture of requestFixtures) {
  test(`request fixture ${fixture.case} is ${fixture.valid ? "accepted" : "rejected as invalid_params"}`, async (t) => {
    const { backend } = startBackend(t);
    if (fixture.method === PROFILE_SYNC) {
      assert.equal(contract.memoryProfileSyncRequestSchema.safeParse(fixture.params).success, fixture.valid);
      if (!fixture.valid) {
        await assert.rejects(backend.call(fixture.method, fixture.params), (error) => {
          assert.equal(error.code, "invalid_params");
          return true;
        });
        return;
      }
      const response = await backend.call(fixture.method, fixture.params);
      assert.equal(contract.memoryProfileSyncResponseSchema.safeParse(response).success, true, JSON.stringify(response));
      assert.equal(response.generation, fixture.params.generation);
      // why: a lone part of a several-part fixture is staged and cannot make the table effective, whatever its content
      assert.equal(response.complete, fixture.params.parts === 1);
      return;
    }
    if (!fixture.valid) {
      await assert.rejects(backend.call(fixture.method, fixture.params), (error) => {
        assert.equal(error.code, "invalid_params");
        assert.ok(CALL_ERROR_CODES.has(error.code));
        return true;
      });
      return;
    }
    const response = assertContractResponse(fixture.method, await backend.call(fixture.method, fixture.params));
    if (fixture.method === contract.MEMORY_PLUGIN_METHODS.remember) {
      assert.equal(response.results.length, fixture.params.ops.length);
      assert.ok(response.results.every((result) => result.ok), JSON.stringify(response));
    } else if (fixture.method === contract.MEMORY_PLUGIN_METHODS.inspect) {
      if (fixture.params.input.cursor === undefined) {
        assert.equal(response.result.ok, true, JSON.stringify(response));
      } else {
        // why: the fixture cursor is not one Cairn issued, so the call is well formed but the read is refused
        assert.equal(response.result.ok, false);
        assert.equal(response.result.error.code, "INVALID_INPUT");
        assert.equal(response.result.error.retryable, false);
      }
    } else {
      assert.equal(response.storage.status, "ready");
    }
  });
}

for (const fixture of responseFixtures) {
  test(`response fixture ${fixture.case} agrees with the vendored response schema`, () => {
    const schemas = {
      [contract.MEMORY_PLUGIN_METHODS.remember]: contract.memoryRememberResponseSchema,
      [contract.MEMORY_PLUGIN_METHODS.inspect]: contract.memoryInspectResponseSchema,
      [contract.MEMORY_PLUGIN_METHODS.diagnose]: contract.memoryDiagnoseResponseSchema,
      [PROFILE_SYNC]: contract.memoryProfileSyncResponseSchema,
    };
    const parsed = schemas[fixture.method].safeParse(fixture.response);
    assert.equal(parsed.success, fixture.accept);
    if (fixture.accept) assert.deepEqual(parsed.data, fixture.parsed);
  });
}

test("only the four contract methods are served; everything else is unknown_method", async (t) => {
  const { backend } = startBackend(t);
  const params = rememberParams([op("Never written.", "op-unreachable")]);
  const others = [
    "memory.recall@1",
    "memory.capture@1",
    "memory.correct@1",
    "memory.forget@1",
    "profile.sync",
    "memory.profile.sync",
    "memory.profile.sync@2",
    "memory_recall",
    "memory_capture",
    "memory_correct",
    "memory_forget",
    "memory_remember",
    "memory.remember@2",
    "memory.remember",
    "memory.inspect@0",
    "Diagnose",
    " diagnose",
    "",
    "constructor",
    "__proto__",
    "toString",
    "health",
    42,
    null,
    undefined,
  ];
  for (const method of others) {
    await assert.rejects(backend.call(method, params), (error) => {
      assert.equal(error.code, "unknown_method", String(method));
      return true;
    });
  }
  for (const method of contract.MEMORY_PLUGIN_METHOD_NAMES) {
    assert.equal(lock.methods.includes(method), true);
  }
  const page = await callInspect(backend, { scope: "personal", limit: 12 });
  assert.deepEqual(page.result.value.memories, []);
});

test("a request larger than sixteen operations is invalid_params and writes nothing", async (t) => {
  const { backend } = startBackend(t);
  const operations = Array.from({ length: 17 }, (_, index) => op(`Operation ${index} content.`, `op-${index}`));
  await assert.rejects(backend.call("memory.remember@1", rememberParams(operations)), { code: "invalid_params" });
  const page = await callInspect(backend, { scope: "personal", limit: 12 });
  assert.equal(page.result.value.memories.length, 0);
});

test("sixteen operations in one call all land, in order, with one result each", async (t) => {
  const { backend } = startBackend(t);
  const operations = Array.from({ length: 16 }, (_, index) => op(`Sixteen batch entry number ${index}.`, `op-${index}`));
  const response = await callRemember(backend, operations);
  assert.equal(response.results.length, 16);
  assert.ok(response.results.every((result) => result.ok && result.value.deduplicated === false));
  assert.equal(new Set(response.results.map((result) => result.value.memory.id)).size, 16);
});

test("actor shape is strict: extra, missing, empty and mistyped fields are invalid_params", async (t) => {
  const { backend } = startBackend(t);
  const operations = [op("Actor shape content.", "op-actor")];
  const bad = [
    { ...actor, extra: "x" },
    { ...actor, agentId: undefined },
    { ...actor, projectId: undefined },
    { ...actor, agentId: "" },
    { ...actor, sessionId: 5 },
    { ...actor, providerId: "p".repeat(201) },
    "actor",
    null,
  ];
  for (const candidate of bad) {
    await assert.rejects(backend.call("memory.remember@1", { actor: candidate, ops: operations }), { code: "invalid_params" });
    await assert.rejects(backend.call("memory.inspect@1", { actor: candidate, input: { scope: "personal" } }), { code: "invalid_params" });
  }
  const unbound = await callRemember(backend, [op("No project.", "op-null")], { projectId: null });
  assert.equal(unbound.results[0].ok, true);
});

test("project scope without a project id is a per-operation PROJECT_UNBOUND result", async (t) => {
  const { backend } = startBackend(t);
  const response = await callRemember(backend, [op("No project bound.", "op-p", "project"), op("Personal works.", "op-q")], {
    projectId: null,
  });
  assert.equal(response.results[0].ok, false);
  assert.equal(response.results[0].error.code, "PROJECT_UNBOUND");
  assert.equal(response.results[0].error.retryable, false);
  assert.equal(response.results[1].ok, true);
});

test("params outside the strict request schema are rejected without echoing content", async (t) => {
  const { backend } = startBackend(t);
  const secret = "S3CRET-CONTENT-DO-NOT-ECHO";
  const cases = [
    ["memory.remember@1", { actor, ops: [{ ...op(secret, "op-1"), kind: "note" }] }],
    ["memory.remember@1", { actor, ops: [op(secret, "op-1")], extra: true }],
    ["memory.remember@1", { actor, ops: [] }],
    ["memory.remember@1", { actor, ops: [op("x".repeat(4001), "op-1")] }],
    ["memory.remember@1", "not an object"],
    ["memory.inspect@1", { actor, input: { scope: "personal", limit: 13 } }],
    ["memory.inspect@1", { actor, input: { scope: "personal", limit: 0 } }],
    ["memory.inspect@1", { actor, input: { scope: "everyone" } }],
    ["memory.inspect@1", { actor, input: { scope: "personal", extra: secret } }],
    ["diagnose", undefined],
    ["diagnose", null],
    ["diagnose", { verbose: true }],
  ];
  for (const [method, params] of cases) {
    await assert.rejects(backend.call(method, params), (error) => {
      assert.equal(error.code, "invalid_params");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test("a remember result carries only the memory id and the deduplicated flag", async (t) => {
  const { backend } = startBackend(t);
  const response = await callRemember(backend, [op("Projection check content.", "op-projection")]);
  const [result] = response.results;
  assert.deepEqual(Object.keys(result).sort(), ["ok", "requestId", "value"]);
  assert.deepEqual(Object.keys(result.value).sort(), ["deduplicated", "memory"]);
  assert.deepEqual(Object.keys(result.value.memory), ["id"]);
});

test("writing the same content again reports deduplicated true", async (t) => {
  const { backend } = startBackend(t);
  const first = await callRemember(backend, [op("Same content, written twice.", "op-a")]);
  const sameOperation = await callRemember(backend, [op("Same content, written twice.", "op-a")]);
  const otherOperation = await callRemember(backend, [op("Same content, written twice.", "op-b")]);
  const inBatch = await callRemember(backend, [op("Batch twin.", "op-c"), op("Batch twin.", "op-d")]);
  assert.equal(first.results[0].value.deduplicated, false);
  assert.equal(sameOperation.results[0].value.deduplicated, true);
  assert.equal(otherOperation.results[0].value.deduplicated, true);
  assert.equal(sameOperation.results[0].value.memory.id, first.results[0].value.memory.id);
  assert.equal(inBatch.results[0].value.deduplicated, false);
  assert.equal(inBatch.results[1].value.deduplicated, true);
  assert.equal(inBatch.results[1].value.memory.id, inBatch.results[0].value.memory.id);
  const page = await callInspect(backend, { scope: "personal", limit: 12 });
  assert.equal(page.result.value.memories.length, 2);
});

test("remember then inspect reads the same memories back from real Cairn", async (t) => {
  const { backend } = startBackend(t);
  const written = await callRemember(backend, [
    op("任務完成：修正登入頁的表單驗證。", "op-1"),
    op("Second personal note.", "op-2"),
    op("Third personal note.", "op-3"),
    op("A project note.", "op-4", "project", "decision"),
  ]);
  const ids = written.results.map((result) => result.value.memory.id);

  const first = await callInspect(backend, { scope: "personal", limit: 2 });
  assert.equal(first.result.ok, true);
  assert.equal(first.result.value.memories.length, 2);
  assert.equal(first.appliedLimit, 2);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.nextCursor, first.result.value.nextCursor);
  const second = await callInspect(backend, { scope: "personal", limit: first.appliedLimit, cursor: first.nextCursor });
  assert.equal(second.result.value.memories.length, 1);
  assert.equal(second.nextCursor, undefined);
  const personal = [...first.result.value.memories, ...second.result.value.memories].map((memory) => memory.id).sort();
  assert.deepEqual(personal, [ids[0], ids[1], ids[2]].sort());

  const project = await callInspect(backend, { scope: "project" });
  assert.equal(project.appliedLimit, 6);
  assert.deepEqual(project.result.value.memories.map((memory) => memory.id), [ids[3]]);

  const detail = await callInspect(backend, { scope: "personal", memoryId: ids[0] });
  assert.equal(detail.result.ok, true);
  assert.equal(detail.result.value.memory.id, ids[0]);
  assert.equal(detail.result.value.receipts.length, 1);
  assert.equal(detail.nextCursor, undefined);

  const stranger = await callInspect(backend, { scope: "personal" }, { agentId: "team-a/agent-b" });
  assert.deepEqual(stranger.result.value.memories, []);
});

test("an inspect for an unknown memory is a per-call error result, not a call failure", async (t) => {
  const { backend } = startBackend(t);
  const missing = await callInspect(backend, { scope: "personal", memoryId: "no-such-memory" });
  assert.equal(missing.result.ok, false);
  assert.ok(contract.MEMORY_ERROR_CODES.includes(missing.result.error.code));
});

test("no removed error code can be produced: all collapse to INTERNAL", () => {
  const removed = ["CAPABILITY_MISSING", "CAPABILITY_INVALID", "CAPABILITY_PENDING", "CAPABILITY_REVOKED", "SESSION_BINDING_MISMATCH", "IDENTITY_UNBOUND"];
  for (const code of DOMAIN_ERROR_CODES) {
    const outcome = projectFailure({ ok: false, error: { code, message: `Memory operation failed: ${code}`, retryable: true, requestId: "r1" } });
    assert.ok(contract.MEMORY_ERROR_CODES.includes(outcome.error.code), code);
    if (removed.includes(code)) {
      assert.equal(outcome.error.code, "INTERNAL");
      assert.equal(outcome.error.retryable, false);
      assert.equal(outcome.error.message.includes(code), false);
    } else {
      assert.equal(outcome.error.code, code);
      assert.equal(outcome.error.retryable, contract.MEMORY_RETRYABLE_ERROR_CODES.includes(code));
    }
  }
  assert.equal(contractErrorCode("NOT_A_CODE"), "INTERNAL");
});

test("source never constructs a removed error code outside the two files that name them", () => {
  const removed = /CAPABILITY_|SESSION_BINDING_MISMATCH|IDENTITY_UNBOUND/;
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ts") && removed.test(readFileSync(path, "utf8"))) {
        found.push(path.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  visit(join(REPO_ROOT, "src"));
  assert.deepEqual(found.sort(), ["src/backend/contractErrors.ts", "src/domain/errors.ts"]);
});

test("dispose closes every open handle, is idempotent, and refuses later calls with internal", async (t) => {
  let opened = 0;
  let closed = 0;
  const openCore = (path) => {
    const core = openCairnCore(path);
    opened += 1;
    return {
      ...core,
      close: () => {
        closed += 1;
        core.close();
      },
    };
  };
  const { backend } = startBackend(t, { openCore });
  await callRemember(backend, [op("Agent one note.", "op-1")], { agentId: "agent-one" });
  await callRemember(backend, [op("Agent two note.", "op-2")], { agentId: "agent-two" });
  await callInspect(backend, { scope: "personal" }, { agentId: "agent-three" });
  assert.equal(backend.openHandles(), 3);
  assert.equal(opened, 3);
  await backend.dispose();
  assert.equal(backend.openHandles(), 0);
  assert.equal(closed, 3);
  await backend.dispose();
  assert.equal(closed, 3);
  await assert.rejects(backend.call("diagnose", {}), (error) => {
    assert.equal(error.code, "internal");
    assert.ok(CALL_ERROR_CODES.has(error.code));
    return true;
  });
});

test("dispose before any call has nothing to close", async (t) => {
  const { backend } = startBackend(t);
  await backend.dispose();
  assert.equal(backend.openHandles(), 0);
});
