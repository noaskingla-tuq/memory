import { refuse } from "./errors.js";
import { availability, buildDescription, type GroupEntry, type GroupInfo } from "./describe.js";
import { createGuard } from "./guard.js";
import type { LinkFiles } from "./fileService.js";

export interface LinkWho {
  readonly source: { readonly kind: string; readonly pluginId?: string };
  readonly category?: string;
}

export interface LinkChannel {
  readonly closed: boolean;
  emit(body: unknown): Promise<unknown>;
}

export interface OpenInfo {
  readonly linkId: string;
  readonly who: LinkWho;
  readonly group: { readonly id: string } | null;
  readonly mode?: string;
  readonly channel: LinkChannel;
}

export interface CallInput {
  readonly id: string;
  readonly method: string;
  readonly args: unknown[];
  readonly who: LinkWho;
  readonly group: { readonly id: string } | null;
  readonly linkId: string;
  readonly data?: Uint8Array;
}

export interface HandlerContext {
  readonly who: LinkWho;
  readonly linkId: string;
  readonly signal: AbortSignal;
  readonly channel: LinkChannel;
  readonly files: LinkFiles | undefined;
  readonly data?: Uint8Array;
}

export interface CallResult {
  readonly value: unknown;
  readonly data?: Uint8Array;
  readonly meta?: unknown;
}

export interface ArgsSchema {
  safeParse(args: unknown): { readonly success: boolean };
}

export interface GroupModule {
  readonly group: GroupInfo;
  readonly methods: Readonly<Record<string, (args: unknown[], ctx: HandlerContext) => CallResult | Promise<CallResult>>>;
  readonly sideEffects: readonly string[];
  argsSchemaFor?(method: string): ArgsSchema | undefined;
}

export interface ProviderProbe {
  beforeOpen?(info: OpenInfo): unknown;
  call?(input: CallInput): unknown;
  beforeCall?(input: CallInput): unknown;
  executed?(input: CallInput): unknown;
  message?(identity: unknown, message: unknown, data: unknown): unknown;
  closed?(linkId: string, reason: string): unknown;
}

export interface ProviderOptions {
  readonly category: string;
  readonly dataClass: string;
  readonly maxSessions: number;
  readonly modules: readonly GroupModule[];
  readonly files?: LinkFiles;
  readonly now?: () => number;
  readonly callRatePerSecond?: number;
  readonly callBurst?: number;
  readonly probe?: ProviderProbe;
}

interface LinkRecord {
  readonly mod: GroupModule;
  readonly abort: AbortController;
  readonly release: () => void;
  readonly ctx: Omit<HandlerContext, "data">;
}

export interface LinkProvider {
  categories(): Record<string, unknown>;
  argsSchemaFor(method: string): ArgsSchema | undefined;
  open(info: OpenInfo): Promise<{ features: string[] }>;
  call(input: CallInput): Promise<CallResult>;
  message(identity: { linkId: string }, message: unknown, data: unknown): Promise<unknown>;
  closed(linkId: string, reason: string): void;
  dispose(): void;
}

export function createProvider({ category, dataClass, maxSessions, modules, files, now = Date.now, callRatePerSecond, callBurst, probe }: ProviderOptions): LinkProvider {
  const guard = createGuard({ maxSessions, now });
  const calls = createGuard({ maxSessions, now, perSecond: callRatePerSecond ?? 10, burst: callBurst ?? 20 });
  const byId = new Map(modules.map((mod) => [mod.group.id, mod]));
  const links = new Map<string, LinkRecord>();

  const methodsOf = (mod: GroupModule): string[] => Object.keys(mod.methods);
  const entries = (): GroupEntry[] => modules.map((mod) => ({ group: mod.group, methods: methodsOf(mod) }));

  function drop(linkId: string): LinkRecord | undefined {
    const link = links.get(linkId);
    if (link === undefined) return undefined;
    links.delete(linkId);
    guard.forget(linkId);
    calls.forget(linkId);
    link.abort.abort();
    link.release();
    return link;
  }

  return {
    categories: () => ({ [category]: { dataClass, groups: modules.map((mod) => ({ id: mod.group.id, version: mod.group.version, methods: methodsOf(mod) })) } }),
    argsSchemaFor: (method) => modules.find((mod) => methodsOf(mod).includes(method))?.argsSchemaFor?.(method),

    async open(info) {
      await probe?.beforeOpen?.(info);
      if (info.group === null) return { features: [] };
      const mod = byId.get(info.group.id);
      if (mod === undefined) throw refuse("unsupported_options");
      const release = guard.begin();
      const abort = new AbortController();
      const ctx = { who: info.who, linkId: info.linkId, signal: abort.signal, channel: info.channel, files };
      links.set(info.linkId, { mod, abort, release, ctx });
      if (info.mode !== "session") return { features: [...mod.group.features] };
      drop(info.linkId);
      throw refuse("unsupported_options");
    },

    async call(input) {
      const { method, args, who, group, linkId, data } = input;
      probe?.call?.(input);
      if (method === "teamuq.describe") {
        if (args.length !== 0) throw refuse("capability_request_invalid");
        return { value: buildDescription({ category, dataClass, entries: entries() }) };
      }
      if (method === "teamuq.availability") return { value: await availability(args, entries()) };
      const mod = group === null ? undefined : byId.get(group.id);
      const link = links.get(linkId);
      if (mod === undefined || link === undefined) throw refuse("capability_request_invalid");
      if (method.startsWith("teamuq.file.")) {
        if (files === undefined) throw refuse("not_supported");
        return files.handle(method, args, data, who);
      }
      if (method === "teamuq.jobs.list") throw refuse("not_supported");
      const handler = Object.hasOwn(mod.methods, method) ? mod.methods[method] : undefined;
      if (handler === undefined) throw refuse("not_supported");
      calls.rate(who, mod.group.id);
      const handlerContext = { ...link.ctx, ...(data === undefined ? {} : { data }) };
      const run = (): CallResult | Promise<CallResult> => {
        const wait = probe?.beforeCall?.(input);
        if (wait !== undefined) {
          return Promise.resolve(wait).then(() => {
            probe?.executed?.(input);
            return handler(args, handlerContext);
          });
        }
        probe?.executed?.(input);
        return handler(args, handlerContext);
      };
      const releaseCall = calls.begin();
      let result: CallResult | Promise<CallResult>;
      try {
        result = mod.sideEffects.includes(method) ? calls.once(linkId, input.id, args, run) : run();
      } catch (error) {
        releaseCall();
        throw error;
      }
      if (result instanceof Promise) return result.finally(releaseCall);
      releaseCall();
      return result;
    },

    async message(identity, message, data) {
      probe?.message?.(identity, message, data);
      return { code: "session_not_found" };
    },

    closed(linkId, reason) {
      probe?.closed?.(linkId, reason);
      drop(linkId);
    },

    dispose() {
      for (const linkId of [...links.keys()]) drop(linkId);
      files?.dispose();
    },
  };
}
