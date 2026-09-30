import type { UiFailure } from "../../contracts/uiContract.js";
import type { CairnReaderFailure } from "../../adapters/ui/cairnReader.js";

const RETRYABLE = new Set<UiFailure["code"]>(["STORAGE_BUSY", "RESOURCE_BUSY"]);

// why: retryable means the very same request may succeed later, so a stale cursor or a stale revision is not retryable even though Core's own error table says so
export function uiFailure(code: UiFailure["code"]): UiFailure {
  return { ok: false, code, retryable: RETRYABLE.has(code) };
}

export function readerFailure(code: CairnReaderFailure): UiFailure {
  if (code === "not_found") return uiFailure("NOT_FOUND");
  if (code === "unsupported_schema" || code === "unsafe_path") return uiFailure("STORAGE_UNSUPPORTED");
  return uiFailure("STORAGE_BUSY");
}

const MEMORY_CODES: Readonly<Record<string, UiFailure["code"]>> = {
  REVISION_CONFLICT: "REVISION_CONFLICT",
  STORAGE_BUSY: "STORAGE_BUSY",
  RESOURCE_BUSY: "RESOURCE_BUSY",
  STORAGE_UNSUPPORTED: "STORAGE_UNSUPPORTED",
  STORAGE_UNSAFE: "STORAGE_UNSUPPORTED",
  INVALID_INPUT: "INVALID_PARAMS",
};

export function memoryFailure(code: string): UiFailure | null {
  const mapped = MEMORY_CODES[code];
  return mapped === undefined ? null : uiFailure(mapped);
}

export class UiResultTooLarge extends Error {
  constructor() {
    super("A single ui item exceeds the response budget");
    this.name = "UiResultTooLarge";
  }
}
