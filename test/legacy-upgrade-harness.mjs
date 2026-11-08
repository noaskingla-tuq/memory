import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixtureDirectory } from "./readerHarness.mjs";

export const LEGACY_COMMIT = "83a10c3b7664b1f67485a19e7d84d24dcb3041a5";
export const hashOf = (text) => createHash("sha256").update(text).digest("hex");
export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// why: a copy under another directory name keeps the fixture database and gets an identity.json that names that directory, so it is a legitimate legacy candidate whose owner differs
export function installLegacy(dataRoot, label = "fixture-agent", commit = LEGACY_COMMIT) {
  const source = fixtureDirectory(LEGACY_COMMIT);
  const agentHash = hashOf(label);
  const agentRoot = join(dataRoot, "agents", agentHash);
  mkdirSync(agentRoot, { recursive: true });
  cpSync(join(source, "memory.sqlite"), join(agentRoot, "memory.sqlite"));
  const identity = JSON.parse(readFileSync(join(source, "identity.json"), "utf8"));
  writeFileSync(join(agentRoot, "identity.json"), `${JSON.stringify({ ...identity, agentHash, cairnCommit: commit }, null, 2)}\n`);
  return { agentHash, agentRoot, databasePath: join(agentRoot, "memory.sqlite"), identityPath: join(agentRoot, "identity.json") };
}

export function schemaOf(path) {
  const db = new DatabaseSync(path);
  try {
    return { userVersion: db.prepare("PRAGMA user_version").get().user_version, memories: db.prepare("SELECT count(*) AS n FROM memories").get().n };
  } finally {
    db.close();
  }
}

export function completedBackups(dataRoot, agentHash) {
  const directory = join(dataRoot, "backups", agentHash);
  return existsSync(directory) ? readdirSync(directory).filter((name) => /^\d{8}T\d{9}Z-from-[0-9a-f]{8}$/.test(name)) : [];
}
