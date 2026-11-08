# teamuq-plugin-memory：TeamUQ 記憶外掛

TeamUQ 記憶系統的獨立外掛 repo（id `teamuq.memory`，版本 1.4.4，full-trust）。後端、Cairn adapter、UI 與作者端打包工具都在此 repo；使用公開 Devkit 1.8.2，釘選 Cairn e3e3761（套件版本 0.3.3，預設 schema 18）。

> 驗證範圍是本機外掛、公開 devkit、Cairn 與 mock host/model。候選包只用暫時測試金鑰；正式簽章由使用者自行執行。此工作不讀取或啟動 TeamUQ 主程式，也不代表已通過實機 host 或真實模型驗證。

## 工作紀錄與 AI 整理

外掛從公開 `host.workRecords.readPage` 讀取已結算 punches。第一頁同時取得 snapshot 並保留資料，後續頁面固定 snapshotId、generation、highWatermark；重複 cursor 或 snapshot 改變會停止該次同步，稍後重試。`punchId` 保留在本機收據與工作來源，並產生固定的原始寫入與 capture 身分；agentId/projectId 決定記憶 scope，sessionId 用於來源關聯。name 是請求，description 是成果，Lexical JSON 沿用既有純文字轉換。

原始工作紀錄先以 `context` 儲存，再將整理工作持久化，最後確認同步收據。同步收據/checkpoint 位於 `<dataDir>/punch-state.json`，整理佇列位於 `<dataDir>/punch-organization.json`；兩者拒絕 symlink/junction、檢查 revision，先寫 tmp、fsync 後原子 rename。整理檔沿用 `{version:1, records}`，只新增選填的 `organizationResume` 版本 1 與 `organizationQueueSequence`，不建立 SQL table 或匯入 host 私有資料。舊版無映射的 pending job 會保留來源訊息並標記 `legacy_unlinked`，不會自動送模型；舊 claim／已完成工作不重播。只有 claim、沒有相容 round snapshot 的舊日期仍算已消耗，當天只允許精確配對的本機 reply commit recovery，不重新開 AI round。每日 round 在本機日期 claim 與原子佇列序號高水位建立固定快照；重啟接續同一 `roundId`，逐筆繼續未嘗試工作，安全的 reply-ready commit recovery 可以當天接續，已失敗的模型工作與快照後新工作留到下一個每日 round。round metadata 正常最多保留 32 筆並保留當前 open round；較早未完成 round 會在新日期 supersede，pending job 與 operation reply journal 獨立保留。claim 日期另有單調 `throughDate` 高水位，因此時鐘回撥不會重開已消耗日期。舊 host pluginState 的收據與 checkpoint 只讀遷移；`plugin_state_retired` 允許直接使用本機狀態，其他讀取失敗或收據衝突會停止並保留資料。相符的舊寫入收據會重建整理工作，已存在的工作保持原始來源不變。

設定頁可選 `organizationFrequency` 的「每天一輪」或「即時整理」，並設定 `organizationDailyTime`（嚴格 `HH:mm`、本機時區）；預設每天一輪、本機時間 02:00。即時模式會在工作紀錄同步後整理等待項目，並沿用逐筆退避與重試，不建立 daily claim。每日時間在即時模式停用但保留，切回每天一輪仍可使用。現有主機 settings API 逐 key 儲存；設定頁先寫入不會觸發錯誤輪次的欄位，目標為每天一輪時先保存時間、再切換頻率，目標為即時時先切換頻率、再保存時間；停用狀態的設定會在重新啟用前先完成。設定只在各 key 讀回確認後回報儲存，部分失敗會保留未確認草稿。

`organizationEnabled` 預設為 true；未設定時自動啟用，使用者明確設定 false 時仍尊重停用選擇。每日模式的背景 worker 到達設定的本機時間後開始一輪，逐筆經 `MemoryApplication.memory_capture`、唯一 Cairn adapter 與公開 host.ai 整理；單輪可呼叫模型多次。若設定時間時外掛尚未啟動，當天首次 punch catch-up 成功完成後會補跑一輪；同步暫時失敗時先保留每日啟動 gate，避免空輪先取得當日 claim。即時模式不等待每日 gate。入列、輪詢、設定變更或重啟不能開啟已 claim 日期的第二輪；停用時不 claim，設定時間後重新啟用且當天尚未 claim 時可跑當日補跑輪。切換模式或改時間不清除已保存的每日 claim；即時切每日時，當前模型操作可完成，下一筆才依每日時間和 gate 判斷。請求用 user 訊息、成果用 assistant 訊息。原始 context 保留；模型產生的記憶 receipt 指向固定的 punch 來源訊息與原 session。整理前在共用 agent 寫入佇列中確認來源尚未遺忘。整理完成或來源遺忘後清除佇列中的來源文字；失敗、中斷與輪次後入列的工作保留 pending 供下一個符合條件的日期處理。每日模式失敗的工作留到下一個可執行日期；即時模式的模型不可用、額度不足、取消或失敗仍記錄錯誤與退避（30 秒至一小時），並依即時模式重試。重啟或完成收據寫入失敗後，以 Cairn 的持久 capture 身分避免重複 extraction。擷取已完成但 Cairn 分類失敗時記錄警示，不重播已完成擷取。

提供者與模型 ID 可留空使用可用預設值，指定 ID 不可用時暫停，不使用 astra。設定頁的兩個欄位是下拉選單（選項來自 `window.tuqPlugin.ai.getOptions()`，astra 不列出），`getOptions` 不存在、失敗或逾時（8 秒）時退回文字框；存下的值仍是 ID 字串。`organizationContextBudget` 是 UTF-8 bytes 的保守預算（預設 32,768），並非精確 token 數或模型 context window；Cairn 另限制每次模型輸入 6,000、輸出 1,024 個計數單位。整理來源採固定前綴：請求最多 300 UTF-16 units/900 bytes、成果最多 1,200 units/2,400 bytes，保持完整字元；完整的原始工作紀錄仍依既有 3,600 units 規則儲存。真實模型限制與整理品質需另行實測。

`ui.status.organization` 是選填欄位，分開回報 source admitted、pending、reply-ready、committed、`legacy_unlinked`、錯誤 phase 與 host error code；預設狀態列提供短計數，細節以鍵盤/touch 可展開。Host 可選的 `workRecords.readSnapshotDiagnostics({snapshotId})` 只回該 plugin 快照的掃描、schema-skip 與高水位計數，未支援或過期時顯示未知，不阻擋有效 work-record page、AI、CRUD 或每日排程。關閉或 AI 不可用時明確記憶讀寫仍可使用。dispose 取消 host AI、等待 workers/名稱更新，再關閉 Cairn handles。此次只接工作紀錄 capture，未提供 Cairn episodes、確認審閱或 session-context 的新 UI/API。

舊格式記憶庫升級：`ui.upgradeLegacy`（`{skip?: agentHash[≤200], limit?: 1–10}`，預設 5）只由總覽橫幅的「升級」確認框（`initialFocus` 在「取消」）呼叫，是寫入方法，不自動重試。可升級＝被 reader 判為 `unsupported_schema`、檔頭 `application_id` 為 Cairn 且 `user_version` < 18、`identity.json` 的 `agentHash` 等於資料夾名稱且 `cairnCommit` 在 `accepted[]` 內的庫（檔頭用位元組讀取判斷，不下 SQL）；損毀、較新、來源不明的庫不算。逐庫走既有路徑：G7 備份（失敗回 `STORAGE_BUSY`、不升級）→ `openCairnCore` 開庫由 Cairn 自己遷移 → 以 reader 確認可讀 → 改寫 `identity.json`；每庫（含失敗）在 `finally` 呼叫 `markDirtyHash`，單庫失敗不影響其他庫。回應 `{upgraded, failed, results[], remaining}`，畫面把失敗的 hash 放進下一次的 `skip` 迴圈到 `remaining===0`；`ui.overview.storage.upgradableAgents`（選填）是橫幅用的可升級位數。

