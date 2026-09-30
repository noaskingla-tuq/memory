import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryServiceError } from "../../domain/errors.js";

// why: out/adapters/storage 往上三層是 repo 根；打包後目錄結構不同，呼叫端必須改傳 pinPath。
export const DEFAULT_PIN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "cairn-pin.json",
);

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export interface CairnPin {
  readonly commit: string;
  readonly accepted: readonly string[];
}

function incompatible(message: string): MemoryServiceError {
  return new MemoryServiceError("DEPENDENCY_INCOMPATIBLE", message);
}

export function readCairnPin(pinPath: string): CairnPin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch {
    throw incompatible("Cairn pin file is unreadable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw incompatible("Cairn pin file is malformed");
  }
  const { commit, accepted } = parsed as {
    commit?: unknown;
    accepted?: unknown;
  };
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
    throw incompatible("Cairn pin commit is malformed");
  }
  if (
    !Array.isArray(accepted) ||
    !accepted.every(
      (entry) => typeof entry === "string" && COMMIT_PATTERN.test(entry),
    )
  ) {
    throw incompatible("Cairn pin accepted list is malformed");
  }
  if (!accepted.includes(commit)) {
    throw incompatible("Cairn pin accepted list does not contain the commit");
  }
  return { commit, accepted: [...accepted] };
}
