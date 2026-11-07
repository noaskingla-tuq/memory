const MIB = 1024 * 1024;
const OFFICE = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export type BlobClass = "image" | "audio" | "video" | "document" | "data";
type Pool = "light" | "heavy";

export const CLASSES: Readonly<Record<BlobClass, { readonly max: number; readonly mimes: readonly string[]; readonly pool: Pool }>> = Object.freeze({
  image: { max: 32 * MIB, mimes: ["image/png", "image/jpeg", "image/webp"], pool: "light" },
  audio: { max: 32 * MIB, mimes: ["audio/wav", "audio/mpeg", "audio/ogg", "audio/flac", "audio/mp4"], pool: "light" },
  video: { max: 512 * MIB, mimes: ["video/mp4", "video/webm"], pool: "heavy" },
  document: { max: 32 * MIB, mimes: ["application/pdf", ...OFFICE, "text/plain", "text/markdown"], pool: "light" },
  data: { max: 8 * MIB, mimes: ["application/json", "text/plain", "text/vtt", "text/markdown"], pool: "light" },
});

export const FILE_LIMITS = Object.freeze({
  CHUNK_MAX: MIB, PIXEL_LIMIT: 50_000_000, GENERATED_PIXEL_LIMIT: 16_777_216,
  OWNER_LIGHT: 64 * MIB, OWNER_HEAVY: 1024 * MIB, GLOBAL_LIGHT: 256 * MIB, GLOBAL_HEAVY: 2048 * MIB,
  OFFICE_UNPACKED: 256 * MIB, OFFICE_RATIO: 20, OFFICE_ENTRIES: 10_000,
});

export function classOf(mime: unknown): BlobClass | undefined {
  return (Object.keys(CLASSES) as BlobClass[]).find((name) => CLASSES[name].mimes.includes(mime as string));
}

const ascii = (bytes: Uint8Array, at: number, value: string): boolean => bytes.length >= at + value.length && Buffer.from(bytes.subarray(at, at + value.length)).toString("latin1") === value;

export function imageDimensions(mime: string, bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (mime === "image/png" && bytes.length >= 24) return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  if (mime === "image/jpeg") {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: view.readUInt16BE(at + 5), width: view.readUInt16BE(at + 7) };
      const length = view.readUInt16BE(at + 2);
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  if (mime === "image/webp" && bytes.length >= 30) {
    if (ascii(bytes, 12, "VP8X")) return { width: 1 + view.readUIntLE(24, 3), height: 1 + view.readUIntLE(27, 3) };
    if (ascii(bytes, 12, "VP8L")) {
      const bits = view.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (ascii(bytes, 12, "VP8 ")) return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function zipMetrics(bytes: Uint8Array): { entries: number; unpacked: number; packed: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (view.readUInt32LE(at) !== 0x06054b50) continue;
    const entries = view.readUInt16LE(at + 10);
    const centralSize = view.readUInt32LE(at + 12);
    let cursor = view.readUInt32LE(at + 16);
    const end = cursor + centralSize;
    let unpacked = 0;
    let packed = 0;
    for (let count = 0; count < entries; count += 1) {
      if (cursor + 46 > end || view.readUInt32LE(cursor) !== 0x02014b50) return null;
      packed += view.readUInt32LE(cursor + 20);
      unpacked += view.readUInt32LE(cursor + 24);
      cursor += 46 + view.readUInt16LE(cursor + 28) + view.readUInt16LE(cursor + 30) + view.readUInt16LE(cursor + 32);
    }
    return cursor === end ? { entries, unpacked, packed } : null;
  }
  return null;
}

function signatureMatches(mime: string, bytes: Uint8Array): boolean {
  switch (mime) {
    case "image/png": return ascii(bytes, 1, "PNG");
    case "image/jpeg": return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
    case "image/webp": return ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP");
    case "application/pdf": return ascii(bytes, 0, "%PDF");
    case "audio/wav": return ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE");
    case "audio/ogg": return ascii(bytes, 0, "OggS");
    case "audio/flac": return ascii(bytes, 0, "fLaC");
    case "audio/mpeg": return ascii(bytes, 0, "ID3") || (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "audio/mp4":
    case "video/mp4": return ascii(bytes, 4, "ftyp");
    case "video/webm": return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case "application/json":
      try { JSON.parse(Buffer.from(bytes).toString("utf8")); return true; } catch { return false; }
    default: return OFFICE.has(mime) ? ascii(bytes, 0, "PK") : true;
  }
}

export interface ValidateOptions {
  readonly output?: boolean;
  readonly maxInputPixels?: number;
}

export type Validated = { readonly class: BlobClass; readonly code?: undefined } | { readonly code: string; readonly class?: undefined };

export function validateBytes(mime: string, bytes: Uint8Array, { output = false, maxInputPixels }: ValidateOptions = {}): Validated {
  const cls = classOf(mime);
  if (cls === undefined || bytes.length > CLASSES[cls].max) return { code: "capability_request_invalid" };
  if (!signatureMatches(mime, bytes)) return { code: "capability_request_invalid" };
  if (OFFICE.has(mime)) {
    const zip = zipMetrics(bytes);
    if (zip === null || zip.entries > FILE_LIMITS.OFFICE_ENTRIES || zip.unpacked > FILE_LIMITS.OFFICE_UNPACKED || (zip.packed === 0 ? zip.unpacked > 0 : zip.unpacked / zip.packed > FILE_LIMITS.OFFICE_RATIO)) return { code: "capability_request_invalid" };
  }
  if (mime.startsWith("image/")) {
    const size = imageDimensions(mime, bytes);
    if (size === null || size.width < 1 || size.height < 1) return { code: "capability_request_invalid" };
    const pixels = size.width * size.height;
    if (pixels > (output ? FILE_LIMITS.GENERATED_PIXEL_LIMIT : FILE_LIMITS.PIXEL_LIMIT)) return { code: output ? "provider_error" : "blob_too_large" };
    if (!output && maxInputPixels !== undefined && pixels > maxInputPixels) return { code: "unsupported_options" };
  }
  return { class: cls };
}
