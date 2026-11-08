import type { PluginBackendAiSessionV1, PluginBackendAiTurnEventV1 } from "@teamuq/plugin-sdk";
import { MemoryServiceError, type MemoryFailurePhase } from "../../domain/errors.js";
import type { MemoryModelInvocationContext } from "../../application/modelPort.js";
import type { OrganizationCallRecord, OrganizationSessionRecord } from "../../application/punchDataPorts.js";

export const REPLY_LIMIT = 16_384;
export const DETACHED_LOCAL_CODE = "detached_running";

export type TurnState = "prepared" | "sending" | "running" | "detached" | "reply_ready" | "failed";

export interface PairSession {
  readonly session: PluginBackendAiSessionV1;
  readonly record: OrganizationSessionRecord;
}

export interface TurnJournal {
  save(context: MemoryModelInvocationContext, operation: string, callKey: string, phase: OrganizationCallRecord["phase"], fields?: Partial<OrganizationCallRecord>): Promise<OrganizationCallRecord>;
  saveReply(context: MemoryModelInvocationContext, operation: string, callKey: string, turnId: string, sequenceNo: number, value: unknown): Promise<void>;
  persistSession(record: OrganizationSessionRecord): Promise<void>;
}

export interface TurnRequest {
  readonly current: PairSession;
  readonly context: MemoryModelInvocationContext;
  readonly operation: string;
  readonly callKey: string;
  readonly body: string;
  readonly savedCall: OrganizationCallRecord | undefined;
  readonly priorCall: OrganizationCallRecord | undefined;
  readonly journal: TurnJournal | undefined;
  readonly parseCached: (call: OrganizationCallRecord) => unknown;
  readonly parseReply: (text: string) => unknown;
  // why: only interrupt() and cancel() raise the hard signal, so a stop the plugin chose is the only thing that ends a turn the host is still running
  readonly hard: AbortSignal;
  // why: the Cairn deadline raises the soft signal, which after the send only detaches the caller and never touches the host turn
  readonly soft: AbortSignal;
  readonly isDisposed: () => boolean;
  readonly setPhase: (phase: MemoryFailurePhase) => void;
  readonly onDetach: () => void;
  readonly remember: (record: OrganizationSessionRecord, session: PluginBackendAiSessionV1) => void;
}

const cancelled = (): MemoryServiceError => new MemoryServiceError("RESOURCE_BUSY", "Memory model operation was cancelled", undefined, "cancelled");
const outputInvalid = (message: string): MemoryServiceError => new MemoryServiceError("MODEL_OUTPUT_INVALID", message, false, "reply_contract");

function aborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

