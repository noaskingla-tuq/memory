import { createHash } from "node:crypto";
import type { UiFailure, UiOverviewRequest } from "../../contracts/uiContract.js";
import { UI_LIMITS } from "../../contracts/uiContract.js";
import type { IndexedAgent } from "./agentIndex.js";
import { binCounts } from "./dayBins.js";
import { uiFailure, UiResultTooLarge } from "./failures.js";
import { compareText } from "./ordering.js";
import { fitPage } from "./paging.js";
import { teamKeyOf } from "./profilePort.js";
import type { Clock } from "./timeSlice.js";
import type { UiServices } from "./uiServices.js";
import { latestSnippet } from "./workItem.js";

const DAY_MS = 86_400_000;
const SPARK_DAYS = 14;
const ACTIVE_DAYS = 7;
const OVERVIEW_FILTER = { method: "overview" };

const digestOf = (teamKey: string, id: string): string => createHash("sha256").update(JSON.stringify([teamKey, id])).digest("hex").slice(0, 32);

interface Card {
  readonly id: string;
  readonly team: { readonly key: string; readonly name?: string };
  readonly [field: string]: unknown;
}

// why: the day bins are 14 consecutive 24 h spans ending at the caller's local midnight plus one day, so the request's dayStartIso alone fixes them and no timezone arithmetic runs here
function dayEdges(dayStartIso: string): number[] {
  const start = Date.parse(dayStartIso);
  return Array.from({ length: SPARK_DAYS + 1 }, (_, step) => start + (step - (SPARK_DAYS - 1)) * DAY_MS);
}

function binsOf(indexed: IndexedAgent, edges: readonly number[]): number[] {
  const bins = new Array<number>(SPARK_DAYS).fill(0);
  for (const namespace of indexed.agent.namespaces) binCounts(namespace.timesMs, edges).forEach((count, index) => (bins[index] = (bins[index] ?? 0) + count));
  return bins;
}

function cardOf(indexed: IndexedAgent, services: UiServices, teamKey: string, bins: readonly number[]): Card {
  const { agent, latest } = indexed;
  const profile = services.profile.agent(agent.agentId);
  const personal = agent.namespaces.find((namespace) => namespace.scope === "personal")?.count ?? 0;
  const projects = agent.namespaces
    .filter((namespace) => namespace.scope === "project")
    .sort((left, right) => right.count - left.count || compareText(left.projectId ?? "", right.projectId ?? ""));
  const shown = projects.slice(0, UI_LIMITS.overviewProjectsMax);
  const lastAt = agent.namespaces.reduce<string | null>((newest, namespace) => (namespace.lastAt !== null && (newest === null || namespace.lastAt > newest) ? namespace.lastAt : newest), null);
  return {
    id: agent.agentId,
    name: profile?.name,
    team: { key: teamKey, name: profile?.teamName },
    title: profile?.title,
    counts: {
      personal,
      projects: shown.map((namespace) => ({
        projectId: namespace.projectId ?? "",
        name: services.profile.projectName(namespace.projectId ?? ""),
        count: namespace.count,
      })),
      otherProjects: projects.slice(UI_LIMITS.overviewProjectsMax).reduce((sum, namespace) => sum + namespace.count, 0),
      total: agent.total,
    },
    lastAt,
    spark14: bins,
    latest: latest === null ? null : { snippet: latestSnippet(latest), at: latest.updatedAt },
  };
}

export async function runOverview(
  request: UiOverviewRequest,
  services: UiServices,
  clock: Clock,
  storageStatus: string,
): Promise<Record<string, unknown> | UiFailure> {
  let position: readonly string[] | undefined;
  if (request.cursor !== undefined) {
    const decoded = services.cursors.decode(OVERVIEW_FILTER, request.cursor);
    if (!decoded.ok || decoded.position.length > 2) return uiFailure("CURSOR_STALE");
    position = decoded.position;
  }
  const snapshot = await services.index.snapshot(clock);
  const edges = dayEdges(request.dayStartIso);
  const entries = snapshot.agents
    .map((indexed) => ({ indexed, teamKey: teamKeyOf(indexed.agent.agentId, services.profile), bins: binsOf(indexed, edges) }))
    .sort((left, right) => compareText(left.teamKey, right.teamKey) || compareText(left.indexed.agent.agentId, right.indexed.agent.agentId));
  let remaining = entries;
  if (position?.length === 2) {
    const [teamKey = "", id = ""] = position;
    remaining = entries.filter((entry) => (compareText(entry.teamKey, teamKey) || compareText(entry.indexed.agent.agentId, id)) > 0);
  } else if (position?.length === 1) {
    // why: a keyset position made of two very long CJK ids would not fit the cursor, so such a page resumes behind the card whose digest it carries
    const at = entries.findIndex((entry) => digestOf(entry.teamKey, entry.indexed.agent.agentId) === position[0]);
    if (at < 0) return uiFailure("CURSOR_STALE");
    remaining = entries.slice(at + 1);
  }
  const cards = remaining.slice(0, request.limit).map((entry) => cardOf(entry.indexed, services, entry.teamKey, entry.bins));
  const total = entries.reduce((sum, entry) => sum + entry.indexed.agent.total, 0);
  const writtenToday = entries.reduce((sum, entry) => sum + (entry.bins[SPARK_DAYS - 1] ?? 0), 0);
  const activeAgents7d = entries.filter((entry) => entry.bins.slice(SPARK_DAYS - ACTIVE_DAYS).some((count) => count > 0)).length;
  const lastWriteAt = entries.reduce<string | null>((newest, entry) => {
    const at = entry.indexed.agent.namespaces.reduce<string | null>((latest, namespace) => (namespace.lastAt !== null && (latest === null || namespace.lastAt > latest) ? namespace.lastAt : latest), null);
    return at !== null && (newest === null || at > newest) ? at : newest;
  }, null);
  const stamp = services.profile.stamp();
  const wrap = (kept: readonly Card[], nextCursor: string | null): Record<string, unknown> => ({
    ok: true,
    tiles: { totalMemories: total, writtenToday, activeAgents7d, agents: entries.length, lastWriteAt },
    agents: kept,
    nextCursor,
    complete: snapshot.complete,
    profile: { generation: stamp.generation, receivedAt: stamp.receivedAt },
    storage: { status: storageStatus, unavailableAgents: snapshot.unavailable.length },
  });
  const paged = fitPage({
    items: cards,
    more: remaining.length > request.limit,
    position: (card) => [card.team.key, card.id],
    encode: (next) => {
      try {
        return services.cursors.encode(OVERVIEW_FILTER, next);
      } catch {
        return services.cursors.encode(OVERVIEW_FILTER, [digestOf(next[0] ?? "", next[1] ?? "")]);
      }
    },
    build: wrap,
  });
  if (!paged.ok) throw new UiResultTooLarge();
  return paged.response as Record<string, unknown>;
}
