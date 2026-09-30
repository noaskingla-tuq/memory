export interface ProfileAgent {
  readonly name?: string;
  readonly teamKey?: string;
  readonly teamName?: string;
  readonly title?: string;
  readonly enabled?: boolean;
}

export interface ProfileStamp {
  readonly generation: string | null;
  readonly receivedAt: string | null;
}

export interface ProfileSink {
  readonly pending: number;
  readonly lastWrittenAtMs: number | null;
}

export interface ProfileOmitted {
  readonly agents: number;
  readonly teams: number;
  readonly projects: number;
}

export interface ProfileHealth {
  readonly corrupt: boolean;
  readonly omitted: ProfileOmitted;
  readonly incomplete: boolean;
}

export interface ProfilePort {
  stamp(): ProfileStamp;
  agent(agentId: string): ProfileAgent | undefined;
  projectName(projectId: string): string | undefined;
  teamName(teamKey: string): string | undefined;
  counts(): { readonly agents: number; readonly teams: number; readonly projects: number };
  sink(): ProfileSink | null;
  sinkReceivedAt(): string | null;
  health(): ProfileHealth;
}

const NONE_OMITTED: ProfileOmitted = { agents: 0, teams: 0, projects: 0 };

export const NO_PROFILE: ProfilePort = {
  stamp: () => ({ generation: null, receivedAt: null }),
  agent: () => undefined,
  projectName: () => undefined,
  teamName: () => undefined,
  counts: () => ({ agents: 0, teams: 0, projects: 0 }),
  sink: () => null,
  sinkReceivedAt: () => null,
  health: () => ({ corrupt: false, omitted: NONE_OMITTED, incomplete: false }),
};

// why: without a name table the team is the part of the agent id before the slash, which is how Core forms assignee ids
export function teamKeyOf(agentId: string, profile: ProfilePort): string {
  const named = profile.agent(agentId)?.teamKey;
  if (named !== undefined) return named;
  const slash = agentId.indexOf("/");
  return slash < 0 ? "" : agentId.slice(0, slash);
}
