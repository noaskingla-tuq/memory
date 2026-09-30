import { isAbsolute, join } from "node:path";
import { resolvePinPath } from "./pinPath.js";
import { createBackend } from "./service.js";

export interface MemoryPluginBackend {
  call(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

function invalidContext(message: string): Error {
  return Object.assign(new Error(message), { code: "plugin_context_invalid" });
}

export function activate(context: unknown): MemoryPluginBackend {
  const dataDir =
    typeof context === "object" && context !== null
      ? (context as { dataDir?: unknown }).dataDir
      : undefined;
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) {
    throw invalidContext("context.dataDir must be an absolute path");
  }
  const backend = createBackend({
    dataRoot: join(dataDir, "memory-cairn-v1"),
    pinPath: resolvePinPath(import.meta.url),
  });
  backend.warmUp();
  void backend.warmIndex();
  return Object.freeze({
    call: (method: string, params: unknown) => backend.call(method, params),
    dispose: () => backend.dispose(),
  });
}
