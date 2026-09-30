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
const SCAN_CHUNK_ROWS = 100;
const WORK_MARKER = "[工作紀錄 ";
const CLI_OFFSET = 43;

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
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly timesMs: Float64Array;
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

export interface ScanOptions {
  readonly want: number;
  readonly headChars: number;
  readonly after?: KeysetAnchor;
  readonly updatedFrom?: string;
  readonly updatedBefore?: string;
  readonly terms?: readonly string[];
  readonly cli?: string;
  readonly withContent?: boolean;
  readonly withReceipts?: boolean;
  readonly chunkRows?: number;
  readonly stop?: () => boolean;
}

export interface ScannedMemory {
  readonly id: string;
  readonly kind: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly head: string;
  readonly content: string | null;
  readonly receiptCount: number;
}

export interface ScanResult {
  readonly rows: ScannedMemory[];
  readonly resume: KeysetAnchor | null;
  readonly exhausted: boolean;
}

export interface SessionMate extends ScannedMemory {
  readonly namespace: MemoryNamespace;
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
  scan(namespace: MemoryNamespace, options: ScanOptions): ScanResult;
  receiptCounts(memoryIds: readonly string[]): Map<string, number>;
  receiptSessions(memoryId: string): string[];
  receiptRowidMax(): number;
  sessionMatches(ownerId: string, memoryId: string, sessions: readonly string[], lowExclusive: number, highInclusive: number): { id: string; updatedAt: string }[];
  memoriesById(ownerId: string, ids: readonly string[], headChars: number): SessionMate[];
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

type SqlParams = (string | number)[];

function rangeClause(options: ScanOptions, after: KeysetAnchor | undefined, upTo: KeysetAnchor | undefined, params: SqlParams): string {
  let sql = "";
  if (options.updatedFrom !== undefined) {
    sql += " AND updated_at >= ?";
    params.push(options.updatedFrom);
  }
  if (options.updatedBefore !== undefined) {
    sql += " AND updated_at < ?";
    params.push(options.updatedBefore);
  }
  // why: the plain updated_at bounds let SQLite seek the namespace index, and the OR pair then only decides ties on id
  if (after !== undefined) {
    sql += " AND updated_at <= ? AND (updated_at < ? OR (updated_at = ? AND id > ?))";
    params.push(after.updatedAt, after.updatedAt, after.updatedAt, after.id);
  }
  if (upTo !== undefined) {
    sql += " AND updated_at >= ? AND (updated_at > ? OR (updated_at = ? AND id <= ?))";
    params.push(upTo.updatedAt, upTo.updatedAt, upTo.updatedAt, upTo.id);
  }
  return sql;
}

// why: SQLite lower() folds ASCII only, so callers pass terms folded the same way and every term must occur (AND)
function contentClause(options: ScanOptions, params: SqlParams): string {
  let sql = "";
  for (const term of options.terms ?? []) {
    sql += " AND instr(lower(content), ?) > 0";
    params.push(term);
  }
  if (options.cli !== undefined) {
    sql += " AND substr(content, 1, ?) = ? AND substr(content, ?, ?) = ?";
    params.push([...WORK_MARKER].length, WORK_MARKER, CLI_OFFSET, [...options.cli].length + 1, `${options.cli}/`);
  }
  return sql;
}

function selectRows(
  db: DatabaseSync,
  namespace: MemoryNamespace,
  options: ScanOptions,
  window: { readonly after: KeysetAnchor | undefined; readonly upTo: KeysetAnchor | undefined },
  limit: number,
): ScannedMemory[] {
  const params: SqlParams = [options.headChars, ...boundary(namespace)];
  const receipts = options.withReceipts === false ? "0" : "(SELECT count(*) FROM receipts WHERE memory_id = memories.id)";
  let sql = `SELECT id, kind, revision, updated_at, substr(content, 1, ?) AS head, ${options.withContent === true ? "content" : "NULL"} AS body,
      ${receipts} AS receipts FROM memories WHERE owner_id = ? AND scope = ? AND project_id = ? AND deleted = 0`;
  sql += rangeClause(options, window.after, window.upTo, params) + contentClause(options, params);
  sql += " ORDER BY updated_at DESC, id ASC LIMIT ?";
  params.push(limit);
  return (db.prepare(sql).all(...params) as Row[]).map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
    head: String(row.head ?? ""),
    content: row.body === null ? null : String(row.body),
    receiptCount: Number(row.receipts),
  }));
}

