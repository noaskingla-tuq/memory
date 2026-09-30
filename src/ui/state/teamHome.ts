import type { z } from "zod";
import type { uiOverviewSuccess } from "../../contracts/uiContract.js";
import { t } from "../i18n/index.js";
import { parseInstant } from "../i18n/relativeTime.js";

export interface ProjectCount {
  readonly projectId: string;
  readonly name?: string | undefined;
  readonly count: number;
}

export interface OverviewAgent {
  readonly id: string;
  readonly name?: string | undefined;
  readonly team: { readonly key: string; readonly name?: string | undefined };
  readonly title?: string | undefined;
  readonly counts: {
    readonly personal: number;
    readonly projects: readonly ProjectCount[];
    readonly otherProjects: number;
    readonly total: number;
  };
  readonly lastAt: string | null;
  readonly spark14: readonly number[];
  readonly latest: { readonly snippet: string; readonly at: string } | null;
}

export interface OverviewTiles {
  readonly totalMemories: number;
  readonly writtenToday: number;
  readonly activeAgents7d: number;
  readonly agents: number;
  readonly lastWriteAt: string | null;
}

export interface OverviewPage {
  readonly tiles: OverviewTiles;
  readonly agents: readonly OverviewAgent[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly unavailableAgents: number;
  readonly storageStatus: string;
}

// why: the view cannot run zod, so a hand-written parser guards the response and this assertion fails tsc when the contract's overview shape drifts away from it
type Contract = z.infer<typeof uiOverviewSuccess>;
type OverviewContractMatches = Contract["agents"][number] extends OverviewAgent ? (Contract["tiles"] extends OverviewTiles ? true : never) : never;
export const OVERVIEW_CONTRACT_MATCHES: OverviewContractMatches = true;

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): string | undefined | null => (value === undefined ? undefined : isText(value) ? value : null);
const textOrNull = (value: unknown): string | null | undefined => (value === null ? null : isText(value) ? value : undefined);

function parseProject(value: unknown): ProjectCount | null {
  if (!isRecord(value) || !isText(value.projectId) || !isCount(value.count)) return null;
  const name = optionalText(value.name);
  return name === null ? null : { projectId: value.projectId, name, count: value.count };
}

function parseAgent(value: unknown): OverviewAgent | null {
  if (!isRecord(value) || !isText(value.id) || value.id === "") return null;
  const team = value.team;
  const counts = value.counts;
  if (!isRecord(team) || !isText(team.key) || !isRecord(counts)) return null;
  if (!isCount(counts.personal) || !isCount(counts.otherProjects) || !isCount(counts.total) || !Array.isArray(counts.projects)) return null;
  const projects = counts.projects.map(parseProject);
  const name = optionalText(value.name);
  const teamName = optionalText(team.name);
  const title = optionalText(value.title);
  const lastAt = textOrNull(value.lastAt);
  if (projects.includes(null) || name === null || teamName === null || title === null || lastAt === undefined) return null;
  if (!Array.isArray(value.spark14) || value.spark14.length !== 14 || !value.spark14.every(isCount)) return null;
  let latest: OverviewAgent["latest"] = null;
  if (value.latest !== null) {
    if (!isRecord(value.latest) || !isText(value.latest.snippet) || !isText(value.latest.at)) return null;
    latest = { snippet: value.latest.snippet, at: value.latest.at };
  }
  return {
    id: value.id,
    name,
    team: { key: team.key, name: teamName },
    title,
    counts: { personal: counts.personal, projects: projects as ProjectCount[], otherProjects: counts.otherProjects, total: counts.total },
    lastAt,
    spark14: value.spark14 as number[],
    latest,
  };
}

