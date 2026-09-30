import type {
  MemoryModelOperation,
  MemoryModelPolicy,
  MemoryModelPort,
} from "../../application/modelPort.js";
import { MemoryServiceError } from "../../domain/errors.js";

const OPERATIONS: readonly MemoryModelOperation[] = [
  "select",
  "rank",
  "extract",
  "reconcile",
  "qualify",
  "qualifyCandidates",
  "classify",
  "relate",
  "reviewBasis",
];

function assertPolicy(policy: MemoryModelPolicy): void {
  if (!policy.enabled || policy.contextWindow < 8_192) {
    throw new MemoryServiceError(
      "MODEL_POLICY_DENIED",
      "Memory model policy is not allowed",
    );
  }
}

export type ReportModelFailure = (
  code: "MODEL_NOT_CONFIGURED" | "MODEL_POLICY_DENIED",
) => void;

function reportStableFailure(
  error: unknown,
  report?: ReportModelFailure,
): void {
  const code = error instanceof MemoryServiceError ? error.code : undefined;
  if (code === "MODEL_NOT_CONFIGURED" || code === "MODEL_POLICY_DENIED") {
    report?.(code);
  }
}

export function createCairnModelAdapter(
  agentId: string,
  port: MemoryModelPort,
  report?: ReportModelFailure,
) {
  const policy = port.resolvePolicy(agentId);
  assertPolicy(policy);
  const adapter: Record<string, unknown> = {
    contextWindow: policy.contextWindow,
    countTokens: (text: string) => {
      const count = port.countTokens(policy, text);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new MemoryServiceError(
          "TOKEN_COUNT_UNAVAILABLE",
          "Memory tokenizer returned an invalid count",
        );
      }
      return count;
    },
  };
  for (const operation of OPERATIONS) {
    adapter[operation] = async (request: {
      readonly system: string;
      readonly input: unknown;
      readonly maxOutputTokens: 1024;
      readonly signal: AbortSignal;
    }) => {
      if (!policy.allowedOperations.has(operation)) {
        const error = new MemoryServiceError(
          "MODEL_POLICY_DENIED",
          "Memory model operation is not allowed",
        );
        report?.("MODEL_POLICY_DENIED");
        throw error;
      }
      try {
        return await port.invoke({ agentId, policy, operation, ...request });
      } catch (error) {
        reportStableFailure(error, report);
        throw error;
      }
    };
  }
  return Object.freeze(adapter);
}
