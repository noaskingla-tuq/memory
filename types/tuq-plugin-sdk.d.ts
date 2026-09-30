declare module '@teamuq/plugin-sdk' {
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface PluginBackendApiV1 {
    call(method: string, params: JsonValue): Promise<JsonValue>;
}
}
interface Window { tuqPlugin: { backend: import('@teamuq/plugin-sdk').PluginBackendApiV1 } }
declare module '@teamuq/plugin-sdk/external' {
export type PluginBackendContextV1 = Readonly<{
    readonly pluginId: string;
    readonly dataDir: string;
    readonly assetPacks: Readonly<Record<string, string>>;
    readonly allowAddons: boolean;
}>;
}
