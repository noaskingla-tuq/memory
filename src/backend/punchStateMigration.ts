import type { PluginHostApiV1 } from "@teamuq/plugin-sdk/external";
import type { PunchReceiptStorePort, PunchStateRecord } from "../application/punchDataPorts.js";
import { PUNCH_RECEIPT_NAMESPACE } from "../application/punchCatchup.js";
import { LEGACY_PUNCH_RECEIPT_NAMESPACE } from "./hostDataAdapter.js";

const retired = (error: unknown): boolean => error !== null && typeof error === "object" && (error as { code?: string }).code === "plugin_state_retired";

export function createMigratingPunchReceiptStore(host: PluginHostApiV1, local: PunchReceiptStorePort): PunchReceiptStorePort {
  let migration: Promise<void> | undefined;
  const migrate = async (): Promise<void> => {
    const existing = new Map<string, PunchStateRecord>();
    let cursor: string | null = null;
    do {
      const page = await local.readPage(cursor, 100);
      for (const row of page.records) existing.set(row.key, row);
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (existing.has("host-migration.v1")) return;
    for (const namespace of [PUNCH_RECEIPT_NAMESPACE, LEGACY_PUNCH_RECEIPT_NAMESPACE]) {
      cursor = null;
      const seen = new Set<string>();
      do {
        let page;
        try { page = await host.pluginState.readPage(namespace, cursor, 100); }
        catch (error) { if (retired(error)) break; throw error; }
        const writes: PunchStateRecord[] = [];
        for (const row of page.records) {
          const value = row.value as Record<string, unknown> | null;
          let imported: unknown = row.value;
          if (row.key === "checkpoint.v1" && (value?.version !== 1 || !Number.isSafeInteger(value.sinceMs) || Number(value.sinceMs) < 0)) throw new Error("legacy_checkpoint_invalid");
          if (row.key !== "checkpoint.v1") {
            if (value === null || typeof value !== "object") throw new Error("legacy_receipt_invalid");
            const take = (camel: string, snake: string): unknown => value[camel] ?? value[snake];
            imported = { state: value.state, punchId: take("punchId", "punch_id"), agentId: take("agentId", "agent_id"), scope: value.scope,
              projectId: value.projectId !== undefined ? value.projectId : value.project_id,
              writtenAt: take("writtenAt", "written_at"),
              ...(value.state === "written" ? { memoryId: take("memoryId", "memory_id"), contentSha256: take("contentSha256", "content_sha256") } : { reason: value.reason }) };
            const receipt = imported as Record<string, unknown>;
            if (receipt.punchId !== row.key || typeof receipt.agentId !== "string" || !["personal", "project"].includes(String(receipt.scope)) || (receipt.projectId !== null && typeof receipt.projectId !== "string") || !Number.isSafeInteger(receipt.writtenAt)
              || (receipt.state === "written" ? typeof receipt.memoryId !== "string" || typeof receipt.contentSha256 !== "string" : receipt.state !== "skipped" || typeof receipt.reason !== "string")) throw new Error("legacy_receipt_invalid");
          }
          const current = existing.get(row.key);
          if (current !== undefined) {
            if (row.key !== "checkpoint.v1" && Object.entries(imported as Record<string, unknown>).some(([key, value]) => JSON.stringify((current.value as Record<string, unknown>)[key]) !== JSON.stringify(value))) throw new Error("legacy_receipt_conflict");
            continue;
          }
          writes.push({ key: row.key, value: imported, expectedRevision: null, sourceKind: row.sourceKind, sourceId: row.sourceId });
        }
        if (writes.length > 0) await local.writeBatch(writes);
        for (const row of writes) existing.set(row.key, row);
        cursor = page.nextCursor;
        if (cursor !== null && seen.has(cursor)) throw new Error("legacy_cursor_repeated");
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null);
    }
    await local.writeBatch([{ key: "host-migration.v1", value: { version: 1 }, expectedRevision: null }]);
  };
  const ensure = (): Promise<void> => migration ??= migrate().catch((error) => { migration = undefined; throw error; });
  return {
    async readPage(cursor, limit) { await ensure(); return local.readPage(cursor, limit); },
    async writeBatch(rows) { await ensure(); await local.writeBatch(rows); },
  };
}
