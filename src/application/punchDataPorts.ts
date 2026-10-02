export type PunchWriteScope = "personal" | "project";

export interface SettledPunch {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly providerId: string | null;
  readonly punchType: "main" | "subagent";
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly model: string | null;
  readonly name: string | null;
  readonly description: string | null;
}

export interface SettledPunchSnapshot {
  readonly snapshotId: string;
  readonly generation: string;
  readonly highWatermark: string | null;
}

export interface SettledPunchPage {
  readonly snapshot: SettledPunchSnapshot;
  readonly records: readonly SettledPunch[];
  readonly nextCursor: string | null;
}

export interface PunchFeedPort {
  openSettledSnapshot(): Promise<SettledPunchSnapshot>;
  readSettledPage(input: {
    readonly snapshotId: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<SettledPunchPage>;
  subscribeSettledChanges(listener: () => void): () => void;
}

export type PunchTerminalReceipt =
  | {
      readonly state: "written";
      readonly punchId: string;
      readonly agentId: string;
      readonly scope: PunchWriteScope;
      readonly projectId: string | null;
      readonly memoryId: string;
      readonly contentSha256: string;
      readonly writtenAt: number;
    }
  | {
      readonly state: "skipped";
      readonly punchId: string;
      readonly agentId: string;
      readonly scope: PunchWriteScope;
      readonly projectId: string | null;
      readonly reason: string;
      readonly writtenAt: number;
    };

export interface PunchStateRecord {
  readonly key: string;
  readonly value: unknown;
  readonly revision?: number;
  readonly expectedRevision?: number | null;
  readonly sourceKind?: string | null;
  readonly sourceId?: string | null;
}

export interface PunchReceiptStorePort {
  readPage(cursor: string | null, limit: number): Promise<{
    readonly records: readonly PunchStateRecord[];
    readonly nextCursor: string | null;
  }>;
  writeBatch(records: readonly PunchStateRecord[]): Promise<void>;
}

export interface LegacyPunchStatePort {
  readPage(cursor: string | null, limit: number): Promise<{
    readonly records: readonly PunchStateRecord[];
    readonly nextCursor: string | null;
  }>;
  deleteBatch(keys: readonly string[]): Promise<void>;
}

export interface PunchMemoryWrite {
  readonly agentId: string;
  readonly projectId: string | null;
  readonly sessionId: string;
  readonly providerId: string;
  readonly scope: PunchWriteScope;
  readonly content: string;
  readonly operationId: string;
}

export type PunchMemoryWriteResult =
  | { readonly ok: true; readonly memoryId: string; readonly deduplicated: boolean }
  | { readonly ok: false; readonly code: string; readonly retryable: boolean };

export interface PunchMemoryWriterPort {
  rememberMany(inputs: readonly PunchMemoryWrite[]): Promise<readonly PunchMemoryWriteResult[]>;
}
