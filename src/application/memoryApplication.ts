import { randomUUID } from "node:crypto";
import type { MemoryActor } from "../contracts/actor.js";
import {
  failure,
  mapCairnError,
  success,
  MemoryServiceError,
  type MemoryResult,
} from "../domain/errors.js";
import { namespaceForScope, recallReadSet } from "../domain/namespace.js";
import { CoreHandlePool } from "./coreHandlePool.js";
import type { CoreResult, ObservabilityPort } from "./ports.js";
import { ResourceGovernor } from "./resourceGovernor.js";
import type {
  MemoryCaptureInput,
  MemoryCorrectInput,
  MemoryForgetInput,
  MemoryInspectInput,
  MemoryRecallInput,
  MemoryRememberInput,
  MemoryToolName,
} from "./toolContract.js";
import { AgentWriteLane } from "./writeLane.js";

type ToolInput =
  | MemoryRecallInput
  | MemoryRememberInput
  | MemoryCaptureInput
  | MemoryInspectInput
  | MemoryCorrectInput
  | MemoryForgetInput;

function unwrap(result: CoreResult): unknown {
  if (result.ok) return result.value;
  throw mapCairnError(result.error.code);
}

function receipt(
  binding: MemoryActor,
  operationId: string,
  content: string,
) {
  return {
    client: binding.providerId,
    sessionId: binding.sessionId,
    eventId: operationId,
    role: "user" as const,
    excerpt: content.slice(0, 800),
  };
}

export class MemoryApplication {
  private readonly governor = new ResourceGovernor();
  private readonly writeLane = new AgentWriteLane();

  constructor(
    private readonly pool: CoreHandlePool,
    private readonly observability?: ObservabilityPort,
  ) {}

  async execute(
    name: MemoryToolName,
    input: ToolInput,
    binding: MemoryActor,
    sourceMemoryId?: string,
  ): Promise<MemoryResult<unknown>> {
    const requestId = randomUUID();
    const startedAt = performance.now();
    try {
      const value = await this.governor.run(binding.sessionId, () =>
        this.dispatch(name, input, binding, sourceMemoryId),
      );
      this.emitCompletion(requestId, name, startedAt, "OK", binding);
      return success(requestId, value);
    } catch (error) {
      const result = failure(requestId, error);
      this.emitCompletion(
        requestId,
        name,
        startedAt,
        result.error.code,
        binding,
      );
      return result;
    }
  }

  private dispatch(
    name: MemoryToolName,
    input: ToolInput,
    binding: MemoryActor,
    sourceMemoryId?: string,
  ): Promise<unknown> {
    if (name === "memory_recall")
      return this.recall(input as MemoryRecallInput, binding);
    if (name === "memory_inspect")
      return this.inspect(input as MemoryInspectInput, binding);
    const writeInput = input as
      | MemoryRememberInput
      | MemoryCaptureInput
      | MemoryCorrectInput
      | MemoryForgetInput;
    // why: 寫入去重只靠 Cairn 內容指紋與 receipt，不設記憶體 registry，回補大量歷史時才不會 RESOURCE_BUSY
    return this.writeLane.run(binding.agentId, () =>
      this.write(name, writeInput, binding, sourceMemoryId),
    );
  }

  private recall(
    input: MemoryRecallInput,
    binding: MemoryActor,
  ): Promise<unknown> {
    return this.pool.withCore(binding.agentId, async (core) =>
      unwrap(
        await core.recall({
          readSet: recallReadSet(binding),
          query: input.query,
          limit: input.limit ?? 6,
        }),
      ),
    );
  }

  private inspect(
    input: MemoryInspectInput,
    binding: MemoryActor,
  ): Promise<unknown> {
    const namespace = namespaceForScope(binding, input.scope);
    return this.pool.withCore(binding.agentId, (core) =>
      unwrap(
        input.memoryId === undefined
          ? core.list({
              namespace,
              limit: input.limit ?? 6,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            })
          : core.get({
              namespace,
              memoryId: input.memoryId,
              receiptLimit: input.limit ?? 6,
              ...(input.cursor === undefined
                ? {}
                : { receiptCursor: input.cursor }),
            }),
      ),
    );
  }

  private write(
    name: Exclude<MemoryToolName, "memory_recall" | "memory_inspect">,
    input:
      | MemoryRememberInput
      | MemoryCaptureInput
      | MemoryCorrectInput
      | MemoryForgetInput,
    binding: MemoryActor,
    sourceMemoryId?: string,
  ): Promise<unknown> {
    const namespace = namespaceForScope(binding, input.scope);
    return this.pool.withCore(binding.agentId, async (core) => {
      if (name === "memory_remember") {
        const remember = input as MemoryRememberInput;
        return unwrap(
          core.admit({
            namespace,
            memory: { content: remember.content, kind: remember.kind },
            receipts: [
              receipt(binding, remember.operationId, remember.content),
            ],
          }),
        );
      }
      if (name === "memory_capture") {
        const capture = input as MemoryCaptureInput;
        // why: checking within the agent write lane prevents a concurrent forget from deleting the source between validation and capture
        if (sourceMemoryId !== undefined) {
          const source = core.get({ namespace, memoryId: sourceMemoryId });
          if (!source.ok) {
            if (source.error.code === "memory_not_found") throw new MemoryServiceError("MEMORY_SUPPRESSED", "Source memory was forgotten");
            throw mapCairnError(source.error.code);
          }
        }
        return unwrap(
          await core.capture({
            namespace,
            client: binding.providerId,
            eventId: capture.operationId,
            sessionId: binding.sessionId,
            messages: capture.messages,
          }),
        );
      }
      if (name === "memory_correct") {
        const correct = input as MemoryCorrectInput;
        return unwrap(
          core.correct({
            namespace,
            memoryId: correct.memoryId,
            expectedRevision: correct.expectedRevision,
            content: correct.content,
            kind: correct.kind,
            receipt: receipt(binding, correct.operationId, correct.content),
          }),
        );
      }
      const forget = input as MemoryForgetInput;
      return unwrap(
        core.forget({
          namespace,
          memoryId: forget.memoryId,
          expectedRevision: forget.expectedRevision,
        }),
      );
    });
  }

  private emitCompletion(
    requestId: string,
    operation: MemoryToolName,
    startedAt: number,
    resultCode: string,
    binding: MemoryActor,
  ): void {
    this.observability?.emit({
      event: "memory.request.complete",
      requestId,
      operation,
      resultCode,
      durationMs: Math.round(performance.now() - startedAt),
      scopeSet: binding.projectId === null ? "personal" : "personal,project",
    });
  }

  async close(): Promise<void> {
    this.governor.fence();
    await this.pool.close();
  }
}
