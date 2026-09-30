import { teamKeyOf, type ProfilePort } from "./profilePort.js";

export interface AgentNames {
  readonly displayName: string;
  readonly name?: string;
  readonly title?: string;
  readonly teamKey: string;
  readonly teamName?: string;
}

export interface ProjectNames {
  readonly displayName: string;
  readonly name?: string;
}

export interface RefNames {
  readonly agent: Omit<AgentNames, "title">;
  readonly project: ProjectNames | null;
}

const PROJECT_FALLBACK_PREFIX = "專案";
const PROJECT_ID_PREFIX_CHARS = 8;

// why: an agent missing from the name table is still recognisable by the last segment of its id (the agent inside its team) and the team key that groups it
export function degradedAgentName(agentId: string, teamKey: string): string {
  const segments = agentId.split("/").filter((part) => part !== "");
  const last = segments.length === 0 ? agentId : (segments[segments.length - 1] ?? agentId);
  return teamKey === "" ? last : `${last}（${teamKey}）`;
}

export function degradedProjectName(projectId: string): string {
  return `${PROJECT_FALLBACK_PREFIX} ${[...projectId].slice(0, PROJECT_ID_PREFIX_CHARS).join("")}`;
}

export function agentNames(profile: ProfilePort, agentId: string): AgentNames {
  const known = profile.agent(agentId);
  const teamKey = teamKeyOf(agentId, profile);
  const teamName = known?.teamName ?? (teamKey === "" ? undefined : profile.teamName(teamKey));
  return {
    displayName: known?.name ?? degradedAgentName(agentId, teamKey),
    ...(known?.name === undefined ? {} : { name: known.name }),
    ...(known?.title === undefined ? {} : { title: known.title }),
    teamKey,
    ...(teamName === undefined ? {} : { teamName }),
  };
}

export function projectNames(profile: ProfilePort, projectId: string): ProjectNames {
  const name = profile.projectName(projectId);
  return { displayName: name ?? degradedProjectName(projectId), ...(name === undefined ? {} : { name }) };
}

export function refNames(profile: ProfilePort, ref: { readonly agentId: string; readonly projectId: string | null }): RefNames {
  const { title: _title, ...agent } = agentNames(profile, ref.agentId);
  return { agent, project: ref.projectId === null ? null : projectNames(profile, ref.projectId) };
}
