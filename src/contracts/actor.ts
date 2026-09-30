/** 記憶操作的呼叫身分。 */
export interface MemoryActor {
  readonly sessionId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly providerId: string;
}
