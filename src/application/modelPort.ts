export type MemoryModelOperation =
  | "select"
  | "rank"
  | "extract"
  | "reconcile"
  | "qualify"
  | "qualifyCandidates"
  | "classify"
  | "relate"
  | "reviewBasis";

export interface MemoryModelPolicy {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly tokenizerId: string;
  readonly revision: string;
  readonly enabled: boolean;
  readonly allowedOperations: ReadonlySet<MemoryModelOperation>;
}

export interface MemoryModelInvocationContext {
  readonly canonicalAgentId: string;
  readonly sourceProjectId: string | null;
  readonly operationId: string;
  readonly modelOperation: MemoryModelOperation;
  readonly operationSystemSha256: string;
  readonly canonicalRequestSha256: string;
  readonly sameRequestOccurrence: number;
  readonly allowModelSend?: boolean;
}

export interface MemoryModelPort {
  resolvePolicy(agentId: string): MemoryModelPolicy;
  countTokens(policy: MemoryModelPolicy, text: string): number;
  invoke(input: {
    readonly agentId: string;
    readonly policy: MemoryModelPolicy;
    readonly operation: MemoryModelOperation;
    readonly system: string;
    readonly input: unknown;
    readonly maxOutputTokens: 1024;
    readonly signal: AbortSignal;
    readonly invocation?: MemoryModelInvocationContext;
  }): Promise<unknown>;
}