// why: a predicate on content forces a row fetch per index entry, so the scan is cut into chunks whose end key comes from an index-only query and the caller can yield between chunks
function scanNamespace(db: DatabaseSync, namespace: MemoryNamespace, options: ScanOptions): ScanResult {
  const chunkRows = options.chunkRows ?? SCAN_CHUNK_ROWS;
  const filtered = (options.terms?.length ?? 0) > 0 || options.cli !== undefined;
  const rows: ScannedMemory[] = [];
  let anchor = options.after;
  for (;;) {
    let upTo: KeysetAnchor | undefined;
    if (filtered) {
      const params: SqlParams = [...boundary(namespace)];
      const sql = `SELECT updated_at, id FROM memories WHERE owner_id = ? AND scope = ? AND project_id = ? AND deleted = 0${rangeClause(options, anchor, undefined, params)}
        ORDER BY updated_at DESC, id ASC LIMIT 1 OFFSET ?`;
      params.push(chunkRows - 1);
      const edge = db.prepare(sql).get(...params) as Row | undefined;
      if (edge !== undefined) upTo = { updatedAt: String(edge.updated_at), id: String(edge.id) };
    }
    rows.push(...selectRows(db, namespace, options, { after: anchor, upTo }, options.want - rows.length));
    if (rows.length >= options.want) return { rows, resume: null, exhausted: false };
    if (upTo === undefined) return { rows, resume: null, exhausted: true };
    anchor = upTo;
    if (options.stop?.() === true) return { rows, resume: anchor, exhausted: false };
  }
}

