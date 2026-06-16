# CLAUDE.md — BugEzy 工程規則

> Claude Code 在 Zed 中的行為準則

## 基本規則

1. **先讀任務**：開工前先讀 `job/job-MMDD.md` 找到指派的 PM-XX
2. **先讀架構**：動手前先讀 `ARCHITECTURE.md` 和 `docs/` 下的規格書
3. **不猜測**：不確定就問 FOX，不要假設
4. **停工規則**：遇到需要 FOX 決策的問題立即停工回報
5. **範圍控制**：只做被指派的任務，不自作主張擴大範圍
6. **唯讀鐵律**：Claude Chat（PM）不改程式碼，所有修改由 Claude Code 執行

## Commit 規範

- 格式：`feat/fix/docs: 描述（日期）`
- 例：`feat: Chrome 擴充截圖功能（2026-06-17）`
- 每個 PM 完成後 commit，不要累積

## 技術棧

- Chrome 擴充：Manifest V3 + TypeScript
- DOM 側錄：rrweb
- 語音辨識：Web Speech API（優先）→ Groq Whisper API（降級）
- 後端 API：Cloudflare Workers
- 資料庫：Supabase（PostgreSQL）
- 檔案儲存：Cloudflare R2
- Web App：React + Vite
- MCP Server：TypeScript + MCP SDK

## 目錄結構

```
extension/     Chrome 擴充（Manifest V3）
server/        Cloudflare Workers API
web/           React 報告頁
mcp-server/    MCP Server
docs/          規格文件
job/           每日任務檔
```

## 注意事項

- 語音 API 成本敏感：優先用免費的 Web Speech API，不準時才降級 Groq
- rrweb 錄 DOM 變化（JSON），不錄影片（省儲存）
- MCP 用 Pull 模式（按需查詢），不要一次推送全量資料
- 智能過濾：只擷取 console.error 和 4xx/5xx，不存 200 OK
