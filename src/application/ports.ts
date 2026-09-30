import type { MemoryNamespace } from "../domain/namespace.js";

export type CoreResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly retryable: boolean };
    };

export interface MemoryCorePort {
  admit(input: {
    readonly namespace: MemoryNamespace;
    readonly memory: { readonly content: string; readonly kind: string };
    readonly receipts: readonly unknown[];
  }): CoreResult;
  list(input: {
    readonly namespace: MemoryNamespace;
    readonly limit: number;
    readonly cursor?: string;
  }): CoreResult;
  get(input: {
    readonly namespace: MemoryNamespace;
    readonly memoryId: string;
    readonly receiptLimit?: number;
    readonly receiptCursor?: string;
  }): CoreResult;
  correct(input: {
    readonly namespace: MemoryNamespace;
    readonly memoryId: string;
    readonly expectedRevision: number;
    readonly content: string;
    readonly kind: string;
    readonly receipt: unknown;
  }): CoreResult;
  forget(input: {
    readonly namespace: MemoryNamespace;
    readonly memoryId: string;
    readonly expectedRevision: number;
  }): CoreResult;
  recall(input: {
    readonly readSet: readonly MemoryNamespace[];
    readonly query: string;
    readonly limit: number;
  }): Promise<CoreResult>;
  capture(input: {
    readonly namespace: MemoryNamespace;
    readonly client: string;
    readonly eventId: string;
    readonly sessionId: string;
    readonly messages: readonly {
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly content: string;
    }[];
  }): Promise<CoreResult>;
  close(): void;
}

export interface DataLayoutPort {
  agentDbPath(agentId: string): string;
  preflight(): void;
}

export type AgentDirectoryState = "ready" | "no_database" | "unsafe" | "unreadable";

export interface AgentDirectory {
  readonly agentHash: string;
  readonly databasePath: string | null;
  readonly state: AgentDirectoryState;
}

export interface AgentDirectoryPort {
  listAgentDirectories(): readonly AgentDirectory[];
  agentDirectoryNames(): readonly string[];
  inspectAgentDirectory(agentHash: string): AgentDirectory | undefined;
  agentsFingerprint(): string;
}

export interface ObservabilityPort {
  emit(event: Readonly<Record<string, unknown>>): void;
}
