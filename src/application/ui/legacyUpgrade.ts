import type { UiFailure, UiUpgradeLegacyRequest } from "../../contracts/uiContract.js";
import { MemoryServiceError } from "../../domain/errors.js";
import type { UnavailableAgent } from "../../adapters/ui/agentCatalog.js";
import { uiFailure } from "./failures.js";
import type { Clock } from "./timeSlice.js";
import type { UiServices } from "./uiServices.js";

type FailureCode = UiFailure["code"];

interface Outcome {
  readonly agentHash: string;
  readonly ok: boolean;
  readonly code?: FailureCode;
}

// why: only a file that the reader rejected as unsupported_schema can be a legacy database, and the layout then confirms the header, the identity and the accepted commit before it counts
export function legacyCandidates(services: UiServices, unavailable: readonly UnavailableAgent[]): readonly string[] {
  const legacy = services.legacy;
  if (legacy === undefined) return [];
  return unavailable.filter((entry) => entry.reason === "unsupported_schema" && legacy.legacyCandidate(entry.agentHash)).map((entry) => entry.agentHash);
}

// why: a failed backup is STORAGE_BUSY and nothing else is told apart, because the view only needs to know whether waiting and retrying can help
function failureCode(error: unknown): FailureCode {
  if (error instanceof MemoryServiceError) {
    if (error.code === "STORAGE_BUSY" || error.code === "RESOURCE_BUSY") return error.code;
    return "STORAGE_UNSUPPORTED";
  }
  return "STORAGE_BUSY";
}

export async function runUpgradeLegacy(request: UiUpgradeLegacyRequest, services: UiServices, clock: Clock): Promise<Record<string, unknown> | UiFailure> {
  const legacy = services.legacy;
  if (legacy === undefined) return uiFailure("STORAGE_UNSUPPORTED");
  const skipped = new Set(request.skip);
  const pending = legacyCandidates(services, (await services.index.snapshot(clock)).unavailable).filter((hash) => !skipped.has(hash));
  const batch = pending.slice(0, request.limit);
  const results: Outcome[] = [];
  for (const agentHash of batch) {
    if (clock.timeUp()) break;
    await clock.yieldNow();
    try {
      legacy.upgradeLegacy(agentHash);
      results.push({ agentHash, ok: true });
    } catch (error) {
      results.push({ agentHash, ok: false, code: failureCode(error) });
    } finally {
      services.index.markDirtyHash(agentHash);
    }
  }
  const upgraded = results.filter((result) => result.ok).length;
  return { ok: true, upgraded, failed: results.length - upgraded, results, remaining: pending.length - results.length };
}
