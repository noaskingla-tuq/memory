import { randomUUID } from "node:crypto";
import type { UiFailure, UiForgetRequest } from "../../contracts/uiContract.js";
import { memoryFailure, uiFailure } from "./failures.js";
import type { UiServices } from "./uiServices.js";

const UI_PROVIDER = "ui";

export class UiForgetInternalError extends Error {}

// why: forget goes through the same MemoryApplication as the sink so it shares the agent's write lane and handle pool, and the agent is marked dirty even when the call fails half way
export async function runForget(request: UiForgetRequest, services: UiServices): Promise<Record<string, unknown> | UiFailure> {
  const directory = services.index.directoryOf(request.agentId);
  if (directory === undefined || directory.state === "no_database") return uiFailure("NOT_FOUND");
  const actor = { agentId: request.agentId, projectId: request.projectId, sessionId: `${UI_PROVIDER}-forget`, providerId: UI_PROVIDER };
  try {
    const outcome = await services.application.execute(
      "memory_forget",
      { scope: request.scope, memoryId: request.memoryId, expectedRevision: request.expectedRevision, operationId: `ui-forget-${randomUUID()}` },
      actor,
    );
    if (outcome.ok) return { ok: true, forgotten: (outcome.value as { forgotten?: unknown } | null)?.forgotten === true };
    const mapped = memoryFailure(outcome.error.code);
    if (mapped === null) throw new UiForgetInternalError(outcome.error.code);
    return mapped;
  } finally {
    services.index.markDirty(request.agentId);
  }
}
