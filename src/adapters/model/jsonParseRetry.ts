import { JSON_PARSE_CODE } from "../../application/callResolution.js";

export { JSON_PARSE_CODE };
// why: a model that keeps returning broken JSON must not burn quota for ever, so the same request gets at most this many extra turns
export const JSON_PARSE_RETRY_LIMIT = 2;

const retrying = new WeakSet<object>();

export const jsonParseRetryable = (priorFailures: number): boolean => priorFailures < JSON_PARSE_RETRY_LIMIT;
export function markJsonParseRetry<T extends object>(error: T): T { retrying.add(error); return error; }
export const isJsonParseRetry = (error: unknown): boolean => typeof error === "object" && error !== null && retrying.has(error);
