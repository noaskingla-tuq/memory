import { randomBytes } from "node:crypto";
import {
  StoreError, classifyWriteError, createFsIo, fileIdOf, isValidPartitionKey, itemBytes, loadFile, payloadBytes, serializePartition,
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
  snapshot(source: string): Snapshot;
  commit<T>(source: string, mutate: (snapshot: Snapshot, at: number) => Mutation<T>, expect?: CommitExpect): Promise<CommitOutcome<T>>;
  health(source: string): SourceHealth;
  listFiles(): string[];
  describeFile(fileId: string): FileDescription;
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
  const revisionFloor = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
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

  const open = (): void => {
    if (disposed) throw new StoreError("disposed");
  };

  function load(source: string): PartitionState {
    open();
    const fileId = fileIdOf(source);
    const cached = cache.get(fileId);
    if (cached !== undefined) {
      cache.delete(fileId);
      cache.set(fileId, cached);
      return cached;
    }
    const started = generationOf(fileId);
    const loaded = loadFile(io, fileId);
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

  function persist(fileId: string, next: PartitionState): void {
    if (next.items.length === 0) {
      io.remove(fileId);
      return;
    }
    if (io.stat(fileId) === undefined && io.list().length >= limits.sources) throw new StoreError("quota_exceeded");
    io.write(fileId, serializePartition(next));
  }

  return {
    limits,
    now,

    snapshot(source) {
      const state = load(source);
      return { source, revision: state.revision, items: liveItems(state.items, now()) };
    },

    commit(source, mutate, expect) {
      if (!isValidPartitionKey(source)) return Promise.reject(new StoreError("provider_error", "source_invalid"));
      const fileId = fileIdOf(source);
      return enqueue(fileId, async () => {
        const state = load(source);
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
        // why: a partition with no file has no revision history; restarting from 0 would reuse numbers an open screen still holds, so continue above everything seen this run and above the wall clock
        const revision = (state.revision > 0 ? state.revision : Math.max(revisionFloor.get(fileId) ?? 0, at)) + 1;
        // why: an item's rev only has to grow for its id; a new id takes the partition revision so an id that was deleted and written again never gets a rev an old screen still holds
        const before = new Map(snap.items.map((item) => [item.id, item]));
        const stamped = out.items.map((item) => {
          if (before.get(item.id) === item) return item;
          const prior = before.get(item.id);
          return { ...item, rev: prior === undefined ? revision : Math.max(item.rev, prior.rev + 1) };
        });
        const next: PartitionState = { source, revision, items: stamped };
        try {
          persist(fileId, next);
        } catch (error) {
          const failure = classifyWriteError(error);
          if (failure.code !== "quota_exceeded") writeFailed.add(source);
          throw failure;
        }
        writeFailed.delete(source);
        revisionFloor.set(fileId, next.revision);
        bump(fileId);
        remember(fileId, next);
        return { result: out.result, revision: next.revision, changed: true };
      });
    },

    health(source) {
      open();
      const fileId = fileIdOf(source);
      let state: PartitionState;
      try {
        state = load(source);
      } catch (error) {
        if (error instanceof StoreError && error.code === "provider_error") return { state: "corrupt", count: 0, bytes: 0 };
        throw error;
      }
      const items = liveItems(state.items, now());
      const bytes = items.reduce((sum, item) => sum + itemBytes(item), 0);
      if (writeFailed.has(source)) return { state: "write_failed", count: items.length, bytes };
      const present = state.revision > 0 && io.stat(fileId) !== undefined;
      return { state: present ? "ok" : "empty", count: items.length, bytes };
    },

    listFiles() {
      open();
      return io.list();
    },

    describeFile(fileId) {
      open();
      const stat = io.stat(fileId);
      if (stat === undefined) throw new StoreError("not_found");
      const known = summaries.get(fileId);
      if (known !== undefined && known.stat.size === stat.size && known.stat.mtimeMs === stat.mtimeMs) return known.description;
      const started = generationOf(fileId);
      const loaded = loadFile(io, fileId);
      if (loaded.kind === "absent") throw new StoreError("not_found");
      const description: FileDescription = loaded.kind === "corrupt"
        ? { state: "corrupt", fileId }
        : { state: "ok", fileId, source: loaded.state.source, revision: loaded.state.revision, rows: summarize(loaded.state.items) };
      if (generationOf(fileId) === started) summaries.set(fileId, { stat, description });
      return description;
    },

    discardDamaged(fileId) {
      return enqueue(fileId, async () => {
        const loaded = loadFile(io, fileId);
        if (loaded.kind === "absent") throw new StoreError("not_found");
        if (loaded.kind === "ok") throw new StoreError("conflict");
        try {
          io.remove(fileId);
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
