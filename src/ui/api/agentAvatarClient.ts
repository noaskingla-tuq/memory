import type { PluginAgentAvatarApiV1 } from "@teamuq/plugin-sdk";

export type AgentAvatarReader = Pick<PluginAgentAvatarApiV1, "read">;

export function agentAvatarClient(): AgentAvatarReader {
  return { read: (agentId) => window.tuqPlugin.agentAvatar.read(agentId) };
}
