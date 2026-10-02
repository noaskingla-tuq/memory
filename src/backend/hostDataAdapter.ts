import type { PluginHostApiV1 } from "@teamuq/plugin-sdk/external";
import { PUNCH_RECEIPT_NAMESPACE } from "../application/punchCatchup.js";
import type { PunchFeedPort, PunchReceiptStorePort, LegacyPunchStatePort, SettledPunch } from "../application/punchDataPorts.js";
import type { DirectoryAgent, DirectoryProject, DirectorySnapshot, ProfileDirectoryPort } from "../application/profileSource.js";

export const LEGACY_PUNCH_RECEIPT_NAMESPACE = "legacy-punch-write";

function toPunch(record: Awaited<ReturnType<PluginHostApiV1["workRecords"]["readSettledPage"]>>["records"][number]): SettledPunch {
  return {
    id: record.punchId,
    agentId: record.agentId,
    projectId: record.projectId,
    sessionId: record.sessionId,
    providerId: record.providerId,
    punchType: record.punchType,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    model: record.model,
    name: record.name,
    description: record.description,
  };
}

export function createPunchFeed(host: PluginHostApiV1): PunchFeedPort {
  return {
    openSettledSnapshot: () => host.workRecords.openSettledSnapshot(),
    async readSettledPage(input) {
      const page = await host.workRecords.readSettledPage(input);
      return { snapshot: page.snapshot, records: page.records.map(toPunch), nextCursor: page.nextCursor };
    },
    subscribeSettledChanges(listener) {
      return host.workRecords.subscribeSettledChanges(() => listener());
    },
  };
}

export function createPunchReceiptStore(host: PluginHostApiV1): PunchReceiptStorePort {
  return {
    async readPage(cursor, limit) {
      return host.pluginState.readPage(PUNCH_RECEIPT_NAMESPACE, cursor, limit);
    },
    async writeBatch(records) {
      await host.pluginState.writeBatch(PUNCH_RECEIPT_NAMESPACE, records);
    },
  };
}

export function createLegacyPunchState(host: PluginHostApiV1): LegacyPunchStatePort {
  return {
    async readPage(cursor, limit) {
      return host.pluginState.readPage(LEGACY_PUNCH_RECEIPT_NAMESPACE, cursor, limit);
    },
    async deleteBatch(keys) {
      await host.pluginState.deleteBatch(LEGACY_PUNCH_RECEIPT_NAMESPACE, keys);
    },
  };
}

async function readDirectoryPages<TEntry, T>(options: {
  readonly open: () => Promise<{ snapshotId: string; generation: string; highWatermark: string | null }>;
  readonly read: (request: { snapshotId: string; cursor: string | null; limit: number }) => Promise<{
    snapshot: { snapshotId: string; generation: string; highWatermark: string | null };
    entries: readonly TEntry[];
    nextCursor: string | null;
  }>;
  readonly select: (entry: TEntry) => T | null;
}): Promise<DirectorySnapshot<T>> {
  const snapshot = await options.open();
  const entries: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await options.read({ snapshotId: snapshot.snapshotId, cursor, limit: 100 });
    if (page.snapshot.snapshotId !== snapshot.snapshotId || page.snapshot.generation !== snapshot.generation) throw new Error("directory_snapshot_changed");
    for (const entry of page.entries) {
      const selected = options.select(entry);
      if (selected !== null) entries.push(selected);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { generation: snapshot.generation, entries };
}

export function createProfileDirectory(host: PluginHostApiV1): ProfileDirectoryPort {
  return {
    readAgents: () => readDirectoryPages<Awaited<ReturnType<PluginHostApiV1["agentDirectory"]["readPage"]>>["entries"][number], DirectoryAgent>({
      open: () => host.agentDirectory.openSnapshot(),
      read: (request) => host.agentDirectory.readPage(request),
      select: (entry) => "teamKey" in entry
        ? { id: entry.id, name: entry.name, teamKey: entry.teamKey, teamName: entry.teamName, title: entry.title, enabled: entry.enabled }
        : null,
    }),
    readProjects: () => readDirectoryPages<Awaited<ReturnType<PluginHostApiV1["projectDirectory"]["readPage"]>>["entries"][number], DirectoryProject>({
      open: () => host.projectDirectory.openSnapshot(),
      read: (request) => host.projectDirectory.readPage(request),
      select: (entry) => ({ id: entry.id, name: entry.name, archived: entry.archived }),
    }),
  };
}
