import { CAIRN_COMMIT } from "../../adapters/storage/dataLayout.js";
import type { UiStatus } from "../../contracts/uiContract.js";
import type { ProfilePort } from "./profilePort.js";
import type { Clock } from "./timeSlice.js";
import type { UiServices } from "./uiServices.js";

export interface StatusFacts {
  readonly version: string;
  readonly storageStatus: string;
  readonly uptimeSec: number;
  readonly profile: ProfilePort;
}

async function lastWriteOf(services: UiServices, clock: Clock): Promise<string | null> {
  try {
    const snapshot = await services.index.snapshot(clock);
    let newest: string | null = null;
    for (const { agent } of snapshot.agents) {
      for (const namespace of agent.namespaces) {
        if (namespace.lastAt !== null && (newest === null || namespace.lastAt > newest)) newest = namespace.lastAt;
      }
    }
    return newest;
  } catch {
    return null;
  }
}

export async function runStatus(services: UiServices | undefined, clock: Clock, facts: StatusFacts): Promise<UiStatus> {
  const { profile } = facts;
  const stamp = profile.stamp();
  const counts = profile.counts();
  const health = profile.health();
  return {
    ok: true,
    version: facts.version,
    cairnCommit: CAIRN_COMMIT,
    storage: { status: facts.storageStatus },
    profile: {
      generation: stamp.generation,
      receivedAt: stamp.receivedAt,
      agents: counts.agents,
      projects: counts.projects,
      teams: counts.teams,
      incomplete: health.incomplete,
      corrupt: health.corrupt,
      omitted: health.omitted,
      sink: profile.sink(),
      sinkReceivedAt: profile.sinkReceivedAt(),
    },
    lastWriteAt: services === undefined ? null : await lastWriteOf(services, clock),
    uptimeSec: facts.uptimeSec,
  };
}
