import { randomBytes } from "node:crypto";
import type { PunchReceiptStorePort, OrganizationResumeStorePort, OrganizationDailyRound, OrganizationResumeState, OrganizationTrial, OrganizationTrialHaltReason, SettledPunch } from "./punchDataPorts.js";
import { buildPunchSourceMessages, punchOperationId } from "./punchContent.js";
import type { MemoryActor } from "../contracts/actor.js";
import { memoryCaptureSchema, type MemoryCaptureInput } from "./toolContract.js";
import type { MemoryResult } from "../domain/errors.js";
import { failure } from "../domain/errors.js";
import { memoryActorSchema } from "../../vendor/teamuq-contract/contract.mjs";
import { operationKey, pairKey } from "./modelInvocationScope.js";
import { dailyRoundStatus, failedModelAttemptInRound, isRecord, localRoundDate, nextLocalDay, phaseOf, replyReady, type Job } from "./organizationJobState.js";
import { classifyLegacyJob, isTrialRow, summarizeTrial, trialBreaker, type LegacyTrialRequest, type LegacyTrialResponse, type TrialSummary } from "./organizationTrial.js";

export interface OrganizationStatus {
  readonly state: "disabled" | "idle" | "running" | "paused" | "error";
  readonly admitted: number | null;
  readonly pending: number;
  readonly replyReady: number;
  readonly completed: number;
  readonly legacyUnlinked: number;
  readonly legacyTrialCandidates?: number;
  readonly trial?: TrialSummary | null;
  readonly schemaSkipped: number | null;
  readonly diagnosticsAvailable: boolean | null;
  readonly sourceGeneration: string | null;
  readonly sourceHighWatermark: string | null;
  readonly sourcePages: number | null;
  readonly sourceScanned: number | null;
  readonly sourceReceived: number | null;
  readonly sourceEligible: number | null;
  readonly sourceCheckpointed: boolean | null;
  readonly lastError: string | null;
  readonly errorPhase: string | null;
  readonly hostErrorCode: string | null;
  readonly localErrorCode: string | null;
  readonly retryable: boolean | null;
  readonly partialDelivered: boolean | null;
  readonly lastAttemptAt: number | null;
  readonly updatedAt: number | null;
  readonly dailyRound: null | {
    readonly date: string;
    readonly roundId: string;
    readonly state: "running" | "paused" | "completed";
    readonly nextResumeAt: number | null;
    readonly snapshotHighWatermark: number;
    readonly snapshotMembers: number;
    readonly completedMembers: number;
    readonly deferredMembers: number;
  };
}

export interface OrganizationReleaseFault {
  readonly code: string;
  readonly phase: string;
  readonly localCode: string | null;
  readonly retryable: boolean;
  readonly at: number;
}

type OrganizationStore = PunchReceiptStorePort & Partial<Pick<OrganizationResumeStorePort,
  "enqueueJob" | "readResumeState" | "transactResumeState" | "beginOrResumeDailyRound" | "updateDailyRound" | "pruneOperation" | "hasRecoverableReply" | "completeJobAndPruneOperation" | "adoptLegacyJobs" | "revertTrialJobs" | "readTrial" | "writeTrial"
>>;

export interface OrganizationOptions {
  readonly store: OrganizationStore;
  readonly enabled: () => boolean;
  readonly frequency?: () => "daily" | "immediate";
  readonly dailyTime?: () => string;
  readonly claimDailyRound?: (localDate: string) => Promise<boolean>;
  readonly beginOrResumeDailyRound?: OrganizationResumeStorePort["beginOrResumeDailyRound"];
  readonly capture: (job: { actor: MemoryActor; input: MemoryCaptureInput; memoryId: string; allowModelSend?: boolean }) => Promise<MemoryResult<unknown>>;
  readonly now?: () => number;
  readonly pollMs?: number;
}