function createReader(db: DatabaseSync): CairnReader {
  return {
    namespaces() {
      const epochs = db.prepare("SELECT owner_id, scope, project_id FROM namespace_epochs ORDER BY owner_id, scope, project_id").all() as Row[];
      type Found = { namespace: MemoryNamespace; times: number[]; first: string | null; last: string | null };
      const found = new Map<string, Found>();
      const keyOf = (row: Row): string => JSON.stringify([row.owner_id, row.scope, row.project_id]);
      for (const row of epochs) found.set(keyOf(row), { namespace: namespaceOf(row), times: [], first: null, last: null });
      // why: the partial index active_identity also matches this filter and the planner prefers it, which forces a sort of every row; namespace_memories already yields each namespace's rows newest first straight from the index
      const rows = db
        .prepare("SELECT owner_id, scope, project_id, updated_at FROM memories INDEXED BY namespace_memories WHERE deleted = 0 ORDER BY owner_id, scope, project_id, updated_at DESC")
        .iterate() as Iterable<Row>;
      let owner: unknown;
      let scope: unknown;
      let project: unknown;
      let current: Found | undefined;
      for (const row of rows) {
        if (current === undefined || row.owner_id !== owner || row.scope !== scope || row.project_id !== project) {
          owner = row.owner_id;
          scope = row.scope;
          project = row.project_id;
          const key = keyOf(row);
          current = found.get(key) ?? { namespace: namespaceOf(row), times: [], first: null, last: null };
          found.set(key, current);
        }
        const at = row.updated_at as string;
        current.times.push(Date.parse(at));
        current.last ??= at;
        current.first = at;
      }
      return [...found.values()].map((entry) => ({
        ...entry.namespace,
        count: entry.times.length,
        firstAt: entry.first,
        lastAt: entry.last,
        timesMs: Float64Array.from(entry.times),
      }));
    },

    list(namespace, options) {
      const { rows } = scanNamespace(db, namespace, { want: options.limit, headChars: options.snippetChars ?? DEFAULT_SNIPPET_CHARS, after: options.after, updatedFrom: options.updatedFrom, updatedBefore: options.updatedBefore });
      return rows.map(({ id, kind, revision, updatedAt, head, receiptCount }) => ({ id, kind, revision, updatedAt, snippet: head, receiptCount }));
    },

    scan: (namespace, options) => scanNamespace(db, namespace, options),

    receiptCounts(memoryIds) {
      const counts = new Map<string, number>(memoryIds.map((id) => [id, 0]));
      if (memoryIds.length === 0) return counts;
      const marks = memoryIds.map(() => "?").join(", ");
      const rows = db.prepare(`SELECT memory_id, count(*) AS n FROM receipts WHERE memory_id IN (${marks}) GROUP BY memory_id`).all(...memoryIds) as Row[];
      for (const row of rows) counts.set(String(row.memory_id), Number(row.n));
      return counts;
    },

    receiptSessions(memoryId) {
      const rows = db.prepare("SELECT DISTINCT session_id FROM receipts WHERE memory_id = ?").all(memoryId) as Row[];
      return rows.map((row) => String(row.session_id));
    },

    receiptRowidMax() {
      return Number((db.prepare("SELECT coalesce(max(rowid), 0) AS top FROM receipts").get() as Row).top);
    },

    sessionMatches(ownerId, memoryId, sessions, lowExclusive, highInclusive) {
      if (sessions.length === 0) return [];
      const marks = sessions.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT m.id, m.updated_at FROM receipts r JOIN memories m ON m.id = r.memory_id
           WHERE r.rowid > ? AND r.rowid <= ? AND r.session_id IN (${marks}) AND m.id <> ? AND m.owner_id = ? AND m.deleted = 0`,
        )
        .all(lowExclusive, highInclusive, ...sessions, memoryId, ownerId) as Row[];
      return rows.map((row) => ({ id: String(row.id), updatedAt: String(row.updated_at) }));
    },

    memoriesById(ownerId, ids, headChars) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT id, scope, project_id, owner_id, kind, revision, updated_at, substr(content, 1, ?) AS head,
             (SELECT count(*) FROM receipts WHERE memory_id = memories.id) AS receipts
           FROM memories WHERE owner_id = ? AND deleted = 0 AND id IN (${marks})`,
        )
        .all(headChars, ownerId, ...ids) as Row[];
      const byId = new Map(
        rows.map((row): [string, SessionMate] => [
          String(row.id),
          {
            namespace: namespaceOf(row),
            id: String(row.id),
            kind: String(row.kind),
            revision: Number(row.revision),
            updatedAt: String(row.updated_at),
            head: String(row.head ?? ""),
            content: null,
            receiptCount: Number(row.receipts),
          },
        ]),
      );
      return ids.flatMap((id) => byId.get(id) ?? []);
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

export interface CairnSession {
  run<T>(work: (reader: CairnReader) => T): ReaderResult<T>;
  close(): void;
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // why: a failing close after a finished read must not replace the read result
  }
}

// why: a readOnly open cannot roll back a hot journal left by a crashed writer, while a read-write open recovers it and query_only then forbids every write
export function openCairn(path: string): ReaderResult<CairnSession> {
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
    if ((db.prepare("PRAGMA query_only").get() as Row).query_only !== 1) {
      closeQuietly(db);
      return { ok: false, code: "unreadable" };
    }
    const applicationId = (db.prepare("PRAGMA application_id").get() as Row).application_id;
    const userVersion = (db.prepare("PRAGMA user_version").get() as Row).user_version;
    if (applicationId !== CAIRN_APPLICATION_ID || userVersion !== CAIRN_USER_VERSION) {
      closeQuietly(db);
      return { ok: false, code: "unsupported_schema" };
    }
  } catch (error) {
    closeQuietly(db);
    if (isSqliteError(error)) return { ok: false, code: failureOf(error) };
    throw error;
  }
  const reader = createReader(db);
  return {
    ok: true,
    value: {
      run(work) {
        try {
          return { ok: true, value: work(reader) };
        } catch (error) {
          if (isSqliteError(error)) return { ok: false, code: failureOf(error) };
          throw error;
        }
      },
      close: () => closeQuietly(db),
    },
  };
}

export function readCairn<T>(path: string, work: (reader: CairnReader) => T): ReaderResult<T> {
  const opened = openCairn(path);
  if (!opened.ok) return opened;
  try {
    return opened.value.run(work);
  } finally {
    opened.value.close();
  }
}
