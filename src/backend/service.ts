import { openCairnCore } from "../adapters/cairn/cairnCoreAdapter.js";
import { CairnDataLayout } from "../adapters/storage/dataLayout.js";
import { CoreHandlePool } from "../application/coreHandlePool.js";
import { MemoryApplication } from "../application/memoryApplication.js";
import type { MemoryCorePort } from "../application/ports.js";
import { MemoryServiceError } from "../domain/errors.js";
import {
  MEMORY_LIMITS,
  MEMORY_PLUGIN_METHODS,
  memoryDiagnoseRequestSchema,
} from "../../vendor/teamuq-contract/contract.mjs";
import { CallError, callError } from "./contractErrors.js";
import { buildDiagnose } from "./diagnose.js";
import { inspect, inspectStorageFailure, parseInspectRequest } from "./inspectCall.js";
import { parseRememberRequest, remember, rememberStorageFailure } from "./rememberCall.js";

export interface BackendOptions {
  readonly dataRoot: string;
  readonly pinPath: string;
  readonly openCore?: (path: string) => MemoryCorePort;
  readonly inspectBudget?: number;
}

export interface MemoryBackend {
  call(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  warmUp(): void;
  openHandles(): number;
}

interface Ready {
  readonly application: MemoryApplication;
  readonly pool: CoreHandlePool;
}

// why: environmental start-up failures (permissions, busy files) must stay retryable; INTERNAL would let Core skip the write for good
function asStorageError(error: unknown): MemoryServiceError {
  return error instanceof MemoryServiceError
    ? error
    : new MemoryServiceError("STORAGE_BUSY", "Memory storage could not be initialised");
}

export function createBackend(options: BackendOptions): MemoryBackend {
  const openCore = options.openCore ?? ((path: string) => openCairnCore(path));
  const budget = options.inspectBudget ?? MEMORY_LIMITS.inspectBudgetBytes;
  let ready: Ready | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;

  const ensure = (): Ready => {
    if (ready !== undefined) return ready;
    try {
      const layout = new CairnDataLayout(options.dataRoot, { pinPath: options.pinPath });
      layout.preflight();
      const pool = new CoreHandlePool({ layout, openCore });
      ready = { application: new MemoryApplication(pool), pool };
      return ready;
    } catch (error) {
      throw asStorageError(error);
    }
  };

  const storageStatus = (): string => {
    try {
      ensure();
      return "ready";
    } catch (error) {
      return asStorageError(error).code.toLowerCase();
    }
  };

  const dispatch = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case MEMORY_PLUGIN_METHODS.remember: {
        const request = parseRememberRequest(params);
        let active: Ready;
        try {
          active = ensure();
        } catch (error) {
          return rememberStorageFailure(request, error);
        }
        return remember(active.application, request);
      }
      case MEMORY_PLUGIN_METHODS.inspect: {
        const request = parseInspectRequest(params);
        let active: Ready;
        try {
          active = ensure();
        } catch (error) {
          return inspectStorageFailure(error);
        }
        return inspect(active.application, request, budget);
      }
      case MEMORY_PLUGIN_METHODS.diagnose: {
        if (!memoryDiagnoseRequestSchema.safeParse(params).success) {
          throw callError("invalid_params", "Invalid params for diagnose");
        }
        return buildDiagnose(storageStatus());
      }
      default:
        throw callError("unknown_method", "Unknown method");
    }
  };

  return {
    async call(method, params) {
      if (disposed) throw callError("internal", "The backend is disposed");
      try {
        return await dispatch(method, params);
      } catch (error) {
        if (error instanceof CallError) throw error;
        throw callError("internal", "Internal error");
      }
    },
    dispose() {
      disposed = true;
      disposing ??= (async () => {
        if (ready !== undefined) await ready.application.close();
      })();
      return disposing;
    },
    warmUp() {
      storageStatus();
    },
    openHandles: () => ready?.pool.openHandles ?? 0,
  };
}
