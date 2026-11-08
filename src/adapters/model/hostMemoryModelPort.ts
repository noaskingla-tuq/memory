import type { PluginBackendAiApiV1, PluginBackendAiSessionV1 } from "@teamuq/plugin-sdk";
import { MemoryServiceError, type MemoryFailurePhase } from "../../domain/errors.js";
import type { MemoryModelInvocationContext, MemoryModelOperation, MemoryModelPolicy, MemoryModelPort } from "../../application/modelPort.js";
import { legacyModelCallKey, modelCallKey, modelRequestSha256, operationKey, pairKey, sha256 } from "../../application/modelInvocationScope.js";
import type { OrganizationCallRecord, OrganizationOperationRecord, OrganizationSessionRecord, OrganizationResumeStorePort } from "../../application/punchDataPorts.js";
import type { OrganizationSettings } from "../../backend/organizationSettings.js";
import type { TeamuqTaskBinding } from "../../application/teamuqTaskBinding.js";
import { isStrandedSent, reconcileAfterResumeError, reconcileBeforeSession, reconcileWithSession, type CallRecoveryDeps } from "./recoverCall.js";
import { DEFAULT_TURN_LIMITS, type TurnLimits } from "./turnLimits.js";
import type { TraceSink } from "../storage/organizationTrace.js";
import { DETACHED_LOCAL_CODE, REPLY_LIMIT, runTurn, type PairSession, type TurnJournal } from "./turnTracker.js";
import { BASE_SYSTEM, createTurnSessions, type EffectiveAiOptions, type ResumeAi } from "./turnSession.js";

const operations = new Set<MemoryModelOperation>(["select", "rank", "extract", "reconcile", "qualify", "qualifyCandidates", "classify", "relate", "reviewBasis"]);
const deniedModel = (id: string): boolean => /astra/i.test(id);
const JOURNAL_OPERATION_LIMIT = 2_000;
const SESSION_LIMIT = 512;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_LOCAL_CODE = "close_timeout";

const serviceError = (code: MemoryServiceError["code"], message: string, retryable?: boolean, phase?: MemoryFailurePhase, localCode?: string): MemoryServiceError =>
  new MemoryServiceError(code, message, retryable, phase, localCode);

function stateError(): MemoryServiceError {
  return serviceError("STORAGE_BUSY", "Memory recovery state is unavailable", undefined, "state");
}

function cancelledError(): MemoryServiceError {
  return serviceError("RESOURCE_BUSY", "Memory model operation was cancelled", undefined, "cancelled");
}

function publicError(error: unknown, phase: string): MemoryServiceError {
  const code = (error as { code?: unknown } | null)?.code;
  const mappedPhase: MemoryFailurePhase = phase === "send" ? "send_unknown"
    : ["discovery", "session_open", "session_resume", "task_binding", "send_unknown", "turn", "turn_timeout", "reply_contract", "cairn_schema", "commit", "state", "policy", "quota", "cancelled"].includes(phase)
      ? phase as MemoryFailurePhase : "turn";
  if (code === "plugin_permission_denied" || code === "access_revoked" || code === "not_granted") return serviceError("MODEL_POLICY_DENIED", "Memory host permission is unavailable", false, mappedPhase === "turn" ? "policy" : mappedPhase);
  if (code === "quota_exhausted") return serviceError("RESOURCE_BUSY", "Memory AI quota is exhausted", undefined, "quota");
  if (code === "task_not_found") return serviceError("MODEL_POLICY_DENIED", "The organization Task binding is unavailable", false, "task_binding");
  if (code === "turn_timeout" || code === "stalled") return serviceError("MODEL_TIMEOUT", "Memory model operation timed out", undefined, "turn_timeout");
  if (phase === "send" || phase === "send_unknown") return serviceError("RESOURCE_BUSY", "Memory model send outcome is unknown", undefined, "send_unknown");
  return serviceError("RESOURCE_BUSY", "Memory host AI is unavailable", undefined, mappedPhase);
}

function operationRecord(state: Awaited<ReturnType<OrganizationResumeStorePort["readResumeState"]>>, key: string): OrganizationOperationRecord | undefined {
  return state?.operations[key];
}

