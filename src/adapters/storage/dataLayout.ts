import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  AgentDirectory,
  AgentDirectoryPort,
  DataLayoutPort,
} from "../../application/ports.js";
import { MemoryServiceError } from "../../domain/errors.js";
import { openCairnCore } from "../cairn/cairnCoreAdapter.js";
import { DEFAULT_PIN_PATH, readCairnPin } from "./cairnPin.js";
import {
  backupAgentDatabase,
  defaultBackupHooks,
  type BackupHooks,
} from "./upgradeBackup.js";

export const CAIRN_COMMIT = "83a10c3b7664b1f67485a19e7d84d24dcb3041a5";
export const CAIRN_CORE_TREE = "c5ba8efa24876b77e2279b9cbc827c221ae277f5";

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertDirectPath(path: string, expectedReal: string = path): Stats {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    comparablePath(realpathSync.native(path)) !== comparablePath(expectedReal)
  ) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path uses a symbolic link or reparse point",
    );
  }
  return stat;
}

// why: under node --permission a plugin can read nothing above its dataDir, so the walk starts at the host-created dataDir and only its descendants are checked
function assertSafeBelow(absolute: string, trustedBase: string): void {
  const suffix = relative(trustedBase, absolute);
  if (suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path is outside its trusted base",
    );
  }
  let current = trustedBase;
  let expected = realpathSync.native(trustedBase);
  for (const segment of suffix === "" ? [] : suffix.split(sep)) {
    current = join(current, segment);
    expected = join(expected, segment);
    if (!existsSync(current)) break;
    if (!assertDirectPath(current, expected).isDirectory()) {
      throw new MemoryServiceError(
        "STORAGE_UNSAFE",
        "Memory path ancestor is not a directory",
      );
    }
  }
}

function assertSafeAncestors(path: string, trustedBase?: string): void {
  const absolute = resolve(path);
  if (trustedBase !== undefined) {
    assertSafeBelow(absolute, resolve(trustedBase));
    return;
  }
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

function ensureRegularDirectory(path: string, trustedBase?: string): void {
  assertSafeAncestors(path, trustedBase);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertSafeAncestors(path, trustedBase);
  if (!assertDirectPath(path, expectedRealOf(path, trustedBase)).isDirectory()) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      "Memory path is not a regular directory",
    );
  }
}

function expectedRealOf(path: string, trustedBase?: string): string {
  if (trustedBase === undefined) return path;
  const base = resolve(trustedBase);
  return join(realpathSync.native(base), relative(base, resolve(path)));
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
  const stat = assertDirectPath(path, join(realpathSync.native(dirname(path)), basename(path)));
  if (!stat.isFile()) {
    throw new MemoryServiceError(
      "STORAGE_UNSAFE",
      `${label} is not a regular file`,
    );
  }
  assertRealWithin(root, path);
}

interface StoredIdentity {
  readonly createdAt?: unknown;
  readonly [key: string]: unknown;
}

interface IdentityPolicy {
  readonly currentCommit: string;
  readonly accepted: readonly string[];
}

function identityPayload(
  agentHash: string,
  commit: string,
  createdAt: string,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return `${JSON.stringify(
    { schemaVersion: 1, agentHash, cairnCommit: commit, createdAt, ...extra },
    null,
    2,
  )}\n`;
}

