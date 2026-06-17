# mcp-server — MCP Server（Pull 模式 8 Tool）

AI 助手（Claude Code / Cursor / Copilot）透過 MCP 協定**按需查詢** BugEzy 報告，只拉需要的欄位 → 省 token。資料源是 Workers API（`server/`）。

## 8 個 Tool

| Tool | 說明 | 參數 |
|---|---|---|
| `list_reports` | 列出最近報告（metadata） | `limit?`(1-50,預設10)、`url?`(模糊搜尋) |
| `get_report_overview` | 概覽（metadata + 各筆數） | `report_id` |
| `get_console_logs` | Console 記錄（warn/error） | `report_id` |
| `get_network_errors` | Network 錯誤（4xx/5xx） | `report_id` |
| `get_voice_transcript` | 語音轉錄（最有價值線索） | `report_id` |
| `get_page_info` | 頁面資訊 | `report_id` |
| `get_rrweb_summary` | DOM 軌跡摘要（數量/時長/類型分布） | `report_id` |
| `get_rrweb_events` | 完整 rrweb 事件（⚠ 可能數 MB） | `report_id` |

## 設定

- API base 從環境變數 `BUGEZY_API_URL` 讀，預設 `http://127.0.0.1:8787`
- 傳輸：stdio（IDE 整合）

## Build / Run

```powershell
cd C:\dev\bugezy\mcp-server
npm install
npm run build        # tsc → dist/index.js
npx tsx src/index.ts # 或 node dist/index.js（stdio，等 stdin）
```

## IDE 設定範例（Claude Code `.mcp.json`）

> ⚠ 不要覆蓋本專案根目錄既有的 `.mcp.json`（那是 memory 用）。這段是給「使用 BugEzy 的開發者」的 IDE 設定。

```json
{
  "mcpServers": {
    "bugezy": {
      "command": "node",
      "args": ["C:\\dev\\bugezy\\mcp-server\\dist\\index.js"],
      "env": { "BUGEZY_API_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

前置：Workers API 要在跑（`cd server && npx wrangler dev`）。
