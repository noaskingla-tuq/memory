import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PunchReceiptStorePort, PunchStateRecord } from "../../application/punchDataPorts.js";

interface SavedState { version: 1; records: Record<string, PunchStateRecord>; }

export function createLocalPunchReceiptStore(dataDir: string, name = "punch-state.json"): PunchReceiptStorePort {
  const root = resolve(dataDir);
  const file = resolve(root, name);
  const suffix = relative(root, file);
  const pages = new Map<string, { readonly records: readonly PunchStateRecord[]; readonly offset: number }>();
  if (!isAbsolute(dataDir) || suffix.startsWith("..") || isAbsolute(suffix) || suffix === "" || suffix.includes("/") || suffix.includes("\\")) throw new Error("state_path_invalid");
  const safe = (): void => {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error("state_path_unsafe");
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile() || realpathSync(file) !== join(realpathSync(root), name))) throw new Error("state_path_unsafe");
  };
  const read = (): SavedState => {
    safe();
    if (!existsSync(file)) return { version: 1, records: {} };
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw?.version !== 1 || raw.records === null || typeof raw.records !== "object" || Array.isArray(raw.records)) throw new Error("state_file_invalid");
    for (const [key, value] of Object.entries(raw.records)) {
      const row = value as PunchStateRecord;
      if (row?.key !== key || !Number.isSafeInteger(row.revision) || (row.revision ?? 0) < 1) throw new Error("state_file_invalid");
    }
    return raw;
  };
  return {
    async readPage(cursor, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("state_limit_invalid");
      const snapshot = cursor === null ? { records: Object.values(read().records).sort((left, right) => left.key.localeCompare(right.key)), offset: 0 } : pages.get(cursor);
      if (snapshot === undefined) throw new Error("state_cursor_invalid");
      if (cursor !== null) pages.delete(cursor);
      const { records, offset } = snapshot;
      let nextCursor: string | null = null;
      if (offset + limit < records.length) {
        nextCursor = randomUUID();
        pages.set(nextCursor, { records, offset: offset + limit });
        if (pages.size > 8) pages.delete(pages.keys().next().value!);
      }
      return { records: records.slice(offset, offset + limit), nextCursor };
    },
    async writeBatch(records) {
      const current = read();
      const next = { ...current.records };
      const seen = new Set<string>();
      for (const row of records) {
        if (typeof row.key !== "string" || row.key.length === 0 || row.key.length > 256 || seen.has(row.key)) throw new Error("state_key_invalid");
        seen.add(row.key);
        const before = Object.hasOwn(next, row.key) ? next[row.key] : undefined;
        if (row.expectedRevision !== undefined && row.expectedRevision !== (before?.revision ?? null)) throw new Error("state_revision_conflict");
        const { expectedRevision, ...saved } = row;
        Object.defineProperty(next, row.key, { value: { ...saved, revision: (before?.revision ?? 0) + 1 }, enumerable: true, configurable: true, writable: true });
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        try {
          writeFileSync(fd, `${JSON.stringify({ version: 1, records: next })}\n`);
          try { fsyncSync(fd); } catch (error) { if ((error as { code?: string }).code !== "ERR_ACCESS_DENIED") throw error; }
        } finally { closeSync(fd); }
        safe();
        renameSync(temporary, file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    },
  };
}
