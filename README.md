# teamuq-plugin-memory：TeamUQ 記憶外掛（P1 骨架）

TeamUQ 記憶系統的獨立 repo，最終形態是完全信任級（full-trust）的外部 plugin（id `teamuq.memory`）。本片（P1）只完成「搬出」：記憶 domain／application 與 Cairn adapter，自 TeamUQ `packages/platform/memory-server` 原樣搬來，能獨立 `tsc`、跑測試、驗證 Cairn 來源未被改動。

> 狀態：**還沒有** backend 入口（`src/backend/`）、契約 vendor、打包與 manifest（P2、P3）；identity 相容與備份（P4）已完成。設計依據：TeamUQ repo `output/memory-hook-mcp/external-plugin-design-v3.md`（§1、§8）。

## 目錄

```
src/adapters/cairn/     Cairn core adapter（唯一 import cairn-memory 的檔）
src/adapters/model/     Cairn 模型 callback adapter
src/adapters/storage/   每 agent 一顆 SQLite 的資料配置、檔案安全檢查、identity 相容（cairnPin、upgradeBackup）
src/application/        memory application、handle pool、write lane、resource governor、tool contract、ports
src/domain/             namespace 與錯誤碼
src/contracts/          actor.ts（呼叫身分型別）、cairn-memory.d.ts（Cairn core 的型別宣告）
test/                   node --test 測試（讀 out/ 的 tsc 產物）；test/fixtures/legacy-db/<commit>/ 是各 accepted commit 的真實舊庫
tools/                  verify-source-untouched、check-no-secrets、make-legacy-fixture
cairn-pin.json          Cairn 釘選：commit、coreTree、redactSha256、accepted[]
```

## 來源與差異

來源 commit 與 tree hash 記在首個 commit 訊息。相對來源只有下列改動：

- import 路徑：`MemoryActor` 由 `contracts/public.ts` 改為 `contracts/actor.ts`（`public.ts` 其餘內容屬 HTTP 傳輸，不搬）。
- `tools/verify-source-untouched.mjs`：repoRoot 與唯一 import 檢查位置改為本 repo；另驗證 `accepted[]` 含現行 commit，與 `redact.mjs` 的 sha256。
- `test/application.test.mjs`：只改 import 路徑（指向 `out/`）。
- `test/remember-inspect.test.mjs`：新增，取自來源 `memoryControl.test.mjs` 中不依賴 HTTP 的案例，改為直接呼叫 `MemoryApplication.execute`。來源的 HTTP／control token／`/health` 案例隨傳輸層一併不搬。

## 升級 Cairn 後的舊庫（G7）

資料在 `<dataDir>/memory-cairn-v1/agents/<agentHash>/{identity.json,memory.sqlite}`。開庫前比對 `identity.json` 的 `cairnCommit`：

| stored `cairnCommit` | 結果 |
|---|---|
| 等於現行 commit | 直接開庫 |
| 在 `cairn-pin.json` 的 `accepted[]` | 先備份並驗證，通過才開庫，開庫成功後原子改寫 identity（`cairnCommit` 變現行 commit，另記 `upgradedFromCommit`、`upgradedAt`） |
| 不在清單、缺欄位、agentHash 不符 | `STORAGE_UNSUPPORTED`，不備份、不動任何檔案 |

- 備份：`<dataDir>/memory-cairn-v1/backups/<agentHash>/<UTC 時間>-from-<舊 commit 前 8 碼>/{memory.sqlite,identity.json}`。先寫入 `.partial-*`，`VACUUM INTO` 後跑 `PRAGMA integrity_check`（必須只回一列 `ok`），成功才改名成正式目錄；每個 agent 只保留最近 2 份（同時清掉殘留的 `.partial-*`）。DB 檔不存在時沒東西可備份，只改寫 identity。
- 備份任何一步失敗（VACUUM 錯誤、空間不足、integrity_check 不是 ok、目的地已存在）：清掉 `.partial-*`，回 `STORAGE_BUSY`（retryable），DB 與 identity 都不動。路徑安全違規（symlink、非目錄）仍回 `STORAGE_UNSAFE`。
- 備份後開庫失敗：回 `STORAGE_UNSUPPORTED`（identity 不變，備份保留）。identity 改寫失敗：回 `STORAGE_BUSY`，下次啟動會再備份、再開庫、再改寫。
- 改寫後，只認舊 commit 的（精確比對）plugin 會拒開這個庫；plugin rollback 不會自動還原資料，要還原就用備份目錄手動換回。
- `accepted[]` 在 `CairnDataLayout` 建構時讀 `cairn-pin.json`（預設路徑相對 `out/adapters/storage`，即 repo 根）；檔案不可讀或格式錯誤回 `DEPENDENCY_INCOMPATIBLE`（fail closed）。**打包後目錄結構不同，backend entry 必須以 `pinPath` 傳入 stage 進去的 `cairn-pin.json` 位置**（P2／P3 要接）。
- 新增 accepted commit 的步驟：加進 `cairn-pin.json` 的 `accepted[]`；以該 commit 的 Cairn 安裝後跑 `npm run build:ts && node tools/make-legacy-fixture.mjs` 產出 `test/fixtures/legacy-db/<commit>/`；`verify-source-untouched` 與測試會檢查每個 accepted 項目都有 fixture 且可開啟。目前 accepted 只有現行 commit，升級路徑另以「identity 寫成假舊 commit、DB 為現行格式」模擬。

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
