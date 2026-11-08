import { dirname, join } from "node:path";
import { openCairnCore } from "../adapters/cairn/cairnCoreAdapter.js";
import { CairnDataLayout } from "../adapters/storage/dataLayout.js";
import type { BackupHooks } from "../adapters/storage/upgradeBackup.js";
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
  memoryRememberResponseSchema,
} from "../../vendor/teamuq-contract/contract.mjs";
import { CallError, callError } from "./contractErrors.js";
import { buildDiagnose } from "./diagnose.js";
import { inspect, inspectStorageFailure, parseInspectRequest } from "./inspectCall.js";
import { parseRememberRequest, remember, rememberStorageFailure } from "./rememberCall.js";
import { createProfileSync } from "./profileSync.js";
import { dispatchUi, isUiMethod } from "./uiDispatch.js";
import type { PluginBackendContextV1, PluginHostApiV1 } from "@teamuq/plugin-sdk/external";
import { createPunchFeed, createProfileDirectory } from "./hostDataAdapter.js";
import { createPunchCatchupWorker } from "../application/punchCatchup.js";
import { refreshMemoryProfile } from "../application/profileRefresh.js";
import { createHostMemoryModelPort } from "../adapters/model/hostMemoryModelPort.js";
import { createTeamuqTaskBinding } from "../application/teamuqTaskBinding.js";
import { createTeamuqTaskStore } from "../adapters/storage/teamuqTaskStore.js";
import { createLocalPunchOrganizationStore, createLocalPunchReceiptStore } from "../adapters/storage/punchStateStore.js";
import { createPunchOrganizationWorker } from "../application/punchOrganization.js";
import { pairKey } from "../application/modelInvocationScope.js";
import { createMigratingPunchReceiptStore } from "./punchStateMigration.js";
import { readOrganizationSettings } from "./organizationSettings.js";
import { unstickLocalDeadline } from "../application/organizationUnstick.js";
import { backupStateOnce } from "../adapters/storage/stateBackup.js";

export interface BackendOptions {
  readonly dataRoot: string;
  readonly pinPath: string;
  readonly openCore?: (path: string) => MemoryCorePort;
  readonly openAgentCore?: (path: string, agentId: string) => MemoryCorePort;
  readonly inspectBudget?: number;
  readonly uiClock?: () => Clock;
  readonly uiSampleRows?: number;
  readonly uiNow?: () => number;
  readonly uiReceiptChunk?: number;
  readonly backupHooks?: Partial<BackupHooks>;
  readonly organizationNow?: () => number;
  readonly hostSessionCloseTimeoutMs?: number;
  readonly unstickRetryMs?: number;
  readonly profilePath?: string;
  readonly profileIo?: ProfileIo;
  readonly host?: PluginHostApiV1;
  readonly settings?: PluginBackendContextV1["settings"];
}

