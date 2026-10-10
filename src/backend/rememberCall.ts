import { randomUUID } from "node:crypto";
import {
  MEMORY_LIMITS,
  memoryRememberRequestSchema,
  memoryRememberResponseSchema,
  memoryRememberValueSchema,
  type MemoryRememberRequest,
  type MemoryRememberResponse,
} from "../../vendor/teamuq-contract/contract.mjs";
import type { MemoryApplication } from "../application/memoryApplication.js";
import { failure } from "../domain/errors.js";
import { callError, projectFailure } from "./contractErrors.js";

type Executor = Pick<MemoryApplication, "execute">;

export function parseRememberRequest(params: unknown): MemoryRememberRequest {
  const parsed = memoryRememberRequestSchema.safeParse(params);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    throw callError("invalid_params", `Invalid params for memory.remember@1: ${path}`);
  }
  return parsed.data;
}

async function rememberOne(
  executor: Executor,
  request: MemoryRememberRequest,
  index: number,
): Promise<MemoryRememberResponse["results"][number]> {
  const op = request.ops[index];
  if (op === undefined) throw callError("internal", "Operation index out of range");
  const outcome = await executor.execute("memory_remember", op, request.actor);
  if (!outcome.ok) return projectFailure(outcome);
  // why: only {memory:{id}, deduplicated} crosses the boundary; Cairn's revision and indexRevision stay inside the plugin
  const projected = memoryRememberValueSchema.safeParse(outcome.value);
  if (!projected.success) {
    return projectFailure(failure(outcome.requestId, new Error("Cairn returned an unexpected admit shape")));
  }
  return { ok: true, value: projected.data, requestId: outcome.requestId };
}

export async function remember(
  executor: Executor,
  request: MemoryRememberRequest,
): Promise<MemoryRememberResponse> {
  const results: MemoryRememberResponse["results"] = [];
  for (let index = 0; index < request.ops.length; index += 1) {
    // why: ops of one call run in order so a duplicate inside the batch sees the first write and is deduplicated
    results.push(await rememberOne(executor, request, index));
  }
  const response = memoryRememberResponseSchema.safeParse({ results });
  if (!response.success) throw callError("internal", "Remember response failed the contract schema");
  if (Buffer.byteLength(JSON.stringify(response.data), "utf8") > MEMORY_LIMITS.resultMaxBytes) {
    throw callError("result_too_large", "Remember response exceeds the result limit");
  }
  return response.data;
}

export function rememberStorageFailure(request: MemoryRememberRequest, error: unknown): MemoryRememberResponse {
  const results = request.ops.map(() => projectFailure(failure(randomUUID(), error)));
  return { results };
}
