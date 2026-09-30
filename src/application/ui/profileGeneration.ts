import { createHash } from "node:crypto";
import { memoryProfileCanonicalText, type MemoryProfileSnapshot } from "../../../vendor/teamuq-contract/contract.mjs";

export function profileGeneration(snapshot: MemoryProfileSnapshot): string {
  return createHash("sha256").update(memoryProfileCanonicalText(snapshot)).digest("hex");
}
