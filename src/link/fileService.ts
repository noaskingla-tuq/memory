import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refuse } from "./errors.js";
import { CLASSES, FILE_LIMITS, classOf, validateBytes, type BlobClass } from "./fileValidation.js";
import type { LinkWho } from "./provider.js";

const { CHUNK_MAX, OWNER_LIGHT, OWNER_HEAVY, GLOBAL_LIGHT, GLOBAL_HEAVY } = FILE_LIMITS;
const TRANSIENT_MS = 10 * 60_000;
const JOB_OUTPUT_MS = 60 * 60_000;
const UPLOAD_IDLE_MS = 60_000;
const UPLOADS_PER_OWNER = 4;

type Retention = "transient" | "job-output";
type Source = { readonly kind: string; readonly pluginId?: string };
type Bytes = Uint8Array;

interface BlobRef {
  blobId: string;
  retention: Retention;
  mime: string;
  sizeBytes: number;
  class: BlobClass;
  origin: { kind: string; pluginId?: string };
  generated: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  credentials?: unknown;
}

interface BlobEntry { ref: BlobRef; path: string; owner: string; holds: number }
interface UploadEntry { id: string; owner: string; mime: string; cls: BlobClass; sizeBytes: number; received: number; chunks: Buffer[]; touchedAt: number }
type Request = Record<string, unknown>;

export interface FileCallResult {
  readonly value: unknown;
  readonly data?: Uint8Array;
}

export interface FileTesting {
  readonly counters: { decode: number; readSize: number };
  readonly logs: unknown[];
  restart(): void;
  setDiskFree(bytes: number): void;
  produce(input: Record<string, unknown>): unknown;
  count(): number;
  pending(): number;
}

export interface LinkFiles {
  handle(method: string, args: unknown[], data: Uint8Array | undefined, who: LinkWho): FileCallResult;
  dispose(): void;
  testing?: FileTesting;
}

export interface FileServiceOptions {
  readonly now?: () => number;
  readonly dataDir?: string;
  readonly maxInputPixels?: number;
  readonly fileControl?: unknown;
}

function ownerKey(who: { readonly source: Source; readonly category?: string }): string {
  const owner = who.source.kind === "plugin" ? `plugin:${who.source.pluginId}` : "core";
  return `${who.category ?? ""}\0${owner}`;
}

const isRecord = (value: unknown): value is Request => typeof value === "object" && value !== null && !Array.isArray(value);

