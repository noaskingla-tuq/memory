import type { PunchReceiptStorePort, SettledPunch } from "./punchDataPorts.js";
import { buildPunchSourceMessages, punchOperationId } from "./punchContent.js";
import type { MemoryActor } from "../contracts/actor.js";
import { memoryCaptureSchema, type MemoryCaptureInput } from "./toolContract.js";
import type { MemoryResult } from "../domain/errors.js";
import { failure } from "../domain/errors.js";
import { memoryActorSchema } from "../../vendor/teamuq-contract/contract.mjs";

export interface OrganizationStatus {
  readonly state: "disabled" | "idle" | "running" | "paused" | "error";
  readonly pending: number;
  readonly completed: number;
  readonly lastError: string | null;
}
interface Job {
  readonly version: 1;
  readonly punchId: string;
  readonly memoryId: string;
  readonly actor: MemoryActor;
  readonly input: MemoryCaptureInput;
  readonly state: "pending" | "completed" | "skipped";
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
}
export interface OrganizationOptions {
  readonly store: PunchReceiptStorePort;
  readonly enabled: () => boolean;
  readonly capture: (job: { actor: MemoryActor; input: MemoryCaptureInput; memoryId: string }) => Promise<MemoryResult<unknown>>;
  readonly now?: () => number;
  readonly pollMs?: number;
}

export function createPunchOrganizationWorker(options: OrganizationOptions) {
  const now = options.now ?? Date.now;
  let stopped = false;
  let started = false;
  let requested = false;
  let retryNow = false;
  let knownKeys: Set<string> | undefined;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let status: OrganizationStatus = { state: "disabled", pending: 0, completed: 0, lastError: null };
  const jobs = async () => {
    const rows = [];
    let cursor: string | null = null;
    do {
      const page = await options.store.readPage(cursor, 100);
      for (const row of page.records) {
        const job = row.value as Job;
        if (job?.version !== 1 || job.punchId !== row.key || typeof job.memoryId !== "string" || job.memoryId.length === 0 || !memoryActorSchema.safeParse(job.actor).success || !["pending", "completed", "skipped"].includes(job.state) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || !Number.isSafeInteger(job.nextAttemptAt) || job.nextAttemptAt < 0 || (job.lastError !== null && typeof job.lastError !== "string") || !Array.isArray(job.input?.messages)
          || job.input.operationId !== `organize:${punchOperationId(job.punchId)}` || job.input.scope !== (job.actor.projectId === null ? "personal" : "project") || (job.state === "pending" && !memoryCaptureSchema.safeParse(job.input).success)) throw new Error("organization_state_invalid");
        rows.push({ row, job });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    knownKeys ??= new Set(rows.map(({ row }) => row.key));
    return rows;
  };
  const run = async (): Promise<void> => {
    const rows = await jobs();
    const previousFailure = rows.find(({ job }) => job.lastError !== null && job.state !== "skipped")?.job.lastError ?? null;
    const failureState = previousFailure === "MODEL_NOT_CONFIGURED" || previousFailure === "MODEL_POLICY_DENIED" || previousFailure === "RESOURCE_BUSY" ? "paused" : "error";
    status = { pending: rows.filter(({ job }) => job.state === "pending").length, completed: rows.filter(({ job }) => job.state === "completed").length, lastError: previousFailure, state: !options.enabled() ? "disabled" : previousFailure === null ? "idle" : failureState };
    const immediate = retryNow;
    retryNow = false;
    if (!options.enabled()) return;
    for (const { row, job } of rows) {
      if (stopped || !options.enabled()) break;
      if (job.state !== "pending" || (!immediate && job.nextAttemptAt > now())) continue;
      status = { ...status, state: "running" };
      let result: MemoryResult<unknown>;
      try { result = await options.capture(job); } catch (error) { result = failure("organization", error); }
      if (stopped) break;
      const processing = result.ok && (result.value as { processing?: boolean } | null)?.processing === true;
      const classification = result.ok ? (result.value as { classification?: { status: string; error?: { code: string } } } | null)?.classification : undefined;
      const code = result.ok ? processing ? "RESOURCE_BUSY" : classification?.status === "failed" ? classification.error?.code.toUpperCase() ?? "INTERNAL" : null : result.error.code;
      const paused = code === "MODEL_NOT_CONFIGURED" || code === "MODEL_POLICY_DENIED" || code === "RESOURCE_BUSY";
      const nextState = result.ok && !processing ? "completed" : code === "MEMORY_SUPPRESSED" ? "skipped" : "pending";
      const next: Job = { ...job, state: nextState, input: nextState === "pending" ? job.input : { ...job.input, messages: [] }, attempts: job.attempts + 1,
        nextAttemptAt: code === null ? 0 : now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts, 7)), lastError: code };
      await options.store.writeBatch([{ key: row.key, value: next, expectedRevision: row.revision }]);
      status = { ...status, state: code === null || next.state === "skipped" ? "idle" : paused ? "paused" : "error", pending: status.pending - (next.state === "pending" ? 0 : 1), completed: status.completed + (next.state === "completed" ? 1 : 0), lastError: next.state === "skipped" ? null : code };
      if (code !== null) break;
    }
    if (status.state === "running") status = { ...status, state: "idle" };
  };
  const wake = (): void => {
    if (stopped || !started) return;
    if (active !== null) { requested = true; return; }
    active = run().catch(() => { status = { ...status, state: "error", lastError: "STORAGE_BUSY" }; }).finally(() => {
      active = null;
      if (requested && !stopped) { requested = false; wake(); }
    });
  };
  return {
    async enqueue(punch: SettledPunch, memoryId: string) {
      if (knownKeys === undefined) await jobs();
      if (knownKeys!.has(punch.id)) return;
      const job: Job = { version: 1, punchId: punch.id, memoryId, actor: { agentId: punch.agentId, projectId: punch.projectId, sessionId: punch.sessionId ?? "no-session", providerId: punch.providerId ?? "unknown" },
        input: { scope: punch.projectId === null ? "personal" : "project", operationId: `organize:${punchOperationId(punch.id)}`, messages: buildPunchSourceMessages(punch) },
        state: "pending", attempts: 0, nextAttemptAt: 0, lastError: null };
      await options.store.writeBatch([{ key: punch.id, value: job, expectedRevision: null, sourceKind: "work-record", sourceId: punch.id }]);
      knownKeys!.add(punch.id);
      wake();
    },
    async forgetSource(agentId: string, memoryId: string) {
      const rows = (await jobs()).filter(({ job }) => job.actor.agentId === agentId && job.memoryId === memoryId);
      for (const { row, job } of rows) {
        await options.store.writeBatch([{ key: row.key, value: { ...job, state: "skipped", input: { ...job.input, messages: [] }, nextAttemptAt: 0, lastError: null }, expectedRevision: row.revision }]);
      }
      wake();
    },
    start() { if (started || stopped) return; started = true; timer = setInterval(wake, options.pollMs ?? 30_000); timer.unref(); wake(); },
    wake,
    settingsChanged() { retryNow = true; wake(); },
    status: (): OrganizationStatus => ({ ...status, ...(!options.enabled() ? { state: "disabled" as const } : {}) }),
    async idle() { while (active !== null) await active; },
    async stop() { stopped = true; if (timer !== undefined) clearInterval(timer); await active; },
  };
}
