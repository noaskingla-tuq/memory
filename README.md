# teamuq-plugin-memory：TeamUQ 記憶外掛

TeamUQ 記憶系統的獨立 repo，最終形態是完全信任級（full-trust）的外部 plugin（id `teamuq.memory`，版本 1.0.0）。記憶 domain／application 與 Cairn adapter 自 TeamUQ `packages/platform/memory-server` 原樣搬來（P1）；`src/backend/` 是 TeamUQ 外部 full-trust 後端的入口（P2）；`tools/build.mjs` 一鍵產出 `.tuqplugin`（P3）。

> 狀態：backend 入口、契約 vendor（P2）、identity 相容與備份（P4）、打包／stage／manifest／devkit 簽章（P3）已完成。Core 已內嵌兩把根公鑰（C5），devkit 已同步（Core 1.6.3，切換分支 `task/ext-mem-devtrust` 的 `95956859c`，含 `dev-pack --preplanted-id`；合回 V1 後若 commit 雜湊改變，重跑 `devkit:sync`）。**只有暫時金鑰簽過**：正式簽章要等使用者以真金鑰執行（H2，見「正式簽章（H2）」）。設計依據：TeamUQ repo `output/memory-hook-mcp/external-plugin-design-v3.md`（§1、§8）。

## 目錄

```
src/backend/            外部後端入口：entry（activate）、service（派送與生命週期）、rememberCall、inspectCall、uiDispatch、diagnose、contractErrors
vendor/teamuq-contract/ Core 契約的 vendor 副本（contract.mjs、型別、fixtures、lock）＋ vendor.lock.json
vendor/teamuq-devkit/   TeamUQ 作者端 devkit 單檔（tuq-plugin-tool.mjs）＋ devkit.lock.json
plugin/                 manifest.template.json（composed，版本由 package.json 帶入）、ui/index.html（只引用 app.js、app.css）
src/ui/                 view 的純 TypeScript（main.ts → ui/app.js；api/{backendClient,errors}.ts、dom/html.ts、components/dialog.ts、i18n/、styles/{app.css,tokens.css,tokens.lock.json}）；tsconfig.ui.json 檢查（lib DOM），tsconfig.json 排除
src/contracts/uiContract.ts  七個 ui.* 方法名單、請求與回應的 zod schema、錯誤碼（backend 與 UI 共用；UI 只 import 型別）
src/application/ui/     budget（UTF-8 bytes 預算）、cursor（無狀態 keyset 游標）、punchContent（工作紀錄前綴解析）、jsonSafe（出口）
types/                  devkit `types` 指令產生的 tuq-plugin-sdk.d.ts（`npm run types:sync`）
src/adapters/cairn/     Cairn core adapter（唯一 import cairn-memory 的檔）
src/adapters/ui/        cairnReader（唯一對 Cairn 庫檔下 SQL、只讀）、agentCatalog（列出所有 agent）
src/adapters/model/     Cairn 模型 callback adapter
src/adapters/storage/   每 agent 一顆 SQLite 的資料配置、檔案安全檢查、identity 相容（cairnPin、upgradeBackup）
src/application/        memory application、handle pool、write lane、resource governor、tool contract、ports
src/domain/             namespace 與錯誤碼
src/contracts/          actor.ts（呼叫身分型別）、cairn-memory.d.ts（Cairn core 的型別宣告）
test/                   node --test 測試（讀 out/ 的 tsc 產物）；test/fixtures/legacy-db/<commit>/ 是各 accepted commit 的真實舊庫
tools/                  build、stage-cairn、verify-artifact、release（P3）；verify-source-untouched、check-no-secrets、make-legacy-fixture、sync-vendor（契約與 devkit）、verify-contract
dist/                   build 產物（gitignored）：stage/、<id>-<version>.tuqplugin、signer.pub.json、build-info.json
cairn-pin.json          Cairn 釘選：commit、coreTree、redactSha256、accepted[]、stage（打包檔案清單與 sha256）
```

## 來源與差異

來源 commit 與 tree hash 記在首個 commit 訊息。相對來源只有下列改動：