export async function runTurn(request: TurnRequest, publicError: (error: unknown, phase: string) => MemoryServiceError): Promise<unknown> {
  const { current, context, operation, callKey, body, savedCall, priorCall, journal, hard, soft } = request;
  if (savedCall?.replyJson !== null && savedCall !== undefined) return request.parseCached(savedCall);
  const detachable = journal !== undefined;
  const priorTurnId = priorCall?.turnId ?? null;
  let state = "prepared" as TurnState;
  let turnId = priorTurnId;
  let sequenceNo = priorCall?.sequenceNo ?? null;
  let output = priorTurnId !== null && current.session.turn?.turnId === priorTurnId ? current.session.turn.text : "";
  let sendStarted = false;
  let terminalWritten = false;
  let interruptionWrite: Promise<void> | undefined;
  let terminal = false;
  let settled = false;
  const pending: PluginBackendAiTurnEventV1[] = [];
  let eventChain = Promise.resolve();
  let resolveAnswer: ((value: unknown) => void) | undefined;
  let rejectAnswer: ((error: Error) => void) | undefined;
  const answer = new Promise<unknown>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  void answer.catch(() => undefined);
  const writeFailed = async (fields: Partial<OrganizationCallRecord>): Promise<void> => {
    if (journal === undefined) return;
    await journal.save(context, operation, callKey, "failed", fields);
    terminalWritten = true;
    state = "failed";
  };
  const settleIfReady = async (): Promise<void> => {
    if (settled || !terminal || sequenceNo === null) return;
    settled = true;
    try { resolveAnswer?.(request.parseReply(output)); }
    catch (error) {
      await writeFailed({ turnId, sequenceNo, retryable: false, partialDelivered: false, hostErrorCode: "json_parse" });
      rejectAnswer?.(error as Error);
    }
  };
  const tooLong = async (): Promise<void> => {
    settled = true;
    await writeFailed({ turnId, sequenceNo, retryable: false, partialDelivered: true, hostErrorCode: "reply_too_long" });
    rejectAnswer?.(outputInvalid("Memory model reply is too large"));
  };
  const process = async (event: PluginBackendAiTurnEventV1): Promise<void> => {
    if (settled || turnId === null || event.turnId !== turnId) return;
    if (event.kind === "textDelta") {
      output += event.text;
      if (Buffer.byteLength(output, "utf8") > REPLY_LIMIT) await tooLong();
    } else if (event.kind === "contentSaved") {
      sequenceNo = event.sequenceNo;
      await journal?.save(context, operation, callKey, "sent", { turnId, sequenceNo });
      await settleIfReady();
    } else if (event.kind === "completed") {
      const snapshot = current.session.turn;
      if (snapshot?.turnId === turnId) output = snapshot.text;
      if (Buffer.byteLength(output, "utf8") > REPLY_LIMIT) { await tooLong(); return; }
      terminal = true;
      await settleIfReady();
    } else if (event.kind === "failed") {
      settled = true;
      await writeFailed({ turnId, sequenceNo, retryable: event.retryable, partialDelivered: event.partialDelivered, hostErrorCode: event.code });
      rejectAnswer?.(event.code === "access_revoked" ? new MemoryServiceError("MODEL_POLICY_DENIED", "Memory host permission is unavailable", false, "policy")
        : event.code === "quota_exhausted" ? new MemoryServiceError("RESOURCE_BUSY", "Memory AI quota is exhausted", event.retryable, "quota")
        : event.code === "reply_too_long" || event.code === "empty_reply" ? outputInvalid("Memory model reply is invalid")
        : event.code === "turn_timeout" || event.code === "stalled" ? new MemoryServiceError("MODEL_TIMEOUT", "Memory model operation timed out", event.retryable, "turn_timeout")
        : new MemoryServiceError("RESOURCE_BUSY", "Memory host model turn failed", event.retryable, "turn"));
    } else if (event.kind === "interrupted") {
      settled = true;
      await writeFailed({ turnId, sequenceNo, retryable: true, partialDelivered: false, hostErrorCode: "interrupted" });
      rejectAnswer?.(cancelled());
    }
  };
  const enqueue = (event: PluginBackendAiTurnEventV1): void => {
    eventChain = eventChain.then(() => process(event)).catch((error) => { settled = true; rejectAnswer?.(error as Error); });
  };
  const consume = (event: PluginBackendAiTurnEventV1): void => { if (turnId === null) pending.push(event); else enqueue(event); };
  const listenerOff = current.session.onEvent(consume);
  const stopHost = (): void => {
    if (sendStarted || turnId !== null) void current.session.interrupt().catch(() => undefined);
    if (journal !== undefined && turnId !== null && !settled) {
      interruptionWrite = writeFailed({ turnId, sequenceNo, retryable: true, partialDelivered: false, hostErrorCode: "cancelled_local" });
      void interruptionWrite.catch(() => undefined);
    }
    if (!settled) { settled = true; rejectAnswer?.(cancelled()); }
  };
  // why: without a journal nothing can store a reply that arrives after the caller left, so a soft stop there is a plain cancel
  const onSoft = (): void => { if (!detachable) stopHost(); };
  hard.addEventListener("abort", stopHost, { once: true });
  soft.addEventListener("abort", onSoft, { once: true });
  const off = (): void => {
    listenerOff();
    hard.removeEventListener("abort", stopHost);
    soft.removeEventListener("abort", onSoft);
  };
  // why: while the send is still pending there is no turn id to follow, so either stop leaves the outcome unknown and the call blocks until it is reconciled
  const raceStops = <T>(work: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const stop = (): void => { clear(); reject(cancelled()); };
    const clear = (): void => { hard.removeEventListener("abort", stop); soft.removeEventListener("abort", stop); };
    if (hard.aborted || soft.aborted) { reject(cancelled()); return; }
    hard.addEventListener("abort", stop, { once: true });
    soft.addEventListener("abort", stop, { once: true });
    let pendingWork: Promise<T>;
    try { pendingWork = work(); } catch (error) { clear(); reject(error); return; }
    pendingWork.then((value) => { clear(); resolve(value); }, (error) => { clear(); reject(error); });
  });
  const stopped = (): boolean => hard.aborted || soft.aborted || settled || request.isDisposed();
  try {
    if (hard.aborted) stopHost();
    if (turnId === null) {
      if (stopped()) {
        await writeFailed({ retryable: true, partialDelivered: false, hostErrorCode: "cancelled_before_send" });
        throw cancelled();
      }
      request.setPhase("send_unknown");
      state = "sending";
      let turn: { turnId: string };
      try {
        turn = await raceStops(async () => {
          if (stopped()) throw cancelled();
          sendStarted = true;
          return current.session.send({ text: body });
        });
      } catch (error) {
        if (!sendStarted) {
          await writeFailed({ retryable: true, partialDelivered: false, hostErrorCode: "cancelled_before_send" });
          if (error instanceof MemoryServiceError) throw error;
          throw publicError(error, "turn");
        }
        await journal?.save(context, operation, callKey, "send_unknown", { hostSessionId: current.session.sessionId, retryable: true, partialDelivered: true, hostErrorCode: (error as { code?: string } | null)?.code ?? "send_rejected" }).catch(() => undefined);
        throw publicError(error, "send");
      }
      turnId = turn.turnId;
      state = "running";
      request.setPhase("turn");
      const updatedSession: OrganizationSessionRecord = { ...current.record, turnCount: current.record.turnCount + 1, lastUsedAt: Date.now() };
      if (journal !== undefined) {
        await journal.persistSession(updatedSession);
        await journal.save(context, operation, callKey, "sent", { hostSessionId: current.session.sessionId, turnId });
      }
      request.remember(updatedSession, current.session);
      for (const event of pending.splice(0)) enqueue(event);
    } else {
      state = "running";
      for (const event of pending.splice(0)) enqueue(event);
    }
    const snapshot = current.session.turn;
    if (turnId !== null && snapshot?.turnId === turnId && snapshot.terminal?.kind === "completed" && sequenceNo !== null) {
      output = snapshot.text;
      terminal = true;
      void settleIfReady();
    }
    let value: unknown;
    if (detachable) {
      const first = await Promise.race([answer.then((found) => ({ found })), aborted(soft)]);
      if (first === "aborted") {
        state = "detached";
        request.onDetach();
        value = await answer;
      } else value = first.found;
    } else value = await answer;
    const replyJson = JSON.stringify(value);
    if (replyJson === undefined || Buffer.byteLength(replyJson, "utf8") > REPLY_LIMIT) throw outputInvalid("Memory model reply is too large");
    if (journal !== undefined) {
      await journal.saveReply(context, operation, callKey, turnId!, sequenceNo!, value);
      terminalWritten = true;
      state = "reply_ready";
    }
    return value;
  } catch (error) {
    if (interruptionWrite !== undefined) await interruptionWrite.catch(() => undefined);
    if (error instanceof MemoryServiceError) throw error;
    throw publicError(error, turnId === null ? "send" : "turn");
  } finally {
    // why: every way out of a running turn has to leave a terminal record, so a path that wrote none closes the call as cancelled_local
    if (journal !== undefined && turnId !== null && !terminalWritten && !settled && state !== "reply_ready" && state !== "failed") {
      void current.session.interrupt().catch(() => undefined);
      await writeFailed({ turnId, sequenceNo, retryable: true, partialDelivered: false, hostErrorCode: "cancelled_local" }).catch(() => undefined);
    }
    off();
  }
}
