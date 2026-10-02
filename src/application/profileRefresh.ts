import type { MemoryProfileSyncRequest, MemoryProfileSyncResponse } from "../../vendor/teamuq-contract/contract.mjs";
import { readMemoryProfile, type ProfileDirectoryPort } from "./profileSource.js";
import { planProfileSync } from "./profileSyncPlan.js";

export interface ProfileRefreshPort {
  accept(request: MemoryProfileSyncRequest): MemoryProfileSyncResponse;
}

export type ProfileRefreshResult =
  | { readonly kind: "synced"; readonly generation: string; readonly parts: number; readonly omitted: ReturnType<typeof planProfileSync>["omitted"] }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "rejected"; readonly generation: string; readonly part: number; readonly code: string };

export async function refreshMemoryProfile(input: {
  readonly directory: ProfileDirectoryPort;
  readonly sink: ProfileRefreshPort;
  readonly sinkStatus?: () => { readonly pending: number; readonly lastWrittenAtMs: number | null } | null;
}): Promise<ProfileRefreshResult> {
  const source = await readMemoryProfile(input.directory);
  if (source.kind !== "available") return source;
  const plan = planProfileSync({ ...source.snapshot, sink: input.sinkStatus?.() ?? null });
  for (const part of plan.parts) {
    let response: MemoryProfileSyncResponse;
    try {
      response = input.sink.accept(part);
    } catch {
      return { kind: "rejected", generation: plan.generation, part: part.part, code: "profile_sync_failed" };
    }
    if (!response.accepted || response.generation !== plan.generation) {
      return { kind: "rejected", generation: plan.generation, part: part.part, code: "profile_sync_rejected" };
    }
    if (part.part === plan.parts.length && !response.complete) {
      return { kind: "rejected", generation: plan.generation, part: part.part, code: "profile_sync_incomplete" };
    }
  }
  return { kind: "synced", generation: plan.generation, parts: plan.parts.length, omitted: plan.omitted };
}