- import 路徑：`MemoryActor` 由 `contracts/public.ts` 改為 `contracts/actor.ts`（`public.ts` 其餘內容屬 HTTP 傳輸，不搬）。
- `tools/verify-source-untouched.mjs`：repoRoot 與唯一 import 檢查位置改為本 repo；另驗證 `accepted[]` 含現行 commit，與 `redact.mjs` 的 sha256。
- `test/application.test.mjs`：只改 import 路徑（指向 `out/`）。
- `src/adapters/storage/dataLayout.ts`（P3）：新增選項 `trustedBase`，`src/backend/service.ts` 傳入 `dirname(dataRoot)`；祖先目錄檢查改為只從 `dataDir` 往下，檔案的 realpath 比對改以父目錄的 realpath 為準。原因見「後端入口」，由 e2e 在 `--permission` 下重現（原本 `lstat` 到磁碟根目錄被拒，全部 op 回 `STORAGE_BUSY`）。
- `test/remember-inspect.test.mjs`：新增，取自來源 `memoryControl.test.mjs` 中不依賴 HTTP 的案例，改為直接呼叫 `MemoryApplication.execute`。來源的 HTTP／control token／`/health` 案例隨傳輸層一併不搬。

## 後端入口（P2）

`src/backend/entry.ts` 匯出 `activate(context)`，回傳凍結的 `{ call, dispose }`。`context` 是 host 傳入的 `{pluginId, dataDir, assetPacks, allowAddons}`；只用 `dataDir`（必須是絕對路徑）。

- 資料根：`<dataDir>/memory-cairn-v1`。啟動時 `warmUp` 會建 `CairnDataLayout(root, { pinPath })` 並 `preflight`；失敗不擋啟動，之後每次 `call` 與 `diagnose` 會重試。
- `pinPath`：backend 模組同目錄有 `cairn-pin.json`（打包後）就用它，否則取模組往上兩層（`out/backend` 的 repo 根）。P3 stage 必須把 `cairn-pin.json` 放在 `backend.mjs` 旁。
- `call(method, params)` 只服務 `memory.remember@1`、`memory.inspect@1`、`diagnose` 與七個 `ui.*`（`uiDispatch`；S0 只有 `ui.status` 回佔位資料，其餘六個回 `{ok:false, code:'NOT_IMPLEMENTED'}`，預期錯誤不 throw，出口一律 JSON 來回一次）；其餘（含 `memory.recall@1`、`memory.forget@1` 等，recall／capture／correct／forget 的程式碼雖在但沒有入口）一律拋 `unknown_method`。
- 整次呼叫失敗只會拋帶 `code` 的錯誤，且碼只能是 `unknown_method`、`invalid_params`、`result_too_large`、`internal`（host 把 `code` 原樣回給 Core）。請求違反契約 schema 是 `invalid_params`；訊息只含欄位路徑，不回顯內容。dispose 之後的呼叫拋 `internal`。
- 個別操作的失敗是回應內的 `{ok:false, error}`，碼取自契約 `MEMORY_ERROR_CODES`；契約沒有的碼（`CAPABILITY_*`、`SESSION_BINDING_MISMATCH`、`IDENTITY_UNBOUND`）收成 `INTERNAL`，且原始碼中沒有任何地方會產生它們。儲存層起不來時，每個 op 依實際碼（`STORAGE_*`、`DEPENDENCY_INCOMPATIBLE`）回失敗，不用 `INTERNAL`。
- remember：每個 op 依序執行，成功值只投影 `{memory:{id}, deduplicated}`。
- inspect：以整個回應 `JSON.stringify(...).length`（UTF-16 單位）60,000 為預算；超過就把 limit 對半、重查，直到符合。回 `nextCursor`（list 取 `nextCursor`，get 取 `nextReceiptCursor`）與 `appliedLimit`，呼叫端續頁必須用 `appliedLimit`。`limit` 沒給時明確用 6（與 application 預設一致）。降到 1 仍超過拋 `result_too_large`。**限制**：Cairn 的 cursor 綁定簽發時的 limit，帶 `cursor` 的續頁超過預算無法對半，同樣拋 `result_too_large`。
- 每個回應在回傳前都用 vendored 回應 schema 解析（失敗拋 `internal`）；`diagnose` 不含任何路徑，`storage.status` 為 `ready` 或小寫的錯誤碼（如 `storage_unsafe`）。
- `plugin.version` 是 `src/backend/diagnose.ts` 的常數（現為 `1.0.0`），測試會比對 `package.json` 的 version，改版時兩處一起改；manifest 的 version 由 `package.json` 帶入。
- 資料層的祖先目錄檢查只從 `dataDir` 往下走（`CairnDataLayout` 的 `trustedBase`）：`--permission` 下外掛讀不到 `dataDir` 以上的任何路徑，往上 lstat 會被拒（實測回 `STORAGE_BUSY`）。`dataDir` 以下仍拒絕 symlink／junction；`dataDir` 以上的重導向（例如 macOS `/var`）視為 host 的事。不傳 `trustedBase` 時維持從根目錄往下檢查。

