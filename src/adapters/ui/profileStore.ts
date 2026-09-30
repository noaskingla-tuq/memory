import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  MEMORY_PROFILE_LIMITS,
  memoryProfileAgentSchema,
  memoryProfileOmittedSchema,
  memoryProfileProjectSchema,
  memoryProfileSinkSchema,
  memoryProfileTeamSchema,
} from "../../../vendor/teamuq-contract/contract.mjs";
import { profileGeneration } from "../../application/ui/profileGeneration.js";

export const PROFILE_FILE_VERSION = 1;
export const PROFILE_DIRECTORY = "memory-ui";
export const PROFILE_FILE = "profile.json";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const TEMP_NAME = /^profile\.json\.[0-9a-f]{16}\.tmp$/u;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const timestamp = z.string().min(1).max(40);

export const profileFileSchema = z
  .object({
    version: z.literal(PROFILE_FILE_VERSION),
    generation: sha256Hex,
    receivedAt: timestamp,
    agents: z.array(memoryProfileAgentSchema).max(MEMORY_PROFILE_LIMITS.maxAgents),
    teams: z.array(memoryProfileTeamSchema).max(MEMORY_PROFILE_LIMITS.maxTeams),
    projects: z.array(memoryProfileProjectSchema).max(MEMORY_PROFILE_LIMITS.maxProjects),
    omitted: memoryProfileOmittedSchema,
    sink: memoryProfileSinkSchema.nullable(),
    sinkReceivedAt: timestamp.nullable(),
  })
  .strict();

export type ProfileFileContent = z.infer<typeof profileFileSchema>;

export type ProfileLoad =
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "ok"; readonly file: ProfileFileContent };

export interface ProfileIo {
  writeTemp(path: string, text: string): void;
  rename(from: string, to: string): void;
}

// why: the temp file is created exclusively and flushed before the rename, so a crash leaves either the old file or a complete new one and never a half-written profile.json; under the Node permission model fsync is disabled (ERR_ACCESS_DENIED, seen in the Electron utility process), and then the rename alone has to carry the atomicity
export function createProfileIo(flush: (handle: number) => void = fsyncSync): ProfileIo {
  return {
    writeTemp(path, text) {
      const handle = openSync(path, "wx", 0o600);
      try {
        writeSync(handle, text, null, "utf8");
        try {
          flush(handle);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "ERR_ACCESS_DENIED") throw error;
        }
      } finally {
        closeSync(handle);
      }
    },
    rename: renameSync,
  };
}

export const defaultProfileIo: ProfileIo = createProfileIo();

export class ProfileStoreError extends Error {
  constructor(readonly reason: "unsafe_path" | "write_failed") {
    super(reason);
    this.name = "ProfileStoreError";
  }
}

function isLink(path: string): "missing" | "link" | "other" {
  try {
    return lstatSync(path).isSymbolicLink() ? "link" : "other";
  } catch {
    return "missing";
  }
}

// why: a stored file whose content does not hash back to its own generation is treated like any other damage, so a half-edited or truncated table can never show names that Core did not send
export function loadProfileFile(path: string): ProfileLoad {
  if (isLink(dirname(path)) === "link") return { kind: "corrupt", reason: "unsafe_path" };
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR" ? { kind: "missing" } : { kind: "corrupt", reason: "unreadable" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "corrupt", reason: "unsafe_path" };
  if (stat.size > MAX_FILE_BYTES) return { kind: "corrupt", reason: "too_large" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "corrupt", reason: "not_json" };
  }
  const parsed = profileFileSchema.safeParse(raw);
  if (!parsed.success) return { kind: "corrupt", reason: "schema" };
  const { agents, teams, projects, omitted, generation } = parsed.data;
  if (profileGeneration({ agents, teams, projects, omitted }) !== generation) return { kind: "corrupt", reason: "generation_mismatch" };
  return { kind: "ok", file: parsed.data };
}

function removeStaleTemps(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    try {
      rmSync(join(directory, name), { force: true });
    } catch {
      // why: a leftover temp file is only clutter, and the next write tries again
    }
  }
}

export function writeProfileFile(path: string, file: ProfileFileContent, io: ProfileIo = defaultProfileIo): void {
  const directory = dirname(path);
  try {
    if (isLink(directory) === "link" || isLink(path) === "link") throw new ProfileStoreError("unsafe_path");
    mkdirSync(directory, { recursive: true });
    if (isLink(directory) === "link") throw new ProfileStoreError("unsafe_path");
    removeStaleTemps(directory);
    const temp = join(directory, `${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      io.writeTemp(temp, `${JSON.stringify(file)}\n`);
      io.rename(temp, path);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // why: the failure that matters is the write, and a temp file left behind is removed by the next write
      }
      throw error;
    }
  } catch (error) {
    throw error instanceof ProfileStoreError ? error : new ProfileStoreError("write_failed");
  }
}
