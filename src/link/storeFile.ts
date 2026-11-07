import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LINK_DIR_NAME = "memory-link-v1";
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_LISTED_FILES = 32;
export const MAX_SOURCE_LENGTH = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

const FILE_NAME = /^[0-9a-f]{64}\.json$/;
const RETRYABLE_WRITE_CODES = new Set(["ENOSPC", "EDQUOT", "EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE"]);

export type StoreErrorCode = "quota_exceeded" | "provider_not_ready" | "provider_error" | "conflict" | "not_found" | "disposed" | "unsafe";

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string = code) {
    super(message);
    this.name = "StoreError";
  }
}

export interface LinkItem {
  readonly id: string;
  readonly key?: string;
  readonly payload: unknown;
  readonly tags?: readonly string[];
  readonly rev: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs?: number;
}

export interface PartitionState {
  readonly source: string;
  readonly revision: number;
  readonly items: readonly LinkItem[];
}

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly regular: boolean;
}

export interface StoreIo {
  list(): string[];
  stat(fileId: string): FileStat | undefined;
  read(fileId: string): string;
  write(fileId: string, text: string): void;
  remove(fileId: string): void;
}

export type LoadedFile =
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "ok"; readonly state: PartitionState; readonly stat: FileStat };

const itemSchema = z
  .object({
    id: z.string().min(1).max(128),
    key: z.string().min(1).max(128).optional(),
    payload: z.unknown(),
    tags: z.array(z.string().min(1).max(32)).max(8).optional(),
    rev: z.number().int().min(1),
    updatedAtMs: z.number().int().min(0),
    expiresAtMs: z.number().int().min(0).optional(),
  })
  .strict();

const fileSchema = z
  .object({
    version: z.literal(1),
    source: z.string().min(1).max(MAX_SOURCE_LENGTH),
    revision: z.number().int().min(0),
    items: z.array(itemSchema),
  })
  .strict();

export function partitionKeyOf(who: { readonly source: { readonly kind: string; readonly pluginId?: string } }): string {
  return who.source.kind === "plugin" ? `plugin:${who.source.pluginId ?? ""}` : "core";
}

export function isValidPartitionKey(key: string): boolean {
  return key.length <= MAX_SOURCE_LENGTH && (key === "core" || (key.length > "plugin:".length && key.startsWith("plugin:") && !CONTROL_CHARS.test(key)));
}

export function fileIdOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

export function itemBytes(item: LinkItem): number {
  return Buffer.byteLength(JSON.stringify(item));
}

export function serializePartition(state: PartitionState): string {
  return `${JSON.stringify({ version: 1, source: state.source, revision: state.revision, items: state.items })}\n`;
}

export function parsePartition(text: string, fileId: string): PartitionState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success || fileIdOf(parsed.data.source) !== fileId) return undefined;
  const ids = new Set<string>();
  for (const item of parsed.data.items) {
    if (ids.has(item.id) || item.payload === undefined) return undefined;
    ids.add(item.id);
  }
  return { source: parsed.data.source, revision: parsed.data.revision, items: parsed.data.items as LinkItem[] };
}

export function classifyWriteError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new StoreError(typeof code === "string" && RETRYABLE_WRITE_CODES.has(code) ? "provider_not_ready" : "provider_error");
}

export function loadFile(io: StoreIo, fileId: string): LoadedFile {
  const stat = io.stat(fileId);
  if (stat === undefined) return { kind: "absent" };
  if (!stat.regular || stat.size > MAX_FILE_BYTES) return { kind: "corrupt" };
  let text: string;
  try {
    text = io.read(fileId);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return { kind: "absent" };
    if (typeof code === "string" && RETRYABLE_WRITE_CODES.has(code)) throw new StoreError("provider_not_ready");
    return { kind: "corrupt" };
  }
  const state = parsePartition(text, fileId);
  return state === undefined ? { kind: "corrupt" } : { kind: "ok", state, stat };
}

export function createFsIo(dataDir: string): StoreIo {
  const root = join(dataDir, LINK_DIR_NAME);
  const pathOf = (fileId: string): string => join(root, `${fileId}.json`);
  const rootState = (): "absent" | "ok" => {
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (stat === undefined) return "absent";
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError("provider_error", "root_unsafe");
    return "ok";
  };
  const guardName = (fileId: string): void => {
    if (!FILE_NAME.test(`${fileId}.json`)) throw new StoreError("provider_error", "file_id_invalid");
  };
  return {
    list() {
      if (rootState() === "absent") return [];
      return readdirSync(root)
        .filter((name) => FILE_NAME.test(name))
        .sort()
        .slice(0, MAX_LISTED_FILES)
        .map((name) => name.slice(0, -5));
    },
    stat(fileId) {
      guardName(fileId);
      if (rootState() === "absent") return undefined;
      const stat = lstatSync(pathOf(fileId), { throwIfNoEntry: false });
      if (stat === undefined) return undefined;
      return { size: stat.size, mtimeMs: stat.mtimeMs, regular: stat.isFile() && !stat.isSymbolicLink() };
    },
    read(fileId) {
      guardName(fileId);
      return readFileSync(pathOf(fileId), "utf8");
    },
    write(fileId, text) {
      guardName(fileId);
      mkdirSync(root, { recursive: true });
      rootState();
      const target = pathOf(fileId);
      const existing = lstatSync(target, { throwIfNoEntry: false });
      if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) throw new StoreError("provider_error", "file_unsafe");
      const temporary = `${target}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        try {
          writeFileSync(fd, text);
          try { fsyncSync(fd); } catch (error) { if ((error as { code?: string }).code !== "ERR_ACCESS_DENIED") throw error; }
        } finally { closeSync(fd); }
        const again = lstatSync(target, { throwIfNoEntry: false });
        if (again !== undefined && (again.isSymbolicLink() || !again.isFile())) throw new StoreError("provider_error", "file_unsafe");
        renameSync(temporary, target);
      } finally {
        if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) unlinkSync(temporary);
      }
    },
    remove(fileId) {
      guardName(fileId);
      if (rootState() === "absent") return;
      const target = pathOf(fileId);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat === undefined) return;
      if (stat.isDirectory() && !stat.isSymbolicLink()) throw new StoreError("unsafe", "directory");
      try { unlinkSync(target); } catch (error) {
        // why: Windows refuses unlink on a directory junction, and rmdir removes only the link
        if (!stat.isSymbolicLink()) throw error;
        rmdirSync(target);
      }
    },
  };
}
