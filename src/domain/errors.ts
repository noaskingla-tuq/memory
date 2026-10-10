export const MEMORY_ERROR_CODES = [
  "INVALID_INPUT",
  "CAPABILITY_MISSING",
  "CAPABILITY_INVALID",
  "CAPABILITY_PENDING",
  "CAPABILITY_REVOKED",
  "SESSION_BINDING_MISMATCH",
  "IDENTITY_UNBOUND",
  "PROJECT_UNBOUND",
  "MODEL_NOT_CONFIGURED",
  "MODEL_POLICY_DENIED",
  "MODEL_TIMEOUT",
  "MODEL_OUTPUT_INVALID",
  "TOKEN_COUNT_UNAVAILABLE",
  "REVISION_CONFLICT",
  "CURSOR_STALE",
  "IDEMPOTENCY_CONFLICT",
  "MEMORY_SUPPRESSED",
  "RESOURCE_BUSY",
  "STORAGE_BUSY",
  "STORAGE_UNSAFE",
  "STORAGE_UNSUPPORTED",
  "DEPENDENCY_INCOMPATIBLE",
  "INTERNAL",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export type MemoryResult<T> =
  | { readonly ok: true; readonly value: T; readonly requestId: string }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: MemoryErrorCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly requestId: string;
      };
    };

export type MemoryFailure = Extract<
  MemoryResult<never>,
  { readonly ok: false }
>;

const RETRYABLE = new Set<MemoryErrorCode>([
  "MODEL_TIMEOUT",
  "REVISION_CONFLICT",
  "CURSOR_STALE",
  "RESOURCE_BUSY",
  "STORAGE_BUSY",
]);

export class MemoryServiceError extends Error {
  readonly code: MemoryErrorCode;
  readonly retryable: boolean;

  constructor(
    code: MemoryErrorCode,
    message: string,
    retryable = RETRYABLE.has(code),
  ) {
    super(message);
    this.name = "MemoryServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

const CAIRN_ERROR_MAP: Readonly<Record<string, MemoryErrorCode>> = {
  invalid_input: "INVALID_INPUT",
  invalid_read_set: "INVALID_INPUT",
  invalid_cursor: "INVALID_INPUT",
  model_not_configured: "MODEL_NOT_CONFIGURED",
  model_policy_denied: "MODEL_POLICY_DENIED",
  context_budget_exceeded: "MODEL_POLICY_DENIED",
  model_timeout: "MODEL_TIMEOUT",
  invalid_model_output: "MODEL_OUTPUT_INVALID",
  model_output_invalid: "MODEL_OUTPUT_INVALID",
  model_cancelled: "MODEL_TIMEOUT",
  extraction_failed: "MODEL_OUTPUT_INVALID",
  resource_busy: "RESOURCE_BUSY",
  token_count_unavailable: "TOKEN_COUNT_UNAVAILABLE",
  revision_conflict: "REVISION_CONFLICT",
  index_revision_conflict: "REVISION_CONFLICT",
  cursor_stale: "CURSOR_STALE",
  memory_suppressed: "MEMORY_SUPPRESSED",
  storage_busy: "STORAGE_BUSY",
  storage_error: "INTERNAL",
};

export function mapCairnError(code: string): MemoryServiceError {
  const mapped = CAIRN_ERROR_MAP[code] ?? "INTERNAL";
  return new MemoryServiceError(mapped, `Memory operation failed: ${mapped}`);
}

export function failure(requestId: string, error: unknown): MemoryFailure {
  const normalized =
    error instanceof MemoryServiceError
      ? error
      : new MemoryServiceError("INTERNAL", "Memory operation failed");
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      requestId,
    },
  };
}

export function success<T>(requestId: string, value: T): MemoryResult<T> {
  return { ok: true, value, requestId };
}
