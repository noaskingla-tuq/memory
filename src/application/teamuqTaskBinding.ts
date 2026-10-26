import type { PluginProgramApiV1 } from "@teamuq/plugin-sdk";

export const TEAMUQ_PROJECT_NAME = "Cairn記憶管理";
export const TEAMUQ_PROJECT_DESCRIPTION = "Cairn記憶管理外掛的記憶整理與相關紀錄。";
export const TEAMUQ_TASK_NAME = "AI 整理記憶";
export const TEAMUQ_TASK_DESCRIPTION = "Cairn記憶管理外掛在背景用 TeamUQ 的 AI 把工作紀錄整理成記憶；每一輪 AI 對話都歸在這個 Task 底下。";

export interface TeamuqTaskStored {
  projectId: string | null;
  taskId: string | null;
}

export interface TeamuqTaskStore {
  load(): TeamuqTaskStored;
  save(record: TeamuqTaskStored): void;
}

export interface TeamuqTaskBinding {
  resolve(): Promise<string | null>;
  forget(taskId: string): void;
}

export interface TeamuqTaskBindingOptions {
  program?: Pick<PluginProgramApiV1, "call"> | undefined;
  store: TeamuqTaskStore | null;
  now?: () => number;
  retryMs?: number;
  guardMs?: number;
  log?: (event: string, detail?: Record<string, string>) => void;
}

const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_PATTERN.test(value) ? value : null);

export function parseTeamuqTaskStored(value: unknown): TeamuqTaskStored {
  const record = (typeof value === "object" && value !== null ? value : {}) as { projectId?: unknown; taskId?: unknown };
  return { projectId: idOf(record.projectId), taskId: idOf(record.taskId) };
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

export function createTeamuqTaskBinding(options: TeamuqTaskBindingOptions): TeamuqTaskBinding {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 60_000;
  const guardMs = options.guardMs ?? 5_000;
  const program = options.program;
  const log = (event: string, detail?: Record<string, string>): void => {
    try {
      options.log?.(event, detail);
    } catch {
      // why: diagnostics must never change whether an AI turn goes out
    }
  };

  let stored: TeamuqTaskStored | undefined;
  let retryAt = 0;
  let inFlight: Promise<string | null> | null = null;

  const state = (): TeamuqTaskStored => {
    if (stored === undefined) {
      try {
        stored = parseTeamuqTaskStored(options.store?.load());
      } catch {
        // why: an unreadable or unsafe state file is treated as absent so the next resolve rebuilds the Task
        stored = { projectId: null, taskId: null };
      }
    }
    return stored;
  };

  const save = (): void => {
    const current = state();
    try {
      options.store?.save({ projectId: current.projectId, taskId: current.taskId });
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

  type Api = Pick<PluginProgramApiV1, "call">;

  const createProject = async (api: Api): Promise<string> => {
    const projectId = idFrom(await guarded(() => api.call("data.projects.create", { name: TEAMUQ_PROJECT_NAME, description: TEAMUQ_PROJECT_DESCRIPTION })));
    state().projectId = projectId;
    save();
    log("project created");
    return projectId;
  };

  const createTask = async (api: Api, projectId: string): Promise<string> =>
    idFrom(await guarded(() => api.call("data.tasks.create", { name: TEAMUQ_TASK_NAME, description: TEAMUQ_TASK_DESCRIPTION, projectId })));

  const ensure = async (api: Api): Promise<string | null> => {
    try {
      let projectId = state().projectId ?? await createProject(api);
      let taskId: string;
      try {
        taskId = await createTask(api, projectId);
      } catch (error) {
        // why: not_found on task creation means the Project was deleted in TeamUQ, so the Project is rebuilt with the Task
        if (!(error instanceof ProgramError) || error.code !== "not_found") throw error;
        projectId = await createProject(api);
        taskId = await createTask(api, projectId);
      }
      state().taskId = taskId;
      save();
      log("task created");
      return taskId;
    } catch (error) {
      retryAt = now() + retryMs;
      log("task unavailable", { code: error instanceof ProgramError ? error.code : errorName(error) });
      return null;
    }
  };

  return {
    resolve() {
      const current = state();
      if (current.taskId !== null) return Promise.resolve(current.taskId);
      if (program === undefined || now() < retryAt) return Promise.resolve(null);
      inFlight ??= ensure(program).finally(() => { inFlight = null; });
      return inFlight;
    },
    forget(taskId) {
      const current = state();
      if (current.taskId !== taskId) return;
      current.taskId = null;
      retryAt = 0;
      save();
      log("task forgotten");
    },
  };
}
