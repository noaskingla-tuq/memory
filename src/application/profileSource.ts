export interface DirectoryAgent {
  readonly id: string;
  readonly name: string;
  readonly teamKey: string;
  readonly teamName: string | null;
  readonly title: string;
  readonly enabled: boolean;
}

export interface DirectoryProject {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface DirectorySnapshot<T> {
  readonly generation: string;
  readonly entries: readonly T[];
}

export type ProfileDirectoryRead =
  | { readonly kind: "available"; readonly agents: DirectorySnapshot<DirectoryAgent>; readonly projects: DirectorySnapshot<DirectoryProject> }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ProfileDirectoryPort {
  readAgents(): Promise<DirectorySnapshot<DirectoryAgent>>;
  readProjects(): Promise<DirectorySnapshot<DirectoryProject>>;
}

export interface MemoryProfileAgent {
  readonly id: string;
  readonly name: string;
  readonly teamKey: string | null;
  readonly title: string | null;
  readonly enabled: boolean;
}

export interface MemoryProfileTeam {
  readonly key: string;
  readonly name: string;
}

export interface MemoryProfileProject {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface MemoryProfileSnapshot {
  readonly agents: readonly MemoryProfileAgent[];
  readonly teams: readonly MemoryProfileTeam[];
  readonly projects: readonly MemoryProfileProject[];
}

export type ProfileSnapshotRead =
  | { readonly kind: "available"; readonly snapshot: MemoryProfileSnapshot; readonly sourceGenerations: { readonly agents: string; readonly projects: string } }
  | { readonly kind: "unavailable"; readonly reason: string };

export async function readMemoryProfile(directory: ProfileDirectoryPort): Promise<ProfileSnapshotRead> {
  let agents: DirectorySnapshot<DirectoryAgent>;
  let projects: DirectorySnapshot<DirectoryProject>;
  try {
    [agents, projects] = await Promise.all([directory.readAgents(), directory.readProjects()]);
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.name : "directory_unavailable" };
  }
  if (agents.entries.length === 0) {
    return { kind: "unavailable", reason: "directory_empty" };
  }
  const teamNames = new Map<string, Set<string>>();
  for (const agent of agents.entries) {
    if (agent.teamKey === "") continue;
    const names = teamNames.get(agent.teamKey) ?? new Set<string>();
    names.add(agent.teamName?.trim() || agent.teamKey);
    teamNames.set(agent.teamKey, names);
  }
  const teams = [...teamNames].map(([key, names]) => ({ key, name: [...names].sort((left, right) => Number(left === key) - Number(right === key) || (left < right ? -1 : left > right ? 1 : 0))[0] ?? key }));
  return {
    kind: "available",
    sourceGenerations: { agents: agents.generation, projects: projects.generation },
    snapshot: {
      agents: agents.entries.map((agent) => ({ id: agent.id, name: agent.name, teamKey: agent.teamKey || null, title: agent.title || null, enabled: agent.enabled })),
      teams: teams.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
      projects: projects.entries.map((project) => ({ id: project.id, name: project.name, archived: project.archived })),
    },
  };
}
