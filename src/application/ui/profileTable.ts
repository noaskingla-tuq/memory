import type { ProfileFileContent, ProfileLoad } from "../../adapters/ui/profileStore.js";
import type { ProfileAgent, ProfileHealth, ProfilePort, ProfileSink, ProfileStamp } from "./profilePort.js";

type FileAgent = ProfileFileContent["agents"][number];

interface Loaded {
  readonly file: ProfileFileContent | null;
  readonly corrupt: boolean;
  readonly agents: ReadonlyMap<string, FileAgent>;
  readonly teams: ReadonlyMap<string, string>;
  readonly projects: ReadonlyMap<string, string>;
}

const EMPTY: Loaded = { file: null, corrupt: false, agents: new Map(), teams: new Map(), projects: new Map() };

function build(file: ProfileFileContent | null, corrupt: boolean): Loaded {
  if (file === null) return corrupt ? { ...EMPTY, corrupt } : EMPTY;
  return {
    file,
    corrupt,
    agents: new Map(file.agents.map((entry) => [entry.id, entry])),
    teams: new Map(file.teams.map((entry) => [entry.key, entry.name])),
    projects: new Map(file.projects.map((entry) => [entry.id, entry.name])),
  };
}

// why: the table is swapped as one immutable snapshot, so a ui call that is already running never sees half of an old table and half of a new one
export class ProfileTable implements ProfilePort {
  private current: Loaded;

  constructor(load: ProfileLoad) {
    this.current = load.kind === "ok" ? build(load.file, false) : build(null, load.kind === "corrupt");
  }

  replace(file: ProfileFileContent): void {
    this.current = build(file, false);
  }

  generation(): string | null {
    return this.current.file?.generation ?? null;
  }

  snapshot(): ProfileFileContent | null {
    return this.current.file;
  }

  stamp(): ProfileStamp {
    return { generation: this.current.file?.generation ?? null, receivedAt: this.current.file?.receivedAt ?? null };
  }

  agent(agentId: string): ProfileAgent | undefined {
    const entry = this.current.agents.get(agentId);
    if (entry === undefined) return undefined;
    const teamName = entry.teamKey === null ? undefined : this.current.teams.get(entry.teamKey);
    return {
      name: entry.name,
      ...(entry.teamKey === null ? {} : { teamKey: entry.teamKey }),
      ...(teamName === undefined ? {} : { teamName }),
      ...(entry.title === null ? {} : { title: entry.title }),
      enabled: entry.enabled,
    };
  }

  projectName(projectId: string): string | undefined {
    return this.current.projects.get(projectId);
  }

  teamName(teamKey: string): string | undefined {
    return this.current.teams.get(teamKey);
  }

  counts(): { readonly agents: number; readonly teams: number; readonly projects: number } {
    return { agents: this.current.agents.size, teams: this.current.teams.size, projects: this.current.projects.size };
  }

  sink(): ProfileSink | null {
    return this.current.file?.sink ?? null;
  }

  sinkReceivedAt(): string | null {
    return this.current.file?.sinkReceivedAt ?? null;
  }

  health(): ProfileHealth {
    const omitted = this.current.file?.omitted ?? { agents: 0, teams: 0, projects: 0 };
    return { corrupt: this.current.corrupt, omitted, incomplete: omitted.agents + omitted.teams + omitted.projects > 0 };
  }
}