## 唯讀讀取器與 agent 目錄（S1）

UI 需要 Cairn API 沒有的東西（一次列多個 namespace、內容片段、總數），所以 `src/adapters/ui/cairnReader.ts` 直接以 SQL 讀庫檔；這是唯一對 Cairn 庫檔下 SQL 的檔案，寫入仍走 Cairn API（`AGENTS.md` 有完整規則，`verify-source-untouched` 強制）。

- `readCairn(path, work)`：開檔前 `lstat` 檢查檔案存在、是一般檔、父目錄與 `-journal`／`-wal`／`-shm` 不是 symlink／junction；以讀寫模式開檔、設 `PRAGMA query_only = ON`，因為 `readOnly` 遇到 crashed writer 留下的 hot journal 會回 `attempt to write a readonly database`，讀寫模式則會先回復 journal（`test/cairn-reader-safety.test.mjs` 重現）。之後驗 `application_id` 與 `user_version = 13`，不符或不是資料庫回 `unsupported_schema`。每次呼叫開、查、關，不佔 `CoreHandlePool`。失敗回 `{ok:false, code}`，碼為 `not_found`、`unsafe_path`、`unsupported_schema`、`busy`、`unreadable`，不帶路徑。
- `list` 以 `(updated_at DESC, id ASC)` 排序，用 keyset（`after`）分頁與 `updatedFrom`／`updatedBefore` 時間窗；`get` 回完整內容與依 `(created_at, id)` 排序的 receipts。兩者與 Cairn 的 `list`／`get` 逐項相等由 `test/cairn-reader.test.mjs` 把關（含 legacy fixture），升 Cairn pin 時 parity 不過就擋下。
- `layout.listAgentDirectories()`（`CairnDataLayout`）列出 `agents/<64 位 hex>/`，不建目錄、不改 identity，對每個目錄與檔案套用和 `agentDbPath` 相同的 reparse point 檢查，狀態為 `ready`、`no_database`、`unsafe`、`unreadable`。
- `listAgents(layout)`（`agentCatalog.ts`）從 `namespace_epochs` 取 `owner_id` 與 namespace、計算每個 namespace 的未刪除筆數；0 筆的 agent 與 namespace 不列出；`owner_id` 的 sha256 必須等於目錄名（否則 `identity_mismatch`）、同一庫只能有一個 `owner_id`（否則 `owner_conflict`）；讀不了的 agent 放進 `unavailable[]` 並附原因。

## UI 契約與工具（S2）

七個 `ui.*` 方法的本體尚未實作（`uiDispatch` 只有 `ui.status` 佔位）；本節是它們共用的零件，形狀依設計 §1.3。

