import { createHash } from "node:crypto";
import {
  MEMORY_LIMITS,
  MEMORY_PROFILE_LIMITS,
  memoryProfileCanonicalText,
  type MemoryProfileAgent,
  type MemoryProfileOmitted,
  type MemoryProfileProject,
  type MemoryProfileSink,
  type MemoryProfileSnapshot,
  type MemoryProfileSyncRequest,
  type MemoryProfileTeam,
} from "../../vendor/teamuq-contract/contract.mjs";

export interface ProfileSyncInput {
  readonly agents: readonly MemoryProfileAgent[];
  readonly teams: readonly MemoryProfileTeam[];
  readonly projects: readonly MemoryProfileProject[];
  readonly sink: MemoryProfileSink | null;
}

export interface ProfileSyncPlan {
  readonly generation: string;
  readonly parts: readonly MemoryProfileSyncRequest[];
  readonly omitted: MemoryProfileOmitted;
  readonly titlesDropped: boolean;
}

const ELLIPSIS = "…";
const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function clean(text: string, max: number): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const end = /[\uD800-\uDBFF]/.test(flat[max - 2] ?? "") ? max - 2 : max - 1;
  return flat.slice(0, end) + ELLIPSIS;
}

const validKey = (key: string): boolean => key.length >= 1 && key.length <= MEMORY_LIMITS.identifierMaxChars;

function uniqueByKey<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const ordered = [...entries].sort((a, b) => compare(key(a), key(b)) || compare(JSON.stringify(a), JSON.stringify(b)));
  return ordered.filter((entry, index) => index === 0 || key(ordered[index - 1] as T) !== key(entry));
}

interface Ranked<T> {
  readonly priority: readonly T[];
  readonly dropped: number;
}

function cap<T>(entries: readonly T[], limit: number, rank: (a: T, b: T) => number): Ranked<T> {
  const priority = [...entries].sort(rank).slice(0, limit);
  return { priority, dropped: entries.length - priority.length };
}

function envelopeBytes(sink: MemoryProfileSink | null): number {
  const probe: MemoryProfileSyncRequest = {
    generation: "f".repeat(64), part: MEMORY_PROFILE_LIMITS.maxParts, parts: MEMORY_PROFILE_LIMITS.maxParts,
    agents: [], teams: [], projects: [], omitted: { agents: 9_999_999, teams: 9_999_999, projects: 9_999_999 },
    sink: sink === null ? null : { pending: Number.MAX_SAFE_INTEGER, lastWrittenAtMs: Number.MAX_SAFE_INTEGER },
  };
  return utf8(JSON.stringify(probe));
}

interface Slice {
  agents: MemoryProfileAgent[];
  teams: MemoryProfileTeam[];
  projects: MemoryProfileProject[];
}

function split(agents: readonly MemoryProfileAgent[], teams: readonly MemoryProfileTeam[], projects: readonly MemoryProfileProject[], budget: number): Slice[] {
  const slices: Slice[] = [{ agents: [], teams: [], projects: [] }];
  let used = 0;
  const place = (entry: unknown, put: (slice: Slice) => void): void => {
    const cost = utf8(JSON.stringify(entry)) + 1;
    if (used + cost > budget && used > 0) {
      slices.push({ agents: [], teams: [], projects: [] });
      used = 0;
    }
    put(slices[slices.length - 1]!);
    used += cost;
  };
  for (const entry of agents) place(entry, (slice) => slice.agents.push(entry));
  for (const entry of teams) place(entry, (slice) => slice.teams.push(entry));
  for (const entry of projects) place(entry, (slice) => slice.projects.push(entry));
  return slices;
}

const byId = (a: { readonly id: string }, b: { readonly id: string }): number => compare(a.id, b.id);
const byTeamKey = (a: MemoryProfileTeam, b: MemoryProfileTeam): number => compare(a.key, b.key);

