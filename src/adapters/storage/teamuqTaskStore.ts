import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTeamuqTaskStored, TEAMUQ_TASK_FILE_VERSION, type TeamuqTaskStore } from "../../application/teamuqTaskBinding.js";

export const TEAMUQ_TASK_FILE = "teamuq-task.json";

export function createTeamuqTaskStore(dataDir: string): TeamuqTaskStore {
  const root = resolve(dataDir);
  const file = join(root, TEAMUQ_TASK_FILE);
  const temporary = `${file}.tmp`;
  const safe = (): void => {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error("state_path_unsafe");
    const stat = lstatSync(file, { throwIfNoEntry: false });
    // why: a symlink or junction at the state path could redirect the write outside the plugin data directory
    if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("state_path_unsafe");
  };
  return {
    load() {
      safe();
      if (!existsSync(file)) return parseTeamuqTaskStored(undefined);
      try {
        return parseTeamuqTaskStored(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return parseTeamuqTaskStored(undefined);
      }
    },
    save(record) {
      safe();
      writeFileSync(temporary, JSON.stringify({ version: TEAMUQ_TASK_FILE_VERSION, projectId: record.projectId, tasks: Object.fromEntries(record.tasks) }));
      renameSync(temporary, file);
    },
  };
}