- `uiContract.ts`：每個方法一組請求 schema 與成功回應 schema（全部 `strict`），`UI_METHOD_SCHEMAS`、`parseUiParams`、`parseUiResponse`。時間篩選必須是 `toISOString()` 的完整形式（Cairn 的 `updated_at` 以字串比較），`scope` 與 `projectId` 必須相符，snippet 以 code point 計。失敗一律 `{ok:false, code, retryable}`，碼取自 `UI_FAILURE_CODES`。
- `budget.ts`：回傳大小是 `Buffer.byteLength(JSON.stringify(x))`（UTF-8 bytes），上限 56,000；`fitToBudget` 以二分法取「放得下的最長前綴」並回 `truncated`，連第一筆都放不下才回 `result_too_large`（不回指向同一筆的游標）。CJK 每字 3 bytes，用 `.length` 會低估。
- `cursor.ts`：游標是 `base64url(payload).base64url(HMAC-SHA256)`，payload 為版本、篩選條件雜湊與 1 到 4 段 keyset 位置；金鑰預設是行程內隨機值，所以重啟後舊游標會被拒（畫面從第一頁重來）。雜湊不含 `limit` 與 `cursor`，換頁大小仍可續頁；篩選條件不同回 `filter_mismatch`；任何字元被改、簽章被換、格式不符都拒收。
- `punchContent.ts`：以 NFKC 後的前綴 `[工作紀錄 <起>~<迄> <cli>/<model>] 請求:<標題>。成果:<內文>` 解析工作起訖（UTC 分鐘，轉成完整 ISO）、cli、model、標題；`unknown` 的 cli／model 與 `(未命名)` 標題成為 `null`，`(無文字)` 內文成為空字串。前綴格式與 Core 的 `punchMemoryContent.ts` 耦合，樣本是 `vendor/teamuq-contract/fixtures/requests/remember.work-prefix-*`（每種各有寫入形式與 NFKC 形式）。解析失敗（含只讀了內容前 160 字、標題被截斷）回 `{parsed:false, body:<原文>}`。標題本身若含「。成果:」會在該處被切開，這是格式本身的歧義。
- `jsonSafe.ts`：出口的 `JSON.parse(JSON.stringify(x))`，去掉 `undefined`、把 `NaN` 與無限大變成 `null`（preload 的 zod 會拒收前者）。

## UI 基礎（S5）

畫面（S6a～S6d）共用的零件；`main.ts` 只用它們顯示標題與 `ui.status`。

- `api/backendClient.ts`：`createBackendClient({call})` 是唯一呼叫 `window.tuqPlugin.backend.call` 的地方（`backendClient()` 綁定真的 bridge）。同時在途最多 2 個、其餘照順序排隊；同一個 key（預設是方法名，可用 `{key}` 分開，例如抽屜與同工作清單）的舊請求在新請求送出時以 epoch 丟棄，結果是 `{ok:false, superseded:true}`，排隊中的舊請求根本不送出；`ui.forget` 是寫入，永不丟棄、也不自動重試。只有平台碼 `plugin_backend_unavailable` 自動重試最多 3 次（延遲 1、2、4 秒，涵蓋冷啟動；等待期間不佔在途名額，等完若已被取代就不再送）。成功回 `{ok:true, value}`（value 是後端整個回應），失敗一律攤平成 `{ok:false, code, source, message, action, actionKind, retryable, superseded, attempts}`；參數的 `undefined` 成員在送出前移除（preload 會拒收）。
- `api/errors.ts`：平台碼（`PLATFORM_CODES`）、plugin 碼（`PLUGIN_CODES`，含契約的 `UI_FAILURE_CODES` 與預留的 `CURSOR_STALE`、`MEMORY_SUPPRESSED`、整次呼叫失敗碼）、client 碼（`superseded`、`malformed_response`、`unknown`）各對應一句白話加一個建議動作（字串在 `i18n/zhTW.ts`）；`UI_FAILURE_CODES_COVERED` 讓契約新增碼而這裡沒補時 `tsc -p tsconfig.ui.json` 直接失敗。`codeFromThrown` 從 Electron 包過的 ipc 錯誤訊息裡找碼；`isCursorReset` 判斷要從第一頁重來的碼。
- `dom/html.ts`：`html` 模板標籤與 `esc()`。插值在文字位置一律跳脫（巢狀 `html` 片段與陣列除外）、在有引號的屬性值位置跳脫；tag 名、屬性名、無引號屬性值、註解、`<script>`／`<style>` 內插值都直接 throw，`on*` 事件屬性連靜態寫也 throw；URL 屬性開頭的 `javascript:`／`data:`／`vbscript:` 換成 `#`；`style` 屬性只收數字或 `[A-Za-z0-9#%.- ]`。`SafeHtml` 只有 `html` 能產生（`new` 一個會 throw），`mount()` 是唯一寫 `innerHTML` 的地方。
- `components/dialog.ts` 與 `dialogFocus.ts`：`openDialog`／`confirmDialog`。`role=dialog|alertdialog`、`aria-modal`、`aria-labelledby`／`aria-describedby`；Tab 與 Shift+Tab 在 dialog 內循環、焦點跑到外面就拉回；Esc 與點背景關閉（`dismissible:false` 時兩者都不關）；背景元素可傳入並設 `inert`；關閉後焦點回到開啟前的元素，該元素已不在時回 `returnFocusTo`。`initialFocus` 指定動作 id 或內文元素 id；沒指定或找不到時，落在第一個「非 danger」的可聚焦元素，全是 danger 就落在 dialog 本身，所以遺忘確認即使沒設定也不會預設在破壞性按鈕。同時只能開一個。
- `i18n/`：`STRINGS`（繁體中文、台灣用語，不用「程序」與大陸用語）與 `t(key, params)`；`{name}` 佔位。
- `styles/tokens.css` 與 `tokens.lock.json`：由 `npm run tokens:sync -- --core <TeamUQ 路徑>` 從 Core 的 `apps/desktop/src/renderer/styles/base.css` 產生（Core 該檔有未提交變更就拒絕），lock 記來源 commit、檔案雜湊、兩套值與輸出雜湊；`npm run tokens:verify`（在 `npm run check` 內）離線檢查 css 沒被手改；`tokens:sync -- --core <路徑> --check` 比對 Core 有沒有漂移。深淺色只有 `:root{color-scheme: light dark}` 加一個 `@media (prefers-color-scheme: dark)`，沒有 `data-theme`。plugin 自有的 token：`--link`、`--text-secondary-strong`（Core 的 `--text-secondary` 在 `--surface-muted` 上只有 4.33:1）、`--accent-fg`（Core 的 `--on-accent` 在 `--accent` 上只有 2.46:1）、`--danger-fg`、`--font-ui`。`--text-muted`、`--accent-hover`、`--accent`、`--on-accent` 不得當文字色；焦點外框用 `--link`（`--accent` 對白底不到 3:1）。`test/ui-contrast.test.mjs` 對兩套配色算對比並掃 `app.css` 的 `color:`。
- `bundleUi` 用 esbuild 把 `styles/app.css`（`@import "./tokens.css"`）打成單一 `ui/app.css`，因為 view 只准連結 `app.css`。
- 測試：`test/uiHarness.mjs` 以 esbuild 把 `src/ui` 的 TypeScript 打成暫存 ESM 供 node 測試載入（同一次載入的模組共用一份打包，否則 `SafeHtml` 的身分檢查會跨份失敗）；`test/fakeDom.mjs` 是 dialog 用的最小假 DOM。

