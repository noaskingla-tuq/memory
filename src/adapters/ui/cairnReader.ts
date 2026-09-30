import { lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryNamespace } from "../../domain/namespace.js";

export const CAIRN_APPLICATION_ID = 0x43414952;
export const CAIRN_USER_VERSION = 13;

const BUSY_TIMEOUT_MS = 2_000;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_NOTADB = 26;
const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const DEFAULT_SNIPPET_CHARS = 160;

export type CairnReaderFailure =
  | "not_found"
  | "unsafe_path"
  | "unsupported_schema"
  | "busy"
  | "unreadable";

export type ReaderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CairnReaderFailure };

export interface NamespaceSummary {
  readonly ownerId: string;
  readonly scope: "personal" | "project";
  readonly projectId: string | null;
  readonly count: number;
}

export interface KeysetAnchor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ListOptions {
  readonly limit: number;
  readonly after?: KeysetAnchor;
  readonly updatedFrom?: string;
  readonly updatedBefore?: string;
  readonly snippetChars?: number;
}

export interface ListedMemory {
  readonly id: string;
  readonly kind: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly snippet: string;
  readonly receiptCount: number;
}

export interface StoredReceipt {
  readonly id: string;
  readonly client: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly role: string;
  readonly excerpt: string;
  readonly createdAt: string;
}

export interface StoredMemory {
  readonly id: string;
  readonly namespace: MemoryNamespace;
  readonly kind: string;
  readonly origin: string;
  readonly confidence: number;
  readonly revision: number;
  readonly state: "active" | "historical";
  readonly filing: string;
  readonly receiptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly content: string;
}

export interface CairnReader {
  namespaces(): NamespaceSummary[];
  list(namespace: MemoryNamespace, options: ListOptions): ListedMemory[];
  get(
    namespace: MemoryNamespace,
    memoryId: string,
    receiptLimit: number,
  ): { readonly memory: StoredMemory; readonly receipts: StoredReceipt[] } | null;
}

type Row = Record<string, unknown>;
type SqliteFailure = Error & { errcode?: number };

function isSqliteError(error: unknown): error is SqliteFailure {
  return error instanceof Error && (error as { code?: unknown }).code === "ERR_SQLITE_ERROR";
}

function failureOf(error: SqliteFailure): CairnReaderFailure {
  const primary = typeof error.errcode === "number" ? error.errcode & 0xff : undefined;
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return "busy";
  if (primary === SQLITE_NOTADB) return "unsupported_schema";
  return "unreadable";
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

// why: a plugin dataDir can be swapped for a reparse point behind the layout's back, so the reader rechecks the file, its parent and the journal sidecars itself
function guardPath(path: string): CairnReaderFailure | null {
  if (!isAbsolute(path)) return "unsafe_path";
  try {
    const file = statOrNull(path);
    if (file === null) return "not_found";
    if (file.isSymbolicLink() || !file.isFile()) return "unsafe_path";
    const parent = statOrNull(dirname(path));
    if (parent === null) return "not_found";
    if (parent.isSymbolicLink() || !parent.isDirectory()) return "unsafe_path";
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = statOrNull(`${path}${suffix}`);
      if (sidecar !== null && (sidecar.isSymbolicLink() || !sidecar.isFile())) return "unsafe_path";
    }
    return null;
  } catch {
    return "unreadable";
  }
}

const boundary = (namespace: MemoryNamespace): [string, string, string] => [
  namespace.ownerId,
  namespace.scope,
  namespace.projectId ?? "",
];

function namespaceOf(row: Row): MemoryNamespace {
  const isProject = row.scope === "project";
  return {
    ownerId: String(row.owner_id),
    scope: isProject ? "project" : "personal",
    projectId: isProject ? String(row.project_id) : null,
  };
}

