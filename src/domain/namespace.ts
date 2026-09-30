import type { MemoryActor } from "../contracts/actor.js";
import { MemoryServiceError } from "./errors.js";

export interface MemoryNamespace {
  readonly ownerId: string;
  readonly scope: "personal" | "project";
  readonly projectId: string | null;
}

export function personalNamespace(binding: MemoryActor): MemoryNamespace {
  return { ownerId: binding.agentId, scope: "personal", projectId: null };
}

export function projectNamespace(binding: MemoryActor): MemoryNamespace {
  if (binding.projectId === null) {
    throw new MemoryServiceError("PROJECT_UNBOUND", "This session is not bound to a project");
  }
  return { ownerId: binding.agentId, scope: "project", projectId: binding.projectId };
}

export function namespaceForScope(
  binding: MemoryActor,
  scope: "personal" | "project",
): MemoryNamespace {
  return scope === "personal" ? personalNamespace(binding) : projectNamespace(binding);
}

export function recallReadSet(binding: MemoryActor): readonly MemoryNamespace[] {
  const personal = personalNamespace(binding);
  return binding.projectId === null ? [personal] : [personal, projectNamespace(binding)];
}
