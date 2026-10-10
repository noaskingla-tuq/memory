import type { PluginHostApiV1 } from "@teamuq/plugin-sdk/external";
import { PUNCH_RECEIPT_NAMESPACE } from "../application/punchCatchup.js";
import type { PunchFeedPort, PunchReceiptStorePort, LegacyPunchStatePort, SettledPunch } from "../application/punchDataPorts.js";
import type { DirectoryAgent, DirectoryProject, DirectorySnapshot, ProfileDirectoryPort } from "../application/profileSource.js";

export const LEGACY_PUNCH_RECEIPT_NAMESPACE = "legacy-punch-write";

function toPunch(record: Awaited<ReturnType<PluginHostApiV1["workRecords"]["readPage"]>>["records"][number]): SettledPunch {
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
  let firstPage: Awaited<ReturnType<PluginHostApiV1["workRecords"]["readPage"]>> | undefined;
  let snapshot: NonNullable<typeof firstPage>["snapshot"] | undefined;
  return {
    async openSettledSnapshot() {
      firstPage = await host.workRecords.readPage({ cursor: null, limit: 100 });
      snapshot = firstPage.snapshot;
      return firstPage.snapshot;
    },
    async readSettledPage(input) {
      const cached = input.cursor === null && input.limit === 100 && firstPage?.snapshot.snapshotId === input.snapshotId ? firstPage : undefined;
      firstPage = undefined;
      const page = cached ?? await host.workRecords.readPage(input);
      if (page.snapshot.snapshotId !== input.snapshotId || snapshot?.snapshotId !== input.snapshotId || page.snapshot.generation !== snapshot.generation || page.snapshot.highWatermark !== snapshot.highWatermark) throw new Error("work_record_snapshot_changed");
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
  readonly read: (request: { snapshotId?: string; cursor: string | null; limit: number }) => Promise<{
    snapshot: { snapshotId: string; generation: string; highWatermark: string | null };
    entries: readonly TEntry[];
    nextCursor: string | null;
  }>;
  readonly select: (entry: TEntry) => T | null;
}): Promise<DirectorySnapshot<T>> {
  let snapshot: { snapshotId: string; generation: string; highWatermark: string | null } | undefined;
  const entries: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await options.read({ ...(snapshot === undefined ? {} : { snapshotId: snapshot.snapshotId }), cursor, limit: 100 });
    snapshot ??= page.snapshot;
    if (page.snapshot.snapshotId !== snapshot.snapshotId || page.snapshot.generation !== snapshot.generation || page.snapshot.highWatermark !== snapshot.highWatermark) throw new Error("directory_snapshot_changed");
    for (const entry of page.entries) {
      const selected = options.select(entry);
      if (selected !== null) entries.push(selected);
    }
    cursor = page.nextCursor;
    if (cursor !== null && seen.has(cursor)) throw new Error("directory_cursor_repeated");
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return { generation: snapshot.generation, entries };
}

export function createProfileDirectory(host: PluginHostApiV1): ProfileDirectoryPort {
  return {
    readAgents: () => readDirectoryPages<Awaited<ReturnType<PluginHostApiV1["agentDirectory"]["readPage"]>>["entries"][number], DirectoryAgent>({
      read: (request) => host.agentDirectory.readPage(request),
      select: (entry) => "teamKey" in entry
        ? { id: entry.id, name: entry.name, teamKey: entry.teamKey, teamName: entry.teamName, title: entry.title, enabled: entry.enabled }
        : null,
    }),
    readProjects: () => readDirectoryPages<Awaited<ReturnType<PluginHostApiV1["projectDirectory"]["readPage"]>>["entries"][number], DirectoryProject>({
      read: (request) => host.projectDirectory.readPage(request),
      select: (entry) => ({ id: entry.id, name: entry.name, archived: entry.archived }),
    }),
  };
}
