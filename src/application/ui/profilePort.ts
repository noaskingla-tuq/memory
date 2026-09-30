export interface ProfileAgent {
  readonly name?: string;
  readonly teamKey?: string;
  readonly teamName?: string;
  readonly title?: string;
}

export interface ProfileStamp {
  readonly generation: string | null;
  readonly receivedAt: string | null;
}

export interface ProfileSink {
  readonly pending: number;
  readonly lastWrittenAtMs: number | null;
}

export interface ProfilePort {
  stamp(): ProfileStamp;
  agent(agentId: string): ProfileAgent | undefined;
  projectName(projectId: string): string | undefined;
  counts(): { readonly agents: number; readonly projects: number };
  sink(): ProfileSink | null;
}

export const NO_PROFILE: ProfilePort = {
  stamp: () => ({ generation: null, receivedAt: null }),
  agent: () => undefined,
  projectName: () => undefined,
  counts: () => ({ agents: 0, projects: 0 }),
  sink: () => null,
};

// why: without a name table the team is the part of the agent id before the slash, which is how Core forms assignee ids
export function teamKeyOf(agentId: string, profile: ProfilePort): string {
  const named = profile.agent(agentId)?.teamKey;
  if (named !== undefined) return named;
  const slash = agentId.indexOf("/");
  return slash < 0 ? "" : agentId.slice(0, slash);
}
