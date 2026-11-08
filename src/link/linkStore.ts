import { randomBytes } from "node:crypto";
import {
  StoreError, classifyWriteError, createFsIo, fileIdOf, itemBytes, loadFile, payloadBytes, serializePartition,
  type FileStat, type LinkItem, type PartitionState, type StoreIo,
} from "./storeFile.js";

export interface LinkLimits {
  readonly items: number;
  readonly bytes: number;
  readonly sources: number;
}

export const LINK_LIMITS: LinkLimits = Object.freeze({ items: 2000, bytes: 2_097_152, sources: 32 });

const CONTENT_CACHE_SIZE = 4;

export interface Snapshot {
  readonly source: string;
  readonly revision: number;
  readonly items: readonly LinkItem[];
}

export interface CommitExpect {
  readonly revision?: number;
  readonly item?: { readonly id: string; readonly rev: number };
}

export interface Mutation<T> {
  readonly items: readonly LinkItem[];
  readonly result: T;
}

export interface CommitOutcome<T> {
  readonly result: T;
  readonly revision: number;
  readonly changed: boolean;
}

export interface SummaryRow {
  readonly payloadBytes: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number | undefined;
}

export type FileDescription =
  | { readonly state: "corrupt"; readonly fileId: string }
  | { readonly state: "ok"; readonly fileId: string; readonly source: string; readonly revision: number; readonly rows: readonly SummaryRow[] };

export interface SourceHealth {
  readonly state: "empty" | "ok" | "corrupt" | "write_failed";
  readonly count: number;
  readonly bytes: number;
}

export interface LinkStoreOptions {
  readonly io?: StoreIo;
  readonly dataDir?: string;
  readonly now?: () => number;
  readonly limits?: LinkLimits;
}

export interface LinkStore {
  snapshot(source: string): Promise<Snapshot>;
  commit<T>(source: string, mutate: (snapshot: Snapshot, at: number) => Mutation<T>, expect?: CommitExpect): Promise<CommitOutcome<T>>;
  health(source: string): Promise<SourceHealth>;
  listFiles(): Promise<string[]>;
  describeFile(fileId: string): Promise<FileDescription>;
  discardDamaged(fileId: string): Promise<void>;
  readonly limits: LinkLimits;
  readonly now: () => number;
  dispose(): Promise<void>;
}

export function newItemId(): string {
  return `m${randomBytes(11).toString("hex")}`;
}

export function liveItems(items: readonly LinkItem[], at: number): readonly LinkItem[] {
  return items.some((item) => item.expiresAtMs !== undefined && item.expiresAtMs <= at) ? items.filter((item) => item.expiresAtMs === undefined || item.expiresAtMs > at) : items;
}

export function summarize(items: readonly LinkItem[]): readonly SummaryRow[] {
  return items.map((item) => ({ payloadBytes: payloadBytes(item.payload), updatedAtMs: item.updatedAtMs, expiresAtMs: item.expiresAtMs }));
}

