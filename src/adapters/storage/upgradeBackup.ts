import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { MemoryServiceError } from "../../domain/errors.js";

export const KEEP_BACKUPS = 2;

const BACKUP_NAME = /^\d{8}T\d{9}Z-from-[0-9a-f]{8}$/;

export interface BackupHooks {
  readonly now: () => Date;
  readonly vacuumInto: (databasePath: string, destination: string) => void;
  readonly freeBytes: (directory: string) => number | undefined;
}

export interface BackupRequest {
  readonly backupsRoot: string;
  readonly agentHash: string;
  readonly databasePath: string;
  readonly identityPath: string;
  readonly fromCommit: string;
  readonly ensureDirectory: (path: string) => void;
}

export const defaultBackupHooks: BackupHooks = {
  now: () => new Date(),
  vacuumInto: (databasePath, destination) => {
    const db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      db.prepare("VACUUM INTO ?").run(destination);
    } finally {
      db.close();
    }
  },
  freeBytes: (directory) => {
    try {
      const stat = statfsSync(directory);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      return undefined;
    }
  },
};

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function assertIntegrity(backupPath: string): void {
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    const values = rows.map((row) => Object.values(row)[0]);
    if (values.length !== 1 || values[0] !== "ok") {
      throw new Error("backup integrity_check failed");
    }
  } finally {
    db.close();
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

export function pruneBackups(agentBackups: string, keep = KEEP_BACKUPS): void {
  const entries = readdirSync(agentBackups, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".partial-")) {
      rmSync(join(agentBackups, entry.name), { recursive: true, force: true });
    }
  }
  const complete = entries
    .filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of complete.slice(0, Math.max(0, complete.length - keep))) {
    rmSync(join(agentBackups, name), { recursive: true, force: true });
  }
}

export function backupAgentDatabase(
  request: BackupRequest,
  hooks: BackupHooks,
): string {
  const agentBackups = join(request.backupsRoot, request.agentHash);
  request.ensureDirectory(request.backupsRoot);
  request.ensureDirectory(agentBackups);
  const name = `${stamp(hooks.now())}-from-${request.fromCommit.slice(0, 8)}`;
  const finalPath = join(agentBackups, name);
  const partialPath = join(agentBackups, `.partial-${name}`);
  try {
    if (existsSync(finalPath)) throw new Error("backup target already exists");
    rmSync(partialPath, { recursive: true, force: true });
    mkdirSync(partialPath, { mode: 0o700 });
    const needed =
      sizeOf(request.databasePath) + sizeOf(`${request.databasePath}-wal`);
    const free = hooks.freeBytes(agentBackups);
    if (free !== undefined && free < needed) {
      throw new Error("not enough free space for the backup");
    }
    const backupDatabase = join(partialPath, "memory.sqlite");
    hooks.vacuumInto(request.databasePath, backupDatabase);
    assertIntegrity(backupDatabase);
    copyFileSync(request.identityPath, join(partialPath, "identity.json"));
    renameSync(partialPath, finalPath);
  } catch {
    rmSync(partialPath, { recursive: true, force: true });
    throw new MemoryServiceError(
      "STORAGE_BUSY",
      "Memory backup before the Cairn upgrade failed; no data was changed",
    );
  }
  try {
    pruneBackups(agentBackups);
  } catch {
    // why: 備份已驗證完成，清理舊份失敗不可擋住升級；下次升級會再清。
  }
  return finalPath;
}
