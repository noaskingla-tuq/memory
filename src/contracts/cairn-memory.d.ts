declare module "cairn-memory/core/index.mjs" {
  export type CairnNamespace = {
    readonly ownerId: string;
    readonly scope: "personal" | "project";
    readonly projectId: string | null;
  };

  export type CairnResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly retryable: boolean } };

  export interface CairnModel {
    readonly contextWindow?: number;
    readonly countTokens?: (text: string) => number;
    readonly onDiagnostic?: (diagnostic: unknown) => void;
    readonly select?: (input: unknown) => Promise<unknown>;
    readonly rank?: (input: unknown) => Promise<unknown>;
    readonly extract?: (input: unknown) => Promise<unknown>;
    readonly reconcile?: (input: unknown) => Promise<unknown>;
    readonly qualify?: (input: unknown) => Promise<unknown>;
    readonly qualifyCandidates?: (input: unknown) => Promise<unknown>;
    readonly classify?: (input: unknown) => Promise<unknown>;
    readonly relate?: (input: unknown) => Promise<unknown>;
    readonly reviewBasis?: (input: unknown) => Promise<unknown>;
  }

  export interface CairnCore {
    admit(input: unknown): CairnResult<unknown>;
    list(input: unknown): CairnResult<unknown>;
    get(input: unknown): CairnResult<unknown>;
    correct(input: unknown): CairnResult<unknown>;
    forget(input: unknown): CairnResult<unknown>;
    recall(input: unknown): Promise<CairnResult<unknown>>;
    capture(input: unknown): Promise<CairnResult<unknown>>;
    close(): CairnResult<null>;
  }

  export function openMemoryCore(input: {
    readonly path: string;
    readonly model?: CairnModel;
  }): CairnCore;
}