export function parseOverview(value: unknown): OverviewPage | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.tiles) || !Array.isArray(value.agents) || !isRecord(value.storage)) return null;
  const tiles = value.tiles;
  const lastWriteAt = textOrNull(tiles.lastWriteAt);
  if (!isCount(tiles.totalMemories) || !isCount(tiles.writtenToday) || !isCount(tiles.activeAgents7d) || !isCount(tiles.agents) || lastWriteAt === undefined) return null;
  const nextCursor = textOrNull(value.nextCursor);
  if (nextCursor === undefined || !isText(value.storage.status) || !isCount(value.storage.unavailableAgents)) return null;
  const agents = value.agents.map(parseAgent);
  if (agents.includes(null) || (value.complete !== undefined && typeof value.complete !== "boolean")) return null;
  return {
    tiles: { totalMemories: tiles.totalMemories, writtenToday: tiles.writtenToday, activeAgents7d: tiles.activeAgents7d, agents: tiles.agents, lastWriteAt },
    agents: agents as OverviewAgent[],
    nextCursor,
    complete: value.complete !== false,
    unavailableAgents: value.storage.unavailableAgents,
    storageStatus: value.storage.status,
  };
}

export type SortKey = "recent" | "count" | "name";
export const SORT_KEYS: readonly SortKey[] = ["recent", "count", "name"];
export const isSortKey = (value: string): value is SortKey => (SORT_KEYS as readonly string[]).includes(value);

export const TEAM_OPTION_PREFIX = "t:";

export function idTail(id: string): string {
  const tail = id.slice(id.lastIndexOf("/") + 1);
  return tail === "" ? id : tail;
}

// why: without a name table the card still needs a readable title, and the last id segment is the part that tells agents of one team apart
export function displayName(agent: Pick<OverviewAgent, "id" | "name">): string {
  const named = agent.name?.trim();
  return named === undefined || named === "" ? idTail(agent.id) : named;
}

export function projectLabel(project: ProjectCount): string {
  const named = project.name?.trim();
  return named === undefined || named === "" ? t("card.projectFallback", { id: [...project.projectId].slice(0, 8).join("") }) : named;
}

export function sparkSum(agent: OverviewAgent): number {
  return agent.spark14.reduce((sum, value) => sum + value, 0);
}

export function mergeAgents(existing: readonly OverviewAgent[], incoming: readonly OverviewAgent[]): OverviewAgent[] {
  const merged = new Map<string, OverviewAgent>();
  for (const agent of existing) merged.set(agent.id, agent);
  for (const agent of incoming) merged.set(agent.id, agent);
  return [...merged.values()];
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const lastMs = (agent: OverviewAgent): number => parseInstant(agent.lastAt) ?? Number.NEGATIVE_INFINITY;

const COMPARATORS: Readonly<Record<SortKey, (left: OverviewAgent, right: OverviewAgent) => number>> = {
  recent: (left, right) => lastMs(right) - lastMs(left) || compareText(left.id, right.id),
  count: (left, right) => right.counts.total - left.counts.total || compareText(left.id, right.id),
  name: (left, right) => displayName(left).localeCompare(displayName(right), "zh-Hant") || compareText(left.id, right.id),
};

export function sortAgents(agents: readonly OverviewAgent[], sort: SortKey): OverviewAgent[] {
  const compare = COMPARATORS[sort];
  return [...agents].sort((left, right) => {
    const order = compare(left, right);
    return Number.isNaN(order) ? compareText(left.id, right.id) : order;
  });
}

export interface TeamGroup {
  readonly key: string;
  readonly label: string;
  readonly agents: readonly OverviewAgent[];
  readonly total: number;
}

export function teamLabel(key: string, name: string | undefined): string {
  const named = name?.trim();
  if (named !== undefined && named !== "") return named;
  return key === "" ? t("home.team.none") : key;
}

export function buildGroups(agents: readonly OverviewAgent[], sort: SortKey): TeamGroup[] {
  const byKey = new Map<string, OverviewAgent[]>();
  for (const agent of agents) {
    const bucket = byKey.get(agent.team.key);
    if (bucket === undefined) byKey.set(agent.team.key, [agent]);
    else bucket.push(agent);
  }
  const groups = [...byKey.entries()].map(([key, members]) => ({
    key,
    label: teamLabel(key, members.find((member) => (member.team.name?.trim() ?? "") !== "")?.team.name),
    agents: sortAgents(members, sort),
    total: members.reduce((sum, member) => sum + member.counts.total, 0),
  }));
  return groups.sort((left, right) => right.total - left.total || compareText(left.key, right.key));
}

export function hasTeam(agents: readonly OverviewAgent[], key: string): boolean {
  return agents.some((agent) => agent.team.key === key);
}
