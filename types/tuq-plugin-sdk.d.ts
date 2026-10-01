declare module '@teamuq/plugin-sdk' {
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface PluginBackendApiV1 {
    call(method: string, params: JsonValue): Promise<JsonValue>;
}
export type PluginAgentAvatarResultV1 = Readonly<{
    protocolVersion: 1;
    image: Readonly<{
        mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
        bytes: Uint8Array;
    }> | null;
}>;
export interface PluginAgentAvatarApiV1 {
    read(agentId: string): Promise<PluginAgentAvatarResultV1['image']>;
}
export interface PluginStoreStatusViewV1 {
    readonly state: 'disabled' | 'fresh' | 'stale' | 'offline' | 'untrusted';
    readonly ageSec: number | null;
    readonly acquirable: boolean;
}
export interface PluginStorePreviewViewV1 {
    readonly role: 'cover' | 'video' | 'voice';
    readonly mime: string;
    readonly sizeBytes: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly durationMs: number | null;
    readonly url: string;
}
export interface PluginStoreEntryViewV1 {
    readonly entryId: string;
    readonly packId: string;
    readonly version: string;
    readonly name: string;
    readonly summary: string;
    readonly tags: readonly string[];
    readonly creator: string;
    readonly downloadBytes: number;
    readonly installedBytes: number;
    readonly consentLabel: string | null;
}
export interface PluginStoreEntryDetailViewV1 extends PluginStoreEntryViewV1 {
    readonly description: string;
    readonly previews: readonly PluginStorePreviewViewV1[];
}
export interface PluginStoreListViewV1 {
    readonly entries: readonly PluginStoreEntryViewV1[];
    readonly nextCursor: string | null;
}
export interface PluginStoreListQueryV1 {
    readonly text?: string;
    readonly tags?: readonly string[];
    readonly cursor?: string | null;
    readonly limit?: number;
}
export interface PluginStoreNoticeV1 {
    readonly title: string;
    readonly body: string;
}
export interface PluginStoreInstalledViewV1 {
    readonly entryId: string;
    readonly packId: string;
    readonly version: string;
    readonly state: 'ready' | 'hidden' | 'disabled' | 'removed';
    readonly withdrawnReason: string | null;
    readonly notice: PluginStoreNoticeV1 | null;
    readonly previousVersion: string | null;
}
export interface PluginStorePendingViewV1 {
    readonly entryId: string;
    readonly version: string;
    readonly bytesReceived: number;
    readonly bytesTotal: number | null;
    readonly stale: boolean;
    readonly active: boolean;
}
export interface PluginStoreUpdateViewV1 {
    readonly entryId: string;
    readonly packId: string;
    readonly installedVersion: string;
    readonly version: string;
}
export interface PluginStorePreflightViewV1 {
    readonly downloadBytes: number;
    readonly installedBytes: number;
    readonly neededBytes: number;
    readonly reserveBytes: number;
    readonly freeBytes: number;
    readonly enough: boolean;
}
export interface PluginStoreErrorTextViewV1 {
    readonly title: string;
    readonly body: string;
    readonly steps: readonly string[];
    readonly named: boolean;
}
export type PluginStoreAcquireOutcomeV1 = Readonly<{
    status: 'installed' | 'updated';
    packId: string;
    version: string;
    name: string;
}> | Readonly<{
    status: 'cancelled';
}>;
export interface PluginStoreProgressViewV1 {
    readonly entryId: string;
    readonly stage: 'downloading' | 'verifying' | 'installing';
    readonly bytesReceived: number;
    readonly bytesTotal: number | null;
    readonly retry: Readonly<{
        attempt: number;
        max: number;
    }> | null;
}
export interface PluginStoreChangeViewV1 {
    readonly entryId: string;
    readonly state: 'installed' | 'updated' | 'hidden' | 'disabled' | 'removed';
    readonly withdrawnReason: string | null;
    readonly notice: PluginStoreNoticeV1 | null;
}
export type PluginStoreRollbackOutcomeV1 = Readonly<{
    status: 'rolled_back';
    packId: string;
    version: string;
    name: string;
}> | Readonly<{
    status: 'cancelled';
}> | Readonly<{
    status: 'no_previous';
}>;
export interface PluginStoreApiV1 {
    status(options?: Readonly<{
        refresh?: boolean;
    }>): Promise<PluginStoreStatusViewV1>;
    list(query?: PluginStoreListQueryV1): Promise<PluginStoreListViewV1>;
    get(entryId: string): Promise<PluginStoreEntryDetailViewV1 | null>;
    installed(): Promise<readonly PluginStoreInstalledViewV1[]>;
    pending(): Promise<readonly PluginStorePendingViewV1[]>;
    updates(): Promise<readonly PluginStoreUpdateViewV1[]>;
    preflight(entryId: string): Promise<PluginStorePreflightViewV1>;
    acquire(entryId: string): Promise<PluginStoreAcquireOutcomeV1>;
    cancel(entryId: string): Promise<void>;
    discard(entryId: string): Promise<void>;
    rollback(entryId: string): Promise<PluginStoreRollbackOutcomeV1>;
    errorText(code: string): Promise<PluginStoreErrorTextViewV1 | null>;
    onProgress(listener: (progress: PluginStoreProgressViewV1) => void): () => void;
    onChange(listener: (change: PluginStoreChangeViewV1) => void): () => void;
}
}
interface Window { tuqPlugin: { backend: import('@teamuq/plugin-sdk').PluginBackendApiV1; store: import('@teamuq/plugin-sdk').PluginStoreApiV1; agentAvatar: import('@teamuq/plugin-sdk').PluginAgentAvatarApiV1 } }
declare module '@teamuq/plugin-sdk/external' {
export type PluginBackendContextV1 = Readonly<{
    readonly pluginId: string;
    readonly dataDir: string;
    readonly assetPacks: Readonly<Record<string, string>>;
    readonly allowAddons: boolean;
    readonly settings: Readonly<{
        all(): Readonly<Record<string, boolean | number | string>>;
        get(key: string): boolean | number | string | undefined;
        onChange(listener: (values: Readonly<Record<string, boolean | number | string>>) => void): () => void;
    }>;
}>;
}
