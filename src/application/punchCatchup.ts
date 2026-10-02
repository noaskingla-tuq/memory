import { buildPunchMemoryContent } from "./punchContent.js";
import type {
  PunchFeedPort,
  LegacyPunchStatePort,
  PunchMemoryWrite,
  PunchMemoryWriterPort,
  PunchReceiptStorePort,
  PunchStateRecord,
  PunchTerminalReceipt,
  PunchWriteScope,
  SettledPunch,
} from "./punchDataPorts.js";

export const PUNCH_RECEIPT_NAMESPACE = "punch-write-v1";
const CHECKPOINT_KEY = "checkpoint.v1";
const PAGE_LIMIT = 100;
const BATCH_SIZE = 200;
const MAX_PER_RUN = 2_000;
const MAX_OPS_PER_REQUEST = 16;
const INTERNAL_FAILURE_LIMIT = 3;

export interface PunchCatchupOptions {
  readonly feed: PunchFeedPort;
  readonly receipts: PunchReceiptStorePort;
  readonly legacyReceipts?: LegacyPunchStatePort;
  readonly writer: PunchMemoryWriterPort;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly batchPauseMs?: number;
  readonly minAgeMs?: number;
  readonly maxPerRun?: number;
  readonly onProgress?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface PunchCatchupResult {
  readonly examined: number;
  readonly written: number;
  readonly deduplicated: number;
  readonly skipped: number;
  readonly pending: number;
  readonly lastWrittenAtMs: number | null;
  readonly complete: boolean;
  readonly stoppedCode: string | null;
}

export interface PunchCatchupWorker {
  start(): void;
  wake(): void;
  idle(): Promise<void>;
  status(): { readonly pending: number; readonly lastWrittenAtMs: number | null } | null;
  stop(): Promise<void>;
}

const scopeOf = (punch: SettledPunch): PunchWriteScope => punch.projectId === null ? "personal" : "project";
const groupOf = (punch: SettledPunch): string => JSON.stringify([punch.agentId, punch.projectId, punch.sessionId, punch.providerId]);

function isReceipt(value: unknown): value is PunchTerminalReceipt {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (row.state === "written" || row.state === "skipped")
    && typeof row.punchId === "string" && typeof row.agentId === "string"
    && (row.projectId === null || typeof row.projectId === "string")
    && (row.scope === "personal" || row.scope === "project")
    && typeof row.writtenAt === "number" && Number.isSafeInteger(row.writtenAt)
    && (row.state === "written"
      ? typeof row.memoryId === "string" && typeof row.contentSha256 === "string"
      : typeof row.reason === "string");
}

async function readState(store: PunchReceiptStorePort): Promise<{ receipts: Map<string, PunchTerminalReceipt>; checkpoint: unknown; checkpointRevision: number | null }> {
  const records = new Map<string, PunchTerminalReceipt>();
  let checkpointValue: unknown = null;
  let checkpointRevision: number | null = null;
  let cursor: string | null = null;
  do {
    const page = await store.readPage(cursor, PAGE_LIMIT);
    for (const record of page.records) {
      if (record.key === CHECKPOINT_KEY) { checkpointValue = record.value; checkpointRevision = record.revision ?? null; }
      else if (isReceipt(record.value) && record.key === record.value.punchId) records.set(record.key, record.value);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { receipts: records, checkpoint: checkpointValue, checkpointRevision };
}

function record(receipt: PunchTerminalReceipt): PunchStateRecord {
  return { key: receipt.punchId, value: receipt, sourceKind: "work-record", sourceId: receipt.punchId };
}

function legacyReceipt(value: unknown, key: string): PunchTerminalReceipt {
  if (value === null || typeof value !== "object") throw new Error("legacy_receipt_invalid");
  const row = value as Record<string, unknown>;
  const valueOf = (camel: string, snake: string): unknown => row[camel] !== undefined ? row[camel] : row[snake];
  const punchId = valueOf("punchId", "punch_id");
  const agentId = valueOf("agentId", "agent_id");
  const projectId = valueOf("projectId", "project_id");
  const writtenAt = valueOf("writtenAt", "written_at");
  const state = row.state;
  const scope = row.scope;
  if (punchId !== key || typeof agentId !== "string" || (projectId !== null && typeof projectId !== "string")
    || (scope !== "personal" && scope !== "project") || typeof writtenAt !== "number" || !Number.isSafeInteger(writtenAt)) {
    throw new Error("legacy_receipt_invalid");
  }
  if (state === "written") {
    const memoryId = valueOf("memoryId", "memory_id");
    const contentSha256 = valueOf("contentSha256", "content_sha256");
    if (typeof memoryId !== "string" || typeof contentSha256 !== "string") throw new Error("legacy_receipt_invalid");
    return { state, punchId, agentId, scope, projectId: projectId as string | null, memoryId, contentSha256, writtenAt };
  }
  if (state === "skipped") {
    const reason = row.reason;
    if (typeof reason !== "string") throw new Error("legacy_receipt_invalid");
    return { state, punchId, agentId, scope, projectId: projectId as string | null, reason, writtenAt };
  }
  throw new Error("legacy_receipt_invalid");
}

function sameReceipt(left: PunchTerminalReceipt, right: PunchTerminalReceipt): boolean {
  return left.state === right.state && left.punchId === right.punchId && left.agentId === right.agentId
    && left.scope === right.scope && left.projectId === right.projectId && left.writtenAt === right.writtenAt
    && (left.state === "written" && right.state === "written"
      ? left.memoryId === right.memoryId && left.contentSha256 === right.contentSha256
      : left.state === "skipped" && right.state === "skipped" && left.reason === right.reason);
}

async function importLegacyReceipts(legacy: LegacyPunchStatePort | undefined, target: PunchReceiptStorePort): Promise<void> {
  if (legacy === undefined) return;
  let cursor: string | null = null;
  const existing = await readState(target);
  do {
    const page = await legacy.readPage(cursor, PAGE_LIMIT);
    const imported = page.records.map((record) => ({ key: record.key, receipt: legacyReceipt(record.value, record.key) }));
    const writes: PunchStateRecord[] = [];
    for (const item of imported) {
      const current = existing.receipts.get(item.key);
      if (current === undefined) writes.push(record(item.receipt));
      else if (!sameReceipt(current, item.receipt)) throw new Error("legacy_receipt_conflict");
    }
    if (writes.length > 0) {
      await target.writeBatch(writes);
      for (const item of imported) existing.receipts.set(item.key, item.receipt);
    }
    if (page.records.length > 0) await legacy.deleteBatch(page.records.map((item) => item.key));
    cursor = page.nextCursor;
  } while (cursor !== null);
}

function resolveSinceMs(value: unknown, now: number): number {
  if (value !== null && typeof value === "object") {
    const candidate = (value as { sinceMs?: unknown }).sinceMs;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  }
  return Math.max(0, now - 14 * 24 * 60 * 60 * 1000);
}

interface Tally {
  written: number;
  deduplicated: number;
  skipped: number;
  terminalized: number;
  stoppedCode: string | null;
  lastWrittenAtMs: number | null;
}

export function createPunchCatchupWorker(options: PunchCatchupOptions): PunchCatchupWorker {
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPerRun = options.maxPerRun ?? MAX_PER_RUN;
  const minAgeMs = options.minAgeMs ?? 120_000;
  const log = (event: Readonly<Record<string, unknown>>): void => {
    try { options.onProgress?.(event); } catch {}
  };
  const internalFailures = new Map<string, number>();
  let stopped = false;
  let started = false;
  let pending = false;
  let active: Promise<void> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let sinceMs: number | null = null;
  let lastStatus: { readonly pending: number; readonly lastWrittenAtMs: number | null } | null = null;

  const terminal = async (rows: readonly PunchTerminalReceipt[]): Promise<void> => {
    if (rows.length === 0) return;
    for (let index = 0; index < rows.length; index += 100) {
      await options.receipts.writeBatch(rows.slice(index, index + 100).map(record));
    }
  };

  async function rememberGroup(punches: readonly SettledPunch[], tally: Tally): Promise<void> {
    if (stopped || punches.length === 0) return;
    const prepared = punches.map((punch) => ({ punch, content: buildPunchMemoryContent(punch) }));
    const nonEmpty = prepared.filter((item): item is { punch: SettledPunch; content: NonNullable<typeof item.content> } => item.content !== null);
    const empty = prepared.filter((item) => item.content === null);
    if (empty.length > 0) {
      const at = now();
      await terminal(empty.map(({ punch }) => ({ state: "skipped", punchId: punch.id, agentId: punch.agentId, scope: scopeOf(punch), projectId: punch.projectId, reason: "empty_content", writtenAt: at })));
      tally.skipped += empty.length;
      tally.terminalized += empty.length;
    }
    if (nonEmpty.length === 0) {
      return;
    }
    const writes: PunchMemoryWrite[] = nonEmpty.map(({ punch, content }) => ({
      agentId: punch.agentId,
      projectId: punch.projectId,
      sessionId: punch.sessionId ?? "no-session",
      providerId: punch.providerId ?? "unknown",
      scope: scopeOf(punch),
      content: content.content,
      operationId: content.operationId,
    }));
    let results: Awaited<ReturnType<PunchMemoryWriterPort["rememberMany"]>>;
    try {
      results = await options.writer.rememberMany(writes);
    } catch (error) {
      tally.stoppedCode = error instanceof Error ? error.name : "writer_unavailable";
      return;
    }
    if (results.length !== nonEmpty.length) {
      tally.stoppedCode = "short_result";
      return;
    }
    const at = now();
    const rows: PunchTerminalReceipt[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const item = nonEmpty[index]!;
      const result = results[index]!;
      if (result.ok) {
        internalFailures.delete(item.punch.id);
        rows.push({ state: "written", punchId: item.punch.id, agentId: item.punch.agentId, scope: scopeOf(item.punch), projectId: item.punch.projectId, memoryId: result.memoryId, contentSha256: item.content.contentSha256, writtenAt: at });
        tally.written += 1;
        if (result.deduplicated) tally.deduplicated += 1;
        continue;
      }
      if (result.code === "INVALID_INPUT" && nonEmpty.length > 1) {
        await rememberGroup([item.punch], tally);
        continue;
      }
      if (result.code === "INVALID_INPUT" || result.code === "MEMORY_SUPPRESSED") {
        rows.push({ state: "skipped", punchId: item.punch.id, agentId: item.punch.agentId, scope: scopeOf(item.punch), projectId: item.punch.projectId, reason: result.code.toLowerCase(), writtenAt: at });
        tally.skipped += 1;
        continue;
      }
      if (result.code === "INTERNAL") {
        const failures = (internalFailures.get(item.punch.id) ?? 0) + 1;
        if (failures >= INTERNAL_FAILURE_LIMIT) {
          internalFailures.delete(item.punch.id);
          rows.push({ state: "skipped", punchId: item.punch.id, agentId: item.punch.agentId, scope: scopeOf(item.punch), projectId: item.punch.projectId, reason: "internal", writtenAt: at });
          tally.skipped += 1;
          continue;
        }
        internalFailures.set(item.punch.id, failures);
      }
      tally.stoppedCode ??= result.code;
    }
    try {
      await terminal(rows);
      tally.terminalized += rows.length;
      for (const row of rows) if (row.state === "written") tally.lastWrittenAtMs = Math.max(tally.lastWrittenAtMs ?? row.writtenAt, row.writtenAt);
    } catch (error) {
      tally.stoppedCode = error instanceof Error ? error.name : "receipt_write_failed";
    }
  }

  async function catchUp(): Promise<PunchCatchupResult> {
    await importLegacyReceipts(options.legacyReceipts, options.receipts);
    const state = await readState(options.receipts);
    const receipts = state.receipts;
    sinceMs = resolveSinceMs(state.checkpoint, now());
    let checkpointRevision = state.checkpointRevision;
    if (state.checkpoint === null) {
      await options.receipts.writeBatch([{ key: CHECKPOINT_KEY, value: { version: 1, sinceMs }, expectedRevision: null }]);
      checkpointRevision = (await readState(options.receipts)).checkpointRevision;
    }
    const snapshot = await options.feed.openSettledSnapshot();
    const tally: Tally = { written: 0, deduplicated: 0, skipped: 0, terminalized: 0, stoppedCode: null, lastWrittenAtMs: null };
    let examined = 0;
    let pending = 0;
    const lastWrittenAtMs = [...receipts.values()].reduce<number | null>((latest, row) => row.state === "written" ? Math.max(latest ?? row.writtenAt, row.writtenAt) : latest, null);
    tally.lastWrittenAtMs = lastWrittenAtMs;
    let cursor: string | null = null;
    let more = false;
    do {
      const page = await options.feed.readSettledPage({ snapshotId: snapshot.snapshotId, cursor, limit: PAGE_LIMIT });
      const eligible = page.records.filter((punch) => punch.startedAtMs >= (sinceMs ?? 0) && punch.endedAtMs <= now() - minAgeMs && !receipts.has(punch.id));
      pending += eligible.length;
      const processable = eligible.slice(0, Math.max(0, maxPerRun - examined));
      for (let start = 0; start < processable.length && tally.stoppedCode === null; start += BATCH_SIZE) {
        const batch = processable.slice(start, start + BATCH_SIZE);
        examined += batch.length;
        batch.sort((left, right) => groupOf(left).localeCompare(groupOf(right)) || left.startedAtMs - right.startedAtMs);
        let index = 0;
        while (index < batch.length && tally.stoppedCode === null) {
          const key = groupOf(batch[index]!);
          let end = index;
          while (end < batch.length && end - index < MAX_OPS_PER_REQUEST && groupOf(batch[end]!) === key) end += 1;
          await rememberGroup(batch.slice(index, end), tally);
          index = end;
        }
        if (tally.stoppedCode === null && batch.length === BATCH_SIZE) await pause(options.batchPauseMs ?? 200);
      }
      cursor = page.nextCursor;
      more = cursor !== null || processable.length < eligible.length;
      if (examined >= maxPerRun) break;
    } while (cursor !== null && tally.stoppedCode === null && !stopped);
    if (tally.stoppedCode === null && !more && !stopped) {
      try {
        const checkpointValue = { version: 1, sinceMs, generation: snapshot.generation, highWatermark: snapshot.highWatermark, completedAt: now() };
        await options.receipts.writeBatch([{ key: CHECKPOINT_KEY, value: checkpointValue, expectedRevision: checkpointRevision }]);
      } catch (error) {
        tally.stoppedCode = error instanceof Error ? error.name : "checkpoint_write_failed";
      }
    }
    const remaining = Math.max(0, pending - tally.terminalized);
    const result = { examined, written: tally.written, deduplicated: tally.deduplicated, skipped: tally.skipped, pending: remaining, lastWrittenAtMs: tally.lastWrittenAtMs, complete: tally.stoppedCode === null && !more, stoppedCode: tally.stoppedCode };
    if (result.complete) lastStatus = { pending: remaining, lastWrittenAtMs: tally.lastWrittenAtMs };
    return result;
  }

  const run = (): void => {
    if (stopped || active !== null) { pending = true; return; }
    active = catchUp().then((result) => {
      log({ event: "punch_catchup", ...result });
      if (!result.complete && result.stoppedCode === null) pending = true;
    }).catch((error: unknown) => {
      log({ event: "punch_catchup_failed", code: error instanceof Error ? error.name : typeof error });
    }).finally(() => {
      active = null;
      if (pending && !stopped) { pending = false; run(); }
    });
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      unsubscribe = options.feed.subscribeSettledChanges(() => run());
      poll = setInterval(run, options.pollMs ?? 30_000);
      poll.unref();
      run();
    },
    wake: run,
    async idle() { while (active !== null) await active; },
    status: () => lastStatus,
    async stop() {
      stopped = true;
      pending = false;
      if (poll !== null) clearInterval(poll);
      unsubscribe?.();
      unsubscribe = null;
      await active;
    },
  };
}
