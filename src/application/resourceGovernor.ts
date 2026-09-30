import { MemoryServiceError } from "../domain/errors.js";

export interface ResourceGovernorOptions {
  readonly maxGlobalRequests?: number;
  readonly maxRequestsPerSession?: number;
}

export class ResourceGovernor {
  private readonly maxGlobalRequests: number;
  private readonly maxRequestsPerSession: number;
  private globalRequests = 0;
  private readonly sessionRequests = new Map<string, number>();
  private accepting = true;

  constructor(options: ResourceGovernorOptions = {}) {
    this.maxGlobalRequests = options.maxGlobalRequests ?? 32;
    this.maxRequestsPerSession = options.maxRequestsPerSession ?? 4;
  }

  async run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const perSession = this.sessionRequests.get(sessionId) ?? 0;
    if (!this.accepting || this.globalRequests >= this.maxGlobalRequests || perSession >= this.maxRequestsPerSession) {
      throw new MemoryServiceError("RESOURCE_BUSY", "Memory service is at capacity");
    }
    this.globalRequests += 1;
    this.sessionRequests.set(sessionId, perSession + 1);
    try {
      return await work();
    } finally {
      this.globalRequests -= 1;
      const remaining = (this.sessionRequests.get(sessionId) ?? 1) - 1;
      if (remaining === 0) this.sessionRequests.delete(sessionId);
      else this.sessionRequests.set(sessionId, remaining);
    }
  }

  fence(): void {
    this.accepting = false;
  }

  get activeRequests(): number {
    return this.globalRequests;
  }
}
