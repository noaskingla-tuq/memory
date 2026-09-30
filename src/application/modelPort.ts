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
  }): Promise<unknown>;
}
