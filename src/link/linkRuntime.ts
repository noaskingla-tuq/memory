import { isAbsolute } from "node:path";
import type { PluginBackendContextV1 } from "@teamuq/plugin-sdk/external";
import type { LinkAdminPort } from "../application/ui/linkAdminPort.js";
import { createFiles, type FileTesting } from "./fileService.js";
import { createLinkAdmin } from "./linkAdmin.js";
import { createLinkStore } from "./linkStore.js";
import { createMemoryStoreGroup, type MemoryControl } from "./memoryStoreGroup.js";
import { createProvider, type LinkProvider, type ProviderProbe } from "./provider.js";

export const LINK_MAX_SESSIONS = 4;
export const LINK_CATEGORY = "teamuq.memory@1";

interface ConformanceHooks {
  readonly rootDir?: string;
  readonly now?: () => number;
  readonly fileControl?: unknown;
  readonly features?: readonly string[];
  readonly maxPayloadChars?: number;
  readonly methods?: readonly string[];
  readonly memoryControl?: MemoryControl;
  readonly maxSessions?: number;
  readonly callRatePerSecond?: number;
  readonly callBurst?: number;
  readonly providerProbe?: ProviderProbe;
}

export interface LinkRuntime {
  readonly link: LinkProvider;
  readonly admin: LinkAdminPort;
  readonly conformance?: { readonly files: FileTesting };
  readonly isConformance: boolean;
  dispose(): Promise<void>;
}

// why: the offline acceptance tool sets context.conformance and nothing else may read it, so the whole hook surface is parsed here once
function hooksOf(context: PluginBackendContextV1): ConformanceHooks | undefined {
  const found = (context as { conformance?: unknown } | null)?.conformance;
  return typeof found === "object" && found !== null ? (found as ConformanceHooks) : undefined;
}

function invalidContext(message: string): Error {
  return Object.assign(new Error(message), { code: "plugin_context_invalid" });
}

export function resolveDataDir(context: PluginBackendContextV1): string {
  const rootDir = typeof context === "object" && context !== null ? hooksOf(context)?.rootDir : undefined;
  const candidate: unknown = typeof rootDir === "string" ? rootDir : typeof context === "object" && context !== null ? context.dataDir : undefined;
  if (typeof candidate !== "string" || !isAbsolute(candidate)) throw invalidContext("context.dataDir must be an absolute path");
  return candidate;
}

export function createLinkRuntime({ context, dataDir }: { readonly context: PluginBackendContextV1; readonly dataDir: string }): LinkRuntime {
  const hooks = hooksOf(context);
  const now = hooks?.now ?? Date.now;
  const store = createLinkStore({ dataDir, now });
  const admin = createLinkAdmin(store);
  const files = createFiles({ now, dataDir, fileControl: hooks?.fileControl });
  const group = createMemoryStoreGroup({
    store,
    ...(hooks?.features === undefined ? {} : { features: hooks.features }),
    ...(hooks?.maxPayloadChars === undefined ? {} : { maxPayloadChars: hooks.maxPayloadChars }),
    ...(hooks?.methods === undefined ? {} : { methods: hooks.methods }),
    ...(hooks?.memoryControl === undefined ? {} : { control: hooks.memoryControl }),
  });
  const link = createProvider({
    category: LINK_CATEGORY,
    dataClass: "local",
    maxSessions: hooks?.maxSessions ?? LINK_MAX_SESSIONS,
    modules: [group],
    files,
    now,
    ...(hooks?.callRatePerSecond === undefined ? {} : { callRatePerSecond: hooks.callRatePerSecond }),
    ...(hooks?.callBurst === undefined ? {} : { callBurst: hooks.callBurst }),
    ...(hooks?.providerProbe === undefined ? {} : { probe: hooks.providerProbe }),
  });
  return {
    link,
    admin,
    ...(files.testing === undefined ? {} : { conformance: { files: files.testing } }),
    isConformance: hooks !== undefined,
    async dispose() {
      await store.dispose();
      link.dispose();
    },
  };
}
