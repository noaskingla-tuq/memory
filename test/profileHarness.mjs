import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as contract from "../vendor/teamuq-contract/contract.mjs";

export const SYNC = contract.MEMORY_PLUGIN_METHODS.profileSync;
export const profileFilePath = (base) => join(base, "memory-ui", "profile.json");
export const readProfileFile = (base) => JSON.parse(readFileSync(profileFilePath(base), "utf8"));
export const profileFileExists = (base) => existsSync(profileFilePath(base));

const byKey = (key) => (left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);

export function snapshotOf({ agents = [], teams = [], projects = [], omitted = { agents: 0, teams: 0, projects: 0 } } = {}) {
  return {
    agents: [...agents].sort(byKey((entry) => entry.id)),
    teams: [...teams].sort(byKey((entry) => entry.key)),
    projects: [...projects].sort(byKey((entry) => entry.id)),
    omitted,
  };
}

export const generationOf = (snapshot) => createHash("sha256").update(contract.memoryProfileCanonicalText(snapshot)).digest("hex");

export const agentEntry = (id, name, teamKey, title = null, enabled = true) => ({ id, name, teamKey, title, enabled });

// why: the stream of entries is agents, then teams, then projects, cut into consecutive parts of about equal serialized size, the same shape Core's plan produces
export function partsOf(input, count = 1, { sink = null } = {}) {
  const snapshot = snapshotOf(input);
  const generation = generationOf(snapshot);
  const stream = [
    ...snapshot.agents.map((entry) => ["agents", entry]),
    ...snapshot.teams.map((entry) => ["teams", entry]),
    ...snapshot.projects.map((entry) => ["projects", entry]),
  ];
  const weights = stream.map(([, entry]) => Buffer.byteLength(JSON.stringify(entry)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let before = 0;
  const owner = weights.map((weight) => {
    const at = Math.min(count - 1, Math.floor(((before + weight / 2) / total) * count));
    before += weight;
    return at;
  });
  return Array.from({ length: count }, (_, index) => {
    const slice = stream.filter((_entry, at) => owner[at] === index);
    const pick = (kind) => slice.filter(([name]) => name === kind).map(([, entry]) => entry);
    return {
      generation,
      part: index + 1,
      parts: count,
      agents: pick("agents"),
      teams: pick("teams"),
      projects: pick("projects"),
      omitted: snapshot.omitted,
      sink,
    };
  });
}

export async function pushAll(backend, parts) {
  let last;
  for (const part of parts) last = await backend.call(SYNC, part);
  return last;
}

export const TEAMS = [
  { key: "sw", name: "軟體組" },
  { key: "ops", name: "維運組" },
];

export const SAMPLE = {
  agents: [
    agentEntry("sw/dev", "開發工程師", "sw", "寫程式的人"),
    agentEntry("sw/rev", "審查員", "sw"),
    agentEntry("ops/x", "維運小幫手", "ops"),
    agentEntry("solo", "獨行俠", null),
  ],
  teams: TEAMS,
  projects: [
    { id: "p1", name: "第一個專案", archived: false },
    { id: "p2", name: "封存的專案", archived: true },
  ],
};
