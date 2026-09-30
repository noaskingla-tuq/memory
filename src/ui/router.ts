export type Route = { readonly name: "home" } | { readonly name: "agent"; readonly agentId: string };

const AGENT_PREFIX = "#/agent/";

// why: an id with a lone surrogate would make encodeURIComponent throw and take the whole card wall down with it
const wellFormed = (text: string): string => text.replace(/[\ud800-\udfff]/gu, "�");

export function agentHref(agentId: string): string {
  return `${AGENT_PREFIX}${encodeURIComponent(wellFormed(agentId))}`;
}

export function parseRoute(hash: string): Route {
  if (!hash.startsWith(AGENT_PREFIX)) return { name: "home" };
  try {
    const agentId = decodeURIComponent(hash.slice(AGENT_PREFIX.length));
    return agentId === "" ? { name: "home" } : { name: "agent", agentId };
  } catch {
    return { name: "home" };
  }
}
