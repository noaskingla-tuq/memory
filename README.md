# teamuq-plugin-memory：TeamUQ 記憶外掛

TeamUQ 記憶系統的獨立 repo，最終形態是完全信任級（full-trust）的外部 plugin（id `teamuq.memory`）。記憶 domain／application 與 Cairn adapter 自 TeamUQ `packages/platform/memory-server` 原樣搬來（P1）；`src/backend/` 是 TeamUQ 外部 full-trust 後端的入口（P2）。

> 狀態：backend 入口、契約 vendor（P2）與 identity 相容與備份（P4）已完成；**還沒有**打包、stage 與 manifest（P3）。設計依據：TeamUQ repo `output/memory-hook-mcp/external-plugin-design-v3.md`（§1、§8）。

## 目錄

```
src/backend/            外部後端入口：entry（activate）、service（派送與生命週期）、rememberCall、inspectCall、diagnose、contractErrors
vendor/teamuq-contract/ Core 契約的 vendor 副本（contract.mjs、型別、fixtures、lock）＋ vendor.lock.json
src/adapters/cairn/     Cairn core adapter（唯一 import cairn-memory 的檔）
src/adapters/model/     Cairn 模型 callback adapter
src/adapters/storage/   每 agent 一顆 SQLite 的資料配置、檔案安全檢查、identity 相容（cairnPin、upgradeBackup）
src/application/        memory application、handle pool、write lane、resource governor、tool contract、ports
src/domain/             namespace 與錯誤碼
src/contracts/          actor.ts（呼叫身分型別）、cairn-memory.d.ts（Cairn core 的型別宣告）
test/                   node --test 測試（讀 out/ 的 tsc 產物）；test/fixtures/legacy-db/<commit>/ 是各 accepted commit 的真實舊庫
tools/                  verify-source-untouched、check-no-secrets、make-legacy-fixture、sync-vendor、verify-contract
cairn-pin.json          Cairn 釘選：commit、coreTree、redactSha256、accepted[]
```

## 來源與差異

來源 commit 與 tree hash 記在首個 commit 訊息。相對來源只有下列改動：

- import 路徑：`MemoryActor` 由 `contracts/public.ts` 改為 `contracts/actor.ts`（`public.ts` 其餘內容屬 HTTP 傳輸，不搬）。
- `tools/verify-source-untouched.mjs`：repoRoot 與唯一 import 檢查位置改為本 repo；另驗證 `accepted[]` 含現行 commit，與 `redact.mjs` 的 sha256。
- `test/application.test.mjs`：只改 import 路徑（指向 `out/`）。
- `test/remember-inspect.test.mjs`：新增，取自來源 `memoryControl.test.mjs` 中不依賴 HTTP 的案例，改為直接呼叫 `MemoryApplication.execute`。來源的 HTTP／control token／`/health` 案例隨傳輸層一併不搬。

## 後端入口（P2）

`src/backend/entry.ts` 匯出 `activate(context)`，回傳凍結的 `{ call, dispose }`。`context` 是 host 傳入的 `{pluginId, dataDir, assetPacks, allowAddons}`；只用 `dataDir`（必須是絕對路徑）。

- 資料根：`<dataDir>/memory-cairn-v1`。啟動時 `warmUp` 會建 `CairnDataLayout(root, { pinPath })` 並 `preflight`；失敗不擋啟動，之後每次 `call` 與 `diagnose` 會重試。
- `pinPath`：backend 模組同目錄有 `cairn-pin.json`（打包後）就用它，否則取模組往上兩層（`out/backend` 的 repo 根）。P3 stage 必須把 `cairn-pin.json` 放在 `backend.mjs` 旁。
- `call(method, params)` 只服務 `memory.remember@1`、`memory.inspect@1`、`diagnose`；其餘（含 `memory.recall@1`、`memory.forget@1` 等，recall／capture／correct／forget 的程式碼雖在但沒有入口）一律拋 `unknown_method`。
- 整次呼叫失敗只會拋帶 `code` 的錯誤，且碼只能是 `unknown_method`、`invalid_params`、`result_too_large`、`internal`（host 把 `code` 原樣回給 Core）。請求違反契約 schema 是 `invalid_params`；訊息只含欄位路徑，不回顯內容。dispose 之後的呼叫拋 `internal`。
- 個別操作的失敗是回應內的 `{ok:false, error}`，碼取自契約 `MEMORY_ERROR_CODES`；契約沒有的碼（`CAPABILITY_*`、`SESSION_BINDING_MISMATCH`、`IDENTITY_UNBOUND`）收成 `INTERNAL`，且原始碼中沒有任何地方會產生它們。儲存層起不來時，每個 op 依實際碼（`STORAGE_*`、`DEPENDENCY_INCOMPATIBLE`）回失敗，不用 `INTERNAL`。
- remember：每個 op 依序執行，成功值只投影 `{memory:{id}, deduplicated}`。
- inspect：以整個回應 `JSON.stringify(...).length`（UTF-16 單位）60,000 為預算；超過就把 limit 對半、重查，直到符合。回 `nextCursor`（list 取 `nextCursor`，get 取 `nextReceiptCursor`）與 `appliedLimit`，呼叫端續頁必須用 `appliedLimit`。`limit` 沒給時明確用 6（與 application 預設一致）。降到 1 仍超過拋 `result_too_large`。**限制**：Cairn 的 cursor 綁定簽發時的 limit，帶 `cursor` 的續頁超過預算無法對半，同樣拋 `result_too_large`。
- 每個回應在回傳前都用 vendored 回應 schema 解析（失敗拋 `internal`）；`diagnose` 不含任何路徑，`storage.status` 為 `ready` 或小寫的錯誤碼（如 `storage_unsafe`）。
- `plugin.version` 是 `src/backend/diagnose.ts` 的常數，測試會比對 `package.json` 的 version，改版時兩處一起改。