function parseCached(call: OrganizationCallRecord): unknown {
  if (call.replyJson === null) throw serviceError("RESOURCE_BUSY", "A previous memory turn requires reconciliation", undefined, "session_resume");
  if (typeof call.hostSessionId !== "string" || call.hostSessionId.length === 0 || typeof call.turnId !== "string" || call.turnId.length === 0
    || !(call.sequenceNo === null || Number.isSafeInteger(call.sequenceNo))) throw serviceError("RESOURCE_BUSY", "Saved memory model reply is not linked to a completed turn", undefined, "session_resume");
  if (Buffer.byteLength(call.replyJson, "utf8") !== call.responseBytes || sha256(call.replyJson) !== call.replySha256) {
    throw serviceError("STORAGE_BUSY", "Saved memory recovery state failed integrity validation", false, "state");
  }
  try { return JSON.parse(call.replyJson); }
  catch { throw serviceError("MODEL_OUTPUT_INVALID", "Saved memory model reply is invalid", false, "reply_contract"); }
}

function parseReply(text: string): unknown {
  const fence = String.fromCharCode(96).repeat(3);
  const json = text.trim().replace(new RegExp("^" + fence + "(?:json)?\\s*\\n([\\s\\S]*?)\\n" + fence + "$", "u"), "$1");
  try { return JSON.parse(json); }
  catch { throw serviceError("MODEL_OUTPUT_INVALID", "Memory model returned invalid JSON", false, "reply_contract"); }
}

