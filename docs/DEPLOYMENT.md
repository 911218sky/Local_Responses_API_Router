# 部署與維運手冊

本專案使用單一 Docker Compose 服務，Dashboard 與 Router 共用同一個容器與資料目錄。

## 啟動

```bash
git clone https://github.com/911218sky/Local_Responses_API_Router.git
cd Local_Responses_API_Router
docker compose up --build -d
```

若 Router 透過 Nginx 與 Cloudflare 對外提供服務，請在對應的 `server` 區塊加入
`deploy/nginx/llm-router.conf` 中的設定，尤其是 `client_max_body_size 50m;`。Responses
續接請求會攜帶累積的輸入歷史；若仍使用 Nginx 預設的 1 MiB 限制，長對話會在 Router
收到請求前回傳 `413 Payload Too Large`。

套用範例：

```bash
sudo install -m 0644 deploy/nginx/llm-router.conf /etc/nginx/sites-available/llm-router
sudo ln -sfn /etc/nginx/sites-available/llm-router /etc/nginx/sites-enabled/llm-router
sudo nginx -t
sudo systemctl reload nginx
```

若既有站台已負責 TLS，請只把 `client_max_body_size 50m;`、`proxy_request_buffering off;`
及相關 timeout/header 設定合併到現有的 Router `location`，不要建立第二個同名 `server`。

確認容器與健康狀態：

```bash
docker compose ps
curl http://127.0.0.1:38127/healthz
curl http://127.0.0.1:38128/healthz
```

預設入口：

```text
Dashboard: http://127.0.0.1:38127/
Router:    http://127.0.0.1:38128/{provider}/v1
```

## 更新

```bash
git pull --ff-only
docker compose up --build -d
docker compose ps
```

Compose 使用 `restart: unless-stopped`。若 Docker daemon 在 WSL 啟動，容器會自動恢復；也可手動啟動：

```bash
docker compose start
```

停止服務：

```bash
docker compose down
```

## 連接埠

可在 `compose.yaml` 或環境變數中調整本機連接埠：

```bash
CODEX_ROUTER_DASHBOARD_PORT=38127 CODEX_ROUTER_ROUTER_PORT=38128 docker compose up --build -d
```

Dashboard 與 Router 預設只綁定 `127.0.0.1`。若要讓其他主機存取，請明確修改 Compose 的 port 綁定與防火牆規則。

## 資料與備份

執行資料位於 `./data/`，包含 SQLite 資料庫與相容舊版的設定檔。資料可能包含 API 金鑰、提示詞和回應內容，請勿提交至 Git。

停止容器後備份整個資料目錄：

```bash
docker compose down
tar -czf router-data-backup.tgz data/
docker compose up -d
```

目錄權限基準為 `0700`，資料檔案為 `0600`。

## 部署後檢查

```bash
docker ps --filter name=local-responses-api-router
docker inspect --format '{{.State.Health.Status}}' local-responses-api-router
curl -fsS http://127.0.0.1:38127/healthz
curl -fsS http://127.0.0.1:38128/healthz
```

Dashboard 的設定頁可啟停 Router；Router 健康端點在服務停止時會回傳 `503`，啟動時回傳 `200`。

## 故障排查

- 容器未啟動：執行 `docker compose logs --tail=200 local-responses-api-router`。
- Dashboard 無法連線：確認 `docker compose ps` 的 port 映射，並檢查 `127.0.0.1:38127` 是否被其他程式占用。
- Router 回傳 404：請使用 `/{provider}/v1/...` 路徑，並在 Dashboard 設定相同的 Provider route ID。
- 更新後資產未變更：執行 `docker compose build --no-cache && docker compose up -d`。

請勿在排查時輸出完整環境變數、Authorization header、Dashboard 密碼或上游回應內容。
