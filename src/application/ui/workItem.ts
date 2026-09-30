import type { ScannedMemory } from "../../adapters/ui/cairnReader.js";
import type { MemoryNamespace } from "../../domain/namespace.js";
import { UI_LIMITS, type UiItem, type UiRef } from "../../contracts/uiContract.js";
import { clipCodePoints } from "./budget.js";
import { parsePunchContent } from "./punchContent.js";
import { snippetAround } from "./textQuery.js";

export interface RowOrigin {
  readonly agentId: string;
  readonly scope: "personal" | "project";
  readonly projectId: string | null;
}

export const refOf = (origin: RowOrigin, memoryId: string): UiRef => ({
  agentId: origin.agentId,
  scope: origin.scope,
  projectId: origin.projectId,
  memoryId,
});

// why: a punch record is shown as its result text with the request title beside it as work info, and anything that does not parse falls back to the raw text
export function toItem(row: ScannedMemory, origin: RowOrigin, terms?: readonly string[]): UiItem {
  const parsed = parsePunchContent(row.content ?? row.head);
  const snippet =
    terms === undefined
      ? clipCodePoints(parsed.body, UI_LIMITS.listSnippetChars)
      : snippetAround(parsed.body, terms, UI_LIMITS.listSnippetChars);
  return {
    ref: refOf(origin, row.id),
    kind: row.kind as UiItem["kind"],
    revision: row.revision,
    updatedAt: row.updatedAt,
    snippet,
    ...(parsed.parsed ? { work: parsed.work } : {}),
    receiptCount: row.receiptCount,
  };
}

export function latestSnippet(row: ScannedMemory): string {
  const parsed = parsePunchContent(row.head);
  const text = parsed.parsed ? (parsed.work.title ?? parsed.body) : parsed.body;
  return clipCodePoints(text, UI_LIMITS.overviewSnippetChars);
}

export const namespaceOfOrigin = (origin: RowOrigin): MemoryNamespace => ({
  ownerId: origin.agentId,
  scope: origin.scope,
  projectId: origin.projectId,
});
