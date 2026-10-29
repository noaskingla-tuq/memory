import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { OrganizationDailyRound, OrganizationResumeState, OrganizationResumeStorePort, PunchReceiptStorePort, PunchStateRecord } from "../../application/punchDataPorts.js";
import { legacyModelCallKey, modelCallKey } from "../../application/modelInvocationScope.js";
import type { MemoryModelOperation } from "../../application/modelPort.js";

const DAILY_ROUND_HISTORY_LIMIT = 32;
const DAILY_CLAIM_HISTORY_LIMIT = 32;

interface SavedState {
  version: 1;
  records: Record<string, PunchStateRecord>;
  organizationClaims?: { version: 1; dates: string[]; throughDate?: string };
  organizationQueueSequence?: number;
  organizationResume?: unknown;
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

export function createLocalPunchReceiptStore(dataDir: string, name = "punch-state.json"): PunchReceiptStorePort {
  return createLocalStore(dataDir, name, false).store;
}

export function createLocalPunchOrganizationStore(dataDir: string): OrganizationResumeStorePort & { claimDailyRound(date: string): Promise<boolean> } {
  const local = createLocalStore(dataDir, "punch-organization.json", true);
  return Object.assign(local.store, { claimDailyRound: local.claimDailyRound });
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function maxLocalDate(...dates: (string | null | undefined)[]): string | undefined {
  const valid = dates.filter((date): date is string => date !== null && date !== undefined && validLocalDate(date));
  return valid.length === 0 ? undefined : valid.sort().at(-1);
}

function retainedClaimDates(dates: readonly string[], _throughDate: string | undefined): string[] {
  return [...new Set(dates.filter(validLocalDate))].sort().slice(-DAILY_CLAIM_HISTORY_LIMIT);
}

function retainDailyRounds(rounds: Readonly<Record<string, OrganizationDailyRound>>): Readonly<Record<string, OrganizationDailyRound>> {
  const entries = Object.entries(rounds);
  const active = entries.filter(([, round]) => round.state === "running" || round.state === "paused");
  const closed = entries.filter(([, round]) => round.state === "completed" || round.state === "superseded")
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, Math.max(0, DAILY_ROUND_HISTORY_LIMIT - active.length));
  return Object.fromEntries([...active, ...closed]);
}

function supersedeOtherRounds(
  rounds: Readonly<Record<string, OrganizationDailyRound>>,
  keepDate: string | null,
  updatedAt: number,
): Readonly<Record<string, OrganizationDailyRound>> {
  return Object.fromEntries(Object.entries(rounds).map(([date, round]) => [date,
    (date !== keepDate && (round.state === "running" || round.state === "paused"))
      ? { ...round, state: "superseded" as const, updatedAt, nextResumeAt: null }
      : round,
  ]));
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resumeState(value: unknown): OrganizationResumeState | null {
  if (value === undefined) return { version: 1, sessions: {}, operations: {}, dailyRounds: {} };
  if (!objectRecord(value) || value.version !== 1 || !objectRecord(value.sessions) || !objectRecord(value.operations) || !objectRecord(value.dailyRounds)) return null;
  if (value.claimedThroughDate !== undefined && !validLocalDate(value.claimedThroughDate)) return null;
  for (const [sessionKey, session] of Object.entries(value.sessions)) {
    if (!objectRecord(session) || session.version !== 1 || typeof session.pairKey !== "string" || !/^[a-f0-9]{64}$/u.test(session.pairKey) || typeof session.agentId !== "string"
      || !(session.projectId === null || typeof session.projectId === "string") || typeof session.hostSessionId !== "string"
      || session.baseSystemVersion !== 1 || !(session.taskId === null || typeof session.taskId === "string")
      || typeof session.baseSystemSha256 !== "string" || typeof session.providerId !== "string" || typeof session.modelId !== "string"
      || typeof session.policyRevision !== "string" || !Number.isSafeInteger(session.openedAt) || !Number.isSafeInteger(session.lastUsedAt)
      || !Number.isSafeInteger(session.turnCount) || !["active", "expired", "resume_unavailable", "invalidated"].includes(String(session.state))
      || sessionKey !== session.pairKey || session.pairKey !== hash(JSON.stringify([session.agentId, session.projectId]))) return null;
  }
  for (const [operationStateKey, operation] of Object.entries(value.operations)) {
    if (!objectRecord(operation) || typeof operation.operationKey !== "string" || typeof operation.pairKey !== "string"
      || typeof operation.operationId !== "string" || typeof operation.agentId !== "string"
      || !(operation.projectId === null || typeof operation.projectId === "string") || !objectRecord(operation.calls)
      || !Number.isSafeInteger(operation.updatedAt)
      || operation.operationKey !== operationStateKey
      || operation.pairKey !== hash(JSON.stringify([operation.agentId, operation.projectId]))
      || operation.operationKey !== hash(operation.pairKey + "|" + operation.operationId)) return null;
    for (const [callStateKey, call] of Object.entries(operation.calls)) {
      const callVersion = call && typeof call === "object" && !Array.isArray(call) ? (call as Record<string, unknown>).callKeyVersion : undefined;
      if (!objectRecord(call) || typeof call.callKey !== "string" || typeof call.operationKey !== "string" || typeof call.pairKey !== "string"
        || typeof call.modelOperation !== "string" || typeof call.operationSystemSha256 !== "string" || typeof call.requestSha256 !== "string"
        || (callVersion !== undefined && callVersion !== 2)
        || !Number.isSafeInteger(call.occurrence) || !(call.hostSessionId === null || typeof call.hostSessionId === "string")
        || !(call.turnId === null || typeof call.turnId === "string") || !(call.sequenceNo === null || Number.isSafeInteger(call.sequenceNo))
        || !["prepared", "sent", "reply_ready", "commit_retry", "send_unknown", "failed"].includes(String(call.phase))
        || typeof call.retryable !== "boolean" || typeof call.partialDelivered !== "boolean"
        || !(call.hostErrorCode === null || typeof call.hostErrorCode === "string")
        || !(call.replyJson === null || typeof call.replyJson === "string") || !(call.replySha256 === null || typeof call.replySha256 === "string")
        || !Number.isSafeInteger(call.responseBytes) || !Number.isSafeInteger(call.createdAt) || !Number.isSafeInteger(call.updatedAt)) return null;
      if (callStateKey !== call.callKey || call.operationKey !== operation.operationKey || call.pairKey !== operation.pairKey
        || !/^[a-f0-9]{64}$/u.test(call.operationSystemSha256) || !/^[a-f0-9]{64}$/u.test(call.requestSha256)
        || (callVersion === 2
          ? call.callKey !== modelCallKey(operation.operationKey, call.modelOperation as MemoryModelOperation, call.operationSystemSha256, call.requestSha256, call.occurrence as number)
          : call.callKey !== legacyModelCallKey(operation.operationKey, call.modelOperation as MemoryModelOperation, call.requestSha256, call.occurrence as number))) return null;
      if (call.replyJson !== null && Buffer.byteLength(call.replyJson, "utf8") > 16_384) return null;
    }
  }
  if (Object.keys(value.sessions).length > 512 || Object.keys(value.operations).length > 2_000) return null;
  let replyBytes = 0;
  for (const operation of Object.values(value.operations)) {
    if (!objectRecord(operation) || !objectRecord(operation.calls)) return null;
    const calls = Object.values(operation.calls);
    if (calls.length > 2_000) return null;
    let operationReplyBytes = 0;
    for (const call of calls) {
      if (!objectRecord(call) || !(call.replyJson === null || typeof call.replyJson === "string")) return null;
      if (call.replyJson !== null) {
        const bytes = Buffer.byteLength(call.replyJson, "utf8");
        replyBytes += bytes;
        operationReplyBytes += bytes;
      }
    }
    if (operationReplyBytes > 262_144) return null;
  }
  if (replyBytes > 1_048_576) return null;
  for (const [roundDate, round] of Object.entries(value.dailyRounds)) {
    if (!validLocalDate(roundDate) || !objectRecord(round) || typeof round.roundId !== "string" || !["running", "paused", "completed", "superseded"].includes(String(round.state))
      || !Number.isSafeInteger(round.startedAt) || !Number.isSafeInteger(round.updatedAt)
      || !(round.nextResumeAt === null || Number.isSafeInteger(round.nextResumeAt))
      || !(round.completedAt === null || Number.isSafeInteger(round.completedAt))
      || !(round.lastPhase === null || typeof round.lastPhase === "string") || !objectRecord(round.snapshot)
      || typeof round.snapshot.queueSequenceHighWatermark !== "number" || !Number.isSafeInteger(round.snapshot.queueSequenceHighWatermark) || round.snapshot.queueSequenceHighWatermark < 0
      || typeof round.snapshot.eligibleMemberCount !== "number" || !Number.isSafeInteger(round.snapshot.eligibleMemberCount) || round.snapshot.eligibleMemberCount < 0
      || typeof round.snapshot.eligibleOperationKeysSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(round.snapshot.eligibleOperationKeysSha256)
      || !Number.isSafeInteger(round.snapshot.capturedAt)
      || !(round.snapshot.sourceGeneration === null || typeof round.snapshot.sourceGeneration === "string")
      || !(round.snapshot.sourceHighWatermark === null || typeof round.snapshot.sourceHighWatermark === "string")
      || typeof round.completedMembers !== "number" || !Number.isSafeInteger(round.completedMembers) || round.completedMembers < 0
      || typeof round.deferredMembers !== "number" || !Number.isSafeInteger(round.deferredMembers) || round.deferredMembers < 0
      || typeof round.deferredLegacyCount !== "number" || !Number.isSafeInteger(round.deferredLegacyCount) || round.deferredLegacyCount < 0) return null;
  }
  if (value.lastSourceRun !== undefined) {
    const run = value.lastSourceRun;
    if (!objectRecord(run) || !(run.snapshotId === null || typeof run.snapshotId === "string")
      || !(run.generation === null || typeof run.generation === "string")
      || !(run.highWatermark === null || typeof run.highWatermark === "string")
      || typeof run.pages !== "number" || !Number.isSafeInteger(run.pages) || run.pages < 0
      || !(run.scanned === null || typeof run.scanned === "number" && Number.isSafeInteger(run.scanned) && run.scanned >= 0)
      || typeof run.received !== "number" || !Number.isSafeInteger(run.received) || run.received < 0
      || typeof run.eligible !== "number" || !Number.isSafeInteger(run.eligible) || run.eligible < 0
      || typeof run.admitted !== "number" || !Number.isSafeInteger(run.admitted) || run.admitted < 0
      || typeof run.checkpointed !== "boolean"
      || !(run.schemaSkipped === null || typeof run.schemaSkipped === "number" && Number.isSafeInteger(run.schemaSkipped) && run.schemaSkipped >= 0)
      || typeof run.diagnosticsAvailable !== "boolean"
      || !Number.isSafeInteger(run.updatedAt)) return null;
  }
  return value as unknown as OrganizationResumeState;
}

function createLocalStore(dataDir: string, name: string, supportsOrganizationClaims: boolean): {
  store: OrganizationResumeStorePort;
  claimDailyRound(date: string): Promise<boolean>;
} {
  const root = resolve(dataDir);
  const file = resolve(root, name);
  const suffix = relative(root, file);
  const pages = new Map<string, { readonly records: readonly PunchStateRecord[]; readonly offset: number }>();
  let legacyPendingUpgrade = false;
  if (!isAbsolute(dataDir) || suffix.startsWith("..") || isAbsolute(suffix) || suffix === "" || suffix.includes("/") || suffix.includes("\\")) throw new Error("state_path_invalid");
  const safe = (): void => {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error("state_path_unsafe");
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile() || realpathSync(file) !== join(realpathSync(root), name))) throw new Error("state_path_unsafe");
  };
  const read = (): SavedState => {
    safe();
    if (!existsSync(file)) return { version: 1, records: {} };
    const raw = JSON.parse(readFileSync(file, "utf8")) as SavedState;
    if (raw?.version !== 1 || raw.records === null || typeof raw.records !== "object" || Array.isArray(raw.records)) throw new Error("state_file_invalid");
    for (const [key, value] of Object.entries(raw.records)) {
      const row = value as PunchStateRecord;
      if (row?.key !== key || !Number.isSafeInteger(row.revision) || (row.revision ?? 0) < 1) throw new Error("state_file_invalid");
    }
    if (raw.organizationClaims !== undefined && (raw.organizationClaims?.version !== 1 || !Array.isArray(raw.organizationClaims.dates)
      || raw.organizationClaims.dates.some((date) => !validLocalDate(date)) || new Set(raw.organizationClaims.dates).size !== raw.organizationClaims.dates.length
      || (raw.organizationClaims.throughDate !== undefined && !validLocalDate(raw.organizationClaims.throughDate)))) throw new Error("state_file_invalid");
    if (raw.organizationQueueSequence !== undefined && (!Number.isSafeInteger(raw.organizationQueueSequence) || raw.organizationQueueSequence < 0)) throw new Error("state_file_invalid");
    const migratedRecords: Record<string, PunchStateRecord> = { ...raw.records };
    for (const [key, record] of Object.entries(raw.records)) {
      const value = record.value;
      if (!objectRecord(value) || value.version !== 1 || value.state !== "pending" || value.resumeDisposition !== undefined) continue;
      legacyPendingUpgrade = true;
      Object.defineProperty(migratedRecords, key, { value: { ...record, value: { ...value, resumeDisposition: "legacy_unlinked" } }, enumerable: true, configurable: true, writable: true });
    }
    return { ...raw, records: migratedRecords };
  };
  const compact = (state: SavedState): SavedState => {
    if (!supportsOrganizationClaims) return state;
    const resume = resumeState(state.organizationResume);
    const roundDates = resume === null ? [] : Object.keys(resume.dailyRounds);
    const throughDate = maxLocalDate(state.organizationClaims?.throughDate, ...(state.organizationClaims?.dates ?? []), resume?.claimedThroughDate, ...roundDates);
    const hasClaims = state.organizationClaims !== undefined
      && (state.organizationClaims.dates.length > 0 || state.organizationClaims.throughDate !== undefined);
    const organizationClaims = throughDate === undefined && !hasClaims ? undefined : {
      version: 1 as const,
      dates: retainedClaimDates(state.organizationClaims?.dates ?? [], throughDate),
      ...(throughDate === undefined ? {} : { throughDate }),
    };
    const organizationResume = resume === null ? state.organizationResume : {
      ...resume,
      ...(throughDate === undefined ? {} : { claimedThroughDate: throughDate }),
      dailyRounds: retainDailyRounds(resume.dailyRounds),
    };
    return { ...state, organizationClaims, organizationResume };
  };
  const write = (state: SavedState): void => {
    const persisted = compact(state);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, `${JSON.stringify(persisted)}\n`);
        try { fsyncSync(fd); } catch (error) { if ((error as { code?: string }).code !== "ERR_ACCESS_DENIED") throw error; }
      } finally { closeSync(fd); }
      safe();
      renameSync(temporary, file);
      legacyPendingUpgrade = false;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  };
  const store: OrganizationResumeStorePort = {
    async readPage(cursor, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("state_limit_invalid");
      let current: SavedState | undefined;
      if (cursor === null) {
        current = read();
        if (supportsOrganizationClaims && legacyPendingUpgrade) write(current);
      }
      const snapshot = cursor === null ? { records: Object.values(current!.records).sort((left, right) => left.key.localeCompare(right.key)), offset: 0 } : pages.get(cursor);
      if (snapshot === undefined) throw new Error("state_cursor_invalid");
      if (cursor !== null) pages.delete(cursor);
      const { records, offset } = snapshot;
      let nextCursor: string | null = null;
      if (offset + limit < records.length) {
        nextCursor = randomUUID();
        pages.set(nextCursor, { records, offset: offset + limit });
        if (pages.size > 8) pages.delete(pages.keys().next().value!);
      }
      return { records: records.slice(offset, offset + limit), nextCursor };
    },
    async writeBatch(records) {
      const current = read();
      const next = { ...current.records };
      const seen = new Set<string>();
      for (const row of records) {
        if (typeof row.key !== "string" || row.key.length === 0 || row.key.length > 256 || seen.has(row.key)) throw new Error("state_key_invalid");
        seen.add(row.key);
        const before = Object.hasOwn(next, row.key) ? next[row.key] : undefined;
        if (row.expectedRevision !== undefined && row.expectedRevision !== (before?.revision ?? null)) throw new Error("state_revision_conflict");
        const { expectedRevision, ...saved } = row;
        const value = supportsOrganizationClaims && objectRecord(before?.value) && objectRecord(row.value)
          ? { ...before.value, ...row.value }
          : row.value;
        Object.defineProperty(next, row.key, { value: { ...saved, value, revision: (before?.revision ?? 0) + 1 }, enumerable: true, configurable: true, writable: true });
      }
      write({ ...current, version: 1, records: next });
    },
    async enqueueJob(key, value, sourceKind, sourceId) {
      const current = read();
      if (Object.hasOwn(current.records, key)) {
        const existing = current.records[key]?.value as { queueSequence?: unknown } | undefined;
        return Number.isSafeInteger(existing?.queueSequence) ? existing!.queueSequence as number : 0;
      }
      const sequence = (current.organizationQueueSequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("organization_queue_sequence_invalid");
      const row: PunchStateRecord = { key, value: objectRecord(value) ? { ...value, queueSequence: sequence, resumeDisposition: "eligible" } : value, revision: 1, sourceKind, sourceId };
      const next = { ...current.records };
      Object.defineProperty(next, key, { value: row, enumerable: true, configurable: true, writable: true });
      write({ ...current, version: 1, records: next, organizationQueueSequence: sequence });
      return sequence;
    },
    async readResumeState() {
      return resumeState(read().organizationResume);
    },
    async writeResumeState(value) {
      const current = read();
      if (resumeState(current.organizationResume) === null || resumeState(value) === null) throw new Error("organization_resume_incompatible");
      write({ ...current, organizationResume: value });
    },
    async transactResumeState(update) {
      const current = read();
      const resume = resumeState(current.organizationResume);
      if (resume === null) throw new Error("organization_resume_incompatible");
      const next = update(resume);
      if (resumeState(next) === null) throw new Error("organization_resume_invalid");
      write({ ...current, organizationResume: next });
      return next;
    },
    async beginOrResumeDailyRound(date, source = { generation: null, highWatermark: null }, capturedAt = Date.now()) {
      if (!supportsOrganizationClaims || !validLocalDate(date)) throw new Error("organization_claim_date_invalid");
      const current = read();
      const resume = resumeState(current.organizationResume);
      if (resume === null) throw new Error("organization_resume_incompatible");
      const existing = resume.dailyRounds[date];
      const throughDate = maxLocalDate(current.organizationClaims?.throughDate, ...(current.organizationClaims?.dates ?? []), resume.claimedThroughDate, ...Object.keys(resume.dailyRounds));
      const mayResumeDate = throughDate === undefined || date === throughDate;
      const keepDate = throughDate === undefined || date === throughDate ? date : date < throughDate ? throughDate : null;
      const rounds = supersedeOtherRounds(resume.dailyRounds, keepDate, capturedAt);
      const compactedResume: OrganizationResumeState = {
        ...resume,
        ...(throughDate === undefined ? {} : { claimedThroughDate: throughDate }),
        dailyRounds: rounds,
      };
      const claims = {
        version: 1 as const,
        dates: retainedClaimDates(current.organizationClaims?.dates ?? [], throughDate),
        ...(throughDate === undefined ? {} : { throughDate }),
      };
      if (throughDate !== undefined && date <= throughDate) {
        const resumable = mayResumeDate && existing !== undefined && (existing.state === "running" || existing.state === "paused");
        write({ ...current, organizationClaims: claims, organizationResume: compactedResume });
        return { shouldRun: resumable, replyOnly: !resumable, round: resumable ? existing : null };
      }
      const watermark = current.organizationQueueSequence ?? 0;
      const eligible = Object.entries(current.records).filter(([, row]) => {
        const job = row.value as { state?: unknown; queueSequence?: unknown; resumeDisposition?: unknown; input?: { operationId?: unknown } };
        return Number.isSafeInteger(job?.queueSequence) && (job.queueSequence as number) <= watermark
          && job.resumeDisposition !== "legacy_unlinked" && typeof job.input?.operationId === "string"
          && ["pending", "completed", "skipped"].includes(String(job.state));
      }).map(([key, row]) => {
        const job = row.value as { input: { operationId: string } };
        return hash(key + "|" + job.input.operationId);
      }).sort();
      const startable = eligible.length > 0;
      const at = capturedAt;
      const round: OrganizationDailyRound = {
        roundId: randomUUID(),
        state: startable ? "running" : "completed",
        startedAt: at,
        updatedAt: at,
        nextResumeAt: null,
        completedAt: startable ? null : at,
        lastPhase: null,
        snapshot: {
          queueSequenceHighWatermark: watermark,
          eligibleMemberCount: eligible.length,
          eligibleOperationKeysSha256: hash(eligible.join("|")),
          capturedAt: at,
          sourceGeneration: source.generation,
          sourceHighWatermark: source.highWatermark,
        },
        completedMembers: 0,
        deferredMembers: 0,
        deferredLegacyCount: Object.values(current.records).filter((row) => objectRecord(row.value) && row.value.state === "pending" && row.value.resumeDisposition === "legacy_unlinked").length,
      };
      const nextResume: OrganizationResumeState = {
        ...resume,
        claimedThroughDate: date,
        dailyRounds: retainDailyRounds({ ...supersedeOtherRounds(resume.dailyRounds, null, at), [date]: round }),
      };
      write({
        ...current,
        organizationClaims: { version: 1, dates: retainedClaimDates([...(current.organizationClaims?.dates ?? []), date], date), throughDate: date },
        organizationResume: nextResume,
      });
      return { shouldRun: startable, replyOnly: false, round };
    },
    async updateDailyRound(date, round) {
      const current = read();
      const resume = resumeState(current.organizationResume);
      if (resume === null) throw new Error("organization_resume_incompatible");
      write({ ...current, organizationResume: { ...resume, dailyRounds: { ...resume.dailyRounds, [date]: round } } });
    },
    async completeJobAndPruneOperation(record, key) {
      if (!supportsOrganizationClaims || typeof record.key !== "string" || record.key.length === 0 || !objectRecord(record.value)
        || !["completed", "skipped"].includes(String(record.value.state))) throw new Error("organization_completion_invalid");
      const current = read();
      const before = Object.hasOwn(current.records, record.key) ? current.records[record.key] : undefined;
      if (record.expectedRevision !== undefined && record.expectedRevision !== (before?.revision ?? null)) throw new Error("state_revision_conflict");
      const job = record.value as { actor?: { agentId?: unknown; projectId?: unknown }; input?: { operationId?: unknown } };
      if (typeof job.actor?.agentId !== "string" || !(job.actor.projectId === null || typeof job.actor.projectId === "string")
        || typeof job.input?.operationId !== "string") throw new Error("organization_completion_identity_invalid");
      const resume = resumeState(current.organizationResume);
      if (resume === null) throw new Error("organization_resume_incompatible");
      const operation = resume.operations[key];
      const expectedPair = hash(JSON.stringify([job.actor.agentId, job.actor.projectId]));
      if (operation !== undefined && (operation.operationKey !== key || operation.pairKey !== expectedPair || operation.operationId !== job.input.operationId)) {
        throw new Error("organization_resume_identity_mismatch");
      }
      const { expectedRevision, ...saved } = record;
      const value = objectRecord(before?.value) ? { ...before.value, ...record.value } : record.value;
      const nextRecords = { ...current.records };
      Object.defineProperty(nextRecords, record.key, {
        value: { ...saved, value, revision: (before?.revision ?? 0) + 1 }, enumerable: true, configurable: true, writable: true,
      });
      const operations = { ...resume.operations };
      delete (operations as Record<string, unknown>)[key];
      write({ ...current, records: nextRecords, organizationResume: { ...resume, operations } });
    },
    async pruneOperation(key) {
      const current = read();
      const resume = resumeState(current.organizationResume);
      if (resume === null) throw new Error("organization_resume_incompatible");
      if (!Object.hasOwn(resume.operations, key)) return;
      const operations = { ...resume.operations };
      delete (operations as Record<string, unknown>)[key];
      write({ ...current, organizationResume: { ...resume, operations } });
    },
    async hasRecoverableReply(pair, operationId) {
      const resume = resumeState(read().organizationResume);
      if (resume === null) return false;
      const key = hash(pair + "|" + operationId);
      const operation = resume.operations[key];
      return operation !== undefined && Object.values(operation.calls).some((call) => call.replyJson !== null && ["reply_ready", "commit_retry"].includes(call.phase));
    },
    async sourceRun(run) {
      const current = read();
      const resume = resumeState(current.organizationResume);
      if (resume === null) throw new Error("organization_resume_incompatible");
      write({ ...current, organizationResume: { ...resume, lastSourceRun: run } });
    },
  };
  return {
    store,
    async claimDailyRound(date) {
      if (!supportsOrganizationClaims || !validLocalDate(date)) throw new Error("organization_claim_date_invalid");
      const current = read();
      const resume = resumeState(current.organizationResume);
      const throughDate = maxLocalDate(current.organizationClaims?.throughDate, ...(current.organizationClaims?.dates ?? []), resume?.claimedThroughDate, ...(resume === null ? [] : Object.keys(resume.dailyRounds)));
      if (throughDate !== undefined && date <= throughDate) {
        write({
          ...current,
          organizationClaims: { version: 1, dates: retainedClaimDates(current.organizationClaims?.dates ?? [], throughDate), throughDate },
          ...(resume === null ? {} : { organizationResume: { ...resume, claimedThroughDate: throughDate, dailyRounds: retainDailyRounds(resume.dailyRounds) } }),
        });
        return false;
      }
      write({
        ...current,
        organizationClaims: { version: 1, dates: retainedClaimDates([...(current.organizationClaims?.dates ?? []), date], date), throughDate: date },
        ...(resume === null ? {} : { organizationResume: { ...resume, claimedThroughDate: date, dailyRounds: retainDailyRounds(resume.dailyRounds) } }),
      });
      return true;
    },
  };
}