舊佇列小量試跑：`ui.legacyTrial`（`{action:"start", requestId, count 1–50}` 或 `{action:"stop", requestId}`）只由狀態列的「小量試跑…」確認框（5、20、50 筆）呼叫，是寫入方法，不自動重試。只接管 `legacy_unlinked`、pending、`attempts===0`、`lastError===null`、輸入格式正確、沒有 journal 的 job（有 journal 的計入 `skippedAmbiguous`）；以 agent 輪流、同一 agent 依 key 排序挑選，在同一次檔案寫入補上 `queueSequence`、`resumeDisposition:"eligible"`、`adoptedBatchId`、`adoptedAt`，並寫入頂層選填欄位 `organizationTrial`（降回舊版不會壞）。相同 `requestId` 回上次結果、不寫檔；進行中再開始回 `trial_running`。試跑列不等每日輪次、當天輪次已完成也照送，每筆只送一次；連續失敗 3 次、`MODEL_NOT_CONFIGURED`／`MODEL_POLICY_DENIED` 或 quota／policy／task_binding 階段會自動停止，沒試的退回 `legacy_unlinked`。停止是協作式：做完目前這筆才退回。`ui.status.organization` 另有選填的 `legacyTrialCandidates` 與 `trial`（計數全由 job 列推導）。回應欄位 `candidates` 是這次呼叫處理完之後仍可被試跑選取的 job 數（剛接管的不再計入），與 `legacyTrialCandidates` 同義，確認框顯示的筆數也是這個數。這一版不含背景常駐，也不處理 `attempts>0` 的舊 job。

每次 capture 以原始 `(canonical agentId, projectId|null)` 綁定 Cairn host session；TeamUQ 管理 Task ID 只作 host 關聯，不當來源專案識別。session 的固定 system 是 pair-neutral protocol；每個 turn 都攜帶當次 Cairn operation、system/output schema、callKey 與 input。v2 callKey 同時綁定 operation system/schema、request 與 occurrence；舊版 key 僅在保存的 model operation/system/request/occurrence 完全相符時相容，模糊或不符的舊 call 會停止等待核對，不重送。若 host 回報 `closedSessionResume`，重啟後才以原 sessionId attach 並核對有效 provider/model；舊 host、過期 session、權限失效或未知 send 都顯示降級階段，不自動開新 session 重送。Host `completed` 不是持久化回覆；需收到 matching turn 的 `contentSaved` sequenceNo 後才保存 bounded reply checkpoint，再交 Cairn 驗證 schema 並以穩定 operationId commit。`items:[]` 經 Cairn 驗證後是 `empty_success`，整理 job 完成且新記憶數為零；JSON 解析成功本身不算 Cairn schema 成功。

模型回覆 journal 與 session map 只存於 plugin-owned `punch-organization.json`，限制每回覆 16 KiB、每 operation 256 KiB、未完成回覆合計 1 MiB；Cairn job 結束與 operation journal 移除在同一本機原子提交中完成。超過 7 天仍未完成的 recovery 保留資料並顯示待操作員核對，不會靜默丟棄。Host 擁有 conversation text 與權限授權；本機 UI、診斷、telemetry 不顯示 session／turn／source ID、模型 prompt 或回覆文字。

已知限制：某個 operation 先 turn 逾時、其 host session 的 close 又逾時後，該 pair 的未完成 operation 會被擋住（`RESOURCE_BUSY`／`session_resume`），也不會 resume 舊 session，直到超過 7 天的 `operator_reconcile` 才解開；這是以資料不遺失為優先的取捨。

## 目錄

```
src/backend/            外部後端入口：entry（activate）、service（派送與生命週期）、rememberCall、inspectCall、uiDispatch、profileSync（名稱表推送）、diagnose、contractErrors
contract/v1/             memory contract、types、fixture 的 plugin-owned 唯一來源；vendor 由 contract:sync 生成
vendor/teamuq-contract/ memory contract 的生成快照（contract.mjs、型別、fixtures、lock）＋ vendor.lock.json
vendor/teamuq-devkit/   公開 devkit 作者 CLI、lib capability client 與 devkit.lock.json
plugin/                 manifest.template.json（composed，版本由 package.json 帶入）、ui/index.html（只引用 app.js、app.css）
src/ui/                 view 的純 TypeScript（main.ts → ui/app.js；api/{agentAvatarClient,backendClient,errors}.ts、dom/html.ts、components/{dialog,drawer,avatar,sparkline}.ts、state/teamHome.ts、views/（團隊首頁、狀態列、記憶空間、時間軸與搜尋、詳情與遺忘）、router.ts、i18n/、styles/{app.css,home.css,tokens.css,tokens.lock.json}）；tsconfig.ui.json 檢查（lib DOM），tsconfig.json 排除
src/contracts/uiContract.ts  九個 ui.* 方法名單、請求與回應的 zod schema、錯誤碼（backend 與 UI 共用；UI 只 import 型別）
src/application/ui/     七個方法的本體（overview、agentStats、listing、detail、forget、status）與零件：agentIndex（agent 索引與快取）、collect（跨 namespace 掃描）、timeSlice（時間片）、budget（UTF-8 bytes 預算）、paging、cursor（無狀態 keyset 游標）、punchContent（工作紀錄前綴解析）、textQuery、workItem、dayBins、profilePort（名稱表介面）、profileTable（生效中的名稱表）、profileGeneration、names（名稱合併與降級）、jsonSafe（出口）
types/                  devkit `types` 指令產生的 tuq-plugin-sdk.d.ts（`npm run types:sync`）
src/adapters/cairn/     Cairn core adapter（唯一 import cairn-memory 的檔）
src/adapters/ui/        cairnReader（唯一對 Cairn 庫檔下 SQL、只讀）、agentCatalog（判讀一個 agent 庫、列出所有 agent）、profileStore（名稱表檔 `memory-ui/profile.json` 的讀寫）
src/adapters/model/     Cairn 模型 callback adapter
src/adapters/storage/   每 agent 一顆 SQLite 的資料配置、檔案安全檢查、identity 相容（cairnPin、upgradeBackup）
src/application/        memory application、handle pool、write lane、resource governor、tool contract；punch catch-up 與 receipt state machine；agent/project profile snapshot projection
src/domain/             namespace 與錯誤碼
src/contracts/          actor.ts（呼叫身分型別）、cairn-memory.d.ts（Cairn core 的型別宣告）
test/                   node --test 測試（讀 out/ 的 tsc 產物）；test/fixtures/legacy-db/<commit>/ 是各 accepted commit 的真實舊庫
tools/                  build、stage-cairn、verify-artifact、release（P3）；verify-source-untouched、check-no-secrets、make-legacy-fixture、sync-contract、sync-vendor（devkit）、verify-contract
dist/                   build 產物（gitignored）：stage/、<id>-<version>.tuqplugin、signer.pub.json、build-info.json
cairn-pin.json          Cairn 釘選：commit、coreTree、redactSha256、accepted[]、stage（打包檔案清單與 sha256）
```

## 來源與差異

來源 commit 與 tree hash 記在首個 commit 訊息。初始搬移的差異如下；後續外掛接線另見工作紀錄與 AI 整理說明：

- import 路徑：`MemoryActor` 由 `contracts/public.ts` 改為 `contracts/actor.ts`（`public.ts` 其餘內容屬 HTTP 傳輸，不搬）。
- `tools/verify-source-untouched.mjs`：repoRoot 與唯一 import 檢查位置改為本 repo；另驗證 `accepted[]` 含現行 commit，與 `redact.mjs` 的 sha256。
- `test/application.test.mjs`：只改 import 路徑（指向 `out/`）。
- `src/adapters/storage/dataLayout.ts`（P3）：新增選項 `trustedBase`，`src/backend/service.ts` 傳入 `dirname(dataRoot)`；祖先目錄檢查改為只從 `dataDir` 往下，檔案的 realpath 比對改以父目錄的 realpath 為準。原因見「後端入口」，由 e2e 在 `--permission` 下重現（原本 `lstat` 到磁碟根目錄被拒，全部 op 回 `STORAGE_BUSY`）。
- `test/remember-inspect.test.mjs`：新增，取自來源 `memoryControl.test.mjs` 中不依賴 HTTP 的案例，改為直接呼叫 `MemoryApplication.execute`。來源的 HTTP／control token／`/health` 案例隨傳輸層一併不搬。

## 後端入口（P2）

`src/backend/entry.ts` 匯出 `activate(context)`，回傳凍結的 `{ call, dispose }`。使用公開 SDK context 的 `dataDir`（必須是絕對路徑）、`host` 與 `settings`。

