import { UI_METHOD_NAMES, parseUiParams, type UiFailure, type UiForgetRequest, type UiMethodName } from "../contracts/uiContract.js";
import { runAgentStats } from "../application/ui/agentStats.js";
import { serializedBytes, UI_RESPONSE_BUDGET_BYTES } from "../application/ui/budget.js";
import { runGet } from "../application/ui/detail.js";
import { UiResultTooLarge, uiFailure } from "../application/ui/failures.js";
import { runForget } from "../application/ui/forget.js";
import { jsonSafe } from "../application/ui/jsonSafe.js";
import { runListing } from "../application/ui/listing.js";
import { runOverview } from "../application/ui/overview.js";
import { runStatus } from "../application/ui/status.js";
import { createClock } from "../application/ui/timeSlice.js";
import type { ProfilePort } from "../application/ui/profilePort.js";
import type { UiServices } from "../application/ui/uiServices.js";
import { MemoryServiceError } from "../domain/errors.js";
import { callError } from "./contractErrors.js";
import { PLUGIN_VERSION } from "./diagnose.js";
import type { OrganizationStatus } from "../application/punchOrganization.js";

export interface UiDispatchDeps {
  readonly storageStatus: () => string;
  readonly services: () => UiServices | undefined;
  readonly profile: ProfilePort;
  readonly organizationStatus?: () => OrganizationStatus;
  readonly onForgotten?: (agentId: string, memoryId: string) => Promise<void>;
}

export function isUiMethod(method: unknown): method is UiMethodName {
  return typeof method === "string" && (UI_METHOD_NAMES as readonly string[]).includes(method);
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storageFailure(status: string): UiFailure {
  return uiFailure(status === "storage_unsupported" || status === "storage_unsafe" ? "STORAGE_UNSUPPORTED" : "STORAGE_BUSY");
}

async function run(method: UiMethodName, params: unknown, deps: UiDispatchDeps, services: UiServices | undefined): Promise<unknown> {
  const clock = services?.newClock() ?? createClock();
  // why: calls that arrive in the same loop turn would otherwise all start their first slice back to back, so each call first waits for its own turn
  await clock.yieldNow();
  if (method === "ui.status") {
    return runStatus(services, clock, { version: PLUGIN_VERSION, storageStatus: deps.storageStatus(), uptimeSec: Math.round(process.uptime()), profile: deps.profile, ...(deps.organizationStatus === undefined ? {} : { organization: deps.organizationStatus() }) });
  }
  if (services === undefined) return storageFailure(deps.storageStatus());
  const request = params as never;
  switch (method) {
    case "ui.overview":
      return runOverview(request, services, clock, deps.storageStatus());
    case "ui.agentStats":
      return runAgentStats(request, services, clock);
    case "ui.list":
      return runListing("list", request, services, clock);
    case "ui.search":
      return runListing("search", request, services, clock);
    case "ui.get":
      return runGet(request, services, clock);
    case "ui.forget": {
      const result = await runForget(request, services);
      if (result.ok) {
        const ref = params as UiForgetRequest;
        try { await deps.onForgotten?.(ref.agentId, ref.memoryId); }
        catch { throw new MemoryServiceError("STORAGE_BUSY", "Organization source cleanup is pending"); }
      }
      return result;
    }
  }
}

// why: an unexpected exception must not reach the view as a bare rejection, but a MemoryServiceError raised while opening the layout is an expected storage state and maps to its failure code
export async function dispatchUi(method: UiMethodName, params: unknown, deps: UiDispatchDeps): Promise<unknown> {
  if (!isPlainObject(params)) return jsonSafe(uiFailure("INVALID_PARAMS"));
  const parsed = parseUiParams(method, params);
  if (!parsed.ok) return jsonSafe(uiFailure("INVALID_PARAMS"));
  let result: unknown;
  try {
    result = await run(method, parsed.value, deps, deps.services());
  } catch (error) {
    if (error instanceof UiResultTooLarge) throw callError("result_too_large", "A ui answer cannot fit the response budget");
    if (error instanceof MemoryServiceError) return jsonSafe(storageFailure(error.code.toLowerCase()));
    throw error;
  }
  const safe = jsonSafe(result);
  if (serializedBytes(safe) > UI_RESPONSE_BUDGET_BYTES) throw callError("result_too_large", "A ui answer exceeds the response budget");
  return safe;
}