## 契約 vendor

`vendor/teamuq-contract/` 是 TeamUQ `packages/features/agent-memory/contract/v1/` 的副本，Core 是唯一權威，禁止手改。

| 檔 | 說明 |
|---|---|
| `contract.mjs`、`contract.d.ts`、`fixtures/**`、`lock.json` | 逐檔自 Core 複製（CRLF 正規化為 LF） |
| `contract.d.mts` | 本 repo 加的一行橋接（tsc 把對 `contract.mjs` 的 import 解析到 `.d.mts`），列在 `vendor.lock.json` 的 `pluginOwnedFiles` |
| `vendor.lock.json` | Core commit（HEAD）、最後改到契約目錄的 commit、Core `lock.json` 的 sha256、每個 vendored 檔的 sha256 |

- 同步：`node tools/sync-vendor.mjs --core <TeamUQ 路徑>`。先驗 Core 的 lock（每檔 hash、無多餘檔、方法清單、pluginId；方法清單現為 `memory.remember@1`、`memory.inspect@1`、`diagnose`、`memory.profile.sync@1`，後者本 plugin 尚未服務，呼叫端會得到 `unknown_method`），且契約目錄不得有未提交變更；再重寫 `vendor/teamuq-contract/` 與 `src/backend/vendoredContractLock.ts`（`diagnose.contractLockSha256` 的來源）。
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

## 打包與簽章（P3）

```powershell
node tools/build.mjs                        # 暫時金鑰簽章（--anchors self），產出 dist/teamuq.memory-1.0.0.tuqplugin
node tools/build.mjs --stage-only           # 只做 stage 與 devkit validate
node tools/build.mjs --key <file.key.pem>   # 真金鑰：互動輸入 passphrase，預設 --anchors core
node tools/verify-artifact.mjs dist/teamuq.memory-1.0.0.tuqplugin --pub-file dist/signer.pub.json
```