function createReader(db: DatabaseSync): CairnReader {
  return {
    namespaces() {
      const rows = db
        .prepare(
          `SELECT e.owner_id, e.scope, e.project_id,
            (SELECT count(*) FROM memories m WHERE m.owner_id = e.owner_id AND m.scope = e.scope
              AND m.project_id = e.project_id AND m.deleted = 0) AS n
           FROM namespace_epochs e ORDER BY e.owner_id, e.scope, e.project_id`,
        )
        .all() as Row[];
      return rows.map((row) => ({ ...namespaceOf(row), count: Number(row.n) }));
    },

    list(namespace, options) {
      let sql = `SELECT id, kind, revision, updated_at, substr(content, 1, ?) AS snippet
        FROM memories WHERE owner_id = ? AND scope = ? AND project_id = ? AND deleted = 0`;
      const params: (string | number)[] = [options.snippetChars ?? DEFAULT_SNIPPET_CHARS, ...boundary(namespace)];
      if (options.updatedFrom !== undefined) {
        sql += " AND updated_at >= ?";
        params.push(options.updatedFrom);
      }
      if (options.updatedBefore !== undefined) {
        sql += " AND updated_at < ?";
        params.push(options.updatedBefore);
      }
      if (options.after !== undefined) {
        sql += " AND (updated_at < ? OR (updated_at = ? AND id > ?))";
        params.push(options.after.updatedAt, options.after.updatedAt, options.after.id);
      }
      sql += " ORDER BY updated_at DESC, id ASC LIMIT ?";
      params.push(options.limit);
      const rows = db.prepare(sql).all(...params) as Row[];
      const receipts = db.prepare("SELECT count(*) AS n FROM receipts WHERE memory_id = ?");
      return rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        revision: Number(row.revision),
        updatedAt: String(row.updated_at),
        snippet: String(row.snippet ?? ""),
        receiptCount: Number((receipts.get(String(row.id)) as Row).n),
      }));
    },

    get(namespace, memoryId, receiptLimit) {
      const row = db
        .prepare(
          "SELECT * FROM memories WHERE owner_id = ? AND scope = ? AND project_id = ? AND id = ? AND deleted = 0",
        )
        .get(...boundary(namespace), memoryId) as Row | undefined;
      if (row === undefined) return null;
      const receiptCount = Number(
        (db.prepare("SELECT count(*) AS n FROM receipts WHERE memory_id = ?").get(memoryId) as Row).n,
      );
      const receipts = db
        .prepare(
          `SELECT id, client, session_id, event_id, role, excerpt, created_at FROM receipts
           WHERE memory_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(memoryId, receiptLimit) as Row[];
      return {
        memory: {
          id: String(row.id),
          namespace: namespaceOf(row),
          kind: String(row.kind),
          origin: String(row.origin),
          confidence: Number(row.confidence),
          revision: Number(row.revision),
          state: row.currentness === "historical" ? "historical" : "active",
          filing: String(row.filing_status),
          receiptCount,
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          content: String(row.content),
        },
        receipts: receipts.map((receipt) => ({
          id: String(receipt.id),
          client: String(receipt.client),
          sessionId: String(receipt.session_id),
          eventId: String(receipt.event_id),
          role: String(receipt.role),
          excerpt: String(receipt.excerpt),
          createdAt: String(receipt.created_at),
        })),
      };
    },
  };
}

// why: a readOnly open cannot roll back a hot journal left by a crashed writer, while a read-write open recovers it and query_only then forbids every write
export function readCairn<T>(path: string, work: (reader: CairnReader) => T): ReaderResult<T> {
  const blocked = guardPath(path);
  if (blocked !== null) return { ok: false, code: blocked };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  } catch (error) {
    if (isSqliteError(error)) return { ok: false, code: failureOf(error) };
    throw error;
  }
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    if ((db.prepare("PRAGMA query_only").get() as Row).query_only !== 1) return { ok: false, code: "unreadable" };
    const applicationId = (db.prepare("PRAGMA application_id").get() as Row).application_id;
    const userVersion = (db.prepare("PRAGMA user_version").get() as Row).user_version;
    if (applicationId !== CAIRN_APPLICATION_ID || userVersion !== CAIRN_USER_VERSION) {
      return { ok: false, code: "unsupported_schema" };
    }
    return { ok: true, value: work(createReader(db)) };
  } catch (error) {
    if (isSqliteError(error)) return { ok: false, code: failureOf(error) };
    throw error;
  } finally {
    try {
      db.close();
    } catch {
      // why: a failing close after a finished read must not replace the read result
    }
  }
}
