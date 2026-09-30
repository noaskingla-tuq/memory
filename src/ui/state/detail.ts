import type { z } from "zod";
import type { UI_LIMITS, UiRef, UiWork, uiGetSuccess } from "../../contracts/uiContract.js";
import { parsePunchContent } from "../../application/ui/punchContent.js";
import { parseItem, parseRef, parseWork, type TimelineItem } from "./timeline.js";

export const RECEIPTS_MAX: (typeof UI_LIMITS)["receiptsMax"] = 12;

export interface DetailReceipt {
  readonly client: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly role: "user" | "assistant";
  readonly createdAt: string;
}

export interface DetailData {
  readonly ref: UiRef;
  readonly kind: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly content: string;
  readonly work?: UiWork | undefined;
  readonly agentName: string | null;
  readonly projectName: string | undefined;
  readonly receipts: readonly DetailReceipt[];
  readonly sameSession: readonly TimelineItem[];
}

// why: the view cannot run zod, so a hand-written parser guards the response and these assertions fail tsc when the contract's get shape drifts away from it
type GetSuccess = z.infer<typeof uiGetSuccess>;
type MemoryMatches = GetSuccess["memory"] extends { ref: UiRef; kind: string; revision: number; createdAt: string; updatedAt: string; content: string } ? true : never;
type ReceiptMatches = GetSuccess["receipts"][number] extends DetailReceipt ? true : never;
type SameSessionMatches = GetSuccess["sameSession"][number] extends Omit<TimelineItem, "projectName"> ? true : never;
type WorkMatches = NonNullable<GetSuccess["work"]> extends UiWork ? true : never;
export const DETAIL_CONTRACT_MATCHES: [MemoryMatches, ReceiptMatches, SameSessionMatches, WorkMatches] = [true, true, true, true];

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

function parseReceipt(value: unknown): DetailReceipt | null {
  if (!isRecord(value) || !isText(value.client) || !isText(value.sessionId) || !isText(value.eventId) || !isText(value.createdAt)) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  return { client: value.client, sessionId: value.sessionId, eventId: value.eventId, role: value.role, createdAt: value.createdAt };
}

function workOf(value: unknown): UiWork | undefined | null {
  return value === undefined ? undefined : parseWork(value);
}

function displayNameOf(names: unknown, key: "agent" | "project"): string | null {
  if (!isRecord(names) || !isRecord(names[key])) return null;
  const { displayName } = names[key] as JsonRecord;
  return isText(displayName) && displayName.trim() !== "" ? displayName : null;
}

export function parseDetail(value: unknown): DetailData | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.memory) || !Array.isArray(value.receipts) || !Array.isArray(value.sameSession)) return null;
  const { memory } = value;
  const ref = parseRef(memory.ref);
  if (ref === null || !isText(memory.kind) || !isRevision(memory.revision) || !isText(memory.createdAt) || !isText(memory.updatedAt) || !isText(memory.content)) return null;
  const work = workOf(value.work);
  if (work === null) return null;
  const receipts = value.receipts.map(parseReceipt);
  const sameSession = value.sameSession.map(parseItem);
  if (receipts.includes(null) || sameSession.includes(null)) return null;
  return {
    ref,
    kind: memory.kind,
    revision: memory.revision,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    content: memory.content,
    work,
    agentName: displayNameOf(value.names, "agent"),
    projectName: displayNameOf(value.names, "project") ?? undefined,
    receipts: receipts as DetailReceipt[],
    sameSession: sameSession as TimelineItem[],
  };
}

export function asItem(data: DetailData): TimelineItem {
  return { ref: data.ref, kind: data.kind, revision: data.revision, updatedAt: data.updatedAt, snippet: "", work: data.work, receiptCount: data.receipts.length, projectName: data.projectName };
}

export interface DetailText {
  readonly request: string | null;
  readonly result: string;
  readonly isWork: boolean;
}

// why: the request and the result of a work record come from the one parser that owns the prefix format, so the drawer never guesses where the request ends
export function detailText(data: DetailData): DetailText {
  const parsed = parsePunchContent(data.content);
  if (!parsed.parsed) return { request: null, result: data.content, isWork: false };
  const title = data.work?.title ?? parsed.work.title;
  return { request: title === null || title === undefined || title.trim() === "" ? null : title, result: parsed.body, isWork: true };
}

// why: after a forget the focus goes to the memory that takes its place (next, else previous); a forgotten memory that is not in the list leaves the card that opened the drawer as the place to return to
export function focusCandidates(keys: readonly string[], forgotten: string, origin: string | null): string[] {
  const at = keys.indexOf(forgotten);
  if (at === -1) return origin === null ? [] : [origin];
  return [keys[at + 1], keys[at - 1]].filter((key): key is string => key !== undefined);
}

