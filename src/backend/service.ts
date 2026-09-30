import { dirname, join } from "node:path";
import { openCairnCore } from "../adapters/cairn/cairnCoreAdapter.js";
import { CairnDataLayout } from "../adapters/storage/dataLayout.js";
import { PROFILE_DIRECTORY, PROFILE_FILE, loadProfileFile, type ProfileIo } from "../adapters/ui/profileStore.js";
import { CoreHandlePool } from "../application/coreHandlePool.js";
import { MemoryApplication } from "../application/memoryApplication.js";
import type { MemoryCorePort } from "../application/ports.js";
import { createClock, type Clock } from "../application/ui/timeSlice.js";
import { ProfileTable } from "../application/ui/profileTable.js";
import { createUiServices, type UiServices } from "../application/ui/uiServices.js";
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
import { createProfileSync } from "./profileSync.js";
import { dispatchUi, isUiMethod } from "./uiDispatch.js";

export interface BackendOptions {
  readonly dataRoot: string;
  readonly pinPath: string;
  readonly openCore?: (path: string) => MemoryCorePort;
  readonly inspectBudget?: number;
  readonly uiClock?: () => Clock;
  readonly uiSampleRows?: number;
  readonly uiNow?: () => number;
  readonly uiReceiptChunk?: number;
  readonly profilePath?: string;
  readonly profileIo?: ProfileIo;
}

export interface MemoryBackend {
  call(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  warmUp(): void;
  warmIndex(): Promise<void>;
  openHandles(): number;
}

interface Ready {
  readonly application: MemoryApplication;
  readonly pool: CoreHandlePool;
  readonly ui: UiServices;
}

// why: environmental start-up failures (permissions, busy files) must stay retryable; INTERNAL would let Core skip the write for good
function asStorageError(error: unknown): MemoryServiceError {
  return error instanceof MemoryServiceError
    ? error
    : new MemoryServiceError("STORAGE_BUSY", "Memory storage could not be initialised");
}

const WARM_UP_BUDGET_MS = 120_000;

export function createBackend(options: BackendOptions): MemoryBackend {
  const openCore = options.openCore ?? ((path: string) => openCairnCore(path));
  const budget = options.inspectBudget ?? MEMORY_LIMITS.inspectBudgetBytes;
  let ready: Ready | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let warming: Promise<void> | undefined;
  const profilePath = options.profilePath ?? join(dirname(options.dataRoot), PROFILE_DIRECTORY, PROFILE_FILE);
  // why: the name table is independent of Cairn storage, so it loads and accepts pushes even while the Cairn layout is unavailable
  const profile = new ProfileTable(loadProfileFile(profilePath));
  const profileSync = createProfileSync({ table: profile, filePath: profilePath, now: options.uiNow ?? Date.now, ...(options.profileIo === undefined ? {} : { io: options.profileIo }) });

  const ensure = (): Ready => {
    if (ready !== undefined) return ready;
    try {
      const layout = new CairnDataLayout(options.dataRoot, { pinPath: options.pinPath, trustedBase: dirname(options.dataRoot) });
      layout.preflight();
      const pool = new CoreHandlePool({ layout, openCore });
      const application = new MemoryApplication(pool);
      ready = {
        application,
        pool,
        ui: createUiServices({
          layout,
          application,
          profile,
          ...(options.uiClock === undefined ? {} : { newClock: options.uiClock }),
          ...(options.uiSampleRows === undefined ? {} : { sampleRows: options.uiSampleRows }),
          ...(options.uiNow === undefined ? {} : { now: options.uiNow }),
          ...(options.uiReceiptChunk === undefined ? {} : { receiptChunk: options.uiReceiptChunk }),
        }),
      };
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

  const uiServices = (): UiServices | undefined => {
    try {
      return ensure().ui;
    } catch {
      return undefined;
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
        try {
          return await remember(active.application, request);
        } finally {
          // why: a failed batch may still have written its first ops, so the agent is marked dirty on every outcome
          active.ui.index.markDirty(request.actor.agentId);
        }
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
      case MEMORY_PLUGIN_METHODS.profileSync:
        return profileSync.handle(params);
      default:
        if (isUiMethod(method)) return dispatchUi(method, params, { storageStatus, services: uiServices, profile });
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
    warmIndex() {
      // why: building the agent index in the background from activation on means the first time the view opens it usually finds the index ready instead of opening every agent database itself
      warming ??= (async () => {
        const services = uiServices();
        if (services === undefined || disposed) return;
        try {
          await services.index.snapshot(createClock({ budgetMs: WARM_UP_BUDGET_MS, cancelled: () => disposed }));
        } catch {
          // why: warming is only an optimisation, and every ui call builds what it needs itself
        }
      })();
      return warming;
    },
    dispose() {
      disposed = true;
      disposing ??= (async () => {
        await warming;
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
