import { isAbsolute, join } from "node:path";
import { resolvePinPath } from "./pinPath.js";
import { createBackend } from "./service.js";
import type { PluginBackendContextV1 } from "@teamuq/plugin-sdk/external";

export interface MemoryPluginBackend {
  call(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

function invalidContext(message: string): Error {
  return Object.assign(new Error(message), { code: "plugin_context_invalid" });
}

export function activate(context: PluginBackendContextV1): MemoryPluginBackend {
  const dataDir = typeof context === "object" && context !== null ? context.dataDir : undefined;
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) {
    throw invalidContext("context.dataDir must be an absolute path");
  }
  const backend = createBackend({
    dataRoot: join(dataDir, "memory-cairn-v1"),
    pinPath: resolvePinPath(import.meta.url),
    host: context.host,
  });
  backend.startWorkers();
  backend.warmUp();
  void backend.warmIndex();
  return Object.freeze({
    call: (method: string, params: unknown) => backend.call(method, params),
    dispose: () => backend.dispose(),
  });
}