- 資料根：`<dataDir>/memory-cairn-v1`。啟動時 `warmUp` 會建 `CairnDataLayout(root, { pinPath })` 並 `preflight`；失敗不擋啟動，之後每次 `call` 與 `diagnose` 會重試。
- `pinPath`：backend 模組同目錄有 `cairn-pin.json`（打包後）就用它，否則取模組往上兩層（`out/backend` 的 repo 根）。P3 stage 必須把 `cairn-pin.json` 放在 `backend.mjs` 旁。
- `call(method, params)` 只服務 `memory.remember@1`、`memory.inspect@1`、`diagnose`、`memory.profile.sync@1`（見「名稱表（S4）」）與九個 `ui.*`（`uiDispatch`，見「UI 方法（S3）」；預期錯誤回 `{ok:false, code}` 不 throw，出口一律 JSON 來回一次）；其餘（含 `memory.recall@1`、`memory.forget@1` 等，recall 沒有公開入口，capture 由背景整理 worker 使用，correct／forget 保留 application 能力）一律拋 `unknown_method`。
- 整次呼叫失敗只會拋帶 `code` 的錯誤，且碼只能是 `unknown_method`、`invalid_params`、`result_too_large`、`internal`（host 把 `code` 原樣回給 Core）。請求違反契約 schema 是 `invalid_params`；訊息只含欄位路徑，不回顯內容。dispose 之後的呼叫拋 `internal`。
- 個別操作的失敗是回應內的 `{ok:false, error}`，碼取自契約 `MEMORY_ERROR_CODES`；契約沒有的碼（`CAPABILITY_*`、`SESSION_BINDING_MISMATCH`、`IDENTITY_UNBOUND`）收成 `INTERNAL`，且原始碼中沒有任何地方會產生它們。儲存層起不來時，每個 op 依實際碼（`STORAGE_*`、`DEPENDENCY_INCOMPATIBLE`）回失敗，不用 `INTERNAL`。
- remember：每個 op 依序執行，成功值只投影 `{memory:{id}, deduplicated}`。
- inspect：以整個回應 `Buffer.byteLength(JSON.stringify(response), "utf8")`、60,000 bytes 為預算；超過就把 limit 對半、重查，直到符合。回 `nextCursor`（list 取 `nextCursor`，get 取 `nextReceiptCursor`）與 `appliedLimit`，呼叫端續頁必須用 `appliedLimit`。`limit` 沒給時明確用 6。降到 1 仍超過拋 `result_too_large`。Cairn cursor 綁定簽發時的 limit，帶 cursor 的續頁超過預算無法對半，同樣拋 `result_too_large`。
- 每個回應在回傳前都用 vendored 回應 schema 解析（失敗拋 `internal`）；`diagnose` 不含任何路徑，`storage.status` 為 `ready` 或小寫的錯誤碼（如 `storage_unsafe`）。
- `plugin.version` 是 `src/backend/diagnose.ts` 的常數（現為 `1.4.4`），測試會比對 `package.json` 的 version，改版時兩處一起改；manifest 的 version 由 `package.json` 帶入。
- 資料層的祖先目錄檢查只從 `dataDir` 往下走（`CairnDataLayout` 的 `trustedBase`）：`--permission` 下外掛讀不到 `dataDir` 以上的任何路徑，往上 lstat 會被拒（實測回 `STORAGE_BUSY`）。`dataDir` 以下仍拒絕 symlink／junction；`dataDir` 以上的重導向（例如 macOS `/var`）視為 host 的事。不傳 `trustedBase` 時維持從根目錄往下檢查。

## 唯讀讀取器與 agent 目錄（S1）

UI 需要 Cairn API 沒有的東西（一次列多個 namespace、內容片段、總數），所以 `src/adapters/ui/cairnReader.ts` 直接以 SQL 讀庫檔；這是唯一對 Cairn 庫檔下 SQL 的檔案，寫入仍走 Cairn API（`AGENTS.md` 有完整規則，`verify-source-untouched` 強制）。

- `readCairn(path, work)`：開檔前 `lstat` 檢查檔案存在、是一般檔、父目錄與 `-journal`／`-wal`／`-shm` 不是 symlink／junction；以讀寫模式開檔、設 `PRAGMA query_only = ON`，因為 `readOnly` 遇到 crashed writer 留下的 hot journal 會回 `attempt to write a readonly database`，讀寫模式則會先回復 journal（`test/cairn-reader-safety.test.mjs` 重現）。之後驗 `application_id` 與 `user_version = 18`，不符或不是資料庫回 `unsupported_schema`。每次呼叫開、查、關，不佔 `CoreHandlePool`；`openCairn(path)` 回可重複 `run` 的 session（同一次 UI 呼叫內重用已開的庫，呼叫結束一定關，閒置時不持有任何鎖）。失敗回 `{ok:false, code}`，碼為 `not_found`、`unsafe_path`、`unsupported_schema`、`busy`、`unreadable`，不帶路徑。
- `list` 以 `(updated_at DESC, id ASC)` 排序，用 keyset（`after`）分頁與 `updatedFrom`／`updatedBefore` 時間窗；`get` 回完整內容與依 `(created_at, id)` 排序的 receipts。兩者與 Cairn 的 `list`／`get` 逐項相等由 `test/cairn-reader.test.mjs` 把關（含 legacy fixture），升 Cairn pin 時 parity 不過就擋下。
- `layout.listAgentDirectories()`（`CairnDataLayout`，由 `agentDirectoryNames()` 與逐個 `inspectAgentDirectory(hash)` 組成，另有 `agentsFingerprint()`＝`agents/` 的 mtime）列出 `agents/<64 位 hex>/`，不建目錄、不改 identity，對每個目錄與檔案套用和 `agentDbPath` 相同的 reparse point 檢查，狀態為 `ready`、`no_database`、`unsafe`、`unreadable`。
- `listAgents(layout)`（`agentCatalog.ts`）從 `namespace_epochs` 取 `owner_id` 與 namespace、由未刪除的列算出每個 namespace 的筆數、首末時間與完整更新時間序列（`timesMs`，新到舊）；0 筆的 agent 與 namespace 不列出；`owner_id` 的 sha256 必須等於目錄名（否則 `identity_mismatch`）、同一庫只能有一個 `owner_id`（否則 `owner_conflict`）；讀不了的 agent 放進 `unavailable[]` 並附原因。

## UI 契約與工具（S2）

本節是七個 `ui.*` 方法共用的零件，形狀依設計 §1.3；方法本體見「UI 方法（S3）」。

- `uiContract.ts`：每個方法一組請求 schema 與成功回應 schema（全部 `strict`），`UI_METHOD_SCHEMAS`、`parseUiParams`、`parseUiResponse`。時間篩選必須是 `toISOString()` 的完整形式（Cairn 的 `updated_at` 以字串比較），`scope` 與 `projectId` 必須相符，snippet 以 code point 計。失敗一律 `{ok:false, code, retryable}`，碼取自 `UI_FAILURE_CODES`。
- `budget.ts`：回傳大小是 `Buffer.byteLength(JSON.stringify(x))`（UTF-8 bytes），上限 56,000；`fitToBudget` 以二分法取「放得下的最長前綴」並回 `truncated`，連第一筆都放不下才回 `result_too_large`（不回指向同一筆的游標）。CJK 每字 3 bytes，用 `.length` 會低估。
- `cursor.ts`：游標是 `base64url(payload).base64url(HMAC-SHA256)`，payload 為版本、篩選條件雜湊與 1 到 4 段 keyset 位置；金鑰預設是行程內隨機值，所以重啟後舊游標會被拒（`ui.*` 一律回 `CURSOR_STALE`，畫面從第一頁重來）。雜湊不含 `limit` 與 `cursor`，換頁大小仍可續頁；篩選條件不同回 `filter_mismatch`；任何字元被改、簽章被換、格式不符都拒收。
- `punchContent.ts`：以 NFKC 後的前綴 `[工作紀錄 <起>~<迄> <cli>/<model>] 請求:<標題>。成果:<內文>` 解析工作起訖（UTC 分鐘，轉成完整 ISO）、cli、model、標題；`unknown` 的 cli／model 與 `(未命名)` 標題成為 `null`，`(無文字)` 內文成為空字串。前綴相容樣本由 plugin-owned `contract/v1/fixtures/requests/remember.work-prefix-*` 保持（每種各有寫入形式與 NFKC 形式）。解析失敗（含只讀了內容前 160 字、標題被截斷）回 `{parsed:false, body:<原文>}`。標題本身若含「。成果:」會在該處被切開，這是格式本身的歧義。
- `jsonSafe.ts`：出口的 `JSON.parse(JSON.stringify(x))`，去掉 `undefined`、把 `NaN` 與無限大變成 `null`（preload 的 zod 會拒收前者）。

## UI 方法（S3）

七個 `ui.*` 方法全部實作，經 `src/backend/uiDispatch.ts` 派送到 `src/application/ui/`：`overview.ts`、`agentStats.ts`、`listing.ts`（`ui.list` 與 `ui.search` 共用，差別只有內容比對詞）、`detail.ts`（`ui.get`）、`forget.ts`、`status.ts`。共同規則：