build 依序：`verify-source-untouched`、`contract:verify`（含 devkit lock）→ esbuild 打 `stage/backend.mjs`（zod 內聯；`cairn-memory/core/index.mjs` 改成外部相對路徑 `./cairn/core/index.mjs`，其他 `cairn-memory` import 一律報錯）→ `stage-cairn` → 由 `plugin/manifest.template.json` 產 manifest → devkit `validate` → `release`（devkit `pack`＋`verify`）→ `verify-artifact`。

| 產物內容 | 說明 |
|---|---|
| `backend.mjs`、`cairn-pin.json` | 同目錄（`resolvePinPath` 的規則）；pin 檔以 LF 寫入 |
| `cairn/core/**` | 56 檔，排除 `core/test` 與 `core/testing`（沒有任何執行期 import；`verify-artifact` 會檢查每個 staged `.mjs` 的相對 import 與 `new URL` 資產都解得到） |
| `cairn/plugins/cairn-memory/lib/redact.mjs`、`cairn/LICENSE` | 保留 `core/validation.mjs` 需要的相對路徑 |
| `ui/index.html`、`ui/app.js`、`ui/app.css` | `bundleUi`：esbuild 把 `src/ui/main.ts` 打成 IIFE `app.js`（不得拉進 node_modules）；`index.html` 來自 `plugin/ui/`、`app.css` 由 `src/ui/styles/app.css` 連同 `tokens.css` 一起打包。`verify-artifact` 對這三檔做 CSP 安全掃描（無 inline script／事件屬性／`javascript:`、`eval`、`new Function`、`http(s)://`、`fetch(`、`WebSocket`） |
| `manifest.json`、`integrity.json`、`signature.json` | manifest 見下；後兩者由 devkit 產生 |

- `cairn-pin.json` 的 `stage` 記錄每個 Cairn 檔的路徑與 sha256（共 58 筆）。`verify-source-untouched` 比對「node_modules 的檔案集合與雜湊」等於「pin 記錄」；升 Cairn 後跑 `node tools/stage-cairn.mjs --record` 重寫，再讀 diff。
- manifest（composed）：id `teamuq.memory`、publisher `teamuq`、`trustTier: full-trust`、`entry.ui: ui/index.html`＋`entry.backend: backend.mjs`、`contributes.views` 一個 view（id `memory`、標題「記憶」、presentations `tab`＋`fullpage`、預設 `tab`）、`permissions: ["ui:view","backend:invoke"]`、`backendMethods` 為七個 `ui.*`（不得含 `memory.*`）、`data.uninstall: keep`、`pluginApi ^2.0.0`、`minCoreVersion >=1.6.3`（1.6.3 是第一個含白名單 `invokeBackend`、接受 `@` 的 methodName 與走 invoke 的記憶 sink 的 Core；1.6.0～1.6.2 會通過 manifest 檢查但不會有人呼叫本 plugin，`verify-artifact` 斷言此值）、`platforms` 不限（純 JS 加 `node:sqlite`，無原生檔）。資源：`memoryMB 512`、`cpuThreads 1`、`maxSessions 4`（UI 與 Core sink 共用的在途呼叫上限）、`idleUnloadSec 180`、`bootTimeoutSec 30`（S0 建議 256～512、10～30；S0 實測 RSS 約 110～120 MB，冷啟動約 150～300 ms）。
- devkit：`vendor/teamuq-devkit/tuq-plugin-tool.mjs` 是 TeamUQ `npm run build:plugin-devkit -- --out <路徑>` 的產物，禁止手改；`devkit.lock.json` 記 Core commit、Core 版本與 sha256（CRLF 正規化為 LF 再雜湊）。更新：`npm run devkit:sync -- --core <TeamUQ 路徑>`（Core 內嵌來源有未提交變更時拒絕）。`release`、`build`、`verify-artifact` 執行前都會比對 lock。
- devkit 內嵌當下 Core 的 `TEAMUQ_TRUST_ANCHORS`：現為 `teamuq-root-2026a`、`teamuq-root-2026b` 兩把公鑰（Core 1.6.3，含 `--preplanted-id` 的 commit 記在 `devkit.lock.json`）。Core 的 anchors 再變動就必須重跑 `devkit:sync`。

