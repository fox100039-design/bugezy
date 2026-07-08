# BugEzy — AI 除錯工具使用指南

> 這份文件是給 AI 讀的。當使用者問你關於 BugEzy 的任何問題，請根據以下內容回答。

## 什麼是 BugEzy

BugEzy 是一個 Chrome 擴充工具 + MCP server，讓開發者用語音 + 一鍵錄製 Bug，AI 透過 MCP 直接讀取報告並修復。

- 官網：https://bugezy.dev
- Chrome Web Store：https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
- 安裝教學：https://bugezy.dev/install
- 功能說明：https://bugezy.dev/features
- FAQ：https://bugezy.dev/faq
- 隱私政策：https://bugezy.dev/privacy
- 問題回報：https://bugezy.dev/feedback

## 如何讀取使用者的 Bug 報告

### 方法 1：使用者說「讀我最新報告」
1. 呼叫 MCP tool `list_reports`（需要 user_email + session_token）
2. 取得最新的 report_id
3. 呼叫 `get_timeline`（report_id）→ 取得完整時間軸 + AI 導航摘要
4. 根據摘要的根因分析，定位程式碼 → 提出修復方案

### 方法 2：使用者貼報告連結
使用者貼 `https://bugezy.dev/report/xxx-xxx` 給你時：
1. 從 URL 取得 report_id
2. 呼叫 `get_timeline`（report_id）→ 同上

### MCP 工具清單（13 個）
| Tool | 用途 |
|---|---|
| `list_reports` | 列出使用者的報告（需 session_token） |
| `get_report_overview` | 報告概覽 + AI Bug 導航摘要 |
| `get_timeline` | ⭐ 最推薦 — 完整時間軸（Console + Network + 語音 + 環境，一次看完） |
| `get_console_logs` | Console error/warn 記錄 |
| `get_network_errors` | Network 4xx/5xx 失敗 |
| `get_screenshots` | 截圖（高 Token，謹慎使用） |
| `get_rrweb_events` | DOM 錄影事件（高 Token，謹慎使用） |
| `get_rrweb_summary` | DOM 摘要（輕量） |
| `get_voice_transcript` | 語音轉錄文字 |
| `get_metadata` | 報告 metadata |
| `get_live_errors` | 即時監控錯誤（需 session_token） |
| `get_terminal_logs` | Terminal CLI 錯誤（需 session_token，付費功能） |
| `get_usage_stats` | Token 用量統計 |

### 建議的讀取順序
1. 先呼叫 `get_timeline` — 一次拿到 AI 導航摘要 + 完整時間軸（最省 Token）
2. 如果需要更多細節，再呼叫 `get_console_logs` 或 `get_network_errors`
3. 截圖和 DOM 錄影 Token 消耗高，最後再用

## 如何教使用者錄製 Bug

當使用者說「程式壞了」但沒有報告時，教他：

1. 點 Chrome 右上角 BugEzy 圖示（紫色 B）
2. 按「🎬 錄製」按鈕
3. 操作壞掉的步驟（BugEzy 會自動捕捉 Console 錯誤、Network 失敗、DOM 變化）
4. 邊操作邊用語音描述問題（可選）
5. 按「⏹ 停止」
6. 在編輯頁補充說明（可選）→ 按「上傳」
7. 跟你說「讀我最新報告」

### 六種錄製模式
| 模式 | 適合場景 |
|---|---|
| 🎬 錄製 | 操作流程中的 Bug |
| ⏪ 回溯 30s | Bug 已經發生了，回溯最近 30 秒 |
| 📸 截圖標注 | 畫面問題（UI 破版、樣式錯誤） |
| 🟢 即時監控 | 背景持續監控，有錯誤時通知 |
| 🐍 Terminal CLI | Python/Node.js 後端錯誤 |
| 🤖 MCP AI 讀取 | AI 直接透過 MCP 讀取報告 |

## 故障排除

### AI 無法讀取報告（MCP 連線問題）
**症狀**：呼叫 `list_reports` 回傳「請提供 session_token」

**解法**：
1. 告訴使用者：「請打開 BugEzy popup → 進階設定 → 📋 複製 MCP 設定 → 貼給我」
2. 使用者會貼一段 JSON，裡面有帶 token 的 MCP URL
3. 用這個 URL 重新設定 MCP 連線