export function planProfileSync(input: ProfileSyncInput): ProfileSyncPlan {
  const budget = MEMORY_PROFILE_LIMITS.partBudgetBytes - envelopeBytes(input.sink);
  let invalid = { agents: 0, teams: 0, projects: 0 };
  const agentsIn: MemoryProfileAgent[] = [];
  for (const entry of input.agents) {
    if (!validKey(entry.id)) invalid = { ...invalid, agents: invalid.agents + 1 };
    else {
      const teamKey = entry.teamKey !== null && validKey(entry.teamKey) ? entry.teamKey : null;
      const title = entry.title === null ? "" : clean(entry.title, MEMORY_PROFILE_LIMITS.titleMaxChars);
      agentsIn.push({ id: entry.id, name: clean(entry.name, MEMORY_PROFILE_LIMITS.agentNameMaxChars) || clean(entry.id, MEMORY_PROFILE_LIMITS.agentNameMaxChars), teamKey, title: title || null, enabled: entry.enabled });
    }
  }
  const teamsIn: MemoryProfileTeam[] = [];
  for (const entry of input.teams) {
    if (!validKey(entry.key)) invalid = { ...invalid, teams: invalid.teams + 1 };
    else teamsIn.push({ key: entry.key, name: clean(entry.name, MEMORY_PROFILE_LIMITS.teamNameMaxChars) || clean(entry.key, MEMORY_PROFILE_LIMITS.teamNameMaxChars) });
  }
  const projectsIn: MemoryProfileProject[] = [];
  for (const entry of input.projects) {
    if (!validKey(entry.id)) invalid = { ...invalid, projects: invalid.projects + 1 };
    else projectsIn.push({ id: entry.id, name: clean(entry.name, MEMORY_PROFILE_LIMITS.projectNameMaxChars) || clean(entry.id, MEMORY_PROFILE_LIMITS.projectNameMaxChars), archived: entry.archived });
  }
  const agentsUnique = uniqueByKey(agentsIn, (entry) => entry.id);
  const teamsUnique = uniqueByKey(teamsIn, (entry) => entry.key);
  const projectsUnique = uniqueByKey(projectsIn, (entry) => entry.id);
  let agents = cap(agentsUnique, MEMORY_PROFILE_LIMITS.maxAgents, (a, b) => Number(b.enabled) - Number(a.enabled) || byId(a, b));
  const usedTeams = new Set(agents.priority.flatMap((entry) => entry.teamKey === null ? [] : [entry.teamKey]));
  let teams = cap(teamsUnique, MEMORY_PROFILE_LIMITS.maxTeams, (a, b) => Number(usedTeams.has(b.key)) - Number(usedTeams.has(a.key)) || byTeamKey(a, b));
  let projects = cap(projectsUnique, MEMORY_PROFILE_LIMITS.maxProjects, (a, b) => Number(a.archived) - Number(b.archived) || byId(a, b));
  let titlesDropped = false;
  let slices: Slice[] = [];
  const layout = (): void => { slices = split([...agents.priority].sort(byId), [...teams.priority].sort(byTeamKey), [...projects.priority].sort(byId), budget); };
  layout();
  if (slices.length > MEMORY_PROFILE_LIMITS.maxParts) {
    titlesDropped = true;
    agents = { ...agents, priority: agents.priority.map((entry) => ({ ...entry, title: null })) };
    layout();
  }
  while (slices.length > MEMORY_PROFILE_LIMITS.maxParts) {
    let need = (slices.length - MEMORY_PROFILE_LIMITS.maxParts) * budget;
    const shed = <T>(ranked: Ranked<T>): Ranked<T> => {
      let keep = ranked.priority.length;
      while (keep > 0 && need > 0) { keep -= 1; need -= utf8(JSON.stringify(ranked.priority[keep])) + 1; }
      return { priority: ranked.priority.slice(0, keep), dropped: ranked.dropped + ranked.priority.length - keep };
    };
    projects = shed(projects); teams = shed(teams); agents = shed(agents); layout();
  }
  const omitted: MemoryProfileOmitted = { agents: invalid.agents + agents.dropped, teams: invalid.teams + teams.dropped, projects: invalid.projects + projects.dropped };
  const snapshot: MemoryProfileSnapshot = { agents: slices.flatMap((slice) => slice.agents), teams: slices.flatMap((slice) => slice.teams), projects: slices.flatMap((slice) => slice.projects), omitted };
  const generation = createHash("sha256").update(memoryProfileCanonicalText(snapshot), "utf8").digest("hex");
  const parts = slices.map((slice, index): MemoryProfileSyncRequest => ({ generation, part: index + 1, parts: slices.length, agents: slice.agents, teams: slice.teams, projects: slice.projects, omitted, sink: input.sink }));
  return { generation, parts, omitted, titlesDropped };
}
