import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { DataLayoutPort } from "../../application/ports.js";
import { MemoryServiceError } from "../../domain/errors.js";
import { openCairnCore } from "../cairn/cairnCoreAdapter.js";

export const CAIRN_COMMIT = "83a10c3b7664b1f67485a19e7d84d24dcb3041a5";
export const CAIRN_CORE_TREE = "c5ba8efa24876b77e2279b9cbc827c221ae277f5";

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertDirectPath(path: string): Stats {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    comparablePath(realpathSync.native(path)) !== comparablePath(path)
  ) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path uses a symbolic link or reparse point",
    );
  }
  return stat;
}

function assertSafeAncestors(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  if (!assertDirectPath(current).isDirectory()) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path ancestor is not a directory",
    );
  }
  const suffix = relative(root, absolute);
  for (const segment of suffix === "" ? [] : suffix.split(sep)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (!assertDirectPath(current).isDirectory()) {
      throw new MemoryServiceError(
        "STORAGE_UNSAFE",
        "Memory path ancestor is not a directory",
      );
    }
  }
}

function ensureRegularDirectory(path: string): void {
  assertSafeAncestors(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertSafeAncestors(path);
  if (!assertDirectPath(path).isDirectory()) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path is not a regular directory",
    );
  }
}

function assertWithin(
  root: string,
  candidate: string,
  allowRoot = false,
): void {
  const suffix = relative(root, candidate);
  if (
    (!allowRoot && suffix === "") ||
    suffix.startsWith("..") ||
    isAbsolute(suffix) ||
    resolve(root, suffix) !== candidate
  ) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path escaped its data root",
    );
  }
}

function assertRealWithin(root: string, candidate: string): void {
  assertWithin(root, realpathSync.native(candidate), true);
}

function assertRegularFile(root: string, path: string, label: string): void {
  if (!existsSync(path)) return;
  const stat = assertDirectPath(path);
  if (!stat.isFile()) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      `${label} is not a regular file`,
    );
  }
  assertRealWithin(root, path);
}

function writeIdentity(root: string, path: string, agentHash: string): void {
  const payload = {
    schemaVersion: 1,
    agentHash,
    cairnCommit: CAIRN_COMMIT,
    createdAt: new Date().toISOString(),
  };
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    assertRegularFile(root, path, "Memory identity metadata");
  } else {
    assertRegularFile(root, path, "Memory identity metadata");
  }
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory identity metadata is unreadable",
    );
  }
  if (
    typeof stored !== "object" ||
    stored === null ||
    (stored as { agentHash?: unknown }).agentHash !== agentHash ||
    (stored as { cairnCommit?: unknown }).cairnCommit !== CAIRN_COMMIT
  ) {
    throw new MemoryServiceError(
      "STORAGE_UNSUPPORTED",
      "Memory identity metadata is incompatible",
    );
  }
}

export class CairnDataLayout implements DataLayoutPort {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly agentsRoot: string;

  constructor(dataRoot: string) {
    if (parse(resolve(dataRoot)).base !== "memory-cairn-v1") {
      throw new MemoryServiceError(
        "STORAGE_UNSAFE",
        "Memory data root must end with memory-cairn-v1",
      );
    }
    this.root = resolve(dataRoot);
    ensureRegularDirectory(this.root);
    this.realRoot = realpathSync.native(this.root);
    assertWithin(this.realRoot, this.realRoot, true);
    this.agentsRoot = join(this.root, "agents");
    ensureRegularDirectory(this.agentsRoot);
    assertRealWithin(this.realRoot, this.agentsRoot);
  }

  agentDbPath(agentId: string): string {
    const agentHash = createHash("sha256").update(agentId).digest("hex");
    const agentRoot = resolve(this.root, "agents", agentHash);
    assertWithin(this.root, agentRoot);
    ensureRegularDirectory(agentRoot);
    assertRealWithin(this.realRoot, agentRoot);
    writeIdentity(this.realRoot, join(agentRoot, "identity.json"), agentHash);
    const databasePath = join(agentRoot, "memory.sqlite");
    for (const path of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      assertRegularFile(this.realRoot, path, "Memory database");
    }
    return databasePath;
  }

  preflight(): void {
    const preflightRoot = resolve(this.root, `.preflight-${randomUUID()}`);
    assertWithin(this.root, preflightRoot);
    ensureRegularDirectory(preflightRoot);
    assertRealWithin(this.realRoot, preflightRoot);
    const databasePath = join(preflightRoot, "memory.sqlite");
    try {
      const core = openCairnCore(databasePath);
      core.close();
      assertRegularFile(
        this.realRoot,
        databasePath,
        "Memory preflight database",
      );
    } finally {
      rmSync(preflightRoot, { recursive: true, force: true });
    }
  }
}
