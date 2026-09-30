import {
  MEMORY_CALL_ERROR_CODES,
  MEMORY_ERROR_CODES,
  MEMORY_RETRYABLE_ERROR_CODES,
  type MemoryCallErrorCode,
  type MemoryErrorCode,
} from "../../vendor/teamuq-contract/contract.mjs";
import type { MemoryFailure } from "../domain/errors.js";

export class CallError extends Error {
  readonly code: MemoryCallErrorCode;

  constructor(code: MemoryCallErrorCode, message: string) {
    super(message);
    this.name = "CallError";
    this.code = code;
  }
}

export function callError(code: MemoryCallErrorCode, message: string): CallError {
  return new CallError(code, message);
}

export function isCallErrorCode(code: string): code is MemoryCallErrorCode {
  return (MEMORY_CALL_ERROR_CODES as readonly string[]).includes(code);
}

export function contractErrorCode(code: string): MemoryErrorCode {
  return (MEMORY_ERROR_CODES as readonly string[]).includes(code)
    ? (code as MemoryErrorCode)
    : "INTERNAL";
}

export interface ProjectedFailure {
  readonly ok: false;
  readonly error: {
    readonly code: MemoryErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly requestId: string;
  };
}

// why: codes the contract does not list (the removed CAPABILITY_*, SESSION_BINDING_MISMATCH, IDENTITY_UNBOUND) must never reach Core, so they collapse to INTERNAL
export function projectFailure(outcome: MemoryFailure): ProjectedFailure {
  const code = contractErrorCode(outcome.error.code);
  if (code !== outcome.error.code) {
    return {
      ok: false,
      error: {
        code,
        message: "Memory operation failed: INTERNAL",
        retryable: false,
        requestId: outcome.error.requestId,
      },
    };
  }
  return {
    ok: false,
    error: {
      code,
      message: outcome.error.message,
      retryable: (MEMORY_RETRYABLE_ERROR_CODES as readonly string[]).includes(code),
      requestId: outcome.error.requestId,
    },
  };
}
