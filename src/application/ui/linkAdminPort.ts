export type LinkAdminFailureCode = "NOT_FOUND" | "REVISION_CONFLICT" | "STORAGE_BUSY" | "STORAGE_UNSUPPORTED";

export class LinkAdminError extends Error {
  constructor(readonly code: LinkAdminFailureCode) {
    super(code);
    this.name = "LinkAdminError";
  }
}

export interface LinkSourceRecord {
  readonly source: string | null;
  readonly fileId: string;
  readonly state: "ok" | "corrupt";
  readonly count: number;
  readonly sizeBytes: number;
  readonly revision: number;
  readonly updatedAtMs: number | null;
}

export interface LinkRawItem {
  readonly id: string;
  readonly payload: unknown;
  readonly tags: readonly string[];
  readonly sizeBytes: number;
  readonly rev: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number | null;
}

export interface LinkAdminLimits {
  readonly items: number;
  readonly bytes: number;
  readonly sources: number;
}

export interface LinkAdminPort {
  limits(): LinkAdminLimits;
  sources(): Promise<readonly LinkSourceRecord[]>;
  list(source: string): Promise<{ readonly revision: number; readonly items: readonly LinkRawItem[] }>;
  get(source: string, id: string): Promise<{ readonly revision: number; readonly item: LinkRawItem }>;
  forgetItem(source: string, id: string, expectedItemRev: number): Promise<{ readonly forgotten: number; readonly revision: number | null }>;
  forgetSource(source: string, expectedRevision: number): Promise<{ readonly forgotten: number; readonly revision: number | null }>;
  discardDamaged(fileId: string): Promise<void>;
}
