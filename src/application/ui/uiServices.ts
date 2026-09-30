import type { AgentDirectoryPort } from "../ports.js";
import type { MemoryApplication } from "../memoryApplication.js";
import { AgentIndex } from "./agentIndex.js";
import { createCursorCodec, type CursorCodec } from "./cursor.js";
import { NO_PROFILE, type ProfilePort } from "./profilePort.js";
import { createClock, type Clock } from "./timeSlice.js";

export const SAMPLE_ROWS = 2_000;
export const RECEIPT_CHUNK_ROWIDS = 4_000;

export interface StatsCacheEntry {
  readonly version: string;
  readonly response: unknown;
}

export interface UiServices {
  readonly index: AgentIndex;
  readonly application: Pick<MemoryApplication, "execute">;
  readonly cursors: CursorCodec;
  readonly profile: ProfilePort;
  readonly statsCache: Map<string, StatsCacheEntry>;
  readonly newClock: () => Clock;
  readonly now: () => number;
  readonly sampleRows: number;
  readonly receiptChunk: number;
}

export interface UiServicesInput {
  readonly layout: AgentDirectoryPort;
  readonly application: Pick<MemoryApplication, "execute">;
  readonly profile?: ProfilePort;
  readonly newClock?: () => Clock;
  readonly now?: () => number;
  readonly sampleRows?: number;
  readonly receiptChunk?: number;
}

export function createUiServices(input: UiServicesInput): UiServices {
  return {
    index: new AgentIndex(input.layout),
    application: input.application,
    cursors: createCursorCodec(),
    profile: input.profile ?? NO_PROFILE,
    statsCache: new Map(),
    newClock: input.newClock ?? (() => createClock()),
    now: input.now ?? Date.now,
    sampleRows: input.sampleRows ?? SAMPLE_ROWS,
    receiptChunk: input.receiptChunk ?? RECEIPT_CHUNK_ROWIDS,
  };
}
