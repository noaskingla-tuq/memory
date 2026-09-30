// why: preload's zod rejects undefined and NaN anywhere in a return value, so every UI answer leaves through one JSON round trip that drops them
export function jsonSafe<T>(value: T): T {
  const text = JSON.stringify(value);
  return text === undefined ? (null as T) : (JSON.parse(text) as T);
}
