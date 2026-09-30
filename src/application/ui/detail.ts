import { openCairn, type CairnSession, type SessionMate, type StoredMemory, type StoredReceipt } from "../../adapters/ui/cairnReader.js";
import { UI_LIMITS, type UiFailure, type UiGetRequest, type UiItem } from "../../contracts/uiContract.js";
import { HEAD_CHARS } from "./agentIndex.js";
import { clipCodePoints } from "./budget.js";
import { readerFailure, uiFailure } from "./failures.js";
import { refNames } from "./names.js";
import { newestFirst } from "./ordering.js";
import { parsePunchContent } from "./punchContent.js";
import type { Clock } from "./timeSlice.js";
import type { UiServices } from "./uiServices.js";
import { refOf, toItem } from "./workItem.js";

// why: receipts.session_id has no index, so the neighbours are found by scanning the receipt table in rowid ranges and yielding between them, and only the newest few matches are kept while scanning
async function neighbours(session: CairnSession, request: UiGetRequest, clock: Clock, chunk: number): Promise<SessionMate[] | UiFailure> {
  const sessions = session.run((reader) => ({ ids: reader.receiptSessions(request.memoryId), top: reader.receiptRowidMax() }));
  if (!sessions.ok) return readerFailure(sessions.code);
  let best: { id: string; updatedAt: string }[] = [];
  for (let low = 0; low < sessions.value.top; low += chunk) {
    await clock.yieldIfDue();
    const found = session.run((reader) => reader.sessionMatches(request.agentId, request.memoryId, sessions.value.ids, low, low + chunk));
    if (!found.ok) return readerFailure(found.code);
    best = [...best, ...found.value].sort(newestFirst).slice(0, UI_LIMITS.sameSessionMax);
  }
  const loaded = session.run((reader) => reader.memoriesById(request.agentId, best.map((entry) => entry.id), HEAD_CHARS));
  return loaded.ok ? loaded.value : readerFailure(loaded.code);
}

export async function runGet(request: UiGetRequest, services: UiServices, clock: Clock): Promise<Record<string, unknown> | UiFailure> {
  const directory = services.index.directoryOf(request.agentId);
  if (directory === undefined || directory.state === "no_database") return uiFailure("NOT_FOUND");
  if (directory.state !== "ready" || directory.databasePath === null) return uiFailure("STORAGE_UNSUPPORTED");
  const namespace = { ownerId: request.agentId, scope: request.scope, projectId: request.projectId };
  const opened = openCairn(directory.databasePath);
  if (!opened.ok) return readerFailure(opened.code);
  let found: { readonly memory: StoredMemory; readonly receipts: StoredReceipt[] } | null;
  let mates: Awaited<ReturnType<typeof neighbours>>;
  try {
    const read = opened.value.run((reader) => reader.get(namespace, request.memoryId, UI_LIMITS.receiptsMax));
    if (!read.ok) return readerFailure(read.code);
    found = read.value;
    if (found === null) return uiFailure("NOT_FOUND");
    mates = await neighbours(opened.value, request, clock, services.receiptChunk);
  } finally {
    opened.value.close();
  }
  if (!Array.isArray(mates)) return mates;
  const parsed = parsePunchContent(found.memory.content);
  const ref = refOf(request, found.memory.id);
  const withNames = (item: UiItem): UiItem => ({ ...item, names: refNames(services.profile, item.ref) });
  return {
    ok: true,
    memory: {
      ref,
      kind: found.memory.kind,
      revision: found.memory.revision,
      createdAt: found.memory.createdAt,
      updatedAt: found.memory.updatedAt,
      content: clipCodePoints(found.memory.content, UI_LIMITS.contentMaxChars),
    },
    ...(parsed.parsed ? { work: parsed.work } : {}),
    names: refNames(services.profile, ref),
    receipts: found.receipts.map(({ client, sessionId, eventId, role, createdAt }) => ({ client, sessionId, eventId, role, createdAt })),
    sameSession: mates.map((mate) => withNames(toItem(mate, { agentId: request.agentId, scope: mate.namespace.scope, projectId: mate.namespace.projectId }))),
  };
}
