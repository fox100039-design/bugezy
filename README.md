# BugEzy

> 亞洲專屬平價 MCP 語音除錯工具
> 發起人：FOX ｜ 初版：2026-06-16 ｜ 規格：[`docs/BugEzy_產品規格書_v0.2.md`](docs/BugEzy_產品規格書_v0.2.md)

開發者用中文語音錄 Bug，自動產出 **DOM 軌跡 + 網路錯誤 + Console Log + 中文字幕** 的完整報告，一鍵分享給隊友或 AI 助手直接修復。

## 核心差異（vs Jam）
- 中日韓越混雜語音原生支援（本地 Web Speech API 優先 → 雲端降級）
- NT$80/月（便宜 82%）
- rrweb DOM 軌跡（儲存趨近零，不存真影片）
- MCP **Pull** 模式（按需查詢，省 token）

## 專案結構（monorepo）
| 目錄 | 用途 |
|------|------|
| `extension/` | Chrome 擴充（Manifest V3）— 錄製 DOM/網路/Console + 語音 |
| `server/` | Cloudflare Workers API — 報告儲存與分享 |
| `web/` | React 報告頁 — 播放 rrweb 軌跡 + 字幕 |
| `mcp-server/` | MCP Server — AI 助手按需 Pull 報告資料 |
| `docs/` | 規格與設計文件 |

## 狀態
延伸專案（原隸屬 `lottoshare_tools`），2026-06-16 獨立為 `C:\dev\bugezy`。