export interface MemoryBackend {
  call(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  warmUp(): void;
  warmIndex(): Promise<void>;
  openHandles(): number;
  startWorkers(): void;
  idleWorkers(): Promise<void>;
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
  let profileTimer: ReturnType<typeof setInterval> | null = null;
  let profileRefreshing: Promise<void> | null = null;
  let workerStartup: Promise<void> = Promise.resolve();
  let startupReady: Promise<void> = Promise.resolve();
  let workersStarted = false;
  let settingValues: Readonly<Record<string, boolean | number | string>> = {};
  try { settingValues = options.settings?.all() ?? {}; } catch {}
  const organizationSettings = () => readOrganizationSettings(settingValues);
  const profilePath = options.profilePath ?? join(dirname(options.dataRoot), PROFILE_DIRECTORY, PROFILE_FILE);
  // why: the name table is independent of Cairn storage, so it loads and accepts pushes even while the Cairn layout is unavailable
  const profile = new ProfileTable(loadProfileFile(profilePath));
  // why: a host without the Program API (older Core) gets no binding, so its AI turns never carry a taskId and never call Program
  const teamuqTask = options.host?.program === undefined ? undefined : createTeamuqTaskBinding({ program: options.host.program, store: createTeamuqTaskStore(dirname(options.dataRoot)), profile });
  const organizationStore = options.host === undefined ? undefined : createLocalPunchOrganizationStore(dirname(options.dataRoot));
  const model = options.host?.ai === undefined ? undefined : createHostMemoryModelPort(options.host.ai, organizationSettings, teamuqTask, organizationStore, options.hostSessionCloseTimeoutMs);
  const profileSync = createProfileSync({ table: profile, filePath: profilePath, now: options.uiNow ?? Date.now, ...(options.profileIo === undefined ? {} : { io: options.profileIo }) });

  const organization = organizationStore === undefined ? undefined : createPunchOrganizationWorker({
    store: organizationStore,
    enabled: () => organizationSettings().enabled,
    frequency: () => organizationSettings().frequency,
    dailyTime: () => organizationSettings().dailyTime,
    ...(model === undefined ? {} : { awaitPending: (job: { readonly actor: { readonly agentId: string; readonly projectId: string | null } }) => model.awaitPair(job.actor.agentId, job.actor.projectId), waiting: () => model.waiting() }),
    ...(options.organizationNow === undefined ? {} : { now: options.organizationNow }),
    async capture(job) {
      const active = ensure();
      try { return await active.application.execute("memory_capture", job.input, job.actor, job.memoryId, job.allowModelSend ?? true); }
      finally {
        const pair = pairKey(job.actor.agentId, job.actor.projectId);
        try {
          await model?.releasePair(job.actor.agentId, job.actor.projectId);
          organization?.noteReleaseFault(pair, null);
        } catch (error) {
          // why: the job result stays as it is, but a close that timed out must still show in the organization status
          if (error instanceof MemoryServiceError && error.phase !== undefined) {
            organization?.noteReleaseFault(pair, { code: error.code, phase: error.phase, localCode: error.localCode ?? null, retryable: error.retryable, at: (options.organizationNow ?? Date.now)() });
          }
        }
        active.ui.index.markDirty(job.actor.agentId);
      }
    },
  });
  let unsubscribeSettings: (() => void) | undefined;
  try { unsubscribeSettings = options.settings?.onChange((values) => {
    const previousSettings = organizationSettings();
    settingValues = values;
    const nextSettings = organizationSettings();
    if (!nextSettings.enabled) model?.interrupt();
    const schedulingChanged = previousSettings.enabled !== nextSettings.enabled
      || previousSettings.providerId !== nextSettings.providerId
      || previousSettings.modelId !== nextSettings.modelId
      || previousSettings.contextBudget !== nextSettings.contextBudget
      || previousSettings.frequency !== nextSettings.frequency
      || (nextSettings.frequency === "daily" && previousSettings.dailyTime !== nextSettings.dailyTime);
    if (schedulingChanged) organization?.settingsChanged();
  }); } catch { settingValues = {}; }

  const punchWorker = options.host === undefined ? undefined : createPunchCatchupWorker({
    feed: createPunchFeed(options.host),
    receipts: createMigratingPunchReceiptStore(options.host, createLocalPunchReceiptStore(dirname(options.dataRoot))),
    ...(organizationStore === undefined ? {} : { resumeStore: organizationStore }),
    onAdmitted: (punch, memoryId) => organization!.enqueue(punch, memoryId),
    writer: {
      async rememberMany(inputs) {
        const request = {
          actor: { agentId: inputs[0]?.agentId ?? "", projectId: inputs[0]?.projectId ?? null, sessionId: inputs[0]?.sessionId ?? "no-session", providerId: inputs[0]?.providerId ?? "unknown" },
          ops: inputs.map((input) => ({ scope: input.scope, content: input.content, kind: "context" as const, operationId: input.operationId })),
        };
        const response = memoryRememberResponseSchema.parse(await dispatch(MEMORY_PLUGIN_METHODS.remember, request));
        return response.results.map((result) => {
          if (result.ok) return { ok: true as const, memoryId: result.value.memory.id, deduplicated: result.value.deduplicated };
          return { ok: false as const, code: result.error.code, retryable: result.error.retryable };
        });
      },
    },
  });

  const refreshProfile = (): void => {
    if (options.host === undefined || profileRefreshing !== null || disposed) return;
    profileRefreshing = refreshMemoryProfile({
      directory: createProfileDirectory(options.host),
      sink: { accept: (request) => profileSync.handle(request) },
      sinkStatus: () => punchWorker?.status() ?? null,
    }).then(() => undefined).catch(() => undefined).finally(() => { profileRefreshing = null; });
  };

  // why: a migration failure must not block start-up, so it shows in the organization status and is tried again until it succeeds, which is also what clears that status
  let unstickTimer: ReturnType<typeof setTimeout> | undefined;
  const unstickStrandedCalls = async (): Promise<void> => {
    if (organizationStore === undefined) return;
    const now = options.organizationNow ?? Date.now;
    try {
      await unstickLocalDeadline(organizationStore, now(), () => { backupStateOnce(dirname(options.dataRoot), "punch-organization.json", "punch-organization.pre-unstick.json"); });
      organization?.noteReleaseFault("unstick", null);
      organization?.wake();
    } catch {
      organization?.noteReleaseFault("unstick", { code: "STORAGE_BUSY", phase: "state", localCode: "unstick_failed", retryable: true, at: now() });
      if (disposed) return;
      unstickTimer = setTimeout(() => { void unstickStrandedCalls(); }, options.unstickRetryMs ?? 300_000);
      unstickTimer.unref();
    }
  };

  const ensure = (): Ready => {
    if (ready !== undefined) return ready;
    try {
      const layout = new CairnDataLayout(options.dataRoot, { pinPath: options.pinPath, trustedBase: dirname(options.dataRoot), ...(options.backupHooks === undefined ? {} : { backupHooks: options.backupHooks }) });
      layout.preflight();
      const openAgentCore = options.openAgentCore ?? (options.openCore === undefined && model !== undefined ? (path: string, agentId: string) => openCairnCore(path, { agentId, port: model }) : undefined);
      const pool = new CoreHandlePool({ layout, openCore, ...(openAgentCore === undefined ? {} : { openAgentCore }) });
      const application = new MemoryApplication(pool);
      ready = {
        application,
        pool,
        ui: createUiServices({
          layout,
          legacy: layout,
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
        if (isUiMethod(method)) return dispatchUi(method, params, { storageStatus, services: uiServices, profile, ...(organization === undefined ? {} : { organizationStatus: organization.status, onForgotten: organization.forgetSource, legacyTrial: organization.legacyTrial, agentOrganization: organization.agentOrganization }) });
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
      clearTimeout(unstickTimer);
      if (profileTimer !== null) clearInterval(profileTimer);
      unsubscribeSettings?.();
      unsubscribeSettings = undefined;
      disposing ??= (async () => {
        await startupReady;
        await model?.cancel();
        await punchWorker?.stop();
        await organization?.stop();
        await profileRefreshing;
        await warming;
        if (ready !== undefined) await ready.application.close();
      })();
      return disposing;
    },
    warmUp() {
      storageStatus();
    },
    startWorkers() {
      if (workersStarted || disposed) return;
      workersStarted = true;
      startupReady = (async () => {
        await unstickStrandedCalls();
        if (disposed) return;
        organization?.start({ deferInitialRun: punchWorker !== undefined });
        punchWorker?.start();
      })();
      if (organization !== undefined && punchWorker !== undefined) {
        workerStartup = startupReady.then(() => disposed ? undefined : punchWorker.initialCatchupReady()).then(() => { if (!disposed) organization.resumeStartup(); });
      }
      refreshProfile();
      if (options.host !== undefined) {
        profileTimer = setInterval(refreshProfile, 30_000);
        profileTimer.unref();
      }
    },
    async idleWorkers() {
      await startupReady;
      await punchWorker?.idle();
      if (punchWorker?.status() !== null) await workerStartup;
      await organization?.idle();
      await profileRefreshing;
    },
    openHandles: () => ready?.pool.openHandles ?? 0,
  };
}
