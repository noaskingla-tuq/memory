import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openCairnCore } from "../out/adapters/cairn/cairnCoreAdapter.js";
import { CAIRN_COMMIT, CairnDataLayout } from "../out/adapters/storage/dataLayout.js";
import { CoreHandlePool } from "../out/application/coreHandlePool.js";
import { MemoryApplication } from "../out/application/memoryApplication.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureDirectory = (commit = CAIRN_COMMIT) => join(repoRoot, "test", "fixtures", "legacy-db", commit);

export const agentHashOf = (agentId) => createHash("sha256").update(agentId).digest("hex");

const closers = new WeakMap();

// why: Windows refuses to delete a directory while a SQLite handle is open, so every registered closer runs before the directory goes
export function scratchDirectory(t, label) {
  const base = mkdtempSync(join(tmpdir(), `teamuq-memory-${label}-`));
  const list = [];
  closers.set(t, list);
  t.after(async () => {
    for (const close of list.reverse()) await close();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return base;
}

export function openStore(base, t) {
  const root = join(base, "memory-cairn-v1");
  const layout = new CairnDataLayout(root);
  const app = new MemoryApplication(new CoreHandlePool({ layout, openCore: openCairnCore }));
  if (t !== undefined) closers.get(t)?.push(() => app.close());
  return { root, layout, app };
}

export const actorOf = (agentId, projectId = null) => ({ agentId, projectId, sessionId: `session-${agentId}`, providerId: "claude" });

export function databasePathOf(root, agentId) {
  return join(root, "agents", agentHashOf(agentId), "memory.sqlite");
}

async function must(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(`memory operation failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const SENTENCES = [
  "登入頁的表單驗證要補上空白欄位檢查",
  "部署前一定要先跑完發布閘門，再確認版本號",
  "使用者偏好簡短回答，不要重複題目",
  "資料庫升版一定要用真實舊庫副本驗證",
  "Fixture notes: keep the release gate green before merging",
  "測試資料含表情符號 😀🚀 與全形標點：（括號）～波浪",
];

export function contentOf(agent, scope, index) {
  return `${agent}/${scope} #${index}：${SENTENCES[index % SENTENCES.length]}${"。補充說明".repeat(index % 4)}`;
}

// why: dedup bumps the revision and adds receipts, correct changes content, forget deletes, so one dataset exercises every column the reader projects
export async function fillNamespace(app, actor, scope, count, tag) {
  const forgotten = [];
  for (let index = 0; index < count; index += 1) {
    const content = contentOf(actor.agentId, scope, index);
    const operation = `${tag}-${scope}-${index}`;
    const first = await must(app.execute("memory_remember", { scope, kind: "fact", content, operationId: operation }, actor));
    let revision = first.memory.revision;
    for (let again = 0; again < index % 4; again += 1) {
      revision = (await must(app.execute("memory_remember", { scope, kind: "fact", content, operationId: `${operation}-again-${again}` }, actor))).memory.revision;
    }
    if (index % 7 === 3) {
      revision = (await must(app.execute("memory_correct", { scope, memoryId: first.memory.id, expectedRevision: revision, content: `${content}（更正）`, kind: "decision", operationId: `${operation}-fix` }, actor))).memory.revision;
    }
    if (index % 11 === 5) {
      await must(app.execute("memory_forget", { scope, memoryId: first.memory.id, expectedRevision: revision, operationId: `${operation}-forget` }, actor));
      forgotten.push(first.memory.id);
    }
  }
  return forgotten;
}

export function rawWrite(databasePath, work) {
  const db = new DatabaseSync(databasePath);
  try {
    work(db);
  } finally {
    db.close();
  }
}

export function installFixture(base, commit = CAIRN_COMMIT) {
  const source = fixtureDirectory(commit);
  const meta = JSON.parse(readFileSync(join(source, "fixture.json"), "utf8"));
  const agentRoot = join(base, "memory-cairn-v1", "agents", agentHashOf(meta.agentId));
  mkdirSync(agentRoot, { recursive: true });
  cpSync(join(source, "memory.sqlite"), join(agentRoot, "memory.sqlite"));
  cpSync(join(source, "identity.json"), join(agentRoot, "identity.json"));
  return { agentRoot, databasePath: join(agentRoot, "memory.sqlite"), meta };
}

export async function cairnListAll(app, actor, scope, limit) {
  const memories = [];
  let cursor;
  for (;;) {
    const page = await must(app.execute("memory_inspect", { scope, limit, ...(cursor === undefined ? {} : { cursor }) }, actor));
    memories.push(...page.memories);
    if (page.nextCursor === null) return memories;
    cursor = page.nextCursor;
  }
}

export const cairnGet = (app, actor, scope, memoryId) => must(app.execute("memory_inspect", { scope, memoryId, limit: 12 }, actor));

export function readerListAll(reader, namespace, limit, extra = {}) {
  const rows = [];
  let after;
  for (;;) {
    const page = reader.list(namespace, { limit, ...(after === undefined ? {} : { after }), ...extra });
    rows.push(...page);
    if (page.length < limit) return rows;
    const last = page[page.length - 1];
    after = { updatedAt: last.updatedAt, id: last.id };
  }
}

