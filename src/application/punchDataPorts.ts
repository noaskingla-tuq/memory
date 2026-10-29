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
  readSnapshotDiagnostics?(snapshotId: string): Promise<WorkRecordSnapshotDiagnostics | null>;
}

export interface WorkRecordSnapshotDiagnostics {
  readonly processed: number;
  readonly scanned: number;
  readonly returned: number;
  readonly schemaSkipped: number;
  readonly available: true;
}

export interface OrganizationSessionRecord {
  readonly version: 1;
  readonly pairKey: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly hostSessionId: string;
  readonly baseSystemVersion: 1;
  readonly baseSystemSha256: string;
  readonly taskId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly policyRevision: string;
  readonly openedAt: number;
  readonly lastUsedAt: number;
  readonly turnCount: number;
  readonly state: "active" | "expired" | "resume_unavailable" | "invalidated";
}

export interface OrganizationCallRecord {
  readonly callKey: string;
  readonly callKeyVersion?: 2;
  readonly operationKey: string;
  readonly pairKey: string;
  readonly modelOperation: string;
  readonly operationSystemSha256: string;
  readonly requestSha256: string;
  readonly occurrence: number;
  readonly hostSessionId: string | null;
  readonly turnId: string | null;
  readonly sequenceNo: number | null;
  readonly phase: "prepared" | "sent" | "reply_ready" | "commit_retry" | "send_unknown" | "failed";
  readonly retryable: boolean;
  readonly partialDelivered: boolean;
  readonly hostErrorCode: string | null;
  readonly replyJson: string | null;
  readonly replySha256: string | null;
  readonly responseBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OrganizationOperationRecord {
  readonly operationKey: string;
  readonly pairKey: string;
  readonly operationId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly calls: Readonly<Record<string, OrganizationCallRecord>>;
  readonly updatedAt: number;
}

export interface OrganizationDailyRound {
  readonly roundId: string;
  readonly state: "running" | "paused" | "completed" | "superseded";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly nextResumeAt: number | null;
  readonly completedAt: number | null;
  readonly lastPhase: string | null;
  readonly snapshot: {
    readonly queueSequenceHighWatermark: number;
    readonly eligibleMemberCount: number;
    readonly eligibleOperationKeysSha256: string;
    readonly capturedAt: number;
    readonly sourceGeneration: string | null;
    readonly sourceHighWatermark: string | null;
  };
  readonly completedMembers: number;
  readonly deferredMembers: number;
  readonly deferredLegacyCount: number;
}

export interface OrganizationResumeState {
  readonly version: 1;
  readonly sessions: Readonly<Record<string, OrganizationSessionRecord>>;
  readonly operations: Readonly<Record<string, OrganizationOperationRecord>>;
  readonly dailyRounds: Readonly<Record<string, OrganizationDailyRound>>;
  readonly claimedThroughDate?: string;
  readonly lastSourceRun?: {
    readonly snapshotId: string | null;
    readonly generation: string | null;
    readonly highWatermark: string | null;
    readonly pages: number;
    readonly scanned: number | null;
    readonly received: number;
    readonly eligible: number;
    readonly admitted: number;
    readonly checkpointed: boolean;
    readonly schemaSkipped: number | null;
    readonly diagnosticsAvailable: boolean;
    readonly updatedAt: number;
  };
}

export interface OrganizationResumeStorePort extends PunchReceiptStorePort {
  enqueueJob(key: string, value: unknown, sourceKind: string, sourceId: string): Promise<number>;
  readResumeState(): Promise<OrganizationResumeState | null>;
  writeResumeState(state: OrganizationResumeState): Promise<void>;
  transactResumeState(update: (state: OrganizationResumeState) => OrganizationResumeState): Promise<OrganizationResumeState>;
  beginOrResumeDailyRound(date: string, source?: { generation: string | null; highWatermark: string | null }, capturedAt?: number): Promise<{
    readonly shouldRun: boolean;
    readonly replyOnly?: boolean;
    readonly round: OrganizationDailyRound | null;
  }>;
  completeJobAndPruneOperation?(record: PunchStateRecord, operationKey: string): Promise<void>;
  updateDailyRound(date: string, round: OrganizationDailyRound): Promise<void>;
  pruneOperation(operationKey: string): Promise<void>;
  hasRecoverableReply(pairKey: string, operationId: string): Promise<boolean>;
  sourceRun?(run: NonNullable<OrganizationResumeState["lastSourceRun"]>): Promise<void>;
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
