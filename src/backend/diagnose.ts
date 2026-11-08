import { DatabaseSync } from "node:sqlite";
import {
  MEMORY_CONTRACT_VERSIONS,
  MEMORY_LIMITS,
  MEMORY_PLUGIN_ID,
  memoryDiagnoseResponseSchema,
  type MemoryDiagnoseResponse,
} from "../../vendor/teamuq-contract/contract.mjs";
import { CAIRN_COMMIT } from "../adapters/storage/dataLayout.js";
import { callError } from "./contractErrors.js";
import { CONTRACT_LOCK_SHA256 } from "./vendoredContractLock.js";

// why: test/backend-diagnose asserts this equals package.json version; the packaged plugin has no package.json to read
export const PLUGIN_VERSION = "1.4.11";

let sqliteVersion: string | undefined;

function readSqliteVersion(): string {
  if (sqliteVersion !== undefined) return sqliteVersion;
  let found = "unknown";
  try {
    const database = new DatabaseSync(":memory:");
    try {
      const row = database.prepare("SELECT sqlite_version() AS version").get() as { version?: unknown } | undefined;
      if (typeof row?.version === "string" && row.version.length > 0) found = row.version;
    } finally {
      database.close();
    }
  } catch {
    found = "unknown";
  }
  sqliteVersion = found;
  return found;
}

export function buildDiagnose(storageStatus: string): MemoryDiagnoseResponse {
  const parsed = memoryDiagnoseResponseSchema.safeParse({
    plugin: { id: MEMORY_PLUGIN_ID, version: PLUGIN_VERSION },
    contract: { versions: [...MEMORY_CONTRACT_VERSIONS] },
    cairn: { commit: CAIRN_COMMIT },
    node: { version: process.versions.node, sqlite: readSqliteVersion() },
    storage: { status: storageStatus },
    limits: {
      resultMaxBytes: MEMORY_LIMITS.resultMaxBytes,
      inspectBudgetBytes: MEMORY_LIMITS.inspectBudgetBytes,
      maxOps: MEMORY_LIMITS.maxOps,
    },
    contractLockSha256: CONTRACT_LOCK_SHA256,
  });
  if (!parsed.success) throw callError("internal", "Diagnose response failed the contract schema");
  return parsed.data;
}
