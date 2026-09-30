import type { KeysetAnchor } from "../../adapters/ui/cairnReader.js";
import type { UiFailure, UiItem, UiListRequest, UiSearchRequest } from "../../contracts/uiContract.js";
import { collectCandidates, prepareTargets } from "./collect.js";
import { uiFailure, UiResultTooLarge } from "./failures.js";
import { fitPage } from "./paging.js";
import { refNames } from "./names.js";
import { parseQuery } from "./textQuery.js";
import type { Clock } from "./timeSlice.js";
import type { UiServices } from "./uiServices.js";
import { toItem } from "./workItem.js";

type ListingRequest = UiListRequest | UiSearchRequest;

export async function runListing(
  method: "list" | "search",
  request: ListingRequest,
  services: UiServices,
  clock: Clock,
): Promise<Record<string, unknown> | UiFailure> {
  const query = method === "search" ? parseQuery((request as UiSearchRequest).q) : null;
  if (method === "search" && query === null) return uiFailure("INVALID_PARAMS");
  const terms = query?.terms ?? [];
  const cli = request.cli?.normalize("NFKC");
  const filter = {
    method,
    agentId: request.agentId,
    scope: request.scope,
    projectId: request.projectId,
    sinceIso: request.sinceIso,
    untilIso: request.untilIso,
    cli,
    q: query?.normalized,
  };
  let after: KeysetAnchor | undefined;
  if (request.cursor !== undefined) {
    const decoded = services.cursors.decode(filter, request.cursor);
    const [updatedAt, id] = decoded.ok ? decoded.position : [];
    if (!decoded.ok || decoded.position.length !== 2 || updatedAt === undefined || id === undefined) return uiFailure("CURSOR_STALE");
    after = { updatedAt, id };
  }
  const snapshot = await services.index.snapshot(clock);
  if (!snapshot.complete) return uiFailure("RESOURCE_BUSY");
  const collected = await collectCandidates({
    targets: prepareTargets(snapshot.agents, {
      agentId: request.agentId,
      scope: request.scope,
      projectId: request.projectId,
      after,
      updatedFrom: request.sinceIso,
      updatedBefore: request.untilIso,
    }),
    limit: request.limit,
    after,
    updatedFrom: request.sinceIso,
    updatedBefore: request.untilIso,
    terms,
    cli,
    withContent: method === "search",
    clock,
  });
  let page = collected.candidates.slice(0, request.limit);
  let more = collected.candidates.length > request.limit;
  if (collected.timedOut) {
    const horizon = collected.horizon ?? "";
    page = page.filter((candidate) => candidate.row.updatedAt > horizon);
    more = true;
  }
  const items: UiItem[] = page.map((candidate) => {
    const item = toItem(candidate.row, candidate.origin, method === "search" ? terms : undefined);
    return { ...item, names: refNames(services.profile, item.ref) };
  });
  const complete = !collected.timedOut && collected.unavailable === 0 && snapshot.unavailable.length === 0;
  const wrap = (kept: readonly UiItem[], nextCursor: string | null): Record<string, unknown> =>
    method === "search"
      ? {
          ok: true,
          items: kept,
          nextCursor,
          scanned: { namespaces: collected.covered, complete },
          normalizedQuery: query?.normalized ?? "",
          mode: "literal",
        }
      : { ok: true, items: kept, nextCursor };
  const encode = (position: readonly string[]): string => services.cursors.encode(filter, position);
  // why: a timed-out call with nothing final to show moves the cursor up to the horizon, because everything newer was scanned and matched nothing; a horizon that is not older than the incoming cursor cannot move it, and rewinding it would repeat rows already returned
  if (items.length === 0) {
    const horizon = collected.horizon ?? "";
    const resumeAt = after !== undefined && horizon >= after.updatedAt ? after : { updatedAt: horizon, id: "" };
    return wrap([], collected.timedOut ? encode([resumeAt.updatedAt, resumeAt.id]) : null);
  }
  const paged = fitPage({
    items,
    more,
    position: (item) => [item.updatedAt, item.ref.memoryId],
    encode,
    build: wrap,
  });
  if (!paged.ok) throw new UiResultTooLarge();
  return paged.response as Record<string, unknown>;
}
