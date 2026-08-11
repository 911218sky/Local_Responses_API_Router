# Local Responses API Router

以 Bun 與 Docker 建置的本機 LLM Router 與 Dashboard，可將多個上游 API
整理為統一的 `/{provider}/v1` 路由。

## 功能

- 多供應商路由與獨立 Route ID。
- 支援 Responses API、Chat Completions 與 Route only。
- Dashboard 管理供應商、Router 狀態、請求紀錄與 Session。
- 每條路由可獨立設定模型轉換（例如 `claude-sonnet-4-6` -> `gpt-5.6-terra`），也可使用 `*` 萬用來源模型。
- 路由支援通用 API path 轉送，包括上游提供的 `/images/generations` 圖片生成端點。
- Dashboard 驗證、深色模式及繁體中文、簡體中文、英文介面。
- 使用單一 Docker 容器部署，設定與資料持久化於 `./data/`。

## 快速開始

```bash
git clone https://github.com/911218sky/Local_Responses_API_Router.git
cd Local_Responses_API_Router
docker compose up --build -d
```

```text
Dashboard: http://127.0.0.1:38127/
Router:    http://127.0.0.1:38128/{provider}/v1

### 模型轉換與圖片生成

在 Dashboard 的提供商編輯視窗中新增模型 mapping。`from` 是客戶端送入的模型名稱，`to` 是該路由上游實際使用的模型名稱；精確名稱優先於 `*`。例如：

```json
"modelMappings": [
  { "from": "gpt-5.6-sol", "to": "gpt-5.6-terra" },
  { "from": "claude-sonnet-4-6", "to": "gpt-5.6-terra" }
]
```

圖片請求可使用同一條路由：`POST /<provider>/v1/images/generations`。Router 會保留圖片 API payload，只套用該路由的模型 mapping、驗證與上游轉送設定。
```

一般使用者只需要此單容器模式。啟動後在 Dashboard 新增 Provider，並使用它的
Route ID 呼叫 Router。原生 Bun 執行、設定、開機啟動與正式部署請閱讀下列文件。

## 本機部署教學

### Docker（推薦）

1. 安裝 Docker Engine 與 Docker Compose plugin。
2. 下載並進入專案：

   ```bash
   git clone https://github.com/911218sky/Local_Responses_API_Router.git
   cd Local_Responses_API_Router
   ```

3. 建立並啟動容器：

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

4. 開啟 `http://127.0.0.1:38127/`，在 Dashboard 的「提供商」頁新增上游服務。
   Router 請求格式為 `http://127.0.0.1:38128/{provider}/v1/...`。

資料會保存在專案的 `data/` 目錄。停止服務使用 `docker compose down`，更新程式
使用 `git pull --ff-only && docker compose up --build -d`。

### 直接使用 Bun

需要 Bun `1.3.14` 或更新版本：

```bash
bun install --frozen-lockfile
bun run build
bun run start
```

直接執行時可用環境變數調整資料目錄和連接埠：

```bash
CODEX_ROUTER_DATA_DIR=/tmp/local-responses-api-router \
CODEX_ROUTER_DASHBOARD_PORT=38127 \
CODEX_ROUTER_ROUTER_PORT=38128 \
bun run start
```

詳細的開發檢查、WSL 自動啟動、備份與故障排查請見
[部署與維運手冊](docs/DEPLOYMENT.md) 與 [開發手冊](docs/DEVELOPMENT.md)。

## 文件

- [開發手冊](docs/DEVELOPMENT.md)
- [部署與維運手冊](docs/DEPLOYMENT.md)
- [貢獻與開發規則](docs/CONTRIBUTING.md)
- [Dashboard 設計系統](docs/DESIGN.md)

## 授權與來源

本專案的靈感來源為
<https://github.com/BINKLINGS/Local_Responses_API_Router>。
