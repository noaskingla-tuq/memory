export const UI_METHOD_NAMES = [
  "ui.overview",
  "ui.agentStats",
  "ui.list",
  "ui.search",
  "ui.get",
  "ui.forget",
  "ui.status",
] as const;

export type UiMethodName = (typeof UI_METHOD_NAMES)[number];

export type UiFailureCode = "NOT_IMPLEMENTED" | "INVALID_PARAMS";

export interface UiFailure {
  readonly ok: false;
  readonly code: UiFailureCode;
  readonly retryable: boolean;
  readonly message?: string;
}

export interface UiStatus {
  readonly ok: true;
  readonly stub: boolean;
  readonly version: string;
  readonly cairnCommit: string;
  readonly storage: { readonly status: string };
  readonly profile: {
    readonly generation: string | null;
    readonly receivedAt: string | null;
    readonly agents: number;
    readonly projects: number;
    readonly sink: null;
  };
  readonly lastWriteAt: string | null;
  readonly uptimeSec: number;
}