export function createFiles({ now = Date.now, dataDir, maxInputPixels, fileControl }: FileServiceOptions = {}): LinkFiles {
  const rootDir = dataDir === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), "teamuq-files-")) : path.join(dataDir, "teamuq-capability-files");
  fs.mkdirSync(rootDir, { recursive: true });
  const blobs = new Map<string, BlobEntry>();
  const uploads = new Map<string, UploadEntry>();
  const counters = { decode: 0, readSize: 0 };
  const logs: unknown[] = [];
  let diskFreeOverride: number | undefined;
  let disposed = false;
  const newId = (): string => randomBytes(16).toString("hex");
  const filePath = (id: string): string => path.join(rootDir, `${id}.blob`);

  function diskFree(): number {
    if (diskFreeOverride !== undefined) return diskFreeOverride;
    try {
      const stats = fs.statfsSync(rootDir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return 0;
    }
  }

  function prune(): void {
    const at = now();
    for (const [id, blob] of blobs) {
      if (blob.holds !== 0 || blob.ref.expiresAtMs > at) continue;
      blobs.delete(id);
      fs.rmSync(blob.path, { force: true });
    }
    for (const [id, upload] of uploads) if (at - upload.touchedAt >= UPLOAD_IDLE_MS) uploads.delete(id);
  }

  function used(owner: string | undefined, pool: string): number {
    const entries = [
      ...[...blobs.values()].filter((blob) => owner === undefined || blob.owner === owner).map((blob) => ({ cls: blob.ref.class, size: blob.ref.sizeBytes })),
      ...[...uploads.values()].filter((upload) => owner === undefined || upload.owner === owner).map((upload) => ({ cls: upload.cls, size: upload.sizeBytes })),
    ];
    return entries.reduce((total, entry) => total + (CLASSES[entry.cls]?.pool === pool ? entry.size : 0), 0);
  }

  interface StoreInput {
    owner: string;
    origin: { kind: string; pluginId?: string };
    bytes: Bytes;
    mime: string;
    retention: Retention;
    generated: boolean;
    credentials?: unknown;
    unchecked?: boolean;
    classOverride?: BlobClass;
  }

  function store({ owner, origin, bytes, mime, retention, generated, credentials, unchecked = false, classOverride }: StoreInput): BlobRef {
    const cls = unchecked ? (classOverride ?? classOf(mime)) : validateBytes(mime, bytes, { maxInputPixels }).class;
    if (cls === undefined) throw refuse("provider_error");
    if (mime.startsWith("image/")) counters.readSize += 1;
    const at = now();
    const id = newId();
    const target = filePath(id);
    fs.writeFileSync(target, Buffer.from(bytes), { flag: "wx" });
    const ref: BlobRef = {
      blobId: id, retention, mime, sizeBytes: bytes.length, class: cls, origin, generated,
      createdAtMs: at, expiresAtMs: at + (retention === "job-output" ? JOB_OUTPUT_MS : TRANSIENT_MS),
    };
    if (generated && credentials !== undefined && ["image", "audio", "video"].includes(ref.class)) ref.credentials = credentials;
    blobs.set(id, { ref, path: target, owner, holds: 0 });
    return ref;
  }

  function owned(blobId: unknown, who: LinkWho): BlobEntry {
    prune();
    const blob = typeof blobId === "string" ? blobs.get(blobId) : undefined;
    if (blob === undefined) throw refuse("blob_not_found");
    if (blob.owner !== ownerKey(who)) throw refuse("blob_not_found");
    return blob;
  }

  function parseHandle(args: unknown[]): Request & { blob: { blobId: string } } {
    const request = args[0];
    if (args.length !== 1 || !isRecord(request) || Object.keys(request).some((key) => !["blob", "offset", "length"].includes(key))) throw refuse("capability_request_invalid");
    const handle = request.blob;
    if (!isRecord(handle) || Object.keys(handle).length !== 1 || typeof handle.blobId !== "string" || !/^[0-9a-f]{32}$/u.test(handle.blobId)) throw refuse("capability_request_invalid");
    return request as Request & { blob: { blobId: string } };
  }

  function checkQuota(owner: string, cls: BlobClass, sizeBytes: number): void {
    const pool = CLASSES[cls].pool;
    const ownerLimit = pool === "light" ? OWNER_LIGHT : OWNER_HEAVY;
    const globalLimit = pool === "light" ? GLOBAL_LIGHT : GLOBAL_HEAVY;
    if (sizeBytes > ownerLimit / 2 || used(owner, pool) + sizeBytes > ownerLimit || used(undefined, pool) + sizeBytes > globalLimit) throw refuse("blob_too_large");
    if (diskFree() < globalLimit * 2) throw refuse("blob_too_large");
  }

  function put(args: unknown[], data: Uint8Array | undefined, who: LinkWho): FileCallResult {
    const request = args[0];
    if (args.length !== 1 || !isRecord(request)) throw refuse("capability_request_invalid");
    if (data !== undefined && data.length > CHUNK_MAX) throw refuse("data_too_large");
    const owner = ownerKey(who);
    prune();
    let upload: UploadEntry | undefined;
    if (request.uploadId !== undefined) {
      upload = uploads.get(request.uploadId as string);
      if (upload === undefined || upload.owner !== owner) throw refuse("blob_not_found");
      if (Object.keys(request).some((key) => key !== "uploadId" && key !== "offset") || request.offset !== upload.received) throw refuse("capability_request_invalid");
    } else {
      if (Object.keys(request).some((key) => !["mime", "sizeBytes", "retention"].includes(key)) || (request.retention !== undefined && request.retention !== "transient")) throw refuse("capability_request_invalid");
      const cls = classOf(request.mime);
      const size = request.sizeBytes;
      if (cls === undefined || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw refuse("capability_request_invalid");
      if (size > CLASSES[cls].max) throw refuse("blob_too_large");
      checkQuota(owner, cls, size);
      if ([...uploads.values()].filter((entry) => entry.owner === owner).length >= UPLOADS_PER_OWNER) throw refuse("capability_busy");
      upload = { id: newId(), owner, mime: request.mime as string, cls, sizeBytes: size, received: 0, chunks: [], touchedAt: now() };
      uploads.set(upload.id, upload);
    }
    if (data !== undefined) {
      if (upload.received + data.length > upload.sizeBytes) throw refuse("capability_request_invalid");
      upload.chunks.push(Buffer.from(data));
      upload.received += data.length;
    }
    upload.touchedAt = now();
    if (upload.received < upload.sizeBytes) return { value: { uploadId: upload.id, receivedBytes: upload.received } };
    uploads.delete(upload.id);
    const bytes = Buffer.concat(upload.chunks);
    const validated = validateBytes(upload.mime, bytes, { maxInputPixels });
    if (validated.code !== undefined) throw refuse(validated.code);
    const origin = who.source.kind === "plugin" ? { kind: "plugin", pluginId: who.source.pluginId } : { kind: "core" };
    const ref = store({ owner, origin, bytes, mime: upload.mime, retention: "transient", generated: false });
    return { value: { uploadId: upload.id, receivedBytes: upload.received, blob: ref } };
  }

  function clear(): void {
    if (disposed) return;
    fs.mkdirSync(rootDir, { recursive: true });
    blobs.clear();
    uploads.clear();
    for (const name of fs.readdirSync(rootDir)) fs.rmSync(path.join(rootDir, name), { recursive: true, force: true });
  }

  function handle(method: string, args: unknown[], data: Uint8Array | undefined, who: LinkWho): FileCallResult {
    if (method === "teamuq.file.put") return put(args, data, who);
    const request = parseHandle(args);
    const blob = owned(request.blob.blobId, who);
    if (method === "teamuq.file.stat") return { value: { blob: { ...blob.ref } } };
    if (method === "teamuq.file.release") {
      blobs.delete(blob.ref.blobId);
      fs.rmSync(blob.path, { force: true });
      return { value: { released: true } };
    }
    if (method !== "teamuq.file.read") throw refuse("not_supported");
    const offset = request.offset ?? 0;
    const length = request.length ?? CHUNK_MAX;
    if (typeof offset !== "number" || typeof length !== "number" || !Number.isInteger(offset) || offset < 0 || offset > blob.ref.sizeBytes || !Number.isInteger(length) || length < 1 || length > CHUNK_MAX) throw refuse("capability_request_invalid");
    const bytes = fs.readFileSync(blob.path).subarray(offset, Math.min(blob.ref.sizeBytes, offset + length));
    const value = { offset, length: bytes.length, eof: offset + bytes.length >= blob.ref.sizeBytes };
    return bytes.length === 0 ? { value } : { value, data: new Uint8Array(bytes) };
  }

  const files: LinkFiles = {
    handle,
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };

  if (fileControl !== undefined) {
    files.testing = Object.freeze({
      counters,
      logs,
      restart: clear,
      setDiskFree(bytes: number): void {
        if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError("disk free must be a non-negative number");
        diskFreeOverride = bytes;
      },
      produce(input: Record<string, unknown>): unknown {
        const { source, category, mime, bytes, group, mode, generated, credentials, blobClass, unchecked = true } = input as {
          source: Source; category?: string; mime: string; bytes: Bytes; group?: string; mode?: string; generated?: boolean; credentials?: unknown; blobClass?: BlobClass; unchecked?: boolean;
        };
        const forcedByGroup = ["image-generate", "image-edit", "audio-generate", "audio-edit", "video-generate"].includes(group ?? "") && mode !== "segment";
        const isGenerated = generated ?? (group === "speech-synthesize" ? mode === "job" : forcedByGroup);
        const cls = classOf(mime) ?? blobClass;
        if (cls === undefined) throw refuse("provider_error");
        const owner = ownerKey({ source, category });
        checkQuota(owner, cls, bytes.length);
        const origin = source.kind === "plugin" ? { kind: "plugin", pluginId: source.pluginId } : { kind: "core" };
        return store({ owner, origin, bytes: Buffer.from(bytes), mime, retention: "job-output", generated: isGenerated, credentials, unchecked, classOverride: cls });
      },
      count: () => blobs.size,
      pending: () => uploads.size,
    });
  }
  clear();
  return files;
}
