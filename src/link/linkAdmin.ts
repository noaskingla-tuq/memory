import { LinkAdminError, type LinkAdminPort, type LinkRawItem, type LinkSourceRecord } from "../application/ui/linkAdminPort.js";
import type { LinkStore } from "./linkStore.js";
import { StoreError, fileIdOf, payloadBytes, type LinkItem } from "./storeFile.js";

function mapError(error: unknown): never {
  if (error instanceof LinkAdminError) throw error;
  if (error instanceof StoreError) {
    switch (error.code) {
      case "conflict": throw new LinkAdminError("REVISION_CONFLICT");
      case "not_found": throw new LinkAdminError("NOT_FOUND");
      case "provider_not_ready":
      case "disposed": throw new LinkAdminError("STORAGE_BUSY");
      default: throw new LinkAdminError("STORAGE_UNSUPPORTED");
    }
  }
  throw error;
}

async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return mapError(error);
  }
}

const sizes = new WeakMap<LinkItem, number>();
const sizeOf = (item: LinkItem): number => {
  let size = sizes.get(item);
  if (size === undefined) {
    size = payloadBytes(item.payload);
    sizes.set(item, size);
  }
  return size;
};

const rawOf = (item: LinkItem): LinkRawItem => ({
  id: item.id,
  payload: item.payload,
  tags: item.tags ?? [],
  sizeBytes: sizeOf(item),
  rev: item.rev,
  updatedAtMs: item.updatedAtMs,
  expiresAtMs: item.expiresAtMs ?? null,
});

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createLinkAdmin(store: LinkStore): LinkAdminPort {
  async function requireReadable(source: string): Promise<void> {
    const described = await store.describeFile(fileIdOf(source));
    if (described.state === "corrupt") throw new LinkAdminError("STORAGE_UNSUPPORTED");
  }

  return {
    limits: () => ({ ...store.limits }),

    sources() {
      return attempt(async () => {
        const rows: LinkSourceRecord[] = [];
        for (const fileId of await store.listFiles()) {
          await yieldTurn();
          let described;
          try {
            described = await store.describeFile(fileId);
          } catch (error) {
            if (error instanceof StoreError && error.code === "not_found") continue;
            throw error;
          }
          if (described.state === "corrupt") {
            rows.push({ source: null, fileId, state: "corrupt", count: 0, sizeBytes: 0, revision: 0, updatedAtMs: null });
            continue;
          }
          const at = store.now();
          const live = described.rows.filter((row) => row.expiresAtMs === undefined || row.expiresAtMs > at);
          rows.push({
            source: described.source,
            fileId,
            state: "ok",
            count: live.length,
            sizeBytes: live.reduce((sum, row) => sum + row.payloadBytes, 0),
            revision: described.revision,
            updatedAtMs: live.length === 0 ? null : live.reduce((latest, row) => Math.max(latest, row.updatedAtMs), 0),
          });
        }
        return rows;
      });
    },

    list(source) {
      return attempt(async () => {
        await requireReadable(source);
        const snapshot = await store.snapshot(source);
        return { revision: snapshot.revision, items: snapshot.items.map(rawOf) };
      });
    },

    get(source, id) {
      return attempt(async () => {
        await requireReadable(source);
        const snapshot = await store.snapshot(source);
        const found = snapshot.items.find((item) => item.id === id);
        if (found === undefined) throw new LinkAdminError("NOT_FOUND");
        return { revision: snapshot.revision, item: rawOf(found) };
      });
    },

    forgetItem(source, id, expectedItemRev) {
      return attempt(async () => {
        await requireReadable(source);
        const outcome = await store.commit(
          source,
          (snap) => {
            const kept = snap.items.filter((item) => item.id !== id);
            return { items: kept, result: kept.length };
          },
          { item: { id, rev: expectedItemRev } },
        );
        return { forgotten: 1, revision: outcome.result === 0 ? null : outcome.revision };
      });
    },

    forgetSource(source, expectedRevision) {
      return attempt(async () => {
        await requireReadable(source);
        const outcome = await store.commit(source, (snap) => ({ items: [], result: snap.items.length }), { revision: expectedRevision });
        return { forgotten: outcome.result, revision: null };
      });
    },

    discardDamaged(fileId) {
      return attempt(() => store.discardDamaged(fileId));
    },
  };
}
