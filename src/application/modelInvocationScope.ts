import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { MemoryActor } from "../contracts/actor.js";
import type { MemoryModelInvocationContext, MemoryModelOperation } from "./modelPort.js";

interface CaptureScope {
  readonly agentId: string;
  readonly projectId: string | null;
  readonly operationId: string;
  readonly occurrences: Map<string, number>;
  readonly allowModelSend: boolean;
}

const scope = new AsyncLocalStorage<CaptureScope>();

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function modelRequestSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function pairKey(agentId: string, projectId: string | null): string {
  return sha256(JSON.stringify([agentId, projectId]));
}

export function operationKey(pair: string, operationId: string): string {
  return sha256(pair + "|" + operationId);
}

export function modelCallKey(operation: string, modelOperation: MemoryModelOperation, systemSha: string, requestSha: string, occurrence: number): string {
  return sha256(operation + "|" + modelOperation + "|" + systemSha + "|" + requestSha + "|" + occurrence);
}

export function legacyModelCallKey(operation: string, modelOperation: MemoryModelOperation, requestSha: string, occurrence: number): string {
  return sha256(operation + "|" + modelOperation + "|" + requestSha + "|" + occurrence);
}

export function withMemoryCaptureScope<T>(
  actor: MemoryActor,
  operationId: string,
  work: () => Promise<T>,
  allowModelSend = true,
): Promise<T> {
  return scope.run({ agentId: actor.agentId, projectId: actor.projectId, operationId, occurrences: new Map(), allowModelSend }, work);
}

export function currentMemoryInvocation(
  modelOperation: MemoryModelOperation,
  system: string,
  input: unknown,
): MemoryModelInvocationContext | undefined {
  const current = scope.getStore();
  if (current === undefined) return undefined;
  const requestSha = modelRequestSha256(input);
  const systemSha = sha256(system);
  const occurrenceKey = modelOperation + "|" + systemSha + "|" + requestSha;
  const sameRequestOccurrence = current.occurrences.get(occurrenceKey) ?? 0;
  current.occurrences.set(occurrenceKey, sameRequestOccurrence + 1);
  return {
    canonicalAgentId: current.agentId,
    sourceProjectId: current.projectId,
    operationId: current.operationId,
    modelOperation,
    operationSystemSha256: systemSha,
    canonicalRequestSha256: requestSha,
    sameRequestOccurrence,
    allowModelSend: current.allowModelSend,
  };
}
