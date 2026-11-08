import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type BackupOutcome = "created" | "exists" | "missing";

// why: the first backup is the only copy of the state from before the migration, so an existing one is never overwritten
export function backupStateOnce(dataDir: string, source: string, target: string): BackupOutcome {
  const sourceFile = join(dataDir, source);
  const targetFile = join(dataDir, target);
  const unsafe = (file: string): boolean => {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    return stat !== undefined && (stat.isSymbolicLink() || !stat.isFile());
  };
  if (lstatSync(dataDir).isSymbolicLink() || unsafe(sourceFile) || unsafe(targetFile)) throw new Error("state_path_unsafe");
  if (existsSync(targetFile)) return "exists";
  if (!existsSync(sourceFile)) return "missing";
  const temporary = `${targetFile}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, readFileSync(sourceFile));
      try { fsyncSync(fd); } catch (error) { if ((error as { code?: string }).code !== "ERR_ACCESS_DENIED") throw error; }
    } finally { closeSync(fd); }
    renameSync(temporary, targetFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return "created";
}