- **出口**：先過 `parseUiParams`（不合契約回 `{ok:false, code:'INVALID_PARAMS'}`，不 throw），結果經 `jsonSafe`，再檢查 UTF-8 bytes ≤ 56,000（單一項目就放不下才拋 `result_too_large`）。分頁結果由 `paging.ts` 的 `fitPage` 取「放得下的最長前綴」，游標指向實際回傳的最後一筆之後，被預算截掉的項目下一頁照樣回來。
- **錯誤碼**：預期錯誤只用 `UI_FAILURE_CODES`（`INVALID_PARAMS`、`CURSOR_STALE`、`NOT_FOUND`、`REVISION_CONFLICT`、`STORAGE_BUSY`、`STORAGE_UNSUPPORTED`、`RESOURCE_BUSY`）。`retryable` 表示「原封不動重送也許會成功」，只有 `STORAGE_BUSY`、`RESOURCE_BUSY` 為 true；`CURSOR_STALE` 與 `REVISION_CONFLICT` 為 false。**`CURSOR_STALE` 是「游標已不能用（plugin 重啟後金鑰換了、被改、篩選條件不同、overview 的 agent 已消失），畫面必須從第一頁重來」的唯一訊號。**
- **時間片**（`timeSlice.ts`）：每次呼叫內部限時 4 s；掃描每 15 ms 讓出一次（設計要求至少每 25 ms；一塊查詢可能超出時間片，所以留餘裕），讓出走 `nextTurn()`，一個事件迴圈 turn 只放行一個等待者，所以多個並行呼叫的停頓不會疊加；每個呼叫開頭也先等一個 turn。掃描 SQL 以 100 列為一塊（索引先查出塊尾，再查塊內內容），單次同步查詢不超過一塊。
- **agent 索引與快取**（`agentIndex.ts`）：每個 agent 一筆，內容是 namespace 清單（筆數、首末時間、**完整的更新時間序列**）與最新一筆的文字。有效條件是「行程內 dirty 世代沒變」（`memory.remember@1` 與 `ui.forget` 在 `finally` 標記，成功、失敗、半途失敗都標）**且**「庫檔 mtime＋size 沒變」（第二層，抓不經本行程的寫入）。目錄清單以 `agents/` 的 mtime 為指紋重用（新 agent 目錄、對未知 agent 的寫入都會讓它重建，最長 30 s）。`AgentIndex.snapshot` 逐個 agent 更新且會讓出；`createBackend().warmIndex()` 在 activate 時於背景先建好（`entry.ts` 呼叫），dispose 會等它結束。
- **時間序列的用途**：`ui.list`／`ui.search` 的「掃哪些 namespace」由它決定：每個 namespace 的 head 是「游標之後、時間窗之內最新一列」的時間，依 head 由新到舊逐個掃，掃到 limit+1 筆且下一個 head 比第 limit+1 筆還舊就停。所以翻很深的頁也只開幾個庫；`overview` 的日統計（14 天火花線、今天寫入、7 天活躍）直接由它算，不查庫。
- **逾時仍精確**：逾時時只保留「比下一個尚未掃的 head 更新」的項目（這部分不可能被漏掉的 namespace 插隊），游標接在最後一筆之後；一筆都留不下就把游標移到 head。掃不完的呼叫下一次會從暖的索引接著做。要在 4 s 內走完所有仍在游標之後的 namespace 才保證前進，這在 223 個 namespace 下綽綽有餘。
- `ui.status`：真實資料（版本、Cairn commit、儲存狀態、`lastWriteAt` 取自索引、`uptimeSec`、名稱表狀態）；沒有 `stub`。`profile` 含 `generation`、`receivedAt`、`agents`／`teams`／`projects` 筆數、`incomplete`（`omitted` 任一項大於 0）、`omitted`、`corrupt`、`sink`（Core 附帶的待寫數與最後寫入時間）與 `sinkReceivedAt`。

各方法的語意：

- `ui.overview`：磚塊（總筆數、今天寫入＝`updated_at` 落在 `dayStartIso` 起 24 小時內、7 天活躍 agent、agent 數、最後寫入）與卡片（依 `(teamKey, id)` 排序；`teamKey` 取名稱表給的部門 key，名稱表沒有該 agent 或沒給部門時取 agent id 斜線前的部分）。`counts.projects` 取筆數最多的 5 個 project（同筆數依 id），其餘合計在 `otherProjects`（筆數，不是 project 數）。`complete:false` 表示逾時、只含已掃到的 agent。游標位置是 `(teamKey, id)`；兩者太長放不進游標時改放摘要，該 agent 消失時回 `CURSOR_STALE`。`profile` 由 `profilePort.ts` 的介面供應（生產是 `profileTable.ts`）；除 `generation`、`receivedAt` 外另有 `incomplete`、`corrupt`、`omitted`。卡片另有 `displayName`（名稱缺漏時的降級名稱），`team.name` 取自名稱表的 `teams[]`。
- `ui.agentStats`：取該 agent 每個 namespace 最新 2,000 筆（合計）聚合：日（本地日，`tzOffsetMin`）、時、星期（0＝週日）、工具（cli／model，解析不了的歸 `null`）、重複的請求標題（≥2 次，前 8）、代表項（最常重複的前 4 個標題各取最新一筆，不足再補最新的）；`namespaces` 是精確筆數，超過預算時截尾；`sampled` 表示總數超過取樣上限。結果依 agent 版本、時區、本地日、名稱表 generation 快取（最多 16 筆）；回應另有 `agent`（名稱合併結果）與每個 namespace 的 `project`。
- `ui.list`：所有篩選（agent、scope、project、`sinceIso` 含、`untilIso` 不含、`cli`）先套在 namespace 與 SQL；`cli` 比對的是內容前綴（見 `punchContent.ts`）。項目的 `snippet` 是解析後的成果文字前 160 字（解析失敗則是原文），`work` 為工作起訖、cli、model、標題，`names` 是名稱合併結果（`agent`：`displayName`、選填的 `name`、`teamKey`、選填的 `teamName`；`project`：個人記憶為 `null`，否則 `displayName` 與選填的 `name`）。
- `ui.search`：查詢先 NFKC、壓縮空白；以空白切成詞（去重、上限 16 個，超過或全空白回 `INVALID_PARAMS`），**每個詞都要出現（AND）**，大小寫只有 ASCII 不分（SQLite `lower()` 的範圍；`é` 與 `É` 視為不同）。逐 namespace 以 `instr(lower(content), 詞)` 掃，snippet 以第一個命中處為中心（命中在標題或前綴時取成果開頭）。`scanned.complete:false` 表示有 agent 讀不了。
- `ui.get`：完整內容（≤4,000 字）、工作資訊、最多 12 筆收據、`sameSession`（同一 agent 庫內、任一收據 session 相同的其他記憶，最多 8，新到舊；`receipts.session_id` 沒有索引，超大庫這一步是全表掃描）。回應另有 `names`（同 `ui.list` 的項目），`sameSession` 的項目也帶 `names`。找不到、agent 不存在都是 `NOT_FOUND`，且不會建立任何目錄。
- `ui.forget`：走 `MemoryApplication.execute('memory_forget')`，與 sink 共用寫入通道與 handle pool。過期的 `expectedRevision` 回 `REVISION_CONFLICT`；已忘記或不存在的記憶回 `{ok:true, forgotten:false}`（第二次 forget 也是）；agent 不存在回 `NOT_FOUND`。忘記後 Cairn 記下指紋，同內容再 `memory.remember@1` 會得到 `MEMORY_SUPPRESSED`。

效能與並行的量測工具是 `npm run perf:ui -- --data <含 memory-cairn-v1 的資料集目錄>`（node 與 Electron run-as-node 都能跑；資料集用設計目錄的 `gen-dataset.mjs` 在 repo 外產生）：讀取階段量 overview／list／search 等的耗時與事件迴圈最長停頓並斷言上限，並行階段在 16 筆一批的 sink 式寫入與單筆寫入下同時跑所有 `ui.*`，斷言 0 錯誤、總筆數精確。已知限制：單一 agent 庫超過數萬筆時，該 agent 的索引更新（一次同步掃描）與 `ui.get` 的 `sameSession` 會各佔數十毫秒；冷啟動第一次呼叫（索引還沒建好）要對每個 agent 庫開一次檔（每個約 3～6 ms 的 schema 載入），100 個 agent 約 0.4～0.7 s。

## 名稱表（S4）

Core 把整份名稱表（agent、部門、專案）以 `memory.profile.sync@1` 分段推給 plugin（契約在 `vendor/teamuq-contract`，Core 端規則見 Core 的 agent-memory README）。這個方法**只有 Core 的 sink 通道會呼叫**，不在 manifest 的 `backendMethods`，view 呼叫不到；`verify-artifact` 有專屬檢查。

