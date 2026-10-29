import { AsyncLocalStorage } from "node:async_hooks";
import { openMemoryCore } from "cairn-memory/core/index.mjs";
import type { CoreResult, MemoryCorePort } from "../../application/ports.js";
import type { MemoryModelPort } from "../../application/modelPort.js";
import type { MemoryFailurePhase } from "../../domain/errors.js";
import { createCairnModelAdapter } from "../model/cairnModelAdapter.js";

type ModelFailureCode = string;

interface ModelFailureContext {
  code?: ModelFailureCode;
  phase?: MemoryFailurePhase;
}

export function openCairnCore(
  path: string,
  modelBinding?: { readonly agentId: string; readonly port: MemoryModelPort },
): MemoryCorePort {
  const failures = new AsyncLocalStorage<ModelFailureContext>();
  const model =
    modelBinding === undefined
      ? undefined
      : createCairnModelAdapter(
          modelBinding.agentId,
          modelBinding.port,
          (code, phase) => {
            const context = failures.getStore();
            if (context !== undefined) {
              context.code = code.toLowerCase();
              if (phase !== undefined) context.phase = phase;
            }
          },
        );
  const core = openMemoryCore({
    path,
    ...(model === undefined ? {} : { model }),
  });
  const modelOperation = (
    work: () => Promise<CoreResult>,
  ): Promise<CoreResult> => {
    const context: ModelFailureContext = {};
    return failures.run(context, async () => {
      const result = await work();
      if (!result.ok && context.code !== undefined) {
        return {
          ok: false as const,
          error: { code: context.code, retryable: ["model_timeout", "resource_busy", "storage_busy"].includes(context.code), ...(context.phase === undefined ? {} : { phase: context.phase }) },
        };
      }
      return result;
    });
  };
  return {
    admit: (input) => core.admit(input),
    list: (input) => core.list(input),
    get: (input) => core.get(input),
    correct: (input) => core.correct(input),
    forget: (input) => core.forget(input),
    recall: (input) => modelOperation(() => core.recall(input)),
    capture: (input) => modelOperation(() => core.capture(input)),
    close: () => {
      core.close();
    },
  };
}
