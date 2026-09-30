# teamuq-plugin-memory：TeamUQ 記憶外掛（P1 骨架）

TeamUQ 記憶系統的獨立 repo，最終形態是完全信任級（full-trust）的外部 plugin（id `teamuq.memory`）。本片（P1）只完成「搬出」：記憶 domain／application 與 Cairn adapter，自 TeamUQ `packages/platform/memory-server` 原樣搬來，能獨立 `tsc`、跑測試、驗證 Cairn 來源未被改動。

> 狀態：**還沒有** backend 入口（`src/backend/`）、契約 vendor、打包與 manifest（P2、P3）；也沒有 identity 相容與備份（P4）。設計依據：TeamUQ repo `output/memory-hook-mcp/external-plugin-design-v3.md`（§1、§8）。

## 目錄

```
src/adapters/cairn/     Cairn core adapter（唯一 import cairn-memory 的檔）
src/adapters/model/     Cairn 模型 callback adapter
src/adapters/storage/   每 agent 一顆 SQLite 的資料配置與檔案安全檢查
src/application/        memory application、handle pool、write lane、resource governor、tool contract、ports
src/domain/             namespace 與錯誤碼
src/contracts/          actor.ts（呼叫身分型別）、cairn-memory.d.ts（Cairn core 的型別宣告）
test/                   node --test 測試（讀 out/ 的 tsc 產物）
tools/                  verify-source-untouched、check-no-secrets
cairn-pin.json          Cairn 釘選：commit、coreTree、redactSha256、accepted[]
```

## 來源與差異

來源 commit 與 tree hash 記在首個 commit 訊息。相對來源只有下列改動：

- import 路徑：`MemoryActor` 由 `contracts/public.ts` 改為 `contracts/actor.ts`（`public.ts` 其餘內容屬 HTTP 傳輸，不搬）。
- `tools/verify-source-untouched.mjs`：repoRoot 與唯一 import 檢查位置改為本 repo；另驗證 `accepted[]` 含現行 commit，與 `redact.mjs` 的 sha256。
- `test/application.test.mjs`：只改 import 路徑（指向 `out/`）。
- `test/remember-inspect.test.mjs`：新增，取自來源 `memoryControl.test.mjs` 中不依賴 HTTP 的案例，改為直接呼叫 `MemoryApplication.execute`。來源的 HTTP／control token／`/health` 案例隨傳輸層一併不搬。

## 需求與指令

- Node.js ≥ 24；`npm` 只在本 repo 目錄內執行，一律 `--ignore-scripts`。
- `cairn-memory` 以 git pin 取得（需能連 GitHub）；相依版本與 TeamUQ 主樹一致（`zod` 3.25.76、`typescript` 5.9.3、`@types/node` 24.13.3、`esbuild` 0.21.5）。

```powershell
cd C:\teamuq\teamuq-plugins\memory
npm install --ignore-scripts
npm run check          # tsc → node --test → verify-source-untouched → check-no-secrets
```

| 指令 | 說明 |
|---|---|
| `npm run typecheck` | `tsc -p . --noEmit` |
| `npm run build:ts` | `tsc -p .`，輸出到 `out/`（gitignored） |
| `npm test` | 先 `build:ts`，再 `node --test test/*.test.mjs` |
| `npm run verify:source` | 驗證 lock／package 的 Cairn pin、`core/` tree hash、`redact.mjs` sha256、唯一 import 位置 |
| `npm run check:secrets` | 找私鑰區塊、`*.pem`／`*.key`／`keys/`，並確認 `.gitignore` 仍排除它們 |

## 金鑰

私鑰、`*.pem`、`*.key`、`keys/` 不進 repo（`.gitignore` 排除、`check-no-secrets` 把關）。正式簽章金鑰由使用者自行保管。