- **暫存與生效**（`src/backend/profileSync.ts`）：各段只暫存在記憶體，以 generation 為鍵；收到別的 generation 或不同的 `parts` 就丟棄舊暫存，同一段重送覆蓋，段序不限。收齊 `parts` 段後把三個清單串起來，用契約匯出的 `memoryProfileCanonicalText` 加 sha256 重算 generation：不符（含跨段重複 id、各段 `omitted` 不一致、超過個數上限）回 `invalid_params`，不改變目前生效的表；相符才寫檔並整份換上。未收齊時回 `complete:false, changed:false, received:<已收段數>`，個數欄位是目前生效表的筆數。
- **同 generation**：已生效的 generation 再來任一段，直接回 `complete:true, changed:false, received:1`，不驗證內容、不動名稱表，只用該段的 `sink` 刷新 sink 與 `sinkReceivedAt`（`null` 存成未知）。
- **落地**（`src/adapters/ui/profileStore.ts`）：`<dataDir>/memory-ui/profile.json`，內容 `{version:1, generation, receivedAt, agents, teams, projects, omitted, sink, sinkReceivedAt}`。先寫 `profile.json.<16 hex>.tmp`、fsync、再 rename（Node 權限模型下 fsync 被停用並回 `ERR_ACCESS_DENIED`，此時只忽略這個碼、靠 rename 保證原子；其他 fsync 錯誤照常算寫入失敗）；寫入失敗（含 rename 失敗）清掉 tmp、回 `internal`（Core 視為可重試，整組重送）、目前的表不變；殘留的 tmp 讀取時被忽略、下一次寫入時移除。`memory-ui` 或檔案是 symlink／junction 一律拒絕（讀為 corrupt、寫回 `internal`）。
- **壞檔**：不是 JSON、schema 不符、版本不符、內容重算的 generation 與檔內不符、超過 16 MiB，都視為空表並在 `ui.status.profile.corrupt`、`ui.overview.profile.corrupt` 標記；下一次完整推送會覆寫修復。檔案不存在是空表、不算 corrupt。載入在 `createBackend` 建構時同步完成，與 Cairn 儲存是否可用無關。
- **不完整**：`omitted` 任一項大於 0 表示 Core 因上限丟掉部分名稱，`ui.status.profile` 與 `ui.overview.profile` 的 `incomplete` 為 `true`，`omitted` 帶各項數量。
- **合併與降級**（`src/application/ui/names.ts`）：名稱表有就用（`name`、`title`、`teamName`＝`teams[]` 依 team key 取，agent 沒列部門或沒列在表內時 team key 取 id 斜線前的部分，其名稱一樣去 `teams[]` 查）；沒有時 `displayName`＝agent「id 最後一段（team key）」、專案「專案 」加 id 前 8 個字元。新增的回應欄位都是 schema 內選填、後端一律送出：overview 卡片 `displayName`、`counts.projects[].displayName`，overview／status 的 `profile.{incomplete,corrupt,omitted}`，status 的 `profile.{teams,sinkReceivedAt}`，list／search／get 的項目 `names`，get 的 `names`，agentStats 的 `agent` 與 `namespaces[].project`。
- 名稱表不入 generation 的欄位（`sink`）與名稱一起存檔；Core 在 plugin READY 時會整組重送，所以檔案遺失只影響到下一次推送。

## UI 基礎（S5）

畫面（S6a～S6d）共用的零件。

- `api/backendClient.ts`：`createBackendClient({call})` 是唯一呼叫 `window.tuqPlugin.backend.call` 的地方（`backendClient()` 綁定真的 bridge）。同時在途最多 2 個、其餘照順序排隊；同一個 key（預設是方法名，可用 `{key}` 分開，例如抽屜與同工作清單）的舊請求在新請求送出時以 epoch 丟棄，結果是 `{ok:false, superseded:true}`，排隊中的舊請求根本不送出；`ui.forget` 是寫入，永不丟棄、也不自動重試。只有平台碼 `plugin_backend_unavailable` 自動重試最多 3 次（延遲 1、2、4 秒，涵蓋冷啟動；等待期間不佔在途名額，等完若已被取代就不再送）。成功回 `{ok:true, value}`（value 是後端整個回應），失敗一律攤平成 `{ok:false, code, source, message, action, actionKind, retryable, superseded, attempts}`；參數的 `undefined` 成員在送出前移除（preload 會拒收）。
- `api/errors.ts`：平台碼（`PLATFORM_CODES`）、plugin 碼（`PLUGIN_CODES`，含契約的 `UI_FAILURE_CODES`（`CURSOR_STALE` 是游標不能用、畫面要從第一頁重來的唯一碼；`INVALID_CURSOR`、`NOT_IMPLEMENTED` 已不存在）與預留的 `MEMORY_SUPPRESSED`、`STORAGE_UNSAFE`、整次呼叫失敗碼）、client 碼（`superseded`、`malformed_response`、`unknown`）各對應一句白話加一個建議動作（字串在 `i18n/zhTW.ts`）；`UI_FAILURE_CODES_COVERED` 讓契約新增碼而這裡沒補時 `tsc -p tsconfig.ui.json` 直接失敗。`codeFromThrown` 從 Electron 包過的 ipc 錯誤訊息裡找碼；`isCursorReset` 判斷要從第一頁重來的碼。
- `dom/html.ts`：`html` 模板標籤與 `esc()`。插值在文字位置一律跳脫（巢狀 `html` 片段與陣列除外）、在有引號的屬性值位置跳脫；tag 名、屬性名、無引號屬性值、註解、`<script>`／`<style>` 內插值都直接 throw，`on*` 事件屬性連靜態寫也 throw；URL 屬性開頭的 `javascript:`／`data:`／`vbscript:` 換成 `#`；`style` 屬性只收數字或 `[A-Za-z0-9#%.- ]`。`SafeHtml` 只有 `html` 能產生（`new` 一個會 throw），`mount()` 是唯一寫 `innerHTML` 的地方。
- `components/dialog.ts` 與 `dialogFocus.ts`：`openDialog`／`confirmDialog`。`role=dialog|alertdialog`、`aria-modal`、`aria-labelledby`／`aria-describedby`；Tab 與 Shift+Tab 在 dialog 內循環、焦點跑到外面就拉回；Esc 與點背景關閉（`dismissible:false` 時兩者都不關）；背景元素可傳入並設 `inert`；關閉後焦點回到開啟前的元素，該元素已不在時回 `returnFocusTo`。`initialFocus` 指定動作 id 或內文元素 id；沒指定或找不到時，落在第一個「非 danger」的可聚焦元素，全是 danger 就落在 dialog 本身，所以遺忘確認即使沒設定也不會預設在破壞性按鈕。同時只能開一個。
- `i18n/`：`STRINGS`（繁體中文、台灣用語，不用「程序」與大陸用語）與 `t(key, params)`；`{name}` 佔位。
- `styles/tokens.css` 與 `tokens.lock.json`：由 `npm run tokens:sync -- --core <TeamUQ 路徑>` 從 Core 的 `apps/desktop/src/renderer/styles/base.css` 產生（Core 該檔有未提交變更就拒絕），lock 記來源 commit、檔案雜湊、兩套值與輸出雜湊；`npm run tokens:verify`（在 `npm run check` 內）離線檢查 css 沒被手改；`tokens:sync -- --core <路徑> --check` 比對 Core 有沒有漂移。深淺色只有 `:root{color-scheme: light dark}` 加一個 `@media (prefers-color-scheme: dark)`，沒有 `data-theme`。plugin 自有的 token：`--link`、`--text-secondary-strong`（Core 的 `--text-secondary` 在 `--surface-muted` 上只有 4.33:1）、`--accent-fg`（Core 的 `--on-accent` 在 `--accent` 上只有 2.46:1）、`--danger-fg`、`--font-ui`。`--text-muted`、`--accent-hover`、`--accent`、`--on-accent` 不得當文字色；焦點外框用 `--link`（`--accent` 對白底不到 3:1）。`test/ui-contrast.test.mjs` 對兩套配色算對比並掃 `app.css` 的 `color:`。
- `bundleUi` 用 esbuild 把 `styles/app.css`（`@import "./tokens.css"`）打成單一 `ui/app.css`，因為 view 只准連結 `app.css`。
- 測試：`test/uiViewHarness.mjs` 以 esbuild 把 `src/ui` 的 TypeScript 打成暫存 ESM 供 node 測試載入（同一次載入的模組共用一份打包，否則 `SafeHtml` 的身分檢查會跨份失敗）；`test/fakeDom.mjs` 是 dialog 用的最小假 DOM。後端 `ui.*` 測試的假資料與播種工具是另一支 `test/uiHarness.mjs`（`startStore`、`seed` 等），兩支用途不同、不共用。

## 團隊首頁（S6a）

`main.ts` 是唯一碰 `document`／`window` 的組裝處；畫面邏輯都是可用假目標測試的純函式或小型控制器。

