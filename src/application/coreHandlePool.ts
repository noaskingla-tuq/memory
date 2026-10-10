import type { DataLayoutPort, MemoryCorePort, ObservabilityPort } from "./ports.js";
import { MemoryServiceError } from "../domain/errors.js";

interface PoolEntry {
  readonly core: MemoryCorePort;
  leases: number;
  lastUsedAt: number;
}

export interface CoreHandlePoolOptions {
  readonly layout: DataLayoutPort;
  readonly openCore: (path: string) => MemoryCorePort;
  readonly openAgentCore?: (path: string, agentId: string) => MemoryCorePort;
  readonly observability?: ObservabilityPort;
  readonly maxOpenAgentHandles?: number;
  readonly idleHandleTtlMs?: number;
  readonly now?: () => number;
}

export class CoreHandlePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly maxOpenAgentHandles: number;
  private readonly idleHandleTtlMs: number;
  private readonly now: () => number;
  private accepting = true;

  constructor(private readonly options: CoreHandlePoolOptions) {
    this.maxOpenAgentHandles = options.maxOpenAgentHandles ?? 16;
    this.idleHandleTtlMs = options.idleHandleTtlMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }

  async withCore<T>(agentId: string, work: (core: MemoryCorePort) => Promise<T> | T): Promise<T> {
    if (!this.accepting) throw new MemoryServiceError("RESOURCE_BUSY", "Memory service is stopping");
    const entry = this.acquire(agentId);
    try {
      return await work(entry.core);
    } finally {
      entry.leases -= 1;
      entry.lastUsedAt = this.now();
    }
  }

  private acquire(agentId: string): PoolEntry {
    const existing = this.entries.get(agentId);
    if (existing !== undefined) {
      existing.leases += 1;
      this.options.observability?.emit({ event: "memory.pool.hit", openHandles: this.entries.size });
      return existing;
    }
    this.evictExpired();
    if (this.entries.size >= this.maxOpenAgentHandles) this.evictOldestIdle();
    if (this.entries.size >= this.maxOpenAgentHandles) {
      this.options.observability?.emit({ event: "memory.pool.saturated", openHandles: this.entries.size });
      throw new MemoryServiceError("RESOURCE_BUSY", "No idle agent memory handle is available");
    }
    const entry: PoolEntry = {
      core: this.options.openAgentCore?.(this.options.layout.agentDbPath(agentId), agentId) ?? this.options.openCore(this.options.layout.agentDbPath(agentId)),
      leases: 1,
      lastUsedAt: this.now(),
    };
    this.entries.set(agentId, entry);
    this.options.observability?.emit({ event: "memory.pool.open", openHandles: this.entries.size });
    return entry;
  }

  private evictExpired(): void {
    const threshold = this.now() - this.idleHandleTtlMs;
    for (const [agentId, entry] of this.entries) {
      if (entry.leases === 0 && entry.lastUsedAt <= threshold) this.closeEntry(agentId, entry);
    }
  }

  private evictOldestIdle(): void {
    let oldest: { agentId: string; entry: PoolEntry } | undefined;
    for (const [agentId, entry] of this.entries) {
      if (entry.leases !== 0) continue;
      if (oldest === undefined || entry.lastUsedAt < oldest.entry.lastUsedAt) oldest = { agentId, entry };
    }
    if (oldest !== undefined) this.closeEntry(oldest.agentId, oldest.entry);
  }

  private closeEntry(agentId: string, entry: PoolEntry): void {
    entry.core.close();
    this.entries.delete(agentId);
    this.options.observability?.emit({ event: "memory.pool.evict", openHandles: this.entries.size });
  }

  async close(timeoutMs = 30_000): Promise<void> {
    this.accepting = false;
    const deadline = this.now() + timeoutMs;
    while ([...this.entries.values()].some((entry) => entry.leases > 0) && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const [agentId, entry] of [...this.entries]) {
      if (entry.leases === 0) this.closeEntry(agentId, entry);
    }
  }

  get openHandles(): number {
    return this.entries.size;
  }
}
