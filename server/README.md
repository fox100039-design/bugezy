# server — Cloudflare Workers API

報告上傳、儲存（R2 + Supabase）、分享連結。供 `web/` 報告頁與 `mcp-server/` 讀取。

## 端點

| Method | Path | 說明 |
|---|---|---|
| `POST` | `/api/reports` | 接收 `RecordingPayload`：rrweb 軌跡存 R2、metadata + console/network/voice 存 Supabase；回 `{ report_id, share_url }` |
| `GET` | `/api/reports/:id` | 讀回完整報告（含從 R2 取回的 `rrwebEvents`） |
| `GET` | `/api/reports` | 列出最近報告（metadata only，`limit`/`url` 過濾） |
| `*` | `/mcp` | MCP 端點（Streamable HTTP，`agents/mcp` 的 `createMcpHandler`）— 8 tool，給 Claude.ai Connectors / IDE 直接連 |
| `OPTIONS` | `*` | CORS preflight（MVP 全開 `*`） |

## 儲存切分

- **R2**（`bugezy-reports` bucket）：`reports/<id>/rrweb.json`（大檔 DOM 軌跡）
- **Supabase**（`reports` 表）：metadata + 各計數 + `console_logs`/`network_errors`/`voice_transcript`（JSONB）+ `rrweb_r2_key`

## 檔案

```
server/
├── package.json       # @supabase/supabase-js + wrangler + workers-types
├── tsconfig.json      # strict，types: @cloudflare/workers-types
├── wrangler.toml      # name=bugezy-api、R2 binding、SUPABASE_URL
├── schema.sql         # Supabase 建表 SQL（複製到 SQL Editor 執行）
└── src/index.ts       # Workers 入口（兩端點 + CORS）
```

## 機密

`SUPABASE_ANON_KEY` 走 `wrangler secret put SUPABASE_ANON_KEY`，**不寫進程式碼/wrangler.toml**。本機開發可放 `server/.dev.vars`（已被 .gitignore）。

## FOX 啟用步驟（一次性）

```powershell
npm install -g wrangler
wrangler login
wrangler r2 bucket create bugezy-reports
cd C:\dev\bugezy\server
wrangler secret put SUPABASE_ANON_KEY    # 貼 anon key
npm install
npx wrangler dev                          # → localhost:8787
```

Supabase：Dashboard → SQL Editor → 貼 `schema.sql` → Run。

## curl 驗收

```powershell
curl -X POST http://localhost:8787/api/reports -H "Content-Type: application/json" -d '{"rrwebEvents":[{"type":4}],"consoleLogs":[],"networkErrors":[],"voiceTranscript":[],"pageInfo":{"url":"https://test.com","title":"Test","browser":"Chrome","screenSize":"1920x1080","timestamp":"2026-06-16T00:00:00Z"}}'
# → { "report_id": "...", "share_url": "..." }
curl http://localhost:8787/api/reports/<report_id>
```
