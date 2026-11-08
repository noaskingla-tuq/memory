import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export const CAIRN_APPLICATION_ID = 0x43414952;
export const CURRENT_USER_VERSION = 18;

const HEADER_BYTES = 100;
const MAGIC = "SQLite format 3\0";
const USER_VERSION_OFFSET = 60;
const APPLICATION_ID_OFFSET = 68;

export interface SchemaHeader {
  readonly applicationId: number;
  readonly userVersion: number;
}

// why: the listing must classify a Cairn file without running SQL (only cairnReader.ts may), and both pragmas are plain integers in the 100-byte SQLite header
export function readSchemaHeader(path: string): SchemaHeader | null {
  let descriptor: number | undefined;
  try {
    // why: a non-empty -wal or a leftover -journal means the header can lag behind committed pages, so such a file is not classified here
    for (const sidecar of [`${path}-wal`, `${path}-journal`]) {
      if ((statSync(sidecar, { throwIfNoEntry: false })?.size ?? 0) > 0) return null;
    }
    descriptor = openSync(path, "r");
    if (!fstatSync(descriptor).isFile()) return null;
    const header = Buffer.alloc(HEADER_BYTES);
    if (readSync(descriptor, header, 0, HEADER_BYTES, 0) !== HEADER_BYTES) return null;
    if (header.toString("latin1", 0, MAGIC.length) !== MAGIC) return null;
    return { userVersion: header.readUInt32BE(USER_VERSION_OFFSET), applicationId: header.readUInt32BE(APPLICATION_ID_OFFSET) };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function isLegacyCairnSchema(header: SchemaHeader | null): boolean {
  return header !== null && header.applicationId === CAIRN_APPLICATION_ID && header.userVersion < CURRENT_USER_VERSION;
}

export function isCurrentCairnSchema(header: SchemaHeader | null): boolean {
  return header !== null && header.applicationId === CAIRN_APPLICATION_ID && header.userVersion === CURRENT_USER_VERSION;
}
