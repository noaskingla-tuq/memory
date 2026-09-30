import { openCairn, type CairnSession, type KeysetAnchor, type ReaderResult, type ScannedMemory } from "../../adapters/ui/cairnReader.js";
import type { CatalogNamespace } from "../../adapters/ui/agentCatalog.js";
import { HEAD_CHARS, type IndexedAgent } from "./agentIndex.js";
import { firstAtMost } from "./dayBins.js";
import { compareText, newestFirst } from "./ordering.js";
import type { Clock } from "./timeSlice.js";
import { namespaceOfOrigin, type RowOrigin } from "./workItem.js";

export interface ScanTarget {
  readonly agent: IndexedAgent;
  readonly namespace: CatalogNamespace;
  readonly head: string;
}

export interface TargetFilter {
  readonly agentId: string | undefined;
  readonly scope: "personal" | "project" | undefined;
  readonly projectId: string | undefined;
  readonly after: KeysetAnchor | undefined;
  readonly updatedFrom: string | undefined;
  readonly updatedBefore: string | undefined;
}

export interface Candidate {
  readonly row: ScannedMemory;
  readonly origin: RowOrigin;
}

export interface CollectRequest {
  readonly targets: readonly ScanTarget[];
  readonly limit: number;
  readonly after: KeysetAnchor | undefined;
  readonly updatedFrom: string | undefined;
  readonly updatedBefore: string | undefined;
  readonly terms: readonly string[];
  readonly cli: string | undefined;
  readonly withContent: boolean;
  readonly clock: Clock;
}

export interface Collected {
  readonly candidates: Candidate[];
  readonly horizon: string | null;
  readonly timedOut: boolean;
  readonly unavailable: number;
  readonly covered: number;
}

// why: each namespace's head is the time of its newest row that is still behind the cursor and inside the window, taken from the cached update-time series, so a page far down a timeline starts with the namespaces that really have rows there and skips the rest without opening them
export function prepareTargets(agents: readonly IndexedAgent[], filter: TargetFilter): ScanTarget[] {
  const upper = Math.min(
    filter.after === undefined ? Number.POSITIVE_INFINITY : Date.parse(filter.after.updatedAt),
    filter.updatedBefore === undefined ? Number.POSITIVE_INFINITY : Date.parse(filter.updatedBefore) - 1,
  );
  const lower = filter.updatedFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(filter.updatedFrom);
  const found: (ScanTarget & { readonly headMs: number })[] = [];
  for (const agent of agents) {
    if (filter.agentId !== undefined && agent.agent.agentId !== filter.agentId) continue;
    for (const namespace of agent.agent.namespaces) {
      if (filter.scope !== undefined && namespace.scope !== filter.scope) continue;
      if (filter.projectId !== undefined && namespace.projectId !== filter.projectId) continue;
      const headMs = namespace.timesMs[firstAtMost(namespace.timesMs, upper)];
      if (headMs === undefined || headMs < lower) continue;
      found.push({ agent, namespace, headMs, head: new Date(headMs).toISOString() });
    }
  }
  return found.sort(
    (left, right) =>
      right.headMs - left.headMs ||
      compareText(left.agent.agent.agentId, right.agent.agent.agentId) ||
      compareText(left.namespace.scope, right.namespace.scope) ||
      compareText(left.namespace.projectId ?? "", right.namespace.projectId ?? ""),
  );
}

const MAX_OPEN_DATABASES = 64;

// why: opening a Cairn database costs a few milliseconds of schema loading, so a call keeps the databases it has opened (idle, no statement running, so writers are never blocked) and closes them all when it ends, however it ends
export async function collectCandidates(request: CollectRequest): Promise<Collected> {
  const open = new Map<string, CairnSession>();
  try {
    return await collectWith(request, open);
  } finally {
    for (const session of open.values()) session.close();
  }
}

function sessionFor(open: Map<string, CairnSession>, path: string): ReaderResult<CairnSession> {
  const known = open.get(path);
  if (known !== undefined) return { ok: true, value: known };
  if (open.size >= MAX_OPEN_DATABASES) {
    const [oldestPath, oldest] = open.entries().next().value ?? [];
    if (oldestPath !== undefined && oldest !== undefined) {
      oldest.close();
      open.delete(oldestPath);
    }
  }
  const opened = openCairn(path);
  if (opened.ok) open.set(path, opened.value);
  return opened;
}

// why: namespaces run newest head first, so anything newer than the next unvisited namespace's head is final; when time runs out the page keeps only that final part and the cursor resumes exactly behind it
async function collectWith(request: CollectRequest, open: Map<string, CairnSession>): Promise<Collected> {
  const { limit, clock } = request;
  const need = limit + 1;
  const kept: Candidate[] = [];
  const absorb = (rows: readonly ScannedMemory[], origin: RowOrigin): void => {
    for (const row of rows) kept.push({ row, origin });
    kept.sort((left, right) => newestFirst(left.row, right.row));
    kept.length = Math.min(kept.length, need);
  };
  let unavailable = 0;
  for (let index = 0; index < request.targets.length; index += 1) {
    const target = request.targets[index];
    if (target === undefined) break;
    const { namespace } = target;
    const worst = kept.length >= need ? kept[need - 1] : undefined;
    if (worst !== undefined && target.head < worst.row.updatedAt) break;
    if (clock.timeUp()) return { candidates: kept, horizon: target.head, timedOut: true, unavailable, covered: index };
    const origin: RowOrigin = { agentId: target.agent.agent.agentId, scope: namespace.scope, projectId: namespace.projectId };
    let anchor = request.after;
    for (;;) {
      await clock.yieldIfDue();
      const session = sessionFor(open, target.agent.path);
      const read = session.ok ? session.value.run((reader) =>
        reader.scan(namespaceOfOrigin(origin), {
          want: need,
          headChars: HEAD_CHARS,
          withContent: request.withContent,
          terms: request.terms,
          stop: () => clock.sliceExpired(),
          ...(anchor === undefined ? {} : { after: anchor }),
          ...(request.updatedFrom === undefined ? {} : { updatedFrom: request.updatedFrom }),
          ...(request.updatedBefore === undefined ? {} : { updatedBefore: request.updatedBefore }),
          ...(request.cli === undefined ? {} : { cli: request.cli }),
        }),
      ) : session;
      if (!read.ok) {
        unavailable += 1;
        open.get(target.agent.path)?.close();
        open.delete(target.agent.path);
        break;
      }
      absorb(read.value.rows, origin);
      if (read.value.resume === null) break;
      anchor = read.value.resume;
      if (clock.timeUp()) {
        const next = request.targets[index + 1]?.head ?? "";
        return { candidates: kept, horizon: next > anchor.updatedAt ? next : anchor.updatedAt, timedOut: true, unavailable, covered: index };
      }
    }
  }
  return { candidates: kept, horizon: null, timedOut: false, unavailable, covered: request.targets.length };
}
