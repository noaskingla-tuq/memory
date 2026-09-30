import { z } from "zod";
export declare const MEMORY_PLUGIN_ID = "teamuq.memory";
export declare const MEMORY_CONTRACT_VERSION = 1;
export declare const MEMORY_CONTRACT_VERSIONS: readonly number[];
export declare const MEMORY_PLUGIN_METHODS: {
    readonly remember: "memory.remember@1";
    readonly inspect: "memory.inspect@1";
    readonly diagnose: "diagnose";
    readonly profileSync: "memory.profile.sync@1";
};
export declare const MEMORY_PLUGIN_METHOD_NAMES: readonly ["memory.remember@1", "memory.inspect@1", "diagnose", "memory.profile.sync@1"];
export declare const MEMORY_LIMITS: {
    readonly maxOps: 16;
    readonly paramsMaxBytes: number;
    readonly resultMaxBytes: number;
    readonly inspectBudgetBytes: 60000;
    readonly callTimeoutMs: 30000;
    readonly identifierMaxChars: 200;
    readonly operationIdMaxChars: 128;
    readonly contentMaxChars: 4000;
    readonly inspectMaxLimit: 12;
    readonly cursorMaxChars: 8192;
};
/** Name-table limits: one snapshot is at most maxParts requests of at most partBudgetBytes each; anything beyond is dropped and counted in omitted. */
export declare const MEMORY_PROFILE_LIMITS: {
    readonly maxAgents: 4096;
    readonly maxTeams: 1024;
    readonly maxProjects: 4096;
    readonly maxParts: 32;
    readonly partBudgetBytes: number;
    readonly agentNameMaxChars: 120;
    readonly teamNameMaxChars: 120;
    readonly titleMaxChars: 120;
    readonly projectNameMaxChars: 200;
    readonly canonicalVersion: 1;
};
export declare const MEMORY_ERROR_CODES: readonly ["INVALID_INPUT", "PROJECT_UNBOUND", "MODEL_NOT_CONFIGURED", "MODEL_POLICY_DENIED", "MODEL_TIMEOUT", "MODEL_OUTPUT_INVALID", "TOKEN_COUNT_UNAVAILABLE", "REVISION_CONFLICT", "CURSOR_STALE", "IDEMPOTENCY_CONFLICT", "MEMORY_SUPPRESSED", "RESOURCE_BUSY", "STORAGE_BUSY", "STORAGE_UNSAFE", "STORAGE_UNSUPPORTED", "DEPENDENCY_INCOMPATIBLE", "INTERNAL"];
export declare const MEMORY_RETRYABLE_ERROR_CODES: readonly ["MODEL_TIMEOUT", "REVISION_CONFLICT", "CURSOR_STALE", "RESOURCE_BUSY", "STORAGE_BUSY"];
export declare const MEMORY_CALL_ERROR_CODES: readonly ["unknown_method", "invalid_params", "result_too_large", "internal"];
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];
export type MemoryCallErrorCode = (typeof MEMORY_CALL_ERROR_CODES)[number];
export declare const memoryActorSchema: z.ZodObject<{
    agentId: z.ZodString;
    projectId: z.ZodNullable<z.ZodString>;
    sessionId: z.ZodString;
    providerId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    agentId: string;
    projectId: string | null;
    sessionId: string;
    providerId: string;
}, {
    agentId: string;
    projectId: string | null;
    sessionId: string;
    providerId: string;
}>;
export declare const memoryRememberInputSchema: z.ZodObject<{
    scope: z.ZodEnum<["personal", "project"]>;
    content: z.ZodString;
    kind: z.ZodEnum<["fact", "preference", "decision", "instruction", "context"]>;
    operationId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    scope: "personal" | "project";
    content: string;
    kind: "fact" | "preference" | "decision" | "instruction" | "context";
    operationId: string;
}, {
    scope: "personal" | "project";
    content: string;
    kind: "fact" | "preference" | "decision" | "instruction" | "context";
    operationId: string;
}>;
export declare const memoryInspectInputSchema: z.ZodObject<{
    scope: z.ZodEnum<["personal", "project"]>;
    memoryId: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    scope: "personal" | "project";
    memoryId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
}, {
    scope: "personal" | "project";
    memoryId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
}>;
export declare const memoryRememberRequestSchema: z.ZodObject<{
    actor: z.ZodObject<{
        agentId: z.ZodString;
        projectId: z.ZodNullable<z.ZodString>;
        sessionId: z.ZodString;
        providerId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    }, {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    }>;
    ops: z.ZodArray<z.ZodObject<{
        scope: z.ZodEnum<["personal", "project"]>;
        content: z.ZodString;
        kind: z.ZodEnum<["fact", "preference", "decision", "instruction", "context"]>;
        operationId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        scope: "personal" | "project";
        content: string;
        kind: "fact" | "preference" | "decision" | "instruction" | "context";
        operationId: string;
    }, {
        scope: "personal" | "project";
        content: string;
        kind: "fact" | "preference" | "decision" | "instruction" | "context";
        operationId: string;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    actor: {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    };
    ops: {
        scope: "personal" | "project";
        content: string;
        kind: "fact" | "preference" | "decision" | "instruction" | "context";
        operationId: string;
    }[];
}, {
    actor: {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    };
    ops: {
        scope: "personal" | "project";
        content: string;
        kind: "fact" | "preference" | "decision" | "instruction" | "context";
        operationId: string;
    }[];
}>;
export declare const memoryInspectRequestSchema: z.ZodObject<{
    actor: z.ZodObject<{
        agentId: z.ZodString;
        projectId: z.ZodNullable<z.ZodString>;
        sessionId: z.ZodString;
        providerId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    }, {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    }>;
    input: z.ZodObject<{
        scope: z.ZodEnum<["personal", "project"]>;
        memoryId: z.ZodOptional<z.ZodString>;
        limit: z.ZodOptional<z.ZodNumber>;
        cursor: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        scope: "personal" | "project";
        memoryId?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
    }, {
        scope: "personal" | "project";
        memoryId?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
    }>;
}, "strict", z.ZodTypeAny, {
    actor: {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    };
    input: {
        scope: "personal" | "project";
        memoryId?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
    };
}, {
    actor: {
        agentId: string;
        projectId: string | null;
        sessionId: string;
        providerId: string;
    };
    input: {
        scope: "personal" | "project";
        memoryId?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
    };
}>;
export declare const memoryDiagnoseRequestSchema: z.ZodObject<{}, "strict", z.ZodTypeAny, {}, {}>;
export declare const memoryRememberValueSchema: z.ZodObject<{
    memory: z.ZodObject<{
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
    }, {
        id: string;
    }>;
    deduplicated: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    memory: {
        id: string;
    };
    deduplicated: boolean;
}, {
    memory: {
        id: string;
    };
    deduplicated: boolean;
}>;
export declare const memoryInspectValueSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const memoryRememberResultSchema: z.ZodDiscriminatedUnion<"ok", [z.ZodObject<{
    ok: z.ZodLiteral<true>;
    value: z.ZodObject<{
        memory: z.ZodObject<{
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            id: string;
        }, {
            id: string;
        }>;
        deduplicated: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        memory: {
            id: string;
        };
        deduplicated: boolean;
    }, {
        memory: {
            id: string;
        };
        deduplicated: boolean;
    }>;
    requestId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    value: {
        memory: {
            id: string;
        };
        deduplicated: boolean;
    };
    ok: true;
    requestId: string;
}, {
    value: {
        memory: {
            id: string;
        };
        deduplicated: boolean;
    };
    ok: true;
    requestId: string;
}>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
        code: z.ZodEnum<["INVALID_INPUT", "PROJECT_UNBOUND", "MODEL_NOT_CONFIGURED", "MODEL_POLICY_DENIED", "MODEL_TIMEOUT", "MODEL_OUTPUT_INVALID", "TOKEN_COUNT_UNAVAILABLE", "REVISION_CONFLICT", "CURSOR_STALE", "IDEMPOTENCY_CONFLICT", "MEMORY_SUPPRESSED", "RESOURCE_BUSY", "STORAGE_BUSY", "STORAGE_UNSAFE", "STORAGE_UNSUPPORTED", "DEPENDENCY_INCOMPATIBLE", "INTERNAL"]>;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        requestId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    }, {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    }>;
}, "strip", z.ZodTypeAny, {
    ok: false;
    error: {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    };
}, {
    ok: false;
    error: {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    };
}>]>;
export declare const memoryInspectResultSchema: z.ZodDiscriminatedUnion<"ok", [z.ZodObject<{
    ok: z.ZodLiteral<true>;
    value: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    requestId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    value: Record<string, unknown>;
    ok: true;
    requestId: string;
}, {
    value: Record<string, unknown>;
    ok: true;
    requestId: string;
}>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
        code: z.ZodEnum<["INVALID_INPUT", "PROJECT_UNBOUND", "MODEL_NOT_CONFIGURED", "MODEL_POLICY_DENIED", "MODEL_TIMEOUT", "MODEL_OUTPUT_INVALID", "TOKEN_COUNT_UNAVAILABLE", "REVISION_CONFLICT", "CURSOR_STALE", "IDEMPOTENCY_CONFLICT", "MEMORY_SUPPRESSED", "RESOURCE_BUSY", "STORAGE_BUSY", "STORAGE_UNSAFE", "STORAGE_UNSUPPORTED", "DEPENDENCY_INCOMPATIBLE", "INTERNAL"]>;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        requestId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    }, {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    }>;
}, "strip", z.ZodTypeAny, {
    ok: false;
    error: {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    };
}, {
    ok: false;
    error: {
        code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
        message: string;
        retryable: boolean;
        requestId: string;
    };
}>]>;
export declare const memoryRememberResponseSchema: z.ZodObject<{
    results: z.ZodArray<z.ZodDiscriminatedUnion<"ok", [z.ZodObject<{
        ok: z.ZodLiteral<true>;
        value: z.ZodObject<{
            memory: z.ZodObject<{
                id: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                id: string;
            }, {
                id: string;
            }>;
            deduplicated: z.ZodBoolean;
        }, "strip", z.ZodTypeAny, {
            memory: {
                id: string;
            };
            deduplicated: boolean;
        }, {
            memory: {
                id: string;
            };
            deduplicated: boolean;
        }>;
        requestId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        value: {
            memory: {
                id: string;
            };
            deduplicated: boolean;
        };
        ok: true;
        requestId: string;
    }, {
        value: {
            memory: {
                id: string;
            };
            deduplicated: boolean;
        };
        ok: true;
        requestId: string;
    }>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<["INVALID_INPUT", "PROJECT_UNBOUND", "MODEL_NOT_CONFIGURED", "MODEL_POLICY_DENIED", "MODEL_TIMEOUT", "MODEL_OUTPUT_INVALID", "TOKEN_COUNT_UNAVAILABLE", "REVISION_CONFLICT", "CURSOR_STALE", "IDEMPOTENCY_CONFLICT", "MEMORY_SUPPRESSED", "RESOURCE_BUSY", "STORAGE_BUSY", "STORAGE_UNSAFE", "STORAGE_UNSUPPORTED", "DEPENDENCY_INCOMPATIBLE", "INTERNAL"]>;
            message: z.ZodString;
            retryable: z.ZodBoolean;
            requestId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        }, {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    }, {
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    }>]>, "many">;
}, "strip", z.ZodTypeAny, {
    results: ({
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    } | {
        value: {
            memory: {
                id: string;
            };
            deduplicated: boolean;
        };
        ok: true;
        requestId: string;
    })[];
}, {
    results: ({
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    } | {
        value: {
            memory: {
                id: string;
            };
            deduplicated: boolean;
        };
        ok: true;
        requestId: string;
    })[];
}>;
export declare const memoryInspectResponseSchema: z.ZodObject<{
    result: z.ZodDiscriminatedUnion<"ok", [z.ZodObject<{
        ok: z.ZodLiteral<true>;
        value: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        requestId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        value: Record<string, unknown>;
        ok: true;
        requestId: string;
    }, {
        value: Record<string, unknown>;
        ok: true;
        requestId: string;
    }>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<["INVALID_INPUT", "PROJECT_UNBOUND", "MODEL_NOT_CONFIGURED", "MODEL_POLICY_DENIED", "MODEL_TIMEOUT", "MODEL_OUTPUT_INVALID", "TOKEN_COUNT_UNAVAILABLE", "REVISION_CONFLICT", "CURSOR_STALE", "IDEMPOTENCY_CONFLICT", "MEMORY_SUPPRESSED", "RESOURCE_BUSY", "STORAGE_BUSY", "STORAGE_UNSAFE", "STORAGE_UNSUPPORTED", "DEPENDENCY_INCOMPATIBLE", "INTERNAL"]>;
            message: z.ZodString;
            retryable: z.ZodBoolean;
            requestId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        }, {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    }, {
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    }>]>;
    nextCursor: z.ZodOptional<z.ZodString>;
    appliedLimit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    result: {
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    } | {
        value: Record<string, unknown>;
        ok: true;
        requestId: string;
    };
    nextCursor?: string | undefined;
    appliedLimit?: number | undefined;
}, {
    result: {
        ok: false;
        error: {
            code: "INVALID_INPUT" | "PROJECT_UNBOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED" | "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "TOKEN_COUNT_UNAVAILABLE" | "REVISION_CONFLICT" | "CURSOR_STALE" | "IDEMPOTENCY_CONFLICT" | "MEMORY_SUPPRESSED" | "RESOURCE_BUSY" | "STORAGE_BUSY" | "STORAGE_UNSAFE" | "STORAGE_UNSUPPORTED" | "DEPENDENCY_INCOMPATIBLE" | "INTERNAL";
            message: string;
            retryable: boolean;
            requestId: string;
        };
    } | {
        value: Record<string, unknown>;
        ok: true;
        requestId: string;
    };
    nextCursor?: string | undefined;
    appliedLimit?: number | undefined;
}>;
export declare const memoryDiagnoseResponseSchema: z.ZodObject<{
    plugin: z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        version: string;
    }, {
        id: string;
        version: string;
    }>;
    contract: z.ZodObject<{
        versions: z.ZodArray<z.ZodNumber, "many">;
    }, "strip", z.ZodTypeAny, {
        versions: number[];
    }, {
        versions: number[];
    }>;
    cairn: z.ZodObject<{
        commit: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        commit: string;
    }, {
        commit: string;
    }>;
    node: z.ZodObject<{
        version: z.ZodString;
        sqlite: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        version: string;
        sqlite: string;
    }, {
        version: string;
        sqlite: string;
    }>;
    storage: z.ZodObject<{
        status: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        status: string;
    }, {
        status: string;
    }>;
    limits: z.ZodObject<{
        resultMaxBytes: z.ZodNumber;
        inspectBudgetBytes: z.ZodNumber;
        maxOps: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        resultMaxBytes: number;
        inspectBudgetBytes: number;
        maxOps: number;
    }, {
        resultMaxBytes: number;
        inspectBudgetBytes: number;
        maxOps: number;
    }>;
    contractLockSha256: z.ZodString;
}, "strip", z.ZodTypeAny, {
    plugin: {
        id: string;
        version: string;
    };
    contract: {
        versions: number[];
    };
    cairn: {
        commit: string;
    };
    node: {
        version: string;
        sqlite: string;
    };
    storage: {
        status: string;
    };
    limits: {
        resultMaxBytes: number;
        inspectBudgetBytes: number;
        maxOps: number;
    };
    contractLockSha256: string;
}, {
    plugin: {
        id: string;
        version: string;
    };
    contract: {
        versions: number[];
    };
    cairn: {
        commit: string;
    };
    node: {
        version: string;
        sqlite: string;
    };
    storage: {
        status: string;
    };
    limits: {
        resultMaxBytes: number;
        inspectBudgetBytes: number;
        maxOps: number;
    };
    contractLockSha256: string;
}>;
export declare const memoryProfileAgentSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    teamKey: z.ZodNullable<z.ZodString>;
    title: z.ZodNullable<z.ZodString>;
    enabled: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    id: string;
    name: string;
    teamKey: string | null;
    title: string | null;
    enabled: boolean;
}, {
    id: string;
    name: string;
    teamKey: string | null;
    title: string | null;
    enabled: boolean;
}>;
export declare const memoryProfileTeamSchema: z.ZodObject<{
    key: z.ZodString;
    name: z.ZodString;
}, "strict", z.ZodTypeAny, {
    name: string;
    key: string;
}, {
    name: string;
    key: string;
}>;
export declare const memoryProfileProjectSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    archived: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    id: string;
    name: string;
    archived: boolean;
}, {
    id: string;
    name: string;
    archived: boolean;
}>;
export declare const memoryProfileOmittedSchema: z.ZodObject<{
    agents: z.ZodNumber;
    teams: z.ZodNumber;
    projects: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    agents: number;
    teams: number;
    projects: number;
}, {
    agents: number;
    teams: number;
    projects: number;
}>;
export declare const memoryProfileSinkSchema: z.ZodObject<{
    pending: z.ZodNumber;
    lastWrittenAtMs: z.ZodNullable<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    pending: number;
    lastWrittenAtMs: number | null;
}, {
    pending: number;
    lastWrittenAtMs: number | null;
}>;
/** One part of a name-table snapshot; every list is strictly ascending by key, and all parts of a snapshot share generation, parts, omitted and sink. */
export declare const memoryProfileSyncRequestSchema: z.ZodEffects<z.ZodObject<{
    generation: z.ZodString;
    part: z.ZodNumber;
    parts: z.ZodNumber;
    agents: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        teamKey: z.ZodNullable<z.ZodString>;
        title: z.ZodNullable<z.ZodString>;
        enabled: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        id: string;
        name: string;
        teamKey: string | null;
        title: string | null;
        enabled: boolean;
    }, {
        id: string;
        name: string;
        teamKey: string | null;
        title: string | null;
        enabled: boolean;
    }>, "many">;
    teams: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        name: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        name: string;
        key: string;
    }, {
        name: string;
        key: string;
    }>, "many">;
    projects: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        archived: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        id: string;
        name: string;
        archived: boolean;
    }, {
        id: string;
        name: string;
        archived: boolean;
    }>, "many">;
    omitted: z.ZodObject<{
        agents: z.ZodNumber;
        teams: z.ZodNumber;
        projects: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        agents: number;
        teams: number;
        projects: number;
    }, {
        agents: number;
        teams: number;
        projects: number;
    }>;
    sink: z.ZodNullable<z.ZodObject<{
        pending: z.ZodNumber;
        lastWrittenAtMs: z.ZodNullable<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        pending: number;
        lastWrittenAtMs: number | null;
    }, {
        pending: number;
        lastWrittenAtMs: number | null;
    }>>;
}, "strict", z.ZodTypeAny, {
    agents: {
        id: string;
        name: string;
        teamKey: string | null;
        title: string | null;
        enabled: boolean;
    }[];
    teams: {
        name: string;
        key: string;
    }[];
    projects: {
        id: string;
        name: string;
        archived: boolean;
    }[];
    generation: string;
    part: number;
    parts: number;
    omitted: {
        agents: number;
        teams: number;
        projects: number;
    };
    sink: {
        pending: number;
        lastWrittenAtMs: number | null;
    } | null;
}, {
    agents: {
        id: string;
        name: string;
        teamKey: string | null;
        title: string | null;
        enabled: boolean;
    }[];
    teams: {
        name: string;
        key: string;
    }[];
    projects: {
        id: string;
        name: string;
        archived: boolean;
    }[];
    generation: string;
    part: number;
    parts: number;
    omitted: {
        agents: number;
        teams: number;
        projects: number;
    };
    sink: {
        pending: number;
        lastWrittenAtMs: number | null;
    } | null;
}>, {
    agents: {
        id: string;
        name: string;
        teamKey: string | null;
        title: string | null;
        enabled: boolean;
    }[];
    teams: {
        name: string;
        key: string;
    }[];
    projects: {
        id: string;
        name: string;
        archived: boolean;
    }[];
    generation: string;
    part: number;
    parts: number;
    omitted: {
        agents: number;
        teams: number;
        projects: number;
    };
    sink: {
        pending: number;
        lastWrittenAtMs: number | null;
    } | null;
}, {
    agents: {
        id: string;
        name: string;
        teamKey: string | null;
        title: string | null;
        enabled: boolean;
    }[];
    teams: {
        name: string;
        key: string;
    }[];
    projects: {
        id: string;
        name: string;
        archived: boolean;
    }[];
    generation: string;
    part: number;
    parts: number;
    omitted: {
        agents: number;
        teams: number;
        projects: number;
    };
    sink: {
        pending: number;
        lastWrittenAtMs: number | null;
    } | null;
}>;
export declare const memoryProfileSyncResponseSchema: z.ZodObject<{
    accepted: z.ZodLiteral<true>;
    generation: z.ZodString;
    complete: z.ZodBoolean;
    changed: z.ZodBoolean;
    received: z.ZodNumber;
    agents: z.ZodNumber;
    teams: z.ZodNumber;
    projects: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    received: number;
    agents: number;
    teams: number;
    projects: number;
    generation: string;
    accepted: true;
    complete: boolean;
    changed: boolean;
}, {
    received: number;
    agents: number;
    teams: number;
    projects: number;
    generation: string;
    accepted: true;
    complete: boolean;
    changed: boolean;
}>;
export type MemoryProfileAgent = z.infer<typeof memoryProfileAgentSchema>;
export type MemoryProfileTeam = z.infer<typeof memoryProfileTeamSchema>;
export type MemoryProfileProject = z.infer<typeof memoryProfileProjectSchema>;
export type MemoryProfileOmitted = z.infer<typeof memoryProfileOmittedSchema>;
export type MemoryProfileSink = z.infer<typeof memoryProfileSinkSchema>;
export type MemoryProfileSyncRequest = z.infer<typeof memoryProfileSyncRequestSchema>;
export type MemoryProfileSyncResponse = z.infer<typeof memoryProfileSyncResponseSchema>;
export interface MemoryProfileSnapshot {
    readonly agents: readonly MemoryProfileAgent[];
    readonly teams: readonly MemoryProfileTeam[];
    readonly projects: readonly MemoryProfileProject[];
    readonly omitted: MemoryProfileOmitted;
}
/** The exact text whose sha256 is the generation: version, sorted tuples for agents, teams and projects, then omitted; sink never counts. */
export declare function memoryProfileCanonicalText(snapshot: MemoryProfileSnapshot): string;
export type MemoryActor = z.infer<typeof memoryActorSchema>;
export type MemoryRememberInput = z.infer<typeof memoryRememberInputSchema>;
export type MemoryInspectInput = z.infer<typeof memoryInspectInputSchema>;
export type MemoryRememberRequest = z.infer<typeof memoryRememberRequestSchema>;
export type MemoryInspectRequest = z.infer<typeof memoryInspectRequestSchema>;
export type MemoryRememberResponse = z.infer<typeof memoryRememberResponseSchema>;
export type MemoryInspectResponse = z.infer<typeof memoryInspectResponseSchema>;
export type MemoryDiagnoseResponse = z.infer<typeof memoryDiagnoseResponseSchema>;
