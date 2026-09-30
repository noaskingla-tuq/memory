import { createHash } from "node:crypto";
import type { AgentDirectory, AgentDirectoryPort } from "../../application/ports.js";
import { readCairn, type CairnReaderFailure } from "./cairnReader.js";

export interface CatalogNamespace {
  readonly scope: "personal" | "project";
  readonly projectId: string | null;
  readonly count: number;
}

export interface CatalogAgent {
  readonly agentId: string;
  readonly agentHash: string;
  readonly databasePath: string;
  readonly namespaces: readonly CatalogNamespace[];
  readonly total: number;
}

export type UnavailableReason =
  | CairnReaderFailure
  | "identity_mismatch"
  | "owner_conflict";

export interface UnavailableAgent {
  readonly agentHash: string;
  readonly reason: UnavailableReason;
}

export type AgentSummary =
  | { readonly kind: "agent"; readonly agent: CatalogAgent }
  | { readonly kind: "empty" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason };

export interface AgentCatalog {
  readonly agents: readonly CatalogAgent[];
  readonly unavailable: readonly UnavailableAgent[];
}

// why: the raw agentId exists only as owner_id inside the database, and the directory name is its sha256, so a mismatch means the file was moved or copied under the wrong agent
export function summarizeAgent(directory: AgentDirectory): AgentSummary {
  if (directory.state === "no_database") return { kind: "empty" };
  if (directory.state === "unsafe") return { kind: "unavailable", reason: "unsafe_path" };
  if (directory.state === "unreadable" || directory.databasePath === null) return { kind: "unavailable", reason: "unreadable" };
  const databasePath = directory.databasePath;
  const read = readCairn(databasePath, (reader) => reader.namespaces());
  if (!read.ok) return { kind: "unavailable", reason: read.code };
  const owners = new Set(read.value.map((row) => row.ownerId));
  if (owners.size > 1) return { kind: "unavailable", reason: "owner_conflict" };
  const namespaces = read.value.filter((row) => row.count > 0);
  if (namespaces.length === 0) return { kind: "empty" };
  const agentId = namespaces[0]?.ownerId ?? "";
  if (createHash("sha256").update(agentId).digest("hex") !== directory.agentHash) {
    return { kind: "unavailable", reason: "identity_mismatch" };
  }
  return {
    kind: "agent",
    agent: {
      agentId,
      agentHash: directory.agentHash,
      databasePath,
      namespaces: namespaces.map(({ scope, projectId, count }) => ({ scope, projectId, count })),
      total: namespaces.reduce((sum, row) => sum + row.count, 0),
    },
  };
}

export function listAgents(layout: AgentDirectoryPort): AgentCatalog {
  const agents: CatalogAgent[] = [];
  const unavailable: UnavailableAgent[] = [];
  for (const directory of layout.listAgentDirectories()) {
    const summary = summarizeAgent(directory);
    if (summary.kind === "agent") agents.push(summary.agent);
    else if (summary.kind === "unavailable") unavailable.push({ agentHash: directory.agentHash, reason: summary.reason });
  }
  return { agents, unavailable };
}