- `router.ts`：hash 路由，`#/` 是團隊首頁，`#/agent/<encodeURIComponent(id)>` 是「記憶空間」（見下一節）；解不開的 hash 一律回首頁。卡片是真的 `<a href>`，所以鍵盤 Tab 可達、Enter 可開；切換路由後焦點落在記憶空間標題，回首頁時回到原卡片。
- `state/teamHome.ts`：`parseOverview`（UI 不能跑 zod，手寫的回應檢查；型別斷言 `OVERVIEW_CONTRACT_MATCHES` 讓契約的 overview 形狀漂移時 `tsc -p tsconfig.ui.json` 失敗）、名稱降級（`displayName()`：依序取後端合併好的 `displayName`、名稱表的 `name`、id 最後一段，全 id 仍顯示在卡片上；project 沒名字顯示「專案＋id 前 8 碼」；部門沒名字顯示 key，key 為空顯示「未分組」）、依部門分組與三種排序（最近寫入、累積筆數、名稱，都只作用在已載入的 agent）、`mergeAgents`（續頁依 id 去重）。
- `views/teamHomeController.ts`：載入狀態機（loading／ready／error）。第一頁 `ui.overview({tzOffsetMin, dayStartIso, limit: 60})`（`dayStartIso` 是本地當天 0 點的 ISO、`tzOffsetMin` 是 UTC 以東的分鐘數，與後端 `agentStats` 一致），有 `nextCursor` 就出現「載入更多」；重新整理與載入更多用不同的 backendClient key，重新整理會讓在途的載入更多失效；`CURSOR_STALE` 顯示「從第一頁重新載入」；重新整理失敗但畫面已有資料時保留資料、在橫幅顯示錯誤。首頁只對進入可視範圍的卡片呼叫 `agentAvatar.read(agent.id)`，最多四個請求並行；缺圖、逾時或錯誤保留 initials，重畫與離開首頁會丟棄舊回應並回收 Blob URL。第一次說明「記憶是怎麼來的」以 `localStorage` 記住已讀（讀寫失敗當作沒有）。
- `views/teamHomeView.ts`：只產生 `SafeHtml`，所有動態字串（名稱、id、摘要、部門、project）都經 `html`／`esc`。`overview.complete === false` 時顯示「資料不完整」與重新整理；`profile.corrupt`／`profile.incomplete`（含 `omitted` 的筆數）時多一則給一般使用者看的說明「名稱清單讀不出來／有 N 位 agent、M 個專案沒收進來，先用代號顯示，記憶本身不受影響」（`profileNotice`，壞檔優先於不完整；戳記格式不對時視為健康，不擋卡片）；`storage.unavailableAgents > 0` 時說明有幾位 agent 讀不到。專案記憶只在任務有掛專案時才出現，這句說明（D9）在有卡片時常駐、在空狀態裡也有。
- `views/statusLine.ts`：標題列的狀態點與「最近寫入 N 分鐘前」。`ui.status` 只在 `document.visibilityState === "visible"` 時每 30 秒輪詢一次，隱藏就取消計時器、轉為可見時立刻讀一次並重新計時；儲存狀態不是 `ready` 顯示警示而不是「運作中」。`#status[data-state]`（loading／ok／warn／error）是外部探針（真 Electron harness）讀的介面。
- `views/homeEvents.ts`：以 `closest("[data-act]")`／`[data-role]` 的事件委派，不用事件屬性（CSP）。
- 樣式：`styles/home.css` 由 `app.css` 匯入；頭像色由 id 的雜湊決定（`--h` 色相，唯一一條 `hsl(var(--h) 55% 75%)` 的規則，深藍字 `--accent-fg` 對 360 個色相在兩套配色都 ≥4.5:1，由 `test/ui-contrast.test.mjs` 驗）。
- 測試：`test/ui-team-home-{state,view,contract,avatar}.test.mjs`、`ui-status-line`、`ui-home-events`；`test/homeFixtures.mjs` 是假 overview 與假 backend（依 (teamKey, id) 分頁）；`ui-team-home-contract` 以真的 `ui.overview` 回應（100 個 agent）驗證 UI 解析與續頁。注入測試用 `tokenize` 檢查輸出裡每個標籤與屬性都在白名單內、沒有殘留角括號。

## Agent 記憶空間（S6b）

`#/agent/<id>` 是一位 agent 的記憶空間，只用 `ui.agentStats`（不依賴 `ui.overview`，直接開網址也能用）。

- `state/memorySpace.ts`：`parseAgentStats`（手寫檢查；型別斷言 `STATS_CONTRACT_MATCHES` 讓契約的 agentStats 形狀漂移時 `tsc -p tsconfig.ui.json` 失敗）與衍生資料（`spaceRows`：個人固定第一列、專案依筆數再依 id；`toolRows`；`peakOf`：同值取第一個）。讀不懂的回應一律視為 `malformed_response` 錯誤，不當成空的記憶空間。
- `views/memorySpaceController.ts`：`open(agentId, hint, targets)`／`retry`／`close`。每次載入遞增 generation，已離開的 agent 或已關閉頁面的晚到回應一律丟棄；請求 key 是 `space`，不會被狀態列或首頁的請求取代。`NOT_FOUND` 是「這位 agent 沒有記憶」的空狀態，不是錯誤；總筆數 0 也一樣。標題元素永遠不被取代，只改文字，所以鍵盤焦點停在標題不會因資料到達而跑掉。
- `views/memorySpaceView.ts`／`memorySpaceCharts.ts`：只產生 `SafeHtml`。區塊依序是個人與專案（專案區沒有專案時照樣顯示並說明，D9）、每天寫入（30 欄）、時段與星期、工具、重複出現的請求、四張代表性記憶；`sampled` 時多一則「只統計最新的一部分」。**時段、每天、星期都是依寫入時間（`updatedAt`）算的**，所以一律寫「寫入」，不寫「開工」；每張代表性記憶另外顯示工作起訖。圖是 `<div role="img" aria-label>`＋`<i style="height:Npx">`，標籤已含總數與尖峰，每欄的 `title` 只是給滑鼠的提示。
- 頁面殼 `spaceShell()`：返回連結（首個 Tab 停駐點）、`#space-title`（`tabindex=-1`，進頁後焦點落在這裡）、`#space-body`（控制器每次整塊重畫）與**時間軸掛載點 `#space-timeline[data-slot="timeline"]`**（在 body 外，S6c 掛進去不會被重畫洗掉；S6b 不放任何內容）。資料列與代表性記憶帶 `data-scope`／`data-project-id`／`data-memory-id`，供 S6c／S6d 接篩選與詳情抽屜；目前沒有可點的元素，所以 ready 頁面沒有 Tab 停駐點，錯誤時只多一個重試按鈕。
- 字串在 `i18n/zhTWSpace.ts`（併入 `STRINGS`）、樣式在 `styles/space.css`（全部限定在 `.space-body` 底下）。
- 測試：`test/ui-memory-space-{state,view,states,contract}.test.mjs`（`test/spaceFixtures.mjs` 是假 agentStats 與假 client；contract 那支用真的 `ui.agentStats`／`ui.overview` 與名稱表推送驗證）、`test/ui-team-home-profile.test.mjs`。

## 時間軸與搜尋（S6c）

掛在記憶空間頁的 `#space-timeline` 裡（`main.ts` 的 `showAgent` 把 `timelineShell()` 掛進去），一次只看一位 agent，用 `ui.list`（沒有關鍵字）與 `ui.search`（有關鍵字）。

