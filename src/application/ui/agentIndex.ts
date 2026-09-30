import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  interpretNamespaces,
  readableDatabase,
  type AgentSummary,
  type CatalogAgent,
  type UnavailableAgent,
} from "../../adapters/ui/agentCatalog.js";
import { readCairn, type ScannedMemory } from "../../adapters/ui/cairnReader.js";
import type { AgentDirectory, AgentDirectoryPort } from "../ports.js";
import { compareText } from "./ordering.js";
import type { Clock } from "./timeSlice.js";

export const HEAD_CHARS = 640;
const LISTING_MAX_AGE_MS = 30_000;

export interface IndexedAgent {
  readonly agent: CatalogAgent;
  readonly path: string;
  readonly version: string;
  readonly latest: ScannedMemory | null;
}

export interface IndexSnapshot {
  readonly agents: IndexedAgent[];
  readonly unavailable: UnavailableAgent[];
  readonly complete: boolean;
}

export type AgentLookup =
  | { readonly kind: "found"; readonly indexed: IndexedAgent }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableAgent["reason"] };

interface Entry {
  readonly key: string;
  readonly gen: number;
  readonly summary: AgentSummary;
  readonly latest: ScannedMemory | null;
}

interface Listing {
  readonly fingerprint: string;
  readonly at: number;
  readonly directories: readonly AgentDirectory[];
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function statKey(path: string | null): string {
  if (path === null) return "none";
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "gone";
  }
}

// why: an entry stays valid only while nobody in this process wrote to the agent (dirty generation, the primary signal) and the database file is unchanged (mtime and size, the second layer for writers this process does not see)
export class AgentIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly generations = new Map<string, number>();
  private listing: Listing | null = null;

  constructor(
    private readonly layout: AgentDirectoryPort,
    private readonly now: () => number = Date.now,
  ) {}

  markDirty(agentId: string): void {
    const hash = sha256(agentId);
    this.generations.set(hash, (this.generations.get(hash) ?? 0) + 1);
    const known = this.listing?.directories.find((directory) => directory.agentHash === hash);
    if (known === undefined || known.state !== "ready") this.listing = null;
  }

  // why: inspecting an agent directory costs about a millisecond, so the list is built in slices, and reused until agents/ changes, a write touches an agent it does not know, or 30 s pass
  async directories(clock: Clock): Promise<readonly AgentDirectory[]> {
    const fingerprint = this.layout.agentsFingerprint();
    const at = this.now();
    if (this.listing !== null && this.listing.fingerprint === fingerprint && at - this.listing.at < LISTING_MAX_AGE_MS) return this.listing.directories;
    const directories: AgentDirectory[] = [];
    for (const name of this.layout.agentDirectoryNames()) {
      await clock.yieldIfDue();
      const directory = this.layout.inspectAgentDirectory(name);
      if (directory !== undefined) directories.push(directory);
    }
    this.listing = { fingerprint, at, directories };
    return directories;
  }

  directoryOf(agentId: string): AgentDirectory | undefined {
    return this.layout.inspectAgentDirectory(sha256(agentId));
  }

  lookup(agentId: string): AgentLookup {
    const directory = this.directoryOf(agentId);
    if (directory === undefined) return { kind: "missing" };
    const entry = this.ensure(directory);
    if (entry.summary.kind === "empty") return { kind: "missing" };
    if (entry.summary.kind === "unavailable") return { kind: "unavailable", reason: entry.summary.reason };
    if (entry.summary.agent.agentId !== agentId) return { kind: "missing" };
    return { kind: "found", indexed: this.indexed(directory, entry) };
  }

  async snapshot(clock: Clock): Promise<IndexSnapshot> {
    const directories = await this.directories(clock);
    const live = new Set(directories.map((directory) => directory.agentHash));
    for (const hash of this.entries.keys()) if (!live.has(hash)) this.entries.delete(hash);
    const agents: IndexedAgent[] = [];
    const unavailable: UnavailableAgent[] = [];
    let complete = true;
    for (const directory of directories) {
      if (clock.timeUp()) {
        complete = false;
        break;
      }
      await clock.yieldIfDue();
      const entry = this.ensure(directory);
      if (entry.summary.kind === "unavailable") unavailable.push({ agentHash: directory.agentHash, reason: entry.summary.reason });
      if (entry.summary.kind === "agent") agents.push(this.indexed(directory, entry));
    }
    return { agents, unavailable, complete };
  }

  private indexed(directory: AgentDirectory, entry: Entry): IndexedAgent {
    if (entry.summary.kind !== "agent" || directory.databasePath === null) throw new Error("only a readable agent can be indexed");
    return { agent: entry.summary.agent, path: directory.databasePath, version: `${entry.gen}|${entry.key}`, latest: entry.latest };
  }

  private ensure(directory: AgentDirectory): Entry {
    const gen = this.generations.get(directory.agentHash) ?? 0;
    const key = statKey(directory.databasePath);
    const known = this.entries.get(directory.agentHash);
    const busy = known?.summary.kind === "unavailable" && known.summary.reason === "busy";
    if (known !== undefined && known.gen === gen && known.key === key && !busy) return known;
    const entry = this.read(directory, gen, key);
    this.entries.set(directory.agentHash, entry);
    return entry;
  }

  // why: the newest memory's text comes out of the same open as the namespace pass, because opening a Cairn database costs a few milliseconds of schema loading and a second open per agent would double a cold start
  private read(directory: AgentDirectory, gen: number, key: string): Entry {
    const path = readableDatabase(directory);
    if (typeof path !== "string") return { key, gen, summary: path, latest: null };
    const read = readCairn(path, (reader) => {
      const summary = interpretNamespaces(directory, reader.namespaces());
      if (summary.kind !== "agent") return { summary, latest: null };
      const newest = [...summary.agent.namespaces].sort((left, right) => compareText(right.lastAt ?? "", left.lastAt ?? ""))[0];
      const latest =
        newest === undefined
          ? null
          : (reader.scan({ ownerId: summary.agent.agentId, scope: newest.scope, projectId: newest.projectId }, { want: 1, headChars: HEAD_CHARS, withReceipts: false }).rows[0] ?? null);
      return { summary, latest };
    });
    if (!read.ok) return { key, gen, summary: { kind: "unavailable", reason: read.code }, latest: null };
    return { key, gen, summary: read.value.summary, latest: read.value.latest };
  }
}