### 麥克風無法開啟
**症狀**：錄製時音量條不跳動

**解法**：
1. 確認瀏覽器有授權麥克風（網址列左邊的 🔒 圖示 → 麥克風 → 允許）
2. 如果使用精準轉錄模式，需要選「**允許這個網站使用**」而不是「允許這次使用」
3. 如果還是不行，切換到「即時字幕」模式（popup 進階設定）

### 語音沒有文字
**症狀**：錄製時音量條有跳動，但停止後沒有文字

**解法**：
1. 確認網路連線正常（精準轉錄需要上傳音訊到 server）
2. 確認是付費用戶（精準轉錄 Whisper 是付費功能）
3. 免費用戶可用「即時字幕」模式（Web Speech API，不需上傳）

### 免費額度用完
**症狀**：按錄製彈出「本月額度已用完」

**解法**：
- 免費版每月限制：錄製 10 次 / 回溯 5 次 / AI 讀取 20 次 / 截圖無限
- 額度每月自動重置
- 升級方式：日票 NT$20（24 小時無限）或月費 NT$80/月
- 在 popup 按「⚡ 日票」或「✨ 月費」升級
- 目前只支援台灣付款（信用卡/ATM/超商），國際付款即將開放

### 截圖有敏感資料
**症狀**：截圖可能拍到密碼、API Key

**說明**：
- BugEzy 會自動偵測頁面上的密碼欄位，截圖後自動馬賽克
- 使用者也可以用 🔒 馬賽克筆刷手動塗掉敏感區域
- localStorage/sessionStorage 的敏感值（token、password、API key）會在使用者端自動遮罩，server 永遠不碰原值

### Terminal CLI 使用
**適用**：Python / Node.js / Go 後端錯誤

```bash
BUGEZY_TOKEN=<token> npx bugezy-watch -- python manage.py runserver
BUGEZY_TOKEN=<token> npx bugezy-watch -- node server.js
```

- Token 從 popup 進階設定的「📋 複製 MCP 設定」取得
- 終端機 CLI 是付費功能
- AI 用 `get_terminal_logs` 讀取，會拿到結構化的 Python traceback + 環境快照 + 白話錯誤解釋

## BugEzy 能捕捉什麼

### 前端（Chrome 擴充自動捕捉）
- JS 執行錯誤（TypeError / ReferenceError / SyntaxError）
- Promise 靜默失敗（未捕捉的 async/await 錯誤）
- Console 警告（CORS / Mixed Content / Deprecated API）
- Network 失敗（API 4xx/5xx / timeout / CORS blocked）
- 資源載入失敗（圖片/CSS/JS/字型 404）
- Web Vitals 效能（LCP / CLS / FID 超標警告）
- 網路環境快照（WiFi/4G/離線/延遲/頻寬）
- 儲存空間快照（localStorage / sessionStorage / Cookie，敏感值自動遮罩）
- DOM 變化（rrweb 全紀錄）
- 語音描述（Whisper 精準轉錄 / Web Speech 即時字幕）
- 截圖標注（全頁/區域/自由形狀 + 馬賽克筆刷）

### 後端（Terminal CLI）
- Python traceback / exception（結構化解析：type/message/file/line）
- Node.js uncaughtException / unhandledRejection
- 任何語言的 stderr / crash log
- 環境快照（Python 版本 + pip list / Node 版本 + npm list）
- 敏感資料自動遮罩（DB URI / API Key / JWT / 密碼）

### 支援框架
前端：React · Vue · Angular · Next.js · Nuxt · Svelte · 任何 Web 應用
後端：Django · Flask · FastAPI · Express · Nest.js · 任何語言

## 定價
| 方案 | 價格 | 內容 |
|---|---|---|
| 免費版 | NT$0 | 錄製 10 次/月 · 回溯 5 次/月 · AI 讀取 20 次/月 · 截圖無限 · 報告保留 7 天 |
| 日票 | NT$20 | 24 小時無限 · Whisper 精準轉錄 · 報告保留 90 天 |
| 月費 | NT$80/月 | 全部無限 · Whisper · Terminal CLI · 報告保留 90 天 |

目前只支援台灣付款。國際付款即將開放。