## 契約 vendor

`vendor/teamuq-contract/` 是 TeamUQ `packages/features/agent-memory/contract/v1/` 的副本，Core 是唯一權威，禁止手改。

| 檔 | 說明 |
|---|---|
| `contract.mjs`、`contract.d.ts`、`fixtures/**`、`lock.json` | 逐檔自 Core 複製（CRLF 正規化為 LF） |
| `contract.d.mts` | 本 repo 加的一行橋接（tsc 把對 `contract.mjs` 的 import 解析到 `.d.mts`），列在 `vendor.lock.json` 的 `pluginOwnedFiles` |
| `vendor.lock.json` | Core commit（HEAD）、最後改到契約目錄的 commit、Core `lock.json` 的 sha256、每個 vendored 檔的 sha256 |

- 同步：`node tools/sync-vendor.mjs --core <TeamUQ 路徑>`。先驗 Core 的 lock（每檔 hash、無多餘檔、方法清單、pluginId），且契約目錄不得有未提交變更；再重寫 `vendor/teamuq-contract/` 與 `src/backend/vendoredContractLock.ts`（`diagnose.contractLockSha256` 的來源）。
- 驗證：`npm run contract:verify`（不需要 Core）比對 vendored 檔與兩份 lock、橋接檔內容、`vendoredContractLock.ts`；加 `--core <路徑>` 會另外對照 Core 的 lock 與 commit。

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
- `accepted[]` 在 `CairnDataLayout` 建構時讀 `cairn-pin.json`（預設路徑相對 `out/adapters/storage`，即 repo 根）；檔案不可讀或格式錯誤回 `DEPENDENCY_INCOMPATIBLE`（fail closed）。backend entry 以 `pinPath` 傳入（見「後端入口」）。
- 新增 accepted commit 的步驟：加進 `cairn-pin.json` 的 `accepted[]`；以該 commit 的 Cairn 安裝後跑 `npm run build:ts && node tools/make-legacy-fixture.mjs` 產出 `test/fixtures/legacy-db/<commit>/`；`verify-source-untouched` 與測試會檢查每個 accepted 項目都有 fixture 且可開啟。目前 accepted 只有現行 commit，升級路徑另以「identity 寫成假舊 commit、DB 為現行格式」模擬。

## 需求與指令

- Node.js ≥ 24；`npm` 只在本 repo 目錄內執行，一律 `--ignore-scripts`。
- `cairn-memory` 以 git pin 取得（需能連 GitHub）；相依版本與 TeamUQ 主樹一致（`zod` 3.25.76、`typescript` 5.9.3、`@types/node` 24.13.3、`esbuild` 0.21.5）。

```powershell
cd C:\teamuq\teamuq-plugins\memory
npm install --ignore-scripts
npm run check          # tsc → node --test → contract:verify → verify-source-untouched → check-no-secrets
```

| 指令 | 說明 |
|---|---|
| `npm run typecheck` | `tsc -p . --noEmit` |
| `npm run build:ts` | `tsc -p .`，輸出到 `out/`（gitignored） |
| `npm test` | 先 `build:ts`，再 `node --test test/*.test.mjs` |
| `npm run contract:verify` | 驗證 `vendor/teamuq-contract/` 與 lock、`vendoredContractLock.ts` 一致 |
| `npm run contract:sync -- --core <路徑>` | 自 Core 重新 vendor 契約（寫入檔案） |
| `npm run verify:source` | 驗證 lock／package 的 Cairn pin、`core/` tree hash、`redact.mjs` sha256、唯一 import 位置 |
| `npm run check:secrets` | 找私鑰區塊、`*.pem`／`*.key`／`keys/`，並確認 `.gitignore` 仍排除它們 |

## 金鑰

私鑰、`*.pem`、`*.key`、`keys/` 不進 repo（`.gitignore` 排除、`check-no-secrets` 把關）。正式簽章金鑰由使用者自行保管。
