import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as contract from "../vendor/teamuq-contract/contract.mjs";
import { createBackend } from "../out/backend/service.js";

export { contract };
export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const PIN_PATH = join(REPO_ROOT, "cairn-pin.json");

export const actor = {
  agentId: "team-a/agent-a",
  projectId: "project-a",
  sessionId: "session-a",
  providerId: "codex",
};

const RESPONSE_SCHEMAS = {
  [contract.MEMORY_PLUGIN_METHODS.remember]: contract.memoryRememberResponseSchema,
  [contract.MEMORY_PLUGIN_METHODS.inspect]: contract.memoryInspectResponseSchema,
  [contract.MEMORY_PLUGIN_METHODS.diagnose]: contract.memoryDiagnoseResponseSchema,
};

export function assertContractResponse(method, response) {
  const parsed = RESPONSE_SCHEMAS[method].safeParse(response);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data, response);
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= contract.MEMORY_LIMITS.resultMaxBytes);
  return parsed.data;
}

export function startBackend(t, overrides = {}) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-backend-"));
  const dataRoot = join(base, "memory-cairn-v1");
  const backend = createBackend({ dataRoot, pinPath: PIN_PATH, ...overrides });
  t.after(async () => {
    await backend.dispose();
    rmSync(base, { recursive: true, force: true });
  });
  return { backend, base, dataRoot };
}

export function rememberParams(operations, override = {}) {
  return { actor: { ...actor, ...override }, ops: operations };
}

export function op(content, operationId, scope = "personal", kind = "context") {
  return { scope, content, kind, operationId };
}

export async function callRemember(backend, operations, override) {
  const response = await backend.call(contract.MEMORY_PLUGIN_METHODS.remember, rememberParams(operations, override));
  return assertContractResponse(contract.MEMORY_PLUGIN_METHODS.remember, response);
}

export async function callInspect(backend, input, override = {}) {
  const response = await backend.call(contract.MEMORY_PLUGIN_METHODS.inspect, { actor: { ...actor, ...override }, input });
  return assertContractResponse(contract.MEMORY_PLUGIN_METHODS.inspect, response);
}
