import { join } from "node:path";
import { createLinkRuntime, resolveDataDir } from "../link/linkRuntime.js";
import type { FileTesting } from "../link/fileService.js";
import type { LinkProvider } from "../link/provider.js";
import { resolvePinPath } from "./pinPath.js";
import { createBackend } from "./service.js";
import type { PluginBackendContextV1 } from "@teamuq/plugin-sdk/external";

export interface MemoryPluginBackend {
  call(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  readonly link: LinkProvider;
  readonly conformance?: { readonly files: FileTesting };
}

export function activate(context: PluginBackendContextV1): MemoryPluginBackend {
  const dataDir = resolveDataDir(context);
  const runtime = createLinkRuntime({ context, dataDir });
  let backend: ReturnType<typeof createBackend>;
  try {
    backend = createBackend({
      dataRoot: join(dataDir, "memory-cairn-v1"),
      pinPath: resolvePinPath(import.meta.url),
      host: context.host,
      settings: context.settings,
      linkAdmin: runtime.admin,
    });
  } catch (error) {
    void runtime.dispose();
    throw error;
  }
  // why: the offline acceptance tool has no host, so the background workers would only slow it down
  if (!runtime.isConformance) {
    backend.startWorkers();
    backend.warmUp();
    void backend.warmIndex();
  }
  return Object.freeze({
    call: (method: string, params: unknown) => backend.call(method, params),
    link: runtime.link,
    ...(runtime.conformance === undefined ? {} : { conformance: runtime.conformance }),
    async dispose() {
      await runtime.dispose();
      await backend.dispose();
    },
  });
}