export function createPunchOrganizationWorker(options: OrganizationOptions) {
  const now = options.now ?? Date.now;
  let stopped = false;
  let started = false;
  let startupReady = true;
  let requested = false;
  let retryNow = false;
  let knownKeys: Set<string> | undefined;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopRequested = false;
  let trialQueue: Promise<unknown> = Promise.resolve();
  // why: a failed host-session release happens after the job result is final, so no job row carries it; each pair keeps its own record and the map order is recency
  const releaseFaults = new Map<string, OrganizationReleaseFault>();
  let status: OrganizationStatus = {
    state: "disabled", admitted: 0, pending: 0, replyReady: 0, completed: 0, legacyUnlinked: 0, legacyTrialCandidates: 0, trial: null,
    schemaSkipped: null, diagnosticsAvailable: null, lastError: null, errorPhase: null,
    sourceGeneration: null, sourceHighWatermark: null, sourcePages: null, sourceScanned: null,
    sourceReceived: null, sourceEligible: null, sourceCheckpointed: null,
    hostErrorCode: null, localErrorCode: null, retryable: null, partialDelivered: null, lastAttemptAt: null, updatedAt: null, dailyRound: null,
  };
  const frequency = (): "daily" | "immediate" => options.frequency?.() === "immediate" ? "immediate" : "daily";
  const resumeState = async (): Promise<OrganizationResumeState | null> => options.store.readResumeState === undefined ? null : options.store.readResumeState();
  const trialState = async (): Promise<OrganizationTrial | null> => options.store.readTrial === undefined ? null : options.store.readTrial();
  const jobs = async () => {
    const rows = [];
    let cursor: string | null = null;
    do {
      const page = await options.store.readPage(cursor, 100);
      for (const row of page.records) {
        const job = row.value as Job;
        if (job?.version !== 1 || job.punchId !== row.key || typeof job.memoryId !== "string" || job.memoryId.length === 0 || !memoryActorSchema.safeParse(job.actor).success || !["pending", "completed", "skipped"].includes(job.state) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || !Number.isSafeInteger(job.nextAttemptAt) || job.nextAttemptAt < 0 || (job.lastError !== null && typeof job.lastError !== "string") || !Array.isArray(job.input?.messages)
          || job.input.operationId !== "organize:" + punchOperationId(job.punchId) || job.input.scope !== (job.actor.projectId === null ? "personal" : "project") || (job.state === "pending" && !memoryCaptureSchema.safeParse(job.input).success)
          || (job.queueSequence !== undefined && (!Number.isSafeInteger(job.queueSequence) || job.queueSequence < 1))
          || (job.resumeDisposition !== undefined && !["legacy_unlinked", "eligible", "resolved"].includes(job.resumeDisposition))
          || (job.lastAttemptDate !== undefined && !(job.lastAttemptDate === null || /^\d{4}-\d{2}-\d{2}$/u.test(job.lastAttemptDate)))
          || (job.lastAttemptAt !== undefined && !(job.lastAttemptAt === null || Number.isSafeInteger(job.lastAttemptAt)))
          || (job.errorPhase !== undefined && !(job.errorPhase === null || typeof job.errorPhase === "string"))
          || (job.hostErrorCode !== undefined && !(job.hostErrorCode === null || typeof job.hostErrorCode === "string"))
          || (job.localErrorCode !== undefined && !(job.localErrorCode === null || typeof job.localErrorCode === "string"))
          || (job.retryable !== undefined && !(job.retryable === null || typeof job.retryable === "boolean"))
          || (job.partialDelivered !== undefined && !(job.partialDelivered === null || typeof job.partialDelivered === "boolean"))
          || (job.outcome !== undefined && !(job.outcome === null || ["committed", "empty_success", "skipped"].includes(job.outcome)))
          || (job.adoptedBatchId !== undefined && !(typeof job.adoptedBatchId === "string" && job.adoptedBatchId.length > 0))
          || (job.adoptedAt !== undefined && !Number.isSafeInteger(job.adoptedAt))) throw new Error("organization_state_invalid");
        rows.push({ row, job });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    rows.sort((left, right) => (left.job.queueSequence ?? Number.MAX_SAFE_INTEGER) - (right.job.queueSequence ?? Number.MAX_SAFE_INTEGER) || left.row.key.localeCompare(right.row.key));
    knownKeys ??= new Set(rows.map(({ row }) => row.key));
    return rows;
  };
  const updateStatus = async (rows: Awaited<ReturnType<typeof jobs>>, round: { date: string; value: OrganizationDailyRound } | null): Promise<void> => {
    const resume = await resumeState();
    const trial = await trialState();
    const pendingRows = rows.filter(({ job }) => job.state === "pending");
    const replyCount = pendingRows.filter(({ job }) => replyReady(resume, job)).length;
    const legacy = pendingRows.filter(({ job }) => job.resumeDisposition === "legacy_unlinked").length;
    // why: a legacy_unlinked job is never retried and stays out of the round, so its old error would be a permanent red light and would hide a release fault
    const firstError = pendingRows.find(({ job }) => job.resumeDisposition !== "legacy_unlinked" && (job.lastError !== null || phaseOf(resume, job, now()).phase === "operator_reconcile"));
    const phase = firstError === undefined ? { phase: null, hostCode: null, localCode: null, partial: null } : phaseOf(resume, firstError.job, now());
    const lastSource = resume?.lastSourceRun;
    status = {
      ...status,
      state: !options.enabled() ? "disabled" : firstError === undefined ? (legacy > 0 ? "paused" : "idle") : phase.phase === "operator_reconcile" || firstError.job.lastError === "MODEL_NOT_CONFIGURED" || firstError.job.lastError === "MODEL_POLICY_DENIED" || firstError.job.lastError === "RESOURCE_BUSY" ? "paused" : "error",
      admitted: lastSource?.admitted ?? null,
      pending: pendingRows.length - legacy,
      replyReady: replyCount,
      completed: rows.filter(({ job }) => job.state === "completed").length,
      legacyUnlinked: legacy,
      legacyTrialCandidates: resume === null ? 0 : pendingRows.filter(({ job }) => classifyLegacyJob(job, resume) === "candidate").length,
      trial: trial === null ? null : summarizeTrial(trial, rows),
      schemaSkipped: lastSource?.schemaSkipped ?? null,
      diagnosticsAvailable: lastSource === undefined ? null : lastSource.schemaSkipped === null ? false : true,
      sourceGeneration: lastSource?.generation ?? null,
      sourceHighWatermark: lastSource?.highWatermark ?? null,
      sourcePages: lastSource?.pages ?? null,
      sourceScanned: lastSource?.scanned ?? null,
      sourceReceived: lastSource?.received ?? null,
      sourceEligible: lastSource?.eligible ?? null,
      sourceCheckpointed: lastSource?.checkpointed ?? null,
      lastError: firstError === undefined ? null : firstError.job.lastError ?? (phase.phase === "operator_reconcile" ? "OPERATOR_RECONCILE" : null),
      errorPhase: phase.phase ?? firstError?.job.errorPhase ?? null,
      hostErrorCode: phase.hostCode,
      localErrorCode: phase.localCode,
      retryable: firstError?.job.retryable ?? null,
      partialDelivered: phase.partial ?? firstError?.job.partialDelivered ?? null,
      lastAttemptAt: firstError?.job.lastAttemptAt ?? null,
      updatedAt: lastSource?.updatedAt ?? firstError?.job.lastAttemptAt ?? null,
      dailyRound: round === null ? status.dailyRound : dailyRoundStatus(round.date, round.value),
    };
  };
  // why: a stop only raises a flag and the single-flight run is the one place that reverts, so a revert can never meet a job write that is in progress
  const endTrial = async (state: "halted" | "stopped", haltReason: OrganizationTrialHaltReason | null): Promise<void> => {
    const trial = await trialState();
    if (trial?.state === "running") await options.store.revertTrialJobs?.(trial.batchId, { state, endedAt: now(), haltReason });
    stopRequested = false;
  };
  const trialAnswer = async (action: "start" | "stop", requested: number, adopted: number, blocked: LegacyTrialResponse["blocked"]): Promise<LegacyTrialResponse> => {
    const rows = await jobs();
    const resume = await resumeState();
    const trial = await trialState();
    const kinds = resume === null ? [] : rows.map(({ job }) => classifyLegacyJob(job, resume));
    const trialSummary = trial === null ? null : summarizeTrial(trial, rows);
    const legacy = rows.filter(({ job }) => job.state === "pending" && job.resumeDisposition === "legacy_unlinked").length;
    const candidates = kinds.filter((kind) => kind === "candidate").length;
    status = { ...status, trial: trialSummary, legacyTrialCandidates: candidates, legacyUnlinked: legacy, pending: rows.filter(({ job }) => job.state === "pending").length - legacy };
    return { action, requested, adopted, candidates, skippedAmbiguous: kinds.filter((kind) => kind === "ambiguous").length, blocked, trial: trialSummary };
  };
  const run = async (): Promise<void> => {
    if (stopRequested) await endTrial("stopped", null);
    const rows = await jobs();
    const currentFrequency = frequency();
    const dailyTime = options.dailyTime?.() ?? "02:00";
    const schedule = localRoundDate(now(), dailyTime);
    const savedResume = await resumeState();
    const existingRound = savedResume?.dailyRounds[schedule.date];
    let round: OrganizationDailyRound | null = existingRound ?? null;
    let roundActive = currentFrequency === "immediate";
    if (!options.enabled()) {
      await updateStatus(rows, existingRound === undefined ? null : { date: schedule.date, value: existingRound });
      return;
    }
    const trial = await trialState();
    const trialBatch = trial?.state === "running" ? trial.batchId : null;
    const hasTrialRows = rows.some(({ job }) => isTrialRow(job, trialBatch));
    let trialEnded = false;
    let dailyClosed = false;
    let replyOnly = false;
    if (currentFrequency === "daily") {
      if (!startupReady) { await updateStatus(rows, existingRound === undefined ? null : { date: schedule.date, value: existingRound }); return; }
      if (existingRound?.state === "completed") {
        const deferredMembers = rows.filter(({ job }) => job.state === "pending" && job.resumeDisposition !== "legacy_unlinked"
          && job.queueSequence !== undefined && job.queueSequence > existingRound.snapshot.queueSequenceHighWatermark).length;
        const deferredLegacyCount = rows.filter(({ job }) => job.state === "pending" && job.resumeDisposition === "legacy_unlinked").length;
        const updatedRound = { ...existingRound, updatedAt: now(), deferredMembers, deferredLegacyCount };
        await options.store.updateDailyRound?.(schedule.date, updatedRound);
        round = updatedRound;
        replyOnly = true;
      }
      // why: while a trial has jobs left, a closed daily round must not end the run, but it also must not start a round or send daily members
      dailyClosed = existingRound === undefined && !schedule.due;
      const beginRound = options.beginOrResumeDailyRound ?? options.store.beginOrResumeDailyRound;
      if (!dailyClosed && beginRound !== undefined) {
        const begun = await beginRound(schedule.date, {
          generation: savedResume?.lastSourceRun?.generation ?? null,
          highWatermark: savedResume?.lastSourceRun?.highWatermark ?? null,
        }, now());
        round = begun.round ?? (existingRound?.state === "completed" ? round : null);
        roundActive = begun.shouldRun;
        replyOnly = begun.replyOnly === true || replyOnly;
      } else if (!dailyClosed && options.claimDailyRound !== undefined) {
        roundActive = existingRound !== undefined || await options.claimDailyRound(schedule.date);
        replyOnly = !roundActive;
      }
      if (!roundActive && !replyOnly) {
        if (!hasTrialRows) { await updateStatus(rows, round === null ? null : { date: schedule.date, value: round }); return; }
        dailyClosed = true;
      }
    }
    await updateStatus(rows, round === null ? null : { date: schedule.date, value: round });
    const state = await resumeState();
    const previousFailure = rows.find(({ job }) => job.lastError !== null && job.state !== "skipped" && job.resumeDisposition !== "legacy_unlinked")?.job.lastError ?? null;
    status = { ...status, state: !options.enabled() ? "disabled" : previousFailure === null ? "idle" : previousFailure === "MODEL_NOT_CONFIGURED" || previousFailure === "MODEL_POLICY_DENIED" || previousFailure === "RESOURCE_BUSY" ? "paused" : "error" };
    if (!options.enabled()) return;
    const runFrequency = currentFrequency;
    const immediateRetry = runFrequency === "immediate" && retryNow;
    retryNow = false;
    const date = schedule.date;
    const eligibleRows = rows.filter(({ job }) => {
      if (isTrialRow(job, trialBatch)) return true;
      if (dailyClosed || job.state !== "pending" || job.resumeDisposition === "legacy_unlinked") return false;
      if (runFrequency === "daily" && replyOnly) return replyReady(state, job);
      if (runFrequency === "daily") return round !== null && job.queueSequence !== undefined && job.queueSequence <= round.snapshot.queueSequenceHighWatermark;
      return true;
    }).sort((left, right) => Number(isTrialRow(right.job, trialBatch)) - Number(isTrialRow(left.job, trialBatch)));
    let attempted = false;
    for (const { row, job } of eligibleRows) {
      if (stopped || !options.enabled() || frequency() !== runFrequency) break;
      const trialRow = isTrialRow(job, trialBatch);
      if (trialRow && !trialEnded && stopRequested) { trialEnded = true; await endTrial("stopped", null); }
      if (trialRow && trialEnded) continue;
      if (phaseOf(state, job, now()).phase === "operator_reconcile") continue;
      const hasReply = replyReady(state, job);
      const dailySendBlocked = !trialRow && runFrequency === "daily"
        && (job.lastAttemptDate === date || failedModelAttemptInRound(state, job, date, dailyTime));
      if (dailySendBlocked && !hasReply) continue;
      if (!immediateRetry && !hasReply && job.nextAttemptAt > now()) continue;
      attempted = true;
      status = { ...status, state: "running" };
      const attemptedAt = now();
      let result: MemoryResult<unknown>;
      try { result = await options.capture({ ...job, allowModelSend: trialRow || (!replyOnly && !dailySendBlocked) }); } catch (error) { result = failure("organization", error); }
      if (stopped) break;
      const value = result.ok ? result.value : null;
      const processing = isRecord(value) && value.processing === true;
      const classification = isRecord(value) && isRecord(value.classification) ? value.classification : undefined;
      const classificationFailed = classification?.status === "failed";
      const code = result.ok
        ? processing ? "RESOURCE_BUSY" : classificationFailed ? (isRecord(classification.error) && "code" in classification.error ? String(classification.error.code).toUpperCase() : "INTERNAL") : null
        : result.error.code;
      const terminalOutcome = code === null
        ? classification?.status === "skipped" || (isRecord(value) && value.emptySuccess === true) ? "empty_success" as const : "committed" as const
        : null;
      const nextState: Job["state"] = terminalOutcome !== null ? "completed" : code === "MEMORY_SUPPRESSED" ? "skipped" : "pending";
      const latestResume = await resumeState();
      const reportedPhase = !result.ok ? result.error.phase ?? null : classificationFailed ? "cairn_schema" : null;
      const attemptLocalCode = !result.ok ? result.error.localCode ?? null : null;
      const errorInfo = nextState === "pending" ? phaseOf(latestResume, job, now(), attemptLocalCode) : { phase: null, journalPhase: null, hostCode: null, localCode: null, partial: null };
      const next: Job = {
        ...job,
        state: nextState,
        input: nextState === "pending" ? job.input : { ...job.input, messages: [] },
        attempts: job.attempts + 1,
        nextAttemptAt: code === null ? 0 : nextState === "pending" ? attemptedAt + Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts, 7)) : 0,
        lastError: nextState === "skipped" ? null : code,
        resumeDisposition: nextState === "pending" ? job.resumeDisposition ?? "eligible" : "resolved",
        lastAttemptDate: date,
        lastAttemptAt: attemptedAt,
        errorPhase: reportedPhase ?? (code === "STORAGE_BUSY" && (errorInfo.journalPhase === "reply_ready" || errorInfo.journalPhase === "commit_retry")
          ? "commit"
          : errorInfo.phase ?? (code === null ? null : code === "STORAGE_BUSY" ? "commit" : "model")),
        hostErrorCode: errorInfo.hostCode,
        localErrorCode: errorInfo.localCode,
        retryable: nextState === "pending" ? (result.ok ? code !== null : result.error.retryable) : null,
        partialDelivered: errorInfo.partial,
        outcome: terminalOutcome ?? (nextState === "skipped" ? "skipped" : null),
      };
      const completionRecord = { key: row.key, value: next, expectedRevision: row.revision };
      const pair = pairKey(job.actor.agentId, job.actor.projectId);
      const key = operationKey(pair, job.input.operationId);
      if (nextState !== "pending" && options.store.completeJobAndPruneOperation !== undefined) {
        await options.store.completeJobAndPruneOperation(completionRecord, key);
      } else {
        await options.store.writeBatch([completionRecord]);
      }
      if (nextState === "pending" && code === "STORAGE_BUSY" && replyReady(latestResume, job)) {
        await options.store.transactResumeState?.((resume) => {
          const operation = resume.operations[key];
          if (operation === undefined) return resume;
          const calls = Object.fromEntries(Object.entries(operation.calls).map(([callKey, call]) => [
            callKey,
            call.phase === "reply_ready" ? { ...call, phase: "commit_retry" as const, updatedAt: now() } : call,
          ]));
          return { ...resume, operations: { ...resume.operations, [key]: { ...operation, calls, updatedAt: now() } } };
        });
      }
      if (nextState !== "pending" && options.store.completeJobAndPruneOperation === undefined) {
        await options.store.pruneOperation?.(key);
      }
      status = { ...status, lastError: nextState === "skipped" ? null : code, errorPhase: next.errorPhase ?? null, hostErrorCode: next.hostErrorCode ?? null, localErrorCode: next.localErrorCode ?? null, retryable: next.retryable ?? null, partialDelivered: next.partialDelivered ?? null, lastAttemptAt: attemptedAt, updatedAt: attemptedAt };
      if (trialRow && trial !== null) {
        const latestRows = await jobs();
        // why: the counts come from the job rows, so refreshing them after every job keeps the status line moving during a long trial
        status = { ...status, trial: summarizeTrial(trial, latestRows) };
        const halt = trialBreaker(latestRows, trialBatch!);
        if (halt !== null) { trialEnded = true; await endTrial("halted", halt); }
      }
    }
    if (trial?.state === "running" && !trialEnded) {
      if (stopRequested) await endTrial("stopped", null);
      else if (!(await jobs()).some(({ job }) => isTrialRow(job, trialBatch))) await options.store.writeTrial?.({ ...trial, state: "completed", endedAt: now() });
    }
    if (round !== null && runFrequency === "daily" && options.store.updateDailyRound !== undefined) {
      const latestRows = await jobs();
      const members = latestRows.filter(({ job }) => job.queueSequence !== undefined && job.queueSequence <= round!.snapshot.queueSequenceHighWatermark && job.resumeDisposition !== "legacy_unlinked");
      const remaining = members.filter(({ job }) => job.state === "pending");
      const newerPending = latestRows.filter(({ job }) => job.state === "pending" && job.resumeDisposition !== "legacy_unlinked"
        && job.queueSequence !== undefined && job.queueSequence > round!.snapshot.queueSequenceHighWatermark).length;
      const roundState: OrganizationDailyRound = {
        ...round,
        state: remaining.length === 0 ? "completed" : "paused",
        updatedAt: now(),
        nextResumeAt: remaining.length === 0 ? null : nextLocalDay(now()),
        completedAt: remaining.length === 0 ? now() : null,
        lastPhase: status.errorPhase,
        completedMembers: members.filter(({ job }) => job.state !== "pending").length,
        deferredMembers: remaining.length + newerPending,
        deferredLegacyCount: latestRows.filter(({ job }) => job.state === "pending" && job.resumeDisposition === "legacy_unlinked").length,
      };
      await options.store.updateDailyRound(date, roundState);
      round = roundState;
      await updateStatus(latestRows, { date, value: roundState });
      status = { ...status, state: remaining.length === 0 ? (status.legacyUnlinked > 0 ? "paused" : "idle") : status.lastError === null ? "paused" : status.lastError === "OPERATOR_RECONCILE" || status.lastError === "MODEL_NOT_CONFIGURED" || status.lastError === "MODEL_POLICY_DENIED" || status.lastError === "RESOURCE_BUSY" ? "paused" : "error" };
    } else {
      const latestRows = await jobs();
      await updateStatus(latestRows, null);
      const error = latestRows.find(({ job }) => job.state === "pending" && job.lastError !== null && job.resumeDisposition !== "legacy_unlinked")?.job.lastError ?? null;
      status = { ...status, state: !options.enabled() ? "disabled" : error === null ? (status.legacyUnlinked > 0 ? "paused" : "idle") : error === "OPERATOR_RECONCILE" || error === "MODEL_NOT_CONFIGURED" || error === "MODEL_POLICY_DENIED" || error === "RESOURCE_BUSY" ? "paused" : "error" };
    }
    if (!attempted && status.state === "running") status = { ...status, state: "idle" };
  };
  const wake = (): void => {
    if (stopped || !started) return;
    if (active !== null) { requested = true; return; }
    active = run().catch(() => { status = { ...status, state: "error", lastError: "STORAGE_BUSY", errorPhase: "state", hostErrorCode: null, localErrorCode: null }; }).finally(() => {
      active = null;
      if (requested && !stopped) { requested = false; wake(); }
    });
  };
  return {
    async enqueue(punch: SettledPunch, memoryId: string) {
      if (knownKeys === undefined) await jobs();
      if (knownKeys!.has(punch.id)) return;
      const job: Job = {
        version: 1, punchId: punch.id, memoryId,
        actor: { agentId: punch.agentId, projectId: punch.projectId, sessionId: punch.sessionId ?? "no-session", providerId: punch.providerId ?? "unknown" },
        input: { scope: punch.projectId === null ? "personal" : "project", operationId: "organize:" + punchOperationId(punch.id), messages: buildPunchSourceMessages(punch) },
        state: "pending", attempts: 0, nextAttemptAt: 0, lastError: null, resumeDisposition: "eligible", lastAttemptDate: null,
        lastAttemptAt: null, errorPhase: null, hostErrorCode: null, localErrorCode: null, retryable: null, partialDelivered: null, outcome: null,
      };
      if (options.store.enqueueJob !== undefined) await options.store.enqueueJob(punch.id, job, "work-record", punch.id);
      else await options.store.writeBatch([{ key: punch.id, value: job, expectedRevision: null, sourceKind: "work-record", sourceId: punch.id }]);
      knownKeys!.add(punch.id);
      wake();
    },
    async forgetSource(agentId: string, memoryId: string) {
      const rows = (await jobs()).filter(({ job }) => job.actor.agentId === agentId && job.memoryId === memoryId);
      for (const { row, job } of rows) {
        const record = { key: row.key, value: { ...job, state: "skipped" as const, input: { ...job.input, messages: [] }, nextAttemptAt: 0, lastError: null, resumeDisposition: "resolved" as const, outcome: "skipped" as const }, expectedRevision: row.revision };
        const operation = operationKey(pairKey(job.actor.agentId, job.actor.projectId), job.input.operationId);
        if (options.store.completeJobAndPruneOperation !== undefined) await options.store.completeJobAndPruneOperation(record, operation);
        else {
          await options.store.writeBatch([record]);
          await options.store.pruneOperation?.(operation);
        }
      }
      wake();
    },
    start(settings: { readonly deferInitialRun?: boolean } = {}) {
      if (started || stopped) return;
      started = true;
      startupReady = settings.deferInitialRun !== true;
      timer = setInterval(wake, options.pollMs ?? 30_000);
      timer.unref();
      wake();
    },
    resumeStartup() { if (!started || stopped || startupReady) return; startupReady = true; requested = false; wake(); },
    wake,
    settingsChanged() { retryNow = true; wake(); },
    legacyTrial(request: LegacyTrialRequest): Promise<LegacyTrialResponse> {
      const answer = trialQueue.then(async (): Promise<LegacyTrialResponse> => {
        if (request.action === "stop") {
          const trial = await trialState();
          if (trial?.state !== "running") return trialAnswer("stop", trial?.requested ?? 0, trial?.adopted ?? 0, "not_running");
          stopRequested = true;
          const idle = active === null;
          wake();
          if (idle) await active;
          return trialAnswer("stop", trial.requested, trial.adopted, null);
        }
        if (!options.enabled()) return trialAnswer("start", request.count, 0, "disabled");
        if (options.store.adoptLegacyJobs === undefined) throw new Error("organization_trial_unsupported");
        const batchId = "trial-" + now().toString(36) + "-" + randomBytes(2).toString("hex");
        const adoption = await options.store.adoptLegacyJobs({ requestId: request.requestId, count: request.count, batchId, at: now() });
        if (adoption.blocked === null && !adoption.replayed) wake();
        return trialAnswer("start", request.count, adoption.adopted, adoption.blocked);
      });
      trialQueue = answer.catch(() => undefined);
      return answer;
    },
    noteReleaseFault(pair: string, fault: OrganizationReleaseFault | null) {
      releaseFaults.delete(pair);
      if (fault !== null) releaseFaults.set(pair, fault);
    },
    status: (): OrganizationStatus => {
      const current: OrganizationStatus = { ...status, ...(!options.enabled() ? { state: "disabled" as const } : {}) };
      const releaseFault = [...releaseFaults.values()].pop() ?? null;
      // why: a job's own failure is the more specific cause, so the release fault only fills an otherwise clean status
      if (releaseFault === null || current.state === "disabled" || current.lastError !== null) return current;
      return {
        ...current, state: current.state === "idle" ? "paused" : current.state, lastError: releaseFault.code, errorPhase: releaseFault.phase,
        hostErrorCode: null, localErrorCode: releaseFault.localCode, retryable: releaseFault.retryable, lastAttemptAt: releaseFault.at, updatedAt: releaseFault.at,
      };
    },
    async idle() { while (active !== null) await active; },
    async stop() { stopped = true; if (timer !== undefined) clearInterval(timer); await active; },
  };
}