- `state/timeline.ts`：`parsePage`（手寫檢查；型別斷言 `ITEM_CONTRACT_MATCHES` 讓契約的 item 形狀漂移時 `tsc -p tsconfig.ui.json` 失敗）、查詢與篩選（`makeQuery`／`queryParams`）、`choicesFromStats`（由 `ui.agentStats` 取得完整專案清單與用過的工具）、依寫入日分組與時間文字。
- `views/timelineController.ts`：每個新查詢（搜尋、篩選、清除、換 agent）遞增 generation，已被取代的查詢的晚到回應一律丟棄（也丟棄 load-more 的晚到回應）；所有清單請求共用 key `timeline`，選項請求用 `timeline.options`（自己呼叫一次 `ui.agentStats`，不等記憶空間頁的請求，失敗時保留 `open` 帶入的備用選項）。續頁以游標，以 id 去重；`CURSOR_STALE` 自動從第一頁重來並顯示說明（一次嘗試只重來一次）；`nextCursor` 不為空但本頁沒有項目時仍顯示「載入更多」，不說成沒有記憶。
- **續頁必須沿用同一組篩選**：時間範圍在查詢開始時換算成一個固定的 `sinceIso`，續頁沿用，否則游標內的篩選雜湊不符、每頁都會 `CURSOR_STALE`。
- **`scanned.complete:false`（只有 `ui.search` 有）** 顯示「可能不完整」並在翻頁時維持標記，新搜尋才重置。搜尋框旁固定寫「比對文字，不是語意；多個詞要全部出現」。排序與文案一律用「寫入」（今天寫入、昨天寫入）；每筆另外顯示工作起訖與耗時。
- 選單只在選項集合真的改變時才重畫（重畫會讓鍵盤焦點跑掉）；搜尋用 `<form>` 的 submit，輸入法組字中的 Enter 不會誤送出。事件只認 `data-tl*` 屬性，與首頁的 `data-act` 互不干擾。
- 詳情介面（S6d 已接，見下一節）：`createTimeline({ onOpenDetail(ref) })`；每筆是 `<button data-tl="open" data-tl-key>`，`itemKey(ref)` 可找回按鈕；遺忘後呼叫 `timeline.reload()`。
- 字串在 `i18n/timelineStrings.ts`（併入 `STRINGS`）、樣式在 `styles/timeline.css`。測試：`test/ui-timeline{,-states,-view,-choices,-contract}.test.mjs`（`test/timelineFixtures.mjs` 是假 list／search／agentStats 後端；contract 那支用真的 `ui.list`／`ui.search`／`ui.agentStats`）。

## 詳情與遺忘（S6d）

點時間軸的一筆記憶（Enter 或點擊）開右側詳情抽屜，只用 `ui.get` 與 `ui.forget`；不開放修改記憶，「開啟原對話」延到 V1.1，所以抽屜裡沒有這兩個按鈕。

- `components/drawer.ts`：抽屜的 DOM 與鍵盤。`role="dialog"`、`aria-modal`、`aria-labelledby` 指向標題；開啟時焦點落在標題、把 `header` 與 `main` 設為 `inert`；Esc、關閉鈕、點背後的暗幕都走同一個 `onDismiss`。Tab 只在兩端介入（最後一個控制項往後、第一個往前或焦點在標題時 Shift+Tab 才繞回），其餘交給瀏覽器，所以 `<summary>` 與捲動區照常可達；焦點跑到抽屜外時拉回標題。`isSuspended` 為真（確認框開著）時抽屜不處理 Esc、Tab、focusin，避免與確認框互搶焦點。
- `state/detail.ts`：`parseDetail`（手寫檢查；`DETAIL_CONTRACT_MATCHES` 讓契約的 get 形狀漂移時 `tsc -p tsconfig.ui.json` 失敗，`RECEIPTS_MAX` 綁 `UI_LIMITS`）；「請求」與「成果」一律由 `application/ui/punchContent.ts` 的 `parsePunchContent` 拆，不在 UI 另寫前綴解析；`focusCandidates`：遺忘後焦點依序找下一筆、上一筆，不在清單中的記憶（同一次工作裡載入的另一筆）則回到開抽屜的那張卡。
- `views/detailController.ts`：狀態機（loading／ready／error）。`ui.get` 用 key `detail`，每次載入遞增 generation，已換筆或已關閉的晚到回應（含錯誤）一律丟棄；回應的 ref 與要求的不同視為 `malformed_response`。遺忘：按「遺忘這筆記憶…」開確認框（`alertdialog`，`initialFocus` 在「先不要」，Esc 與點暗幕都等於先不要，說明永久清除、收據一併刪除、相同內容之後不再寫入），確認後以抽屜內那筆的 `revision` 送 `ui.forget`（key `detail.forget`，寫入不被丟棄也不重試）。`forgetting` 期間按鈕 `aria-disabled`、再按不送也不開確認框，抽屜不能關、不能換筆（`close({force:true})` 只給換路由用）。成功（含 `forgotten:false` 與 `NOT_FOUND`，因為目的已達成）：關抽屜、`timeline.reload()`、焦點落在下一張卡（找不到就上一張、再找不到落在清單標題 `#tl-title`），並在 `role="status"` 的朗讀區寫「已遺忘這筆記憶」。`REVISION_CONFLICT`：不動清單，重讀 `ui.get` 並在抽屜最上面顯示「剛才沒有遺忘任何東西」，使用者要再確認一次才會以新的 `revision` 送出；重讀失敗就顯示錯誤、不留舊內容的遺忘鈕。其他失敗留在抽屜顯示白話說明，按鈕恢復可再試。
- 抽屜內「同一次工作的其他記憶」是按鈕，在同一個抽屜換成那一筆（焦點移到標題）；關閉時焦點回到最初開抽屜的那張卡，用 `itemKey` 在重畫後的清單重新找出（卡片不在了就落在清單標題）。
- `views/detailView.ts`／`detailEvents.ts`：只產生 `SafeHtml`，事件只認 `data-dt*` 屬性（與時間軸的 `data-tl`、首頁的 `data-act` 互不干擾）；原始文字放在 `<details>`；樣式在 `styles/detail.css`（`.btn.btn-danger-outline` 要疊 `.btn` 才贏得過 `app.css` 的 `.btn`），字串在 `i18n/detailStrings.ts`。
- `main.ts` 的 `createDetail` 注入：`reloadList`＝`timeline.reload`、`listKeys`、`cardFor`（`[data-tl-key]`）、`listHeading`、`backgrounds`；換路由時 `detail.close({force:true})`。
- 順手清理：`i18n/localClock.ts` 刪除，`timeOfDay` 併入 `clockTime`、`monthDay` 移進 `i18n/clock.ts`。
- 測試：`test/ui-detail-{state,view,controller,contract}.test.mjs`（`test/detailFixtures.mjs` 是假 DOM 場景與假 client；contract 那支用真的 `ui.get`／`ui.forget`／`ui.list`／`ui.search` 與真的時間軸控制器，驗證遺忘後各方法都查不到、衝突重讀、已在別處遺忘）；`test/fakeDom.mjs` 現在會把 innerHTML 裡的 `<button>` 解析成子元素，並在取代內容時讓舊子元素脫離。

## 契約 vendor

`contract/v1/` 是外部 memory contract、types 與 fixtures 的唯一權威；`vendor/teamuq-contract/` 只是生成快照，禁止手改。

| 檔 | 說明 |
|---|---|
| `contract.mjs`、`contract.d.ts`、`fixtures/**`、`lock.json` | 逐檔自 Core 複製（CRLF 正規化為 LF） |
| `contract.d.mts` | 本 repo 加的一行橋接（tsc 把對 `contract.mjs` 的 import 解析到 `.d.mts`），列在 `vendor.lock.json` 的 `pluginOwnedFiles` |
| `vendor.lock.json` | Core commit（HEAD）、最後改到契約目錄的 commit、Core `lock.json` 的 sha256、每個 vendored 檔的 sha256 |

- 同步：`npm run contract:sync` 從 `contract/v1/` 重生 `vendor/teamuq-contract/` 與 `src/backend/vendoredContractLock.ts`；變更來源後用 `node tools/sync-contract.mjs --refresh-lock` 更新 source hashes。SDK/devkit 用 `node tools/sync-vendor.mjs --kit <公開 devkit 路徑> --only devkit` 同步，之後用 `npm run types:sync` 生成 SDK。
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
- 新增 accepted commit 的步驟：加進 `cairn-pin.json` 的 `accepted[]`；以該 commit 的 Cairn 安裝後跑 `npm run build:ts && node tools/make-legacy-fixture.mjs` 產出 `test/fixtures/legacy-db/<commit>/`；`verify-source-untouched` 與測試會檢查每個 accepted 項目都有 fixture 且可開啟。目前 `accepted[]` 包含四個 commit：`83a10c3b7664b1f67485a19e7d84d24dcb3041a5`、`0c7aa20a9cb490bac4d15eca28b2036823a5f48e`、`7197d80035a015db195d7724729926f8749afd32`、`e3e376138c3708c003bcf06584070f8b002d232a`；升級路徑另以「identity 寫成假舊 commit、DB 為現行格式」模擬。

## 打包與簽章（P3）

```powershell
node tools/build.mjs                        # 暫時金鑰簽章（--anchors self），產出 dist/teamuq.memory-1.4.4.tuqplugin
node tools/build.mjs --stage-only           # 只做 stage 與 devkit validate
node tools/build.mjs --key <file.key.pem>   # 真金鑰：互動輸入 passphrase，預設 --anchors core
node tools/verify-artifact.mjs dist/teamuq.memory-1.4.4.tuqplugin --pub-file dist/signer.pub.json
```

build 依序：`verify-source-untouched`、`contract:verify`（含 devkit lock）→ esbuild 打 `stage/backend.mjs`（zod 內聯；`cairn-memory/core/index.mjs` 改成外部相對路徑 `./cairn/core/index.mjs`，其他 `cairn-memory` import 一律報錯）→ `stage-cairn` → 由 `plugin/manifest.template.json` 產 manifest → devkit `validate` → `release`（devkit `pack`＋`verify`）→ `verify-artifact`。

