import {
  MEMORY_PROFILE_LIMITS,
  memoryProfileSyncRequestSchema,
  memoryProfileSyncResponseSchema,
  type MemoryProfileSyncRequest,
  type MemoryProfileSyncResponse,
} from "../../vendor/teamuq-contract/contract.mjs";
import { PROFILE_FILE_VERSION, defaultProfileIo, writeProfileFile, type ProfileFileContent, type ProfileIo } from "../adapters/ui/profileStore.js";
import { profileGeneration } from "../application/ui/profileGeneration.js";
import type { ProfileTable } from "../application/ui/profileTable.js";
import { callError } from "./contractErrors.js";

export interface ProfileSyncDeps {
  readonly table: ProfileTable;
  readonly filePath: string;
  readonly now: () => number;
  readonly io?: ProfileIo;
}

export interface ProfileSync {
  handle(params: unknown): MemoryProfileSyncResponse;
}

interface Staged {
  readonly generation: string;
  readonly parts: number;
  readonly omittedKey: string;
  readonly received: Map<number, MemoryProfileSyncRequest>;
}

const byText = <T>(key: (entry: T) => string) => (left: T, right: T): number => {
  const a = key(left);
  const b = key(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

function invalid(): never {
  throw callError("invalid_params", "Invalid params for memory.profile.sync");
}

// why: the parts of one generation are held in memory only; Core resends every part after any failure, so staged parts never need to survive a restart and a half-received table is never visible
export function createProfileSync(deps: ProfileSyncDeps): ProfileSync {
  const io = deps.io ?? defaultProfileIo;
  let staged: Staged | undefined;

  const respond = (generation: string, complete: boolean, changed: boolean, received: number): MemoryProfileSyncResponse => {
    const parsed = memoryProfileSyncResponseSchema.safeParse({ accepted: true, generation, complete, changed, received, ...deps.table.counts() });
    if (!parsed.success) throw callError("internal", "Profile sync response failed the contract schema");
    return parsed.data;
  };

  const sinkFields = (request: MemoryProfileSyncRequest, at: string) => ({ sink: request.sink, sinkReceivedAt: request.sink === null ? null : at });

  const refreshSink = (request: MemoryProfileSyncRequest, at: string): void => {
    const current = deps.table.snapshot();
    if (current === null) return;
    const next: ProfileFileContent = { ...current, ...sinkFields(request, at) };
    deps.table.replace(next);
    try {
      writeProfileFile(deps.filePath, next, io);
    } catch {
      // why: the names are unchanged and already on disk, so a failed save of the sink numbers only loses them across a restart
    }
  };

  const assemble = (gathered: Staged, at: string): ProfileFileContent => {
    const ordered = [...gathered.received.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === undefined || last === undefined) return invalid();
    const agents = ordered.flatMap((part) => part.agents).sort(byText((entry) => entry.id));
    const teams = ordered.flatMap((part) => part.teams).sort(byText((entry) => entry.key));
    const projects = ordered.flatMap((part) => part.projects).sort(byText((entry) => entry.id));
    if (agents.length > MEMORY_PROFILE_LIMITS.maxAgents || teams.length > MEMORY_PROFILE_LIMITS.maxTeams || projects.length > MEMORY_PROFILE_LIMITS.maxProjects) return invalid();
    const snapshot = { agents, teams, projects, omitted: first.omitted };
    if (profileGeneration(snapshot) !== gathered.generation) return invalid();
    return { version: PROFILE_FILE_VERSION, generation: gathered.generation, receivedAt: at, ...snapshot, ...sinkFields(last, at) };
  };

  return {
    handle(params) {
      const parsed = memoryProfileSyncRequestSchema.safeParse(params);
      if (!parsed.success) return invalid();
      const request = parsed.data;
      const at = new Date(deps.now()).toISOString();
      if (deps.table.generation() === request.generation) {
        staged = undefined;
        refreshSink(request, at);
        return respond(request.generation, true, false, 1);
      }
      if (staged !== undefined && (staged.generation !== request.generation || staged.parts !== request.parts)) staged = undefined;
      const omittedKey = JSON.stringify(request.omitted);
      staged ??= { generation: request.generation, parts: request.parts, omittedKey, received: new Map() };
      if (staged.omittedKey !== omittedKey) {
        staged = undefined;
        return invalid();
      }
      staged.received.set(request.part, request);
      if (staged.received.size < staged.parts) return respond(request.generation, false, false, staged.received.size);
      const gathered = staged;
      staged = undefined;
      const file = assemble(gathered, at);
      try {
        writeProfileFile(deps.filePath, file, io);
      } catch {
        throw callError("internal", "The name table could not be stored");
      }
      deps.table.replace(file);
      return respond(request.generation, true, true, request.parts);
    },
  };
}