export function createHostMemoryModelPort(
  ai: PluginBackendAiApiV1,
  settings: () => OrganizationSettings,
  task?: TeamuqTaskBinding,
  resumeStore?: OrganizationResumeStorePort,
  closeTimeoutMs = SESSION_CLOSE_TIMEOUT_MS,
  limits: TurnLimits = DEFAULT_TURN_LIMITS,
  trace?: TraceSink,
): MemoryModelPort & { interrupt(): void; releasePair(agentId: string, projectId: string | null): Promise<void>; awaitPair(agentId: string, projectId: string | null, signal?: AbortSignal): Promise<void>; waiting(): { readonly sinceMs: number } | null; cancel(): Promise<void> } {
  const resumeAi = ai as unknown as ResumeAi;
  const active = new Set<AbortController>();
  const tails = new Set<Promise<unknown>>();
  const detachedSince = new Map<AbortController, number>();
  const live = new Set<PluginBackendAiSessionV1>();
  let stuckClose: { readonly pair: string; readonly error: MemoryServiceError } | null = null;
  const locks = new Map<string, Promise<void>>();
  // why: a host session whose close timed out may still be open, so it must never be resumed
  const abandoned = new Set<string>();
  let hostSlot: Promise<void> = Promise.resolve();
  let disposed = false;

  // why: a caller that gave up while queued still takes its place in the chain, so the lock order never skips a waiter
  const queued = async (previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> => {
    if (signal === undefined) { await previous; return true; }
    if (signal.aborted) return false;
    let off = (): void => {};
    const gone = new Promise<false>((resolve) => { const stop = (): void => resolve(false); signal.addEventListener("abort", stop, { once: true }); off = () => signal.removeEventListener("abort", stop); });
    try { return await Promise.race([previous.then(() => true as const), gone]); }
    finally { off(); }
  };

  const withPairLock = async <T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    locks.set(key, current);
    const settle = (): void => { release(); if (locks.get(key) === current) locks.delete(key); };
    if (!await queued(previous, signal)) {
      void previous.then(settle);
      throw cancelledError();
    }
    try { return await work(); }
    finally { settle(); }
  };

  const withHostSlot = async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = hostSlot;
    let release = (): void => {};
    hostSlot = new Promise<void>((resolve) => { release = resolve; });
    if (!await queued(previous, signal)) {
      void previous.then(release);
      throw cancelledError();
    }
    try { return await work(); }
    finally { release(); }
  };

  // why: a host close() that never settles must not hold the pair lock or host slot, so the wait is bounded
  const closeWithin = async (session: PluginBackendAiSessionV1): Promise<"closed" | "timeout"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        session.close().then(() => "closed" as const),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), closeTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };

  const closeQuietly = (session: PluginBackendAiSessionV1): Promise<void> => closeWithin(session).then((outcome) => {
    if (outcome === "timeout") abandoned.add(session.sessionId);
  }, () => undefined);

  // why: the saved record outlives this process state, so it must stop reading as an active session that can be resumed
  const invalidateSaved = async (pair: string, hostSessionId: string): Promise<void> => {
    if (resumeStore === undefined) return;
    try {
      await resumeStore.transactResumeState((state) => {
        const saved = state.sessions[pair];
        return saved === undefined || saved.hostSessionId !== hostSessionId || saved.state !== "active"
          ? state
          : { ...state, sessions: { ...state.sessions, [pair]: { ...saved, state: "invalidated" } } };
      });
    } catch {
      // why: the in-memory abandoned set still blocks the resume, and the close timeout is the failure worth reporting
    }
  };

  const persistSession = async (record: OrganizationSessionRecord): Promise<void> => {
    if (resumeStore === undefined) return;
    try {
      await resumeStore.transactResumeState((state) => {
        const next = { ...state.sessions, [record.pairKey]: record };
        if (Object.keys(next).length > SESSION_LIMIT) {
          const removable = Object.entries(next)
            .filter(([key]) => key !== record.pairKey && !Object.values(state.operations).some((operation) =>
              operation.pairKey === key && Object.values(operation.calls).some((call) => ["prepared", "sent", "reply_ready", "commit_retry", "send_unknown"].includes(call.phase)
                || call.phase === "failed" && !(call.retryable && !call.partialDelivered))))
            .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
          if (removable === undefined) throw new Error("resume_capacity");
          delete next[removable[0]];
        }
        return { ...state, sessions: next };
      });
    } catch { throw stateError(); }
  };

  const updateCall = async (
    context: MemoryModelInvocationContext,
    key: string,
    callKey: string,
    update: (call: OrganizationCallRecord | undefined) => OrganizationCallRecord,
  ): Promise<OrganizationCallRecord> => {
    if (resumeStore === undefined) throw new Error("resume_store_unavailable");
    let written: OrganizationCallRecord | undefined;
    try {
      await resumeStore.transactResumeState((state) => {
        const existing = state.operations[key];
        const expectedPair = pairKey(context.canonicalAgentId, context.sourceProjectId);
        if (existing !== undefined && (existing.pairKey !== expectedPair || existing.operationId !== context.operationId
          || existing.agentId !== context.canonicalAgentId || existing.projectId !== context.sourceProjectId)) throw new Error("resume_identity_mismatch");
        written = update(existing?.calls[callKey]);
        const nextOperation: OrganizationOperationRecord = {
          operationKey: key, pairKey: expectedPair, operationId: context.operationId,
          agentId: context.canonicalAgentId, projectId: context.sourceProjectId,
          calls: { ...(existing?.calls ?? {}), [callKey]: written }, updatedAt: Date.now(),
        };
        const nextOperations = { ...state.operations, [key]: nextOperation };
        if (Object.keys(nextOperations).length > JOURNAL_OPERATION_LIMIT) throw new Error("resume_capacity");
        return { ...state, operations: nextOperations };
      });
    } catch { throw stateError(); }
    if (written === undefined) throw new Error("organization_resume_write_failed");
    return written;
  };

  const savePhase = async (
    context: MemoryModelInvocationContext,
    key: string,
    callKey: string,
    phase: OrganizationCallRecord["phase"],
    fields: Partial<OrganizationCallRecord> = {},
  ): Promise<OrganizationCallRecord> => updateCall(context, key, callKey, (previous) => ({
    callKey, ...(previous === undefined ? { callKeyVersion: 2 as const } : previous.callKeyVersion === undefined ? {} : { callKeyVersion: previous.callKeyVersion }),
    operationKey: key, pairKey: pairKey(context.canonicalAgentId, context.sourceProjectId),
    modelOperation: context.modelOperation, operationSystemSha256: context.operationSystemSha256,
    requestSha256: context.canonicalRequestSha256, occurrence: previous?.occurrence ?? context.sameRequestOccurrence,
    hostSessionId: previous?.hostSessionId ?? null, turnId: previous?.turnId ?? null,
    sequenceNo: previous?.sequenceNo ?? null, phase, retryable: previous?.retryable ?? false,
    partialDelivered: previous?.partialDelivered ?? false, hostErrorCode: previous?.hostErrorCode ?? null,
    replyJson: previous?.replyJson ?? null, replySha256: previous?.replySha256 ?? null,
    responseBytes: previous?.responseBytes ?? 0, createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(), ...fields,
  }));

  const saveReply = async (
    context: MemoryModelInvocationContext,
    key: string,
    callKey: string,
    turnId: string,
    sequenceNo: number | null,
    value: unknown,
  ): Promise<void> => {
    if (resumeStore === undefined) return;
    const replyJson = JSON.stringify(value);
    if (replyJson === undefined || Buffer.byteLength(replyJson, "utf8") > REPLY_LIMIT) throw serviceError("MODEL_OUTPUT_INVALID", "Memory model reply is too large", false, "reply_contract");
    await savePhase(context, key, callKey, "reply_ready", {
      turnId, sequenceNo, replyJson, replySha256: sha256(replyJson),
      responseBytes: Buffer.byteLength(replyJson, "utf8"), retryable: false, partialDelivered: false, hostErrorCode: null,
    });
  };

  const selectCall = async (context: MemoryModelInvocationContext, key: string): Promise<{ callKey: string; occurrence: number; prior?: OrganizationCallRecord }> => {
    let state: Awaited<ReturnType<OrganizationResumeStorePort["readResumeState"]>>;
    try { state = await resumeStore!.readResumeState(); }
    catch { throw stateError(); }
    if (state === null) throw stateError();
    const operation = operationRecord(state, key);
    const expectedPair = pairKey(context.canonicalAgentId, context.sourceProjectId);
    if (operation !== undefined && (operation.pairKey !== expectedPair || operation.operationId !== context.operationId
      || operation.agentId !== context.canonicalAgentId || operation.projectId !== context.sourceProjectId)) throw serviceError("MODEL_POLICY_DENIED", "Memory recovery identity does not match", false);
    const checkIdentity = (prior: OrganizationCallRecord, expectedCallKey: string, occurrence: number): void => {
      if (prior.callKey !== expectedCallKey || prior.operationKey !== key || prior.pairKey !== expectedPair
        || prior.modelOperation !== context.modelOperation || prior.operationSystemSha256 !== context.operationSystemSha256
        || prior.requestSha256 !== context.canonicalRequestSha256 || prior.occurrence !== occurrence) {
        throw serviceError("RESOURCE_BUSY", "A prior memory call needs exact identity reconciliation", false, "session_resume");
      }
    };
    let occurrence = context.sameRequestOccurrence;
    for (;;) {
      const callKey = modelCallKey(key, context.modelOperation, context.operationSystemSha256, context.canonicalRequestSha256, occurrence);
      let actualCallKey = callKey;
      let prior = operation?.calls[callKey];
      if (prior !== undefined) checkIdentity(prior, callKey, occurrence);
      if (prior === undefined) {
        const legacyKey = legacyModelCallKey(key, context.modelOperation, context.canonicalRequestSha256, occurrence);
        const legacy = operation?.calls[legacyKey];
        if (legacy !== undefined) {
          checkIdentity(legacy, legacyKey, occurrence);
          actualCallKey = legacyKey;
          prior = legacy;
        }
      }
      if (prior === undefined) return { callKey, occurrence };
      if (prior.replyJson !== null && ["reply_ready", "commit_retry"].includes(prior.phase)) return { callKey: actualCallKey, occurrence, prior };
      if (prior.phase === "failed" && prior.retryable && !prior.partialDelivered) { occurrence += 1; continue; }
      return { callKey: actualCallKey, occurrence, prior };
    }
  };

  const acquireSession = createTurnSessions({
    ai: resumeAi, task, resumeStore, isDisposed: () => disposed, isAbandoned: (id) => abandoned.has(id), deniedModel,
    closeQuietly, persistSession, stateError, publicError, ...(limits.openWaitMs === undefined ? {} : { abandonedWaitMs: limits.openWaitMs }),
  });

  // why: a close that does not settle must not fail a turn whose reply is already saved, so it is remembered and reported once to the next call or release
  const closeTurnSession = async (pair: string, session: PluginBackendAiSessionV1): Promise<void> => {
    live.delete(session);
    let outcome: "closed" | "timeout" = "closed";
    try { outcome = await closeWithin(session); }
    catch { outcome = "timeout"; }
    if (outcome !== "timeout") return;
    abandoned.add(session.sessionId);
    await invalidateSaved(pair, session.sessionId);
    stuckClose = { pair, error: serviceError("RESOURCE_BUSY", "Memory host session close timed out", undefined, "session_close", CLOSE_TIMEOUT_LOCAL_CODE) };
  };

  const journal: TurnJournal | undefined = resumeStore === undefined ? undefined : {
    save: savePhase,
    saveReply,
    persistSession,
  };

  const invoke: MemoryModelPort["invoke"] = async (input) => {
    if (disposed || input.signal.aborted) throw serviceError("RESOURCE_BUSY", "Memory model operation was cancelled", undefined, "cancelled");
    const controller = new AbortController();
    active.add(controller);
    let activePhase: MemoryFailurePhase = "discovery";
    // why: before the send either stop ends the call, so the pre-send steps watch both signals, while the turn itself only obeys the hard one
    const before = new AbortController();
    const stopBefore = (): void => before.abort();
    input.signal.addEventListener("abort", stopBefore, { once: true });
    controller.signal.addEventListener("abort", stopBefore, { once: true });
    let detached = false;
    let sentAt: number | null = null;
    let rejectDetached: (error: Error) => void = () => {};
    const detachedCall = new Promise<never>((_, reject) => { rejectDetached = reject; });
    void detachedCall.catch(() => undefined);
    const bounded = <T>(work: Promise<T> | (() => Promise<T>)): Promise<T> => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => before.signal.removeEventListener("abort", abort);
      const abort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cancelledError());
      };
      if (before.signal.aborted) { reject(cancelledError()); return; }
      before.signal.addEventListener("abort", abort, { once: true });
      let pending: Promise<T>;
      try { pending = typeof work === "function" ? work() : work; }
      catch (error) { settled = true; cleanup(); reject(error); return; }
      Promise.resolve(pending).then((value) => {
        if (settled) return;
        settled = true; cleanup(); resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true; cleanup(); reject(error);
      });
    });
    const invocation = input.invocation;
    const pair = pairKey(invocation?.canonicalAgentId ?? input.agentId, invocation?.sourceProjectId ?? null);
    const opKey = invocation === undefined ? sha256(pair + "|unscoped") : operationKey(pair, invocation.operationId);
    const activeInvocation: MemoryModelInvocationContext = invocation ?? {
      canonicalAgentId: input.agentId, sourceProjectId: null, operationId: "unscoped", modelOperation: input.operation,
      operationSystemSha256: sha256(input.system), canonicalRequestSha256: modelRequestSha256(input.input), sameRequestOccurrence: 0,
    };
    const recovery: CallRecoveryDeps | undefined = resumeStore === undefined ? undefined : {
      resumeStore,
      failCall: async (call, fields) => { await savePhase(activeInvocation, opKey, call.callKey, "failed", fields); },
      persistSession,
    };
    const finish = (): void => {
      input.signal.removeEventListener("abort", stopBefore);
      controller.signal.removeEventListener("abort", stopBefore);
      detachedSince.delete(controller);
      active.delete(controller);
    };
    try {
      if (!operations.has(input.operation)) throw serviceError("MODEL_POLICY_DENIED", "Memory model operation is not allowed", false, "policy");
      if (invocation !== undefined && invocation.canonicalAgentId !== input.agentId) throw serviceError("MODEL_POLICY_DENIED", "Memory invocation identity does not match", false, "policy");
      if (invocation !== undefined && (invocation.modelOperation !== input.operation
        || invocation.operationSystemSha256 !== sha256(input.system)
        || invocation.canonicalRequestSha256 !== modelRequestSha256(input.input)
        || !Number.isSafeInteger(invocation.sameRequestOccurrence) || invocation.sameRequestOccurrence < 0)) {
        throw serviceError("MODEL_POLICY_DENIED", "Memory invocation fingerprint does not match", false, "policy");
      }
      if (resumeStore !== undefined && invocation === undefined) throw serviceError("MODEL_POLICY_DENIED", "Memory invocation scope is missing", false, "policy");
      const selected = settings();
      if (!selected.enabled || !input.policy.enabled) throw serviceError("MODEL_NOT_CONFIGURED", "Memory organization is disabled", false, "policy");
      if (resumeStore !== undefined) {
        const cached = await withPairLock(pair, async () => {
          if (before.signal.aborted || disposed) throw cancelledError();
          const selectedCall = await selectCall(activeInvocation, opKey);
          if (before.signal.aborted || disposed) throw cancelledError();
          return selectedCall;
        }, before.signal);
        if (cached.prior?.replyJson !== null && cached.prior !== undefined) return parseCached(cached.prior);
        if (activeInvocation.allowModelSend === false) throw serviceError("RESOURCE_BUSY", "No exact saved reply is available for local recovery", false, "session_resume");
      }
      activePhase = "discovery";
      const options = await bounded(() => resumeAi.getOptions());
      if (options.quota.state !== "ok") throw serviceError("RESOURCE_BUSY", "Memory AI quota is exhausted", undefined, "quota");
      const providers = options.providers.filter((provider) => provider.state === "ready" && !deniedModel(provider.id));
      const provider = selected.providerId ? providers.find((entry) => entry.id === selected.providerId) : providers.find((entry) => entry.id === options.defaultProviderId) ?? providers[0];
      const models = provider?.models.filter((model) => !deniedModel(model.id)) ?? [];
      const model = selected.modelId ? models.find((entry) => entry.id === selected.modelId) : models.find((entry) => entry.isDefault) ?? models[0];
      if (provider === undefined || model === undefined) throw serviceError("MODEL_NOT_CONFIGURED", "No allowed memory model is ready", false, "policy");
      if (BASE_SYSTEM.length > options.limits.systemChars) throw serviceError("MODEL_POLICY_DENIED", "Memory model system exceeds the host limit", false, "policy");
      const keyedWork = async (): Promise<unknown> => {
        const callInfo = resumeStore === undefined ? undefined : await selectCall(activeInvocation, opKey);
        if (callInfo?.prior?.replyJson !== null && callInfo?.prior !== undefined) return parseCached(callInfo.prior);
        if (activeInvocation.allowModelSend === false) throw serviceError("RESOURCE_BUSY", "No exact saved reply is available for local recovery", false, "session_resume");
        if (callInfo?.prior !== undefined && ["prepared", "sent", "send_unknown"].includes(callInfo.prior.phase) && callInfo.prior.turnId === null) {
          throw serviceError("RESOURCE_BUSY", "Memory send outcome needs reconciliation", undefined, "send_unknown");
        }
        if (callInfo?.prior?.phase === "failed" && !(callInfo.prior.retryable && !callInfo.prior.partialDelivered)) {
          throw callInfo.prior.hostErrorCode === "reply_too_long" || callInfo.prior.hostErrorCode === "empty_reply"
            ? serviceError("MODEL_OUTPUT_INVALID", "The previous memory reply failed validation", false, "reply_contract")
            : serviceError("RESOURCE_BUSY", "The previous memory turn requires reconciliation", false);
        }
        const selectedCallKey = callInfo?.callKey ?? modelCallKey(opKey, input.operation, activeInvocation.operationSystemSha256, activeInvocation.canonicalRequestSha256, activeInvocation.sameRequestOccurrence);
        const envelope = { protocol: "cairn.model-turn/v1", operation: input.operation, callKey: selectedCallKey, operationSystem: input.system, input: input.input };
        const body = JSON.stringify(envelope);
        if (body.length > options.limits.inputChars || Buffer.byteLength(BASE_SYSTEM + body, "utf8") > selected.contextBudget - 2_048) {
          throw serviceError("MODEL_POLICY_DENIED", "Memory input exceeds the configured budget", false);
        }
        const stranded = isStrandedSent(callInfo?.prior) ? callInfo!.prior : undefined;
        if (stranded !== undefined && await reconcileBeforeSession(recovery!, pair, stranded)) return keyedWork();
        activePhase = "session_open";
        let currentSession: PairSession;
        try {
          currentSession = await bounded(() => acquireSession({
            invocation: activeInvocation, pair, operationKey: opKey, providerId: provider.id, modelId: model.id,
            policyRevision: input.policy.revision, signal: before.signal, closedSessionResume: options.capabilities?.closedSessionResume === true, stranded,
          }));
        } catch (error) {
          if (stranded !== undefined && await reconcileAfterResumeError(recovery!, pair, stranded, error)) return keyedWork();
          throw error;
        }
        live.add(currentSession.session);
        let again = false;
        // why: every call owns the one session it opened, and it is closed here before the pair lock and the host slot are let go
        try {
          if (stranded !== undefined && await reconcileWithSession(recovery!, pair, stranded, currentSession.session)) again = true;
          else {
            let stored: OrganizationCallRecord | undefined;
            if (resumeStore !== undefined) {
              stored = callInfo?.prior ?? await savePhase(activeInvocation, opKey, selectedCallKey, "prepared", {
                hostSessionId: currentSession.session.sessionId, turnId: null, sequenceNo: null,
                retryable: false, partialDelivered: false, hostErrorCode: null, replyJson: null,
                replySha256: null, responseBytes: 0, occurrence: callInfo?.occurrence ?? activeInvocation.sameRequestOccurrence,
              });
            }
            return await runTurn({
              current: currentSession, context: activeInvocation, operation: opKey, callKey: selectedCallKey, body,
              savedCall: stored, priorCall: callInfo?.prior, journal, parseCached, parseReply,
              hard: controller.signal, soft: input.signal, limits, isDisposed: () => disposed, ...(trace === undefined ? {} : { trace }),
              setPhase: (phase) => { activePhase = phase; },
              onSent: (at) => { sentAt = at; },
              onDetach: () => {
                if (detached) return;
                detached = true;
                // why: the wait the user sees counts from the send, because the first 30 seconds were spent before the caller was detached
                detachedSince.set(controller, sentAt ?? Date.now());
                rejectDetached(serviceError("MODEL_TIMEOUT", "Memory model operation outlived its caller", undefined, "turn_timeout", DETACHED_LOCAL_CODE));
              },
            }, publicError);
          }
        } finally { await closeTurnSession(pair, currentSession.session); }
        return again ? keyedWork() : undefined;
      };
      const work = invocation === undefined
        ? keyedWork()
        : withPairLock(pair, () => withHostSlot(async () => {
          if (before.signal.aborted || disposed) throw cancelledError();
          if (stuckClose !== null) { const fault = stuckClose.error; stuckClose = null; throw fault; }
          return keyedWork();
        }, before.signal));
      // why: the pair lock and the host slot belong to this tail until the host turn ends, even after the caller was told the call timed out
      const tail: Promise<void> = work.then(() => undefined, () => undefined).finally(() => { tails.delete(tail); if (detached) finish(); });
      tails.add(tail);
      return await Promise.race([work, detachedCall]);
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      const stateCode = (error as { code?: unknown } | null)?.code;
      const stateMessage = (error as { message?: unknown } | null)?.message;
      if (typeof stateCode === "string" && (stateCode.startsWith("organization_resume_") || stateCode === "resume_capacity" || stateCode === "state_file_invalid")) {
        throw serviceError("STORAGE_BUSY", "Memory recovery state is unavailable", undefined, "state");
      }
      if (typeof stateMessage === "string" && stateMessage.startsWith("organization_resume_")) {
        throw serviceError("STORAGE_BUSY", "Memory recovery state is unavailable", undefined, "state");
      }
      throw publicError(error, activePhase);
    } finally {
      if (!detached) finish();
    }
  };

  return {
    resolvePolicy: () => {
      const current = settings();
      return { ...current, contextWindow: current.contextBudget, tokenizerId: "utf8-byte-upper-bound", revision: "host-ai-v1", allowedOperations: operations } as MemoryModelPolicy;
    },
    countTokens: (_policy, text) => Buffer.byteLength(text, "utf8"),
    invoke,
    interrupt() { for (const controller of active) controller.abort(); },
    awaitPair: (agentId, projectId, signal) => withPairLock(pairKey(agentId, projectId), async () => undefined, signal),
    waiting() {
      if (detachedSince.size === 0) return null;
      return { sinceMs: Math.max(0, Date.now() - Math.min(...detachedSince.values())) };
    },
    async releasePair(agentId, projectId) {
      const pair = pairKey(agentId, projectId);
      // why: the turn already closed its own session, so this only waits behind a running turn and reports a close that timed out
      await withPairLock(pair, () => withHostSlot(async () => {
        if (stuckClose?.pair !== pair) return;
        const fault = stuckClose.error;
        stuckClose = null;
        throw fault;
      }));
    },
    async cancel() {
      disposed = true;
      for (const controller of active) controller.abort();
      // why: the hard stop gets a bounded moment to leave every turn closed in the journal, and that bound belongs to shutdown, not to the model
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all([...tails]), new Promise<void>((resolve) => { timer = setTimeout(resolve, closeTimeoutMs); })]);
      clearTimeout(timer);
      await Promise.all([...live].map(closeQuietly).concat(acquireSession.idle(closeTimeoutMs)));
      live.clear();
    },
  };
}