function rewriteIdentity(
  root: string,
  path: string,
  agentHash: string,
  stored: StoredIdentity,
  fromCommit: string,
  policy: IdentityPolicy,
): void {
  const createdAt =
    typeof stored.createdAt === "string"
      ? stored.createdAt
      : new Date().toISOString();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      identityPayload(agentHash, policy.currentCommit, createdAt, {
        upgradedFromCommit: fromCommit,
        upgradedAt: new Date().toISOString(),
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
    throw new MemoryServiceError(
      "STORAGE_BUSY",
      "Memory identity metadata could not be rewritten after the upgrade",
    );
  }
  assertRegularFile(root, path, "Memory identity metadata");
}

function resolveIdentity(
  root: string,
  path: string,
  agentHash: string,
  policy: IdentityPolicy,
): { readonly stored: StoredIdentity; readonly upgradeFrom?: string } {
  if (!existsSync(path)) {
    writeFileSync(
      path,
      identityPayload(agentHash, policy.currentCommit, new Date().toISOString()),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
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
    (stored as { agentHash?: unknown }).agentHash !== agentHash
  ) {
    throw new MemoryServiceError(
      "STORAGE_UNSUPPORTED",
      "Memory identity metadata is incompatible",
    );
  }
  const identity = stored as StoredIdentity;
  const commit = identity.cairnCommit;
  if (commit === policy.currentCommit) return { stored: identity };
  if (typeof commit === "string" && policy.accepted.includes(commit)) {
    return { stored: identity, upgradeFrom: commit };
  }
  throw new MemoryServiceError(
    "STORAGE_UNSUPPORTED",
    "Memory identity metadata is incompatible",
  );
}

export interface CairnDataLayoutOptions {
  readonly pinPath?: string;
  readonly currentCommit?: string;
  readonly acceptedCommits?: readonly string[];
  readonly backupHooks?: Partial<BackupHooks>;
  readonly trustedBase?: string;
}

export class CairnDataLayout implements DataLayoutPort, AgentDirectoryPort {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly agentsRoot: string;
  private readonly backupsRoot: string;
  private readonly policy: IdentityPolicy;
  private readonly backupHooks: BackupHooks;
  private readonly trustedBase: string | undefined;

  constructor(dataRoot: string, options: CairnDataLayoutOptions = {}) {
    const currentCommit = options.currentCommit ?? CAIRN_COMMIT;
    const accepted =
      options.acceptedCommits ??
      readCairnPin(options.pinPath ?? DEFAULT_PIN_PATH).accepted;
    this.policy = {
      currentCommit,
      accepted: accepted.includes(currentCommit)
        ? accepted
        : [...accepted, currentCommit],
    };
    this.backupHooks = { ...defaultBackupHooks, ...options.backupHooks };
    this.trustedBase = options.trustedBase;
    if (parse(resolve(dataRoot)).base !== "memory-cairn-v1") {
      throw new MemoryServiceError(
        "STORAGE_UNSAFE",
        "Memory data root must end with memory-cairn-v1",
      );
    }
    this.root = resolve(dataRoot);
    ensureRegularDirectory(this.root, this.trustedBase);
    this.realRoot = realpathSync.native(this.root);
    assertWithin(this.realRoot, this.realRoot, true);
    this.agentsRoot = join(this.root, "agents");
    ensureRegularDirectory(this.agentsRoot, this.trustedBase);
    assertRealWithin(this.realRoot, this.agentsRoot);
    this.backupsRoot = join(this.root, "backups");
  }

  agentDbPath(agentId: string): string {
    const agentHash = createHash("sha256").update(agentId).digest("hex");
    const agentRoot = resolve(this.root, "agents", agentHash);
    assertWithin(this.root, agentRoot);
    ensureRegularDirectory(agentRoot, this.trustedBase);
    assertRealWithin(this.realRoot, agentRoot);
    const identityPath = join(agentRoot, "identity.json");
    const identity = resolveIdentity(
      this.realRoot,
      identityPath,
      agentHash,
      this.policy,
    );
    const databasePath = join(agentRoot, "memory.sqlite");
    for (const path of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      assertRegularFile(this.realRoot, path, "Memory database");
    }
    if (identity.upgradeFrom !== undefined) {
      this.upgradeAgent({
        agentHash,
        identityPath,
        databasePath,
        stored: identity.stored,
        fromCommit: identity.upgradeFrom,
      });
    }
    return databasePath;
  }

  // why: listing must never create a directory or rewrite an identity, so it applies the same reparse-point checks as agentDbPath without its mkdir and upgrade steps
  listAgentDirectories(): readonly AgentDirectory[] {
    const agentsReal = join(realpathSync.native(this.root), "agents");
    assertDirectPath(this.agentsRoot, agentsReal);
    assertRealWithin(this.realRoot, this.agentsRoot);
    const entries: AgentDirectory[] = [];
    for (const agentHash of readdirSync(this.agentsRoot).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort()) {
      const agentRoot = join(this.agentsRoot, agentHash);
      try {
        if (!assertDirectPath(agentRoot, join(agentsReal, agentHash)).isDirectory()) {
          entries.push({ agentHash, databasePath: null, state: "unsafe" });
          continue;
        }
        assertRealWithin(this.realRoot, agentRoot);
        const databasePath = join(agentRoot, "memory.sqlite");
        for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
          assertRegularFile(this.realRoot, path, "Memory database");
        }
        entries.push(
          existsSync(databasePath)
            ? { agentHash, databasePath, state: "ready" }
            : { agentHash, databasePath: null, state: "no_database" },
        );
      } catch (error) {
        const unsafe = error instanceof MemoryServiceError && error.code === "STORAGE_UNSAFE";
        entries.push({ agentHash, databasePath: null, state: unsafe ? "unsafe" : "unreadable" });
      }
    }
    return entries;
  }

  private upgradeAgent(input: {
    readonly agentHash: string;
    readonly identityPath: string;
    readonly databasePath: string;
    readonly stored: StoredIdentity;
    readonly fromCommit: string;
  }): void {
    if (existsSync(input.databasePath)) {
      backupAgentDatabase(
        {
          backupsRoot: this.backupsRoot,
          agentHash: input.agentHash,
          databasePath: input.databasePath,
          identityPath: input.identityPath,
          fromCommit: input.fromCommit,
          ensureDirectory: (path) => {
            ensureRegularDirectory(path, this.trustedBase);
            assertRealWithin(this.realRoot, path);
          },
        },
        this.backupHooks,
      );
      try {
        openCairnCore(input.databasePath).close();
      } catch (error) {
        if (error instanceof MemoryServiceError) throw error;
        throw new MemoryServiceError(
          "STORAGE_UNSUPPORTED",
          "Memory database could not be opened after the backup; identity metadata is unchanged",
        );
      }
    }
    rewriteIdentity(
      this.realRoot,
      input.identityPath,
      input.agentHash,
      input.stored,
      input.fromCommit,
      this.policy,
    );
  }

  preflight(): void {
    const preflightRoot = resolve(this.root, `.preflight-${randomUUID()}`);
    assertWithin(this.root, preflightRoot);
    ensureRegularDirectory(preflightRoot, this.trustedBase);
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
