import { MemoryServiceError } from "../domain/errors.js";

interface Lane {
  tail: Promise<void>;
  queued: number;
}

export class AgentWriteLane {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly maxQueuedWritesPerAgent = 64) {}

  run<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(agentId) ?? { tail: Promise.resolve(), queued: 0 };
    if (lane.queued >= this.maxQueuedWritesPerAgent) {
      return Promise.reject(new MemoryServiceError("RESOURCE_BUSY", "Agent write queue is full"));
    }
    lane.queued += 1;
    this.lanes.set(agentId, lane);
    const operation = lane.tail.catch(() => undefined).then(work);
    lane.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => {
      lane.queued -= 1;
      if (lane.queued === 0) this.lanes.delete(agentId);
    });
  }

  queued(agentId: string): number {
    return this.lanes.get(agentId)?.queued ?? 0;
  }
}
