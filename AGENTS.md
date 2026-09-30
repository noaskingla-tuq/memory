# teamuq-plugin-memory — agent rules

本檔只列強制規則，一條一行。設計依據：`C:\teamuq\teamuq-electron\output\memory-hook-mcp\external-plugin-design-v3.md`。

- 本 repo 是 TeamUQ 記憶系統的獨立外部 plugin（id `teamuq.memory`，full-trust）；只建本機 repo，不建遠端、不 push，除非使用者明確要求。
- `src/{application,domain,adapters}` 自 TeamUQ `packages/platform/memory-server` 原樣搬出；來源 commit 與 tree hash 記在首個 commit 訊息。改動只限本 repo 需要的 import 路徑，不順手重構。
- 唯一可 import `cairn-memory` 的檔是 `src/adapters/cairn/cairnCoreAdapter.ts`，且只走 `cairn-memory/core/index.mjs`；由 `tools/verify-source-untouched.mjs` 把關。
- Cairn 由 `cairn-pin.json` 釘死：升 commit 前先讀 diff，更新 `commit`、`coreTree`、`redactSha256`，並把相容的 commit 放進 `accepted[]`；`package.json` 與 lock 必須同步。
- 每個 `accepted[]` 項目都必須有 `test/fixtures/legacy-db/<commit>/` 真實舊庫 fixture（`tools/make-legacy-fixture.mjs` 產生）；備份失敗一律回 `STORAGE_BUSY`、不得回 `INTERNAL`。
- `vendor/teamuq-contract/` 是 TeamUQ Core 契約的副本，禁止手改；只用 `tools/sync-vendor.mjs --core <TeamUQ 路徑>` 更新，`npm run contract:verify` 必須 exit 0。
- `src/backend/` 只服務 `memory.remember@1`、`memory.inspect@1`、`diagnose`；整次呼叫失敗的碼只能是 `unknown_method`、`invalid_params`、`result_too_large`、`internal`，個別操作的錯誤碼只能取自契約 `MEMORY_ERROR_CODES`。
- 私鑰、`*.pem`、`*.key`、`keys/` 永不進 repo，也不進 agent context；`tools/check-no-secrets.mjs` 必須 exit 0。`tools/release.mjs` 拒絕 repo 內或任何 git 工作樹內的金鑰路徑；只用暫時金鑰（`tools/temp-key.mjs`，用完即刪）驗證，正式金鑰由使用者親手簽章。
- 測試檔（`test/*.test.mjs`）在測試執行期間不得寫 stdout（`console.log`／`process.stdout.write`／子行程 inherit stdout）；附註走 `console.error` 或 `t.diagnostic()`。
- 新程式檔 ≤500 行；不新增 `utils`、`helpers`、`common`、`misc`。
- 程式碼內不寫檔頭 banner、不重述程式碼、不寫批次／輪次／commit 歷史；理由只寫 `// why: <一行>`。
- 只在本 repo 目錄內執行 `npm install`，且一律 `--ignore-scripts`；不平行安裝。
- `vendor/teamuq-devkit/` 是 TeamUQ devkit 的單檔副本，禁止手改；只用 `npm run devkit:sync -- --core <TeamUQ 路徑>` 更新，`contract:verify` 會比對 `devkit.lock.json`。Core 的 `TEAMUQ_TRUST_ANCHORS` 一變就要重跑。
- `cairn-pin.json` 的 `stage` 記錄打包進 artifact 的 Cairn 檔案與 sha256；升 Cairn 後跑 `node tools/stage-cairn.mjs --record`。`tools/verify-artifact.mjs` 與 `tools/build.mjs` 不得放寬檔案集合、雜湊、無 `core/test`、相對 import 可解析的斷言。
- 資料層路徑檢查只能從 `dataDir` 往下（`trustedBase`），不得往上讀祖先目錄：`--permission` 下外掛讀不到 `dataDir` 以上的路徑。
- 驗證入口：`npm run check`（tsc、`node --test`、`verify-source-untouched`、`check-no-secrets`）。