### 簽章與金鑰

- `release.mjs` 包裝 devkit `pack`（再以另一個行程 `verify`），拒絕位於本 repo 內或任何 git 工作樹內的金鑰路徑，並拒絕 devkit 檔與 lock 不符。真金鑰的 passphrase 只能在互動終端機輸入；環境變數 `TEAMUQ_KEY_PASSPHRASE_FOR_TESTS` 只在 `build.mjs` 為暫時金鑰注入時才傳給 devkit，其餘情況一律移除。
- 暫時金鑰（`tools/temp-key.mjs`）：`os.tmpdir()` 下的隨機目錄、隨機 passphrase、keyId `teamuq-tmp-<8 hex>`，用完即刪；只留公鑰在 `dist/signer.pub.json`。產物只能用 `--anchors self` 驗章，真的 Core 不接受。
- **`teamuq.` 前綴與 `--anchors self`**：Core 的 `assertSignerMayInstall`（`reviewArtifact.ts`）只認簽署者種類：非 `dev-` 的 keyId 落在 anchors 的 `rootKeys` 就是 `teamuq` 簽署者，可安裝 `teamuq.` 前綴的 id。devkit 的 `--anchors self` 把「目前這把金鑰」當唯一的 rootKey，所以 `teamuq.memory` 通得過 pack 自我檢查與 `verify`（keyId 須非 `dev-` 開頭，暫時金鑰已符合）。Core 現行 `TEAMUQ_TRUST_ANCHORS` 仍是空的，同一份產物在真的 Core 會回 `signer_unknown`（e2e 有斷言）。安裝測試以測試 anchors 注入暫時金鑰，未改 Core。

### 正式簽章（H2）

只由持有根金鑰的使用者在**真實終端機**（Windows Terminal／PowerShell 視窗，不是管線、不是 AI 工具的 shell）執行；金鑰檔、passphrase 不進 repo、不交給任何 AI 工具。

```powershell
cd C:\teamuq\teamuq-plugins\memory
node tools/build.mjs --key C:\Users\david\.teamuq-keys\teamuq-root-2026a.key.pem
```

- 出現 `Passphrase for teamuq-root-2026a:` 時輸入 passphrase（不顯示字元），Enter；**120 秒內**要輸入完（devkit 子行程的逾時）。
- 不帶 `--anchors`，預設 `core`：金鑰 keyId（取自檔名）必須是 devkit 內嵌的兩把之一，否則在問 passphrase 之前就拒絕。
- 產物 `dist/teamuq.memory-1.0.0.tuqplugin`；`dist/build-info.json` 記 `anchors: "core"`、`signer.keyId: "teamuq-root-2026a"`。`dist/signer.pub.json` 若存在是舊暫時金鑰的殘留，正式產物不使用。
- 驗證：`node vendor/teamuq-devkit/tuq-plugin-tool.mjs verify dist/teamuq.memory-1.0.0.tuqplugin --anchors core`，必須 exit 0 且 `signer.keyId` 為 `teamuq-root-2026a`；也可用 `node tools/verify-artifact.mjs dist/teamuq.memory-1.0.0.tuqplugin --anchors core`。
- 錯誤：`is inside this repository` 表示金鑰路徑在 git 工作樹內（搬到 repo 外）；`could not be decrypted` 是 passphrase 錯；`signature_invalid` 表示該檔不是 Core 內嵌的那把私鑰；`interactive terminal is required` 表示不在真實終端機。環境變數 `TEAMUQ_KEY_PASSPHRASE_FOR_TESTS` 對真金鑰無效（`release.mjs` 一律移除）。

### 開發迭代：`npm run dev:pack`（開發金鑰，隔離 Core dev profile）

改 plugin 時不必每輪用 TeamUQ 根金鑰簽章。Core 在**未封裝的 dev build 且 `TEAMUQ_DEV_ISOLATION_ROOT` 通過驗證**時，接受「該隔離 profile 已匯入的開發金鑰」簽的 `teamuq.memory`：可安裝、可取代預植的官方版、可通過記憶 invoke gate；打包版與沒設隔離的 dev 照舊拒絕（細節與限制見 Core 的 `docs/plugin-developer-guide.md` 3.1）。

