# 開發手冊

本文件說明如何在不影響正式資料的情況下開發、測試及檢查 Router。
程式碼規範請另見 [貢獻與開發規則](CONTRIBUTING.md)。

## 環境需求

- Bun `1.3.14`
- Docker Engine 與 Docker Compose 外掛
- Bash、curl

本專案使用 Bun 內建執行環境與 Node 相容內建模組，不需要執行 `npm install`
或安裝額外的 TypeScript runtime。

## 本機直接執行

使用獨立的暫存資料目錄，避免讀寫正式環境的 `data/`：

```bash
export CODEX_ROUTER_DATA_DIR=/tmp/local-responses-api-router-dev
export CODEX_ROUTER_DASHBOARD_PORT=38127
export CODEX_ROUTER_ROUTER_PORT=38128
bun run start
```

開啟：

```text
Dashboard: http://127.0.0.1:38127/
Router:    http://127.0.0.1:38128/{provider}/v1
```

不要把正式 SQLite 或 JSON 檔複製進測試目錄，除非正在驗證 migration，且資料已完成
去識別化處理。

## 使用 Docker 開發

`compose.yaml` 是一般使用者與本機開發使用的單容器設定：

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f
```

停止：

```bash
docker compose down
```

此專案只建立一個 Router 容器，Dashboard 與 Router 由同一個 Compose 服務管理。

## 自動測試

執行完整整合測試：

```bash
bun run test
```

測試會使用 Bun 驗證 Responses、Chat Completions、Route only、重試、Session 與
SQLite migration。Dashboard 產物使用 `bun run build:dashboard` 建置，產生的
`.output/` 目錄不應提交。

Docker 與 Compose 驗證：

```bash
docker build -t local-responses-api-router:dev .
docker compose config
```

## 手動 QA

啟動單容器後先檢查：

```bash
curl http://127.0.0.1:38127/healthz
curl http://127.0.0.1:38128/healthz
```

再確認：

- Dashboard 能正常載入、保存設定並顯示成功通知。
- 淺色、深色及繁體中文、簡體中文、英文切換正常。
- 相同上游 URL、不同 Route ID 的供應商不會互相取代。
- `Route only` 開啟及關閉時都能依設定轉送。
- Detailed logging 關閉後不再保存請求與 Session。
- Dashboard authentication 開啟及關閉後立即生效。
- Provider URL 使用目前瀏覽器的公開來源，不會寫死 localhost。

測試上游 API 時，將金鑰放在暫時環境變數或秘密管理工具，不要寫進腳本、fixture、
終端輸出或 commit。

## 修改資料層

- SQLite 實作位於 `server/backend/storage/sqlite-store.ts`。
- migration 必須透過具名 marker 執行，並可安全重複啟動。
- migration 前先備份真實資料，再使用副本測試。
- 新舊容器同時運行時，不得讓較舊 context 覆蓋較新 context。
- 維持資料目錄 `0700`、資料檔案 `0600`。

## 修改 Dashboard

- Vue Dashboard 原始碼位於 `app/`，後端 Nitro handlers 位於 `server/`。
- 使用 `bun run format` 自動排版，使用 `bun run lint` 檢查格式與常見錯誤；也可以使用
  `bun run lint:fix` 同時套用 Biome 修正。VS Code 開啟此專案後，推薦的 Biome 與 Vue
  擴充套件會提供儲存時自動排版及 import 整理。
- 使用 `bun run build:dashboard` 重新建置正式 Dashboard。
- 固定控制元件尺寸，避免按鈕、捲軸或狀態文字改變版面。
- 所有新增文字都要補上繁體中文、簡體中文及英文翻譯。

## 開發完成檢查

```bash
bun run test
docker build -t local-responses-api-router:dev .
docker compose config
git diff --check
git status --short
```

最後必須透過實際 Dashboard 或 HTTP API 驗證，不以「程式可以編譯」取代操作測試。
