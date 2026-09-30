import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// why: the packaged backend.mjs sits next to cairn-pin.json, while out/backend/ reaches the repo root two levels up
export function resolvePinPath(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const packaged = join(here, "cairn-pin.json");
  return existsSync(packaged) ? packaged : resolve(here, "..", "..", "cairn-pin.json");
}