```powershell
# 一次：產生開發金鑰（私鑰放 repo 外，互動輸入至少 16 字元的 passphrase）
node vendor/teamuq-devkit/tuq-plugin-tool.mjs dev-keygen --out-dir $env:LOCALAPPDATA\TeamUQ\plugin-dev-keys

# 每輪：stage、devkit dev-pack --bump-patch --preplanted-id teamuq.memory、自我 verify
npm run dev:pack -- --key $env:LOCALAPPDATA\TeamUQ\plugin-dev-keys\<dev-keyId>.key.pem
```

- 輸出固定在 `dist/dev/teamuq.memory.tuqplugin`（`--out` 可改，但要沿用同一個路徑）：第一次版本是 `package.json` 版本加一個 patch（1.0.1），之後每次依既有檔遞增；stage 在同層 `stage/`。`dist/` 不進版控。
- 金鑰檔必須叫 `dev-<16 碼 hex>.key.pem`，旁邊要有 `.pub.json`；release 金鑰（`teamuq-…`）、repo 內的金鑰路徑都會被拒。passphrase 只在互動提示輸入，不接受參數。
- 到 Core：以隔離 profile 啟動 dev build，設定 → 外掛 → 開發者匯入 `.pub.json` 的公鑰，再選取 `dist/dev/teamuq.memory.tuqplugin` 安裝。第一次是取代預植的官方版（走更新流程，版本要較新），之後是同一把金鑰的原地更新；換金鑰或想回官方版要先移除再從「預植外掛」還原。
- 只有 `dev:pack` 帶 `--preplanted-id teamuq.memory`；`build` 與 `release` 的行為不變，正式簽章仍照上面的 H2。`dev:pack` 的產物帶開發簽章，Core 的打包版一律拒絕。
- 沒有 TTY（CI、agent、一次性證明）時用 `npm run dev:pack -- --temp-key`：以暫時開發金鑰簽章並在結束時刪除，輸出 JSON 帶 `throwawayKey.publicKey`；只適合單次驗證，之後的更新要用同一把金鑰才能過簽章者鏈。`dev:pack` 出檔前會以 `verify-artifact --dev` 自我檢查（含 CSP 掃描），不合格就 exit 1。`node tools/verify-artifact.mjs <檔> --pub-file <.pub.json> --dev` 可單獨檢查 dev-pack 產物。
- 開發版 manifest 的版本是 1.0.x 遞增，`diagnose` 回報的 `plugin.version` 仍是 `src/backend/diagnose.ts` 的常數，兩者在開發版本不一致是預期的。
- devkit 必須是含 `--preplanted-id` 的 Core 版本：目前 vendor 的是 Core worktree `task/ext-mem-devtrust` 的 commit（見 `devkit.lock.json`）；合回 V1 後 commit 雜湊改變，重跑 `npm run devkit:sync -- --core <TeamUQ 路徑>`。

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
| `npm run contract:sync -- --core <路徑>` | 自 Core 重新 vendor 契約（寫入檔案）；`node tools/sync-vendor.mjs --core <路徑>` 不帶 `--only` 則契約與 devkit 都同步 |
| `npm run verify:source` | 驗證 lock／package 的 Cairn pin、`core/` tree hash、`redact.mjs` sha256、唯一 import 位置 |
| `npm run check:secrets` | 找私鑰區塊、`*.pem`／`*.key`／`keys/`，並確認 `.gitignore` 仍排除它們 |
| `npm run build` | 見「打包與簽章」，輸出到 `dist/`（gitignored） |
| `npm run dev:pack -- --key <dev key>` | 見「開發迭代」：以開發金鑰打出 `dist/dev/teamuq.memory.tuqplugin`（版本逐次遞增），只給隔離 Core dev profile |
| `npm run devkit:sync -- --core <路徑>` | 重建並 vendor devkit（`contract:sync` 只同步契約） |

## 金鑰

私鑰、`*.pem`、`*.key`、`keys/` 不進 repo（`.gitignore` 排除、`check-no-secrets` 把關）。正式簽章金鑰由使用者自行保管。