| 產物內容 | 說明 |
|---|---|
| `backend.mjs`、`cairn-pin.json` | 同目錄（`resolvePinPath` 的規則）；pin 檔以 LF 寫入 |
| `cairn/core/**` | 145 個 core 檔案；完整 Cairn stage 共 147 檔，另含下列的 `cairn/plugins/cairn-memory/lib/redact.mjs` 與 `cairn/LICENSE`。排除 `core/test` 與 `core/testing`（沒有任何執行期 import；`verify-artifact` 會檢查每個 staged `.mjs` 的相對 import 與 `new URL` 資產都解得到） |
| `cairn/plugins/cairn-memory/lib/redact.mjs`、`cairn/LICENSE` | 保留 `core/validation.mjs` 需要的相對路徑 |
| `ui/index.html`、`ui/app.js`、`ui/app.css` | `bundleUi`：esbuild 把 `src/ui/main.ts` 打成 IIFE `app.js`（不得拉進 node_modules）；`index.html` 來自 `plugin/ui/`、`app.css` 由 `src/ui/styles/app.css` 連同 `tokens.css` 一起打包。`verify-artifact` 對這三檔做 CSP 安全掃描（無 inline script／事件屬性／`javascript:`、`eval`、`new Function`、`http(s)://`、`fetch(`、`WebSocket`） |
| `manifest.json`、`integrity.json`、`signature.json` | manifest 見下；後兩者由 devkit 產生 |

- `cairn-pin.json` 的 `stage` 記錄每個 Cairn 檔的路徑與 sha256（共 147 筆）。`verify-source-untouched` 比對「node_modules 的檔案集合與雜湊」等於「pin 記錄」；升 Cairn 後跑 `node tools/stage-cairn.mjs --record` 重寫，再讀 diff。
- manifest（composed）：id `teamuq.memory`、publisher `teamuq`、`trustTier: full-trust`、`entry.ui: ui/index.html`＋`entry.backend: backend.mjs`、`contributes.views` 一個 view（id `memory`、標題「記憶」、presentations `tab`＋`fullpage`、預設 `tab`）、`permissions` 包含 UI、工作紀錄與目錄讀取、舊狀態只讀遷移、settings:plugin、ai:chat、backend:invoke、program:data:projects:write 與 program:data:tasks:write（用來建立外掛自己的 Project「Cairn記憶管理」（全部只建一個），以及每個 agent 各一個 Task「AI 整理記憶：<agent 名稱>」；名稱取法與 Cairn 畫面一致，查不到時用降級名稱，agent 改名後 Task 名稱不跟著改。該 agent 每一輪 AI 對話都帶它自己的 `taskId`，各 agent 的 taskId 持久化在 `teamuq-task.json`（version 2，舊版單一 Task 的檔只保留 Project、舊 Task 不再使用）；無此權限或舊 Core 時對話照常、不帶 `taskId`，被拒絕或逾時後該 agent 退避一分鐘再試）；新收據不需要 plugin-state:write、`backendMethods` 為九個 `ui.*`（不得含 `memory.*`）、`data.uninstall: keep`、`pluginApi ^2.0.0`、`minCoreVersion >=1.8.2`（vendored SDK/CLI 已同步公開 Devkit 1.8.2，其內建 coreVersion 就是 manifest 能設的最高 `minCoreVersion`；Core 1.7.12 至 1.8.1 收不到本版）、`platforms` 不限（純 JS 加 `node:sqlite`，無原生檔）。資源：`memoryMB 512`、`cpuThreads 1`、`maxSessions 4`（UI 與 Core sink 共用的在途呼叫上限）、`idleUnloadSec 180`、`bootTimeoutSec 30`（S0 建議 256～512、10～30；S0 實測 RSS 約 110～120 MB，冷啟動約 150～300 ms）。
- devkit：共用 `_devkit` 放在外掛 repos 旁，每個外掛釘選自己的 CLI/lib 與生成 SDK。同步公開 kit：`node tools/sync-vendor.mjs --kit <公開 devkit 路徑> --only devkit`；來源檔案先比對 kit.version.json 的大小與 SHA-256，lock 記錄 kit 版本、metadata hash 與 vendored CLI/lib 的雜湊。`contract:verify` 同時檢查 SDK 版本與 hash；打包前也驗證 devkit lock。
- 作者 CLI 使用公開 kit 內嵌的 trust anchors；公開 kit 更新後重新同步。此 repo 不讀取主程式的 anchors。

### 簽章與金鑰

- `release.mjs` 包裝 devkit `pack`（再以另一個行程 `verify`），拒絕位於本 repo 內或任何 git 工作樹內的金鑰路徑，並拒絕 devkit 檔與 lock 不符。真金鑰的 passphrase 只能在互動終端機輸入；環境變數 `TEAMUQ_KEY_PASSPHRASE_FOR_TESTS` 只在 `build.mjs` 為暫時金鑰注入時才傳給 devkit，其餘情況一律移除。
- 暫時金鑰（`tools/temp-key.mjs`）：`os.tmpdir()` 下的隨機目錄、隨機 passphrase、keyId `teamuq-tmp-<8 hex>`，用完即刪；只留公鑰在 `dist/signer.pub.json`。產物只能用 `--anchors self` 驗章，真的 Core 不接受。
- `--anchors self` 只用於作者端暫時金鑰自我驗證；通過並不代表已取得正式 host 的簽署信任。正式安裝需使用 host 信任的 release 或 development 簽署方式，依公開 devkit 文件操作。

### 正式簽章（H2）

只由持有根金鑰的使用者在**真實終端機**（Windows Terminal／PowerShell 視窗，不是管線、不是 AI 工具的 shell）執行；金鑰檔、passphrase 不進 repo、不交給任何 AI 工具。

```powershell
cd C:\teamuq\teamuq-plugins\memory
node tools/build.mjs --key C:\Users\david\.teamuq-keys\teamuq-root-2026a.key.pem
```

- 出現 `Passphrase for teamuq-root-2026a:` 時輸入 passphrase（不顯示字元），Enter；**120 秒內**要輸入完（devkit 子行程的逾時）。
- 不帶 `--anchors`，預設 `core`：金鑰 keyId（取自檔名）必須是 devkit 內嵌的兩把之一，否則在問 passphrase 之前就拒絕。
- 產物 `dist/teamuq.memory-1.2.0.tuqplugin`；`dist/build-info.json` 記 `anchors: "core"`、`signer.keyId: "teamuq-root-2026a"`。`dist/signer.pub.json` 若存在是舊暫時金鑰的殘留，正式產物不使用。
- 驗證：`node vendor/teamuq-devkit/tuq-plugin-tool.mjs verify dist/teamuq.memory-1.2.0.tuqplugin --anchors core`，必須 exit 0 且 `signer.keyId` 為 `teamuq-root-2026a`；也可用 `node tools/verify-artifact.mjs dist/teamuq.memory-1.2.0.tuqplugin --anchors core`。
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
- 作者 CLI 已釘選公開 Devkit 1.8.2，支援 dev-pack 的 preplanted id；升版從公開 kit 同步。

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
| `npm run perf:ui -- --data <目錄>` | 見「UI 方法（S3）」：10k 筆資料集上的耗時、事件迴圈停頓與並行寫入檢查 |
| `npm run contract:verify` | 驗證 `vendor/teamuq-contract/` 與 lock、`vendoredContractLock.ts` 一致 |
| `npm run contract:sync` | 從本 repo `contract/v1/` 重新生成 contract vendor（寫入檔案） |
| `npm run verify:source` | 驗證 lock／package 的 Cairn pin、`core/` tree hash、`redact.mjs` sha256、唯一 import 位置 |
| `npm run check:secrets` | 找私鑰區塊、`*.pem`／`*.key`／`keys/`，並確認 `.gitignore` 仍排除它們 |
| `npm run build` | 見「打包與簽章」，輸出到 `dist/`（gitignored） |
| `npm run dev:pack -- --key <dev key>` | 見「開發迭代」：以開發金鑰打出 `dist/dev/teamuq.memory.tuqplugin`（版本逐次遞增），只給隔離 Core dev profile |
| `node tools/sync-vendor.mjs --kit <公開 devkit 路徑> --only devkit` | 從公開 kit vendor CLI/lib 與來源 lock（`contract:sync` 只同步契約） |

## 金鑰

私鑰、`*.pem`、`*.key`、`keys/` 不進 repo（`.gitignore` 排除、`check-no-secrets` 把關）。正式簽章金鑰由使用者自行保管。