export function createLinkStore(options: LinkStoreOptions): LinkStore {
  const io = options.io ?? createFsIo(options.dataDir ?? "");
  const now = options.now ?? Date.now;
  const limits = options.limits ?? LINK_LIMITS;
  const cache = new Map<string, PartitionState>();
  const summaries = new Map<string, { readonly stat: FileStat; readonly description: FileDescription }>();
  const generations = new Map<string, number>();
  const writeFailed = new Set<string>();
  const tails = new Map<string, Promise<void>>();
  let creation: Promise<void> = Promise.resolve();
  let disposed = false;

  const generationOf = (fileId: string): number => generations.get(fileId) ?? 0;
  const bump = (fileId: string): void => {
    generations.set(fileId, generationOf(fileId) + 1);
    summaries.delete(fileId);
  };
  const remember = (fileId: string, state: PartitionState): void => {
    cache.delete(fileId);
    cache.set(fileId, state);
    while (cache.size > CONTENT_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  };

  async function load(source: string): Promise<PartitionState> {
    const fileId = fileIdOf(source);
    const cached = cache.get(fileId);
    if (cached !== undefined) {
      cache.delete(fileId);
      cache.set(fileId, cached);
      return cached;
    }
    const started = generationOf(fileId);
    const loaded = await loadFile(io, fileId);
    if (loaded.kind === "corrupt") throw new StoreError("provider_error", "corrupt");
    if (loaded.kind === "absent") return { source, revision: 0, items: [] };
    if (generationOf(fileId) === started) remember(fileId, loaded.state);
    return loaded.state;
  }

  function enqueue<T>(fileId: string, task: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new StoreError("disposed"));
    const run = (tails.get(fileId) ?? Promise.resolve()).then(() => {
      if (disposed) throw new StoreError("disposed");
      return task();
    });
    const tail = run.then(() => undefined, () => undefined);
    tails.set(fileId, tail);
    void tail.then(() => { if (tails.get(fileId) === tail) tails.delete(fileId); });
    return run;
  }

  function overQuota(before: readonly LinkItem[], after: readonly LinkItem[]): boolean {
    const total = (items: readonly LinkItem[]): number => items.reduce((sum, item) => sum + itemBytes(item), 0);
    const grewCount = after.length > before.length && after.length > limits.items;
    return grewCount || (after.length > 0 && total(after) > limits.bytes && total(after) > total(before));
  }

  async function persist(fileId: string, next: PartitionState): Promise<void> {
    if (next.items.length === 0) {
      await io.remove(fileId);
      return;
    }
    if ((await io.stat(fileId)) !== undefined) {
      await io.write(fileId, serializePartition(next));
      return;
    }
    const gate = creation.then(async () => {
      if ((await io.list()).length >= limits.sources) throw new StoreError("quota_exceeded");
      await io.write(fileId, serializePartition(next));
    });
    creation = gate.then(() => undefined, () => undefined);
    await gate;
  }

  return {
    limits,
    now,

    async snapshot(source) {
      const state = await load(source);
      return { source, revision: state.revision, items: liveItems(state.items, now()) };
    },

    commit(source, mutate, expect) {
      const fileId = fileIdOf(source);
      return enqueue(fileId, async () => {
        const state = await load(source);
        const at = now();
        const snap: Snapshot = { source, revision: state.revision, items: liveItems(state.items, at) };
        if (expect?.revision !== undefined && snap.revision !== expect.revision) throw new StoreError("conflict");
        if (expect?.item !== undefined) {
          const wanted = expect.item;
          const found = snap.items.find((item) => item.id === wanted.id);
          if (found === undefined) throw new StoreError("not_found");
          if (found.rev !== wanted.rev) throw new StoreError("conflict");
        }
        const out = mutate(snap, at);
        if (out.items === snap.items) return { result: out.result, revision: snap.revision, changed: false };
        if (overQuota(snap.items, out.items)) throw new StoreError("quota_exceeded");
        const next: PartitionState = { source, revision: state.revision + 1, items: out.items };
        try {
          await persist(fileId, next);
        } catch (error) {
          const failure = classifyWriteError(error);
          if (failure.code !== "quota_exceeded") writeFailed.add(source);
          throw failure;
        }
        writeFailed.delete(source);
        bump(fileId);
        remember(fileId, next);
        return { result: out.result, revision: next.revision, changed: true };
      });
    },

    async health(source) {
      const fileId = fileIdOf(source);
      let state: PartitionState;
      try {
        state = await load(source);
      } catch (error) {
        if (error instanceof StoreError && error.code === "provider_error") return { state: "corrupt", count: 0, bytes: 0 };
        throw error;
      }
      const items = liveItems(state.items, now());
      const bytes = items.reduce((sum, item) => sum + itemBytes(item), 0);
      if (writeFailed.has(source)) return { state: "write_failed", count: items.length, bytes };
      const present = state.revision > 0 && (await io.stat(fileId)) !== undefined;
      return { state: present ? "ok" : "empty", count: items.length, bytes };
    },

    async listFiles() {
      return io.list();
    },

    async describeFile(fileId) {
      const stat = await io.stat(fileId);
      if (stat === undefined) throw new StoreError("not_found");
      const known = summaries.get(fileId);
      if (known !== undefined && known.stat.size === stat.size && known.stat.mtimeMs === stat.mtimeMs) return known.description;
      const started = generationOf(fileId);
      const loaded = await loadFile(io, fileId);
      if (loaded.kind === "absent") throw new StoreError("not_found");
      const description: FileDescription = loaded.kind === "corrupt"
        ? { state: "corrupt", fileId }
        : { state: "ok", fileId, source: loaded.state.source, revision: loaded.state.revision, rows: summarize(loaded.state.items) };
      if (generationOf(fileId) === started) summaries.set(fileId, { stat, description });
      return description;
    },

    discardDamaged(fileId) {
      return enqueue(fileId, async () => {
        const loaded = await loadFile(io, fileId);
        if (loaded.kind === "absent") throw new StoreError("not_found");
        if (loaded.kind === "ok") throw new StoreError("conflict");
        try {
          await io.remove(fileId);
        } catch (error) {
          throw classifyWriteError(error);
        }
        bump(fileId);
        cache.delete(fileId);
      });
    },

    async dispose() {
      disposed = true;
      await Promise.all([...tails.values()]);
    },
  };
}
