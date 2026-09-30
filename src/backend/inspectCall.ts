import { randomUUID } from "node:crypto";
import {
  memoryInspectRequestSchema,
  memoryInspectResponseSchema,
  type MemoryInspectRequest,
  type MemoryInspectResponse,
} from "../../vendor/teamuq-contract/contract.mjs";
import type { MemoryApplication } from "../application/memoryApplication.js";
import { failure } from "../domain/errors.js";
import { callError, projectFailure } from "./contractErrors.js";

type Executor = Pick<MemoryApplication, "execute">;

// why: memoryApplication applies the same default when the caller sends no limit, and a Cairn cursor is bound to the limit it was issued with
const DEFAULT_LIMIT = 6;

export function parseInspectRequest(params: unknown): MemoryInspectRequest {
  const parsed = memoryInspectRequestSchema.safeParse(params);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    throw callError("invalid_params", `Invalid params for memory.inspect@1: ${path}`);
  }
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// why: Cairn names the continuation cursor nextCursor for list and nextReceiptCursor for get
function continuation(request: MemoryInspectRequest, value: Record<string, unknown>): string | undefined {
  const cursor = request.input.memoryId === undefined ? value["nextCursor"] : value["nextReceiptCursor"];
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

export async function inspect(
  executor: Executor,
  request: MemoryInspectRequest,
  budget: number,
): Promise<MemoryInspectResponse> {
  let limit = request.input.limit ?? DEFAULT_LIMIT;
  for (;;) {
    const outcome = await executor.execute("memory_inspect", { ...request.input, limit }, request.actor);
    if (!outcome.ok) return validated({ result: projectFailure(outcome) });
    if (!isRecord(outcome.value)) {
      return validated({
        result: projectFailure(failure(outcome.requestId, new Error("Cairn returned an unexpected inspect shape"))),
      });
    }
    const next = continuation(request, outcome.value);
    const response = validated({
      result: { ok: true, value: outcome.value, requestId: outcome.requestId },
      ...(next === undefined ? {} : { nextCursor: next }),
      appliedLimit: limit,
    });
    if (JSON.stringify(response).length <= budget) return response;
    if (limit === 1) throw callError("result_too_large", "A single inspected item exceeds the result budget");
    // why: a Cairn cursor cannot be re-issued for a smaller limit, so only a first page (no cursor) can be halved
    if (request.input.cursor !== undefined) {
      throw callError("result_too_large", "A continuation page exceeds the result budget and its cursor is bound to the limit");
    }
    limit = Math.max(1, Math.floor(limit / 2));
  }
}

export function inspectStorageFailure(error: unknown): MemoryInspectResponse {
  return validated({ result: projectFailure(failure(randomUUID(), error)) });
}

function validated(candidate: unknown): MemoryInspectResponse {
  const parsed = memoryInspectResponseSchema.safeParse(candidate);
  if (!parsed.success) throw callError("internal", "Inspect response failed the contract schema");
  return parsed.data;
}
