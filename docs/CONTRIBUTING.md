# 貢獻與開發規則

提交變更前，請先閱讀 [開發手冊](docs/DEVELOPMENT.md) 與
[部署手冊](docs/DEPLOYMENT.md)。

## 基本原則

- Runtime 與套件管理統一使用 Bun，不加入 Node.js 專用啟動流程。
- TypeScript 使用標準 ESM `import` / `export`，不要新增 CommonJS `require()`。
- 不使用 `any`、`@ts-ignore`、`@ts-expect-error` 或非空斷言略過型別問題。
- 外部輸入只在 HTTP、檔案或環境變數邊界解析，內部函式維持明確型別。
- 優先使用 Bun 與 Node 相容內建模組。新增第三方套件前，必須說明必要性。
- 只修改完成需求所需的範圍，不夾帶無關重構或格式變更。
- API 金鑰、Dashboard 密碼、上游回應、請求內容及 `data/` 不得提交到 Git。

## 相容性要求

- 保持 `/{provider}/v1/...` 路由格式向後相容。
- `Route only` 必須保留原始 API 路徑與請求內容。
- Detailed logging 關閉時，不得新增持久化請求或 Session 資料。
- SQLite schema 或資料格式變更必須提供可重複執行的 migration，並保留舊資料。
- 單一容器部署期間，SQLite 資料寫入必須支援 WAL 與時間戳優先順序。
- 公開 API 或錯誤訊息不得洩漏密碼雜湊、內嵌 URL 憑證或 Authorization header。

## 變更流程

1. 從最新的 `main` 建立功能分支。
2. 先加入能重現問題或描述新行為的測試。
3. 實作最小範圍的修正。
4. 執行 `bun run test`。
5. 涉及 Dashboard 時，在淺色與深色模式下檢查桌面及手機版面。
6. 涉及部署時，驗證 Docker health check、Nginx 設定與回滾流程。
7. 更新受影響的 README 或 `docs/` 文件。

## Commit 與 Pull Request

- 每個 commit 只包含一個可獨立理解及回復的行為變更。
- Commit message 使用倉庫現有的 Conventional Commit 風格，例如：

```text
feat: add provider health status
fix: preserve newer response contexts
docs: document production deployment
test: cover capacity retry behavior
```

- Pull Request 必須說明目的、風險、測試方法，以及是否影響資料或部署流程。
- GitHub Actions 必須通過後才能合併。

## 完成標準

- 測試通過，且沒有刪除或弱化既有測試。
- 實際透過 Dashboard 或 HTTP API 驗證使用者流程。
- 沒有新增未追蹤的 build、測試、記錄或憑證檔案。
- 文件與實際指令一致。
- 正式部署變更具有明確的回滾方法。
