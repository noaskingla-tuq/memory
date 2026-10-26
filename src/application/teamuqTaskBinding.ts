import type { PluginProgramApiV1 } from "@teamuq/plugin-sdk";
import { agentNames } from "./ui/names.js";
import { NO_PROFILE, type ProfilePort } from "./ui/profilePort.js";

export const TEAMUQ_PROJECT_NAME = "Cairn記憶管理";
export const TEAMUQ_PROJECT_DESCRIPTION = "Cairn記憶管理外掛的記憶整理與相關紀錄。";
export const TEAMUQ_TASK_NAME_PREFIX = "AI 整理記憶：";
export const teamuqTaskNameFor = (agentDisplayName: string): string => `${TEAMUQ_TASK_NAME_PREFIX}${agentDisplayName}`;
export const teamuqTaskDescriptionFor = (agentDisplayName: string): string =>
  `Cairn記憶管理外掛替「${agentDisplayName}」在背景用 TeamUQ 的 AI 把工作紀錄整理成記憶；這個 agent 的每一輪 AI 對話都歸在這個 Task 底下。`;

export const TEAMUQ_TASK_FILE_VERSION = 2;

export interface TeamuqTaskStored {
  projectId: string | null;
  tasks: Map<string, string>;
}

export interface TeamuqTaskStore {
  load(): TeamuqTaskStored;
  save(record: TeamuqTaskStored): void;
}

export interface TeamuqTaskBinding {
  resolve(agentId: string): Promise<string | null>;
  forget(agentId: string, taskId: string): void;
}

export interface TeamuqTaskBindingOptions {
  program?: Pick<PluginProgramApiV1, "call"> | undefined;
  store: TeamuqTaskStore | null;
  profile?: ProfilePort;
  now?: () => number;
  retryMs?: number;
  guardMs?: number;
  log?: (event: string, detail?: Record<string, string>) => void;
}

const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_PATTERN.test(value) ? value : null);

// why: the version-1 file held one shared Task for every agent; its Project is kept because the Project is still the single one, and its Task is dropped because it cannot be attributed to one agent
export function parseTeamuqTaskStored(value: unknown): TeamuqTaskStored {
  const record = (typeof value === "object" && value !== null ? value : {}) as { version?: unknown; projectId?: unknown; tasks?: unknown };
  const tasks = new Map<string, string>();
  if (record.version === TEAMUQ_TASK_FILE_VERSION && typeof record.tasks === "object" && record.tasks !== null && !Array.isArray(record.tasks)) {
    for (const [agentId, taskId] of Object.entries(record.tasks)) {
      const id = idOf(taskId);
      if (agentId !== "" && id !== null) tasks.set(agentId, id);
    }
  }
  return { projectId: idOf(record.projectId), tasks };
}

class ProgramError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface ProgramReply {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "invalid_reply";
};
const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
const isProgramCode = (error: unknown, code: string): boolean => error instanceof ProgramError && error.code === code;

type Api = Pick<PluginProgramApiV1, "call">;

export function createTeamuqTaskBinding(options: TeamuqTaskBindingOptions): TeamuqTaskBinding {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 60_000;
  const guardMs = options.guardMs ?? 5_000;
  const program = options.program;
  const profile = options.profile ?? NO_PROFILE;
  const log = (event: string, detail?: Record<string, string>): void => {
    try {
      options.log?.(event, detail);
    } catch {
      // why: diagnostics must never change whether an AI turn goes out
    }
  };

  let stored: TeamuqTaskStored | undefined;
  let projectFlight: Promise<string> | null = null;
  const flights = new Map<string, Promise<string | null>>();
  const retryAt = new Map<string, number>();

  const state = (): TeamuqTaskStored => {
    if (stored === undefined) {
      try {
        stored = options.store?.load() ?? { projectId: null, tasks: new Map() };
      } catch {
        // why: an unreadable or unsafe state file is treated as absent so the next resolve rebuilds the Tasks
        stored = { projectId: null, tasks: new Map() };
      }
    }
    return stored;
  };

  const save = (): void => {
    const current = state();
    try {
      options.store?.save({ projectId: current.projectId, tasks: current.tasks });
    } catch (error) {
      log("save failed", { error: errorName(error) });
    }
  };

  const guarded = <T>(work: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProgramError("timeout")), guardMs);
    Promise.resolve()
      .then(work)
      .then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
  });

  const idFrom = (reply: ProgramReply): string => {
    if (reply.ok !== true) throw new ProgramError(errorCode(reply.error));
    const id = idOf((reply.result as { id?: unknown } | undefined)?.id);
    if (id === null) throw new ProgramError("invalid_reply");
    return id;
  };

  const createProject = async (api: Api): Promise<string> => {
    const projectId = idFrom(await guarded(() => api.call("data.projects.create", { name: TEAMUQ_PROJECT_NAME, description: TEAMUQ_PROJECT_DESCRIPTION })));
    state().projectId = projectId;
    save();
    log("project created");
    return projectId;
  };

  // why: one Project serves every agent; a Project already rebuilt by another agent's failure is reused, so concurrent agents never create a second Project
  const projectFor = (api: Api, failedId: string | null): Promise<string> => {
    const current = state().projectId;
    if (current !== null && current !== failedId) return Promise.resolve(current);
    projectFlight ??= createProject(api).finally(() => { projectFlight = null; });
    return projectFlight;
  };

  const createTask = async (api: Api, projectId: string, agentId: string): Promise<string> => {
    const displayName = agentNames(profile, agentId).displayName;
    return idFrom(await guarded(() => api.call("data.tasks.create", { name: teamuqTaskNameFor(displayName), description: teamuqTaskDescriptionFor(displayName), projectId })));
  };

  const ensure = async (api: Api, agentId: string): Promise<string | null> => {
    try {
      let projectId = await projectFor(api, null);
      let taskId: string;
      try {
        taskId = await createTask(api, projectId, agentId);
      } catch (error) {
        // why: not_found on Task creation means the Project was deleted in TeamUQ, so the Project is rebuilt and the Task retried
        if (!isProgramCode(error, "not_found")) throw error;
        projectId = await projectFor(api, projectId);
        taskId = await createTask(api, projectId, agentId);
      }
      state().tasks.set(agentId, taskId);
      save();
      log("task created");
      return taskId;
    } catch (error) {
      retryAt.set(agentId, now() + retryMs);
      log("task unavailable", { code: error instanceof ProgramError ? error.code : errorName(error) });
      return null;
    }
  };

  return {
    resolve(agentId) {
      const known = state().tasks.get(agentId);
      if (known !== undefined) return Promise.resolve(known);
      if (program === undefined || now() < (retryAt.get(agentId) ?? 0)) return Promise.resolve(null);
      let flight = flights.get(agentId);
      if (flight === undefined) {
        flight = ensure(program, agentId).finally(() => { flights.delete(agentId); });
        flights.set(agentId, flight);
      }
      return flight;
    },
    forget(agentId, taskId) {
      const current = state();
      if (current.tasks.get(agentId) !== taskId) return;
      current.tasks.delete(agentId);
      retryAt.delete(agentId);
      save();
      log("task forgotten");
    },
  };
}
