import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CURSOR_MAX_CHARS = 1024;
const POSITION_MAX_PARTS = 4;
const POSITION_PART_MAX_CHARS = 200;
const IGNORED_FILTER_KEYS = new Set(["cursor", "limit"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type CursorRejection = "malformed" | "tampered" | "filter_mismatch";

export type CursorDecoding =
  | { readonly ok: true; readonly position: readonly string[] }
  | { readonly ok: false; readonly reason: CursorRejection };

export interface CursorCodec {
  encode(filter: unknown, position: readonly string[]): string;
  decode(filter: unknown, cursor: string): CursorDecoding;
}

function canonical(value: unknown, top: boolean): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, false)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && !(top && IGNORED_FILTER_KEYS.has(key)))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, false)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// why: limit is left out because a keyset position stays valid when the page size changes, while any other filter change would silently continue a different result set
export function filterHash(filter: unknown): string {
  return createHash("sha256").update(canonical(filter, true), "utf8").digest("hex").slice(0, 32);
}

function isPosition(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= POSITION_MAX_PARTS &&
    value.every((part) => typeof part === "string" && part.length <= POSITION_PART_MAX_CHARS)
  );
}

// why: a per-process random key means a cursor cannot be forged or replayed across restarts, and an old cursor simply fails as tampered so the view starts again from page one
export function createCursorCodec(secret: Buffer = randomBytes(32)): CursorCodec {
  const sign = (body: string): Buffer => createHmac("sha256", secret).update(body).digest();
  return {
    encode(filter, position) {
      if (!isPosition(position)) throw new Error("cursor position must be 1 to 4 short strings");
      const body = Buffer.from(JSON.stringify({ v: 1, f: filterHash(filter), k: position }), "utf8").toString("base64url");
      const token = `${body}.${sign(body).toString("base64url")}`;
      if (token.length > CURSOR_MAX_CHARS) throw new Error("cursor exceeds its size limit");
      return token;
    },

    decode(filter, cursor) {
      if (typeof cursor !== "string" || cursor.length > CURSOR_MAX_CHARS || !TOKEN_PATTERN.test(cursor)) {
        return { ok: false, reason: "malformed" };
      }
      const [body = "", signature = ""] = cursor.split(".");
      const expected = sign(body);
      const given = Buffer.from(signature, "base64url");
      // why: base64url decoding ignores the spare bits of the last character, so a token is only accepted in the exact form encode produced
      if (given.toString("base64url") !== signature || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, reason: "tampered" };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        return { ok: false, reason: "malformed" };
      }
      const record = payload as { v?: unknown; f?: unknown; k?: unknown } | null;
      if (record === null || typeof record !== "object" || record.v !== 1 || typeof record.f !== "string" || !isPosition(record.k)) {
        return { ok: false, reason: "malformed" };
      }
      if (record.f !== filterHash(filter)) return { ok: false, reason: "filter_mismatch" };
      return { ok: true, position: record.k };
    },
  };
}
