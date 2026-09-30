# teamuq-plugin-memory — agent rules

本檔只列強制規則，一條一行。設計依據：`C:\teamuq\teamuq-electron\output\memory-hook-mcp\external-plugin-design-v3.md`。

- 本 repo 是 TeamUQ 記憶系統的獨立外部 plugin（id `teamuq.memory`，full-trust）；只建本機 repo，不建遠端、不 push，除非使用者明確要求。
- `src/{application,domain,adapters}` 自 TeamUQ `packages/platform/memory-server` 原樣搬出；來源 commit 與 tree hash 記在首個 commit 訊息。改動只限本 repo 需要的 import 路徑，不順手重構。
- 唯一可 import `cairn-memory` 的檔是 `src/adapters/cairn/cairnCoreAdapter.ts`，且只走 `cairn-memory/core/index.mjs`；由 `tools/verify-source-untouched.mjs` 把關。
- 只有 `src/adapters/ui/cairnReader.ts` 可以對 Cairn 庫檔下 SQL，且只讀：開檔一律讀寫模式加 `PRAGMA query_only = ON`（不用 `readOnly`，否則 hot journal 無法回復）、先確認檔案存在並拒 symlink／junction、`application_id` 必須 `0x43414952` 且 `user_version` 必須 13（否則 `unsupported_schema`）、每次呼叫開、查、關（同一次 UI 呼叫內可重用已開的庫，呼叫結束一定關）且不佔 `CoreHandlePool`。`upgradeBackup.ts`（G7 備份的 `VACUUM INTO` 與備份檔 `integrity_check`）與 `diagnose.ts`（只開 `:memory:` 查 sqlite 版本）是既有例外，不得擴大；`tools/verify-source-untouched.mjs` 強制這份名單、reader 的只讀條件，並有負向測試（`test/sql-boundary.test.mjs`）。升 Cairn pin 時 `test/cairn-reader.test.mjs` 的 parity 不過就擋下。
- Cairn 由 `cairn-pin.json` 釘死：升 commit 前先讀 diff，更新 `commit`、`coreTree`、`redactSha256`，並把相容的 commit 放進 `accepted[]`；`package.json` 與 lock 必須同步。
- 每個 `accepted[]` 項目都必須有 `test/fixtures/legacy-db/<commit>/` 真實舊庫 fixture（`tools/make-legacy-fixture.mjs` 產生）；備份失敗一律回 `STORAGE_BUSY`、不得回 `INTERNAL`。
- `vendor/teamuq-contract/` 是 TeamUQ Core 契約的副本，禁止手改；只用 `tools/sync-vendor.mjs --core <TeamUQ 路徑>` 更新，`npm run contract:verify` 必須 exit 0。
- `src/backend/` 只服務 `memory.remember@1`、`memory.inspect@1`、`diagnose` 與 `ui.*`（七個 UI 方法，名單在 `src/contracts/uiContract.ts`，只由 view 經 `window.tuqPlugin.backend.call` 呼叫）；manifest 的 `backendMethods` 只准列 `ui.*`，不得列 `memory.*` 或 `diagnose`（`verify-artifact` 斷言）；`ui.*` 的預期錯誤回 `{ok:false, code, retryable}`，不 throw；其碼只能取自 `src/contracts/uiContract.ts` 的 `UI_FAILURE_CODES`（游標不能用一律 `CURSOR_STALE`，畫面必須從第一頁重來）。整次呼叫失敗的碼只能是 `unknown_method`、`invalid_params`、`result_too_large`、`internal`；`memory.*` 個別操作的錯誤碼只能取自契約 `MEMORY_ERROR_CODES`。
- `ui.*` 的回傳大小一律以 UTF-8 bytes 計、上限 56,000（`src/application/ui/budget.ts`），不得用 `.length`；出口一律經 `jsonSafe`；分頁游標只用 `src/application/ui/cursor.ts`（簽章加篩選雜湊，不用 Cairn 游標）；工作紀錄前綴只由 `punchContent.ts` 解析，Core 改前綴格式前要先在 `contract/v1/fixtures` 加樣本。
- `ui.*` 的讀取一律經 `src/application/ui/agentIndex.ts` 的索引：內容是 namespace 的筆數、首末時間與完整更新時間序列；有效條件是行程內 dirty 世代（`memory.remember@1` 與 `ui.forget` 在 `finally` 呼叫 `markDirty(agentId)`；**新增任何寫 Cairn 庫的路徑都必須一併標記**）加庫檔 mtime＋size。UI 掃描一律經 `timeSlice.ts`：每 15 ms（設計上限 25 ms）用 `nextTurn()` 讓出（一個事件迴圈 turn 只放行一個等待者）、單次呼叫 4 s 上限、逾時只回精確的前綴並附續頁游標；單一同步查詢不得超過一塊（`cairnReader.ts` 的 `SCAN_CHUNK_ROWS`）。`readCairn`／`openCairn` 開的庫在一次呼叫內可重用，呼叫結束必須關閉，閒置時不得持有 statement 或交易。
- 效能改動要在 10k 筆、100 個 agent 的資料集上跑 `npm run perf:ui -- --data <目錄>`（node 與 Electron run-as-node 都跑），overview ≤1 s、list ≤0.5 s（索引建好後）、search ≤1.5 s、事件迴圈最長停頓 ≤50 ms，並行寫入 0 錯誤；資料集用設計目錄的 `gen-dataset.mjs` 在 repo 外產生，用完刪除。
- 私鑰、`*.pem`、`*.key`、`keys/` 永不進 repo，也不進 agent context；`tools/check-no-secrets.mjs` 必須 exit 0。`tools/release.mjs` 拒絕 repo 內或任何 git 工作樹內的金鑰路徑；只用暫時金鑰（`tools/temp-key.mjs`，用完即刪）驗證，正式金鑰由使用者親手簽章。
- 測試檔（`test/*.test.mjs`）在測試執行期間不得寫 stdout（`console.log`／`process.stdout.write`／子行程 inherit stdout）；附註走 `console.error` 或 `t.diagnostic()`。
- 新程式檔 ≤500 行；不新增 `utils`、`helpers`、`common`、`misc`。
- 程式碼內不寫檔頭 banner、不重述程式碼、不寫批次／輪次／commit 歷史；理由只寫 `// why: <一行>`。
- 只在本 repo 目錄內執行 `npm install`，且一律 `--ignore-scripts`；不平行安裝。
- `vendor/teamuq-devkit/` 是 TeamUQ devkit 的單檔副本，禁止手改；只用 `npm run devkit:sync -- --core <TeamUQ 路徑>` 更新，`contract:verify` 會比對 `devkit.lock.json`。Core 的 `TEAMUQ_TRUST_ANCHORS` 一變就要重跑。
- `cairn-pin.json` 的 `stage` 記錄打包進 artifact 的 Cairn 檔案與 sha256；升 Cairn 後跑 `node tools/stage-cairn.mjs --record`。`tools/verify-artifact.mjs` 與 `tools/build.mjs` 不得放寬檔案集合、雜湊、無 `core/test`、相對 import 可解析的斷言。
- 資料層路徑檢查只能從 `dataDir` 往下（`trustedBase`），不得往上讀祖先目錄：`--permission` 下外掛讀不到 `dataDir` 以上的路徑。
- UI（`src/ui/`）只用純 TypeScript 由 `tools/build.mjs` 的 `bundleUi` 打成 `ui/app.js`；`plugin/ui/index.html` 只能引用外部 `app.js` 與 `app.css`。view 的 CSP 不允許 inline script、`eval`、blob worker、外部連線，因此 UI 檔不得含 inline script／事件屬性、`eval`、`new Function`、`http(s)://`、`fetch(`、`WebSocket`（`verify-artifact` 掃描）。`src/ui` 由 `tsconfig.ui.json`（lib DOM）檢查，backend 的 `tsconfig.json` 排除它；`types/tuq-plugin-sdk.d.ts` 只用 `npm run types:sync` 產生。
- 驗證入口：`npm run check`（`tsc -p .`、`tsc -p tsconfig.ui.json`、`node --test`、`contract:verify`、`verify-source-untouched`、`check-no-secrets`）。
