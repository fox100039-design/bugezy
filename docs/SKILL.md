---
name: BugEzy MCP Voice Debug Tool Dev Guide
description: >
  Asian affordable MCP voice debugging tool BugEzy development guide.
  Triggers on keywords: BugEzy, Bug Ezy, bug reporter, Chrome extension,
  MCP debug, rrweb, Whisper, 語音除錯, DOM 軌跡, voice transcript,
  offscreen document, SpeechRecognition, Cloudflare Workers, Supabase,
  inject.ts, content.ts, background.ts, popup, recording payload,
  seven generations, 七代迭代.
---

# BugEzy 平台開發規範

## 平台概覽
亞洲專屬平價 MCP 語音除錯工具。開發者用中文語音錄 Bug → 自動產出 DOM 軌跡 + Console + Network + 中文字幕 → 一鍵分享 → AI 透過 MCP Pull 模式直接讀取修復。
FOX 是唯一創辦人（同時也是 LottoShare 創辦人），外送員 + 雙專案創業者。

## 角色分工
- **Claude Chat（Opus）** = PM/策略，出任務、驗收、維護文件
- **Claude Code（Sonnet，在 Zed 編輯器）** = 工程師，讀 job 檔執行
- **FOX** = 最高管理員 + 手動驗收

## 七代迭代計畫
| 代 | 名稱 | 狀態 |
|---|---|---|
| ① 能錄能存 | Chrome 擴充骨架（rrweb + Console + Network） | ✅ 完成 |
| ② 能聽能說 | Web Speech API 中文語音辨識 | ✅ 完成 |
| ③ 能存能看 | Cloudflare Workers + Supabase + R2 + React 報告頁 | ✅ 完成 |
| ④ AI 能讀 | MCP Server（Pull 模式 8 Tool）= MVP 封測 | ✅ 完成 |
| ⑤ 能收錢 | Stripe 付費 + Chrome Web Store 上架 | 待做 |
| ⑥ 更好用 | 六模式（錄製/⏪回溯/截圖/🔍即時監控/🔇鍵盤/🖥終端機CLI）+ 跨頁錄製 + 時間軸標記 + AI精簡 + 乾淨toggle | 🔨 進行中（PM-53） |
| ⑦ 規模化 | 日韓越語音、跨境除錯鏈、企業自託管 | 待做 |

## 技術架構（第 2 代完成後）
```
Chrome 擴充（Manifest V3 + TypeScript + esbuild）
├── inject.ts（MAIN world）
│   ├── rrweb DOM 側錄
│   ├── Console 攔截（warn/error）
│   ├── Network 攔截（fetch/XHR 4xx+5xx）
│   └── SpeechRecognition 語音辨識（zh-TW）
├── content.ts（ISOLATED world）— postMessage 橋接 + storage
├── background.ts（Service Worker）— 狀態管理 + Badge
└── popup.ts + popup.html — 三態 UI + 複製/匯出 JSON
```

## 專案路徑
- 主專案：`C:\dev\bugezy`
- 接手指南：`docs/BugEzy_project_status.md`（270 行，§1~§11 完整全貌）

## 技術棧
- Chrome 擴充：Manifest V3 + TypeScript + esbuild
- DOM 側錄：rrweb 2.0-alpha（JSON，非影片）
- 語音辨識：Web Speech API（inject.ts MAIN world + 頁面授權橫幅）
- 語音降級：Groq Whisper API（待第 6 代）
- 後端 API：Cloudflare Workers（✅ 已部署 bugezy-api.bugezy-api.workers.dev：reports + /mcp + /api/summarize）
- 資料庫：Supabase PostgreSQL + Auth（✅ reports 表上線；Auth 待第 5 代）
- 檔案儲存：Cloudflare R2（✅ rrweb + screenshots 大檔）
- Web 報告頁：React + Vite（✅ `@rrweb/replay` 回放 + 四面板 + 深色主題）
- MCP Server：stdio（`mcp-server/`）+ Workers `/mcp`（**12 Tool**，加 `get_live_errors`/`get_terminal_logs`/`get_screenshots`/`get_usage_stats`；每次回應附 token 省錢 footer）（✅ 已驗證）
- 截圖標注：annotate.html canvas（畫筆/箭頭/框/文字）+ 三擷取模式 + 即時字幕（✅ 第 6 代）
- AI 精簡：Cloudflare Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（✅ 已部署）
- 跨頁錄製：inject 即時 flush → background `chrome.storage.local` buffer → STOP 合併去重（PM-34~37，頁面跳轉不丟資料）
- 編輯頁：停止後 edit-report（`@rrweb/replay` mini player + 時間軸標記 📌 + 乾淨/原始 toggle + AI 精簡），markers 經 MCP `get_report_overview` 可讀
- ⏪ 30 秒回溯：inject 背景循環緩存（不必先按錄製），按⏪打包最近 30s（PM-50）
- 🔍 即時監控：背景每 10s 推 live errors → R2 暫存 → AI 經 MCP `get_live_errors` 查當前頁，不產報告、token 極低（PM-51/52）
- 🖥 終端機 CLI：`cli/` `npx bugezy-watch -- <command>` 攔截 stderr/throw/crash → R2 → MCP `get_terminal_logs`（PM-53）
- 測試專頁：server `GET /test` + page2/3 + `/test/api/:status`（可預測 Bug 場景，PM-48）
- 即時監控/終端機暫存：Cloudflare R2 單一物件（非全域 Map — 跨 Worker isolate 才一致）
- Token 省錢透明度：MCP 每次回應附 token 估算 + 對比 Claude in Chrome 省錢 %（PM-54）；edit-report 上傳前各區塊估算（PM-55）；Supabase `mcp_usage` 月度統計 `GET /api/usage/monthly` + MCP `get_usage_stats`（PM-56，記錄要 await 否則 Workers 提前終止丟寫入）
- 報告頁：Server 直接 serve `GET /report/:id` HTML（深色 DevTools Tab 分頁 + Token，vanilla JS 讀 `/api/reports/:id`，PM-59）；web React 版 `ReportPage` 同款 Tab（PM-58，Worker 未服務 SPA，靠 Vite 預覽）

## 核心鐵律
1. **dc-light 唯讀**：PM 不用 dc-light 改 .ts/.tsx，只改文件（.md/job 檔）
2. **PM ≠ 工程師**：PM 出指令+驗收，不直接寫程式
3. **inject.ts 是核心**：rrweb + console + network + voice 四件事都在 MAIN world
4. **語音需 user gesture**：Chrome 要求麥克風由頁面直接點擊觸發，inject.ts 用浮動授權橫幅解決
5. **offscreen 不可行**：Chrome MV3 offscreen document 不支援 SpeechRecognition 權限提示（已驗證失敗）
6. **智能過濾**：只抓 console.warn/error + HTTP 4xx/5xx，不存 200 OK

## Job 檔工作流
- 路徑：`job/job-MMDD.md`
- 格式：`🟡 PM-XX` = PM 出的任務，`🔵 DONE-XX` = Claude Code 回報
- 指令模板：`讀 job/job-MMDD.md 的 PM-XX，照規格做完並 npm run build，完成回報 DONE-XX。`
- Build：`cd extension && npm run build`

## 工具鏈
### dc-light（本機檔案，唯讀）
read_file / write_file / edit_file / search_text / get_info / list_dir / run_cmd

### Jam MCP（瀏覽器 Debug 錄製）
FOX 用 Jam 錄製操作過程 → PM 讀 console logs / network / user events 診斷問題
- Jam 付費版 $16/月
- 重要：Jam voice transcript 只抓英文；中文 Bug 報告用 title + screenshots + getUserEvents

### 匯出 JSON（BugEzy 自帶）
擴充 popup「💾 匯出 JSON」→ `C:\dev\bugezy\debug\` 或 `Downloads\bugezy-debug\`
PM 用 dc-light 讀 JSON 核對 payload（rrwebEvents / consoleLogs / networkErrors / voiceTranscript）

## RecordingPayload 結構
```typescript
interface RecordingPayload {
  rrwebEvents: unknown[];          // DOM 軌跡
  consoleLogs: ConsoleLog[];       // { level, message, timestamp }
  networkErrors: NetworkError[];   // { method, url, status, responseBody, timestamp, duration }
  pageInfo: PageInfo;              // { url, title, browser, screenSize, timestamp }
  voiceTranscript: VoiceSegment[]; // { text, timestamp, isFinal }
}
```

## 語音架構教訓（PM-06~09 踩坑記錄）
1. **offscreen document 失敗**（PM-06/07）：Chrome 隱藏頁不彈麥克風授權，SpeechRecognition 靜默失敗
2. **MAIN world 直接呼叫失敗**（PM-08）：START 經 popup→background→content→inject 四層傳遞，user gesture 丟失，Chrome 回 `not-allowed`
3. **最終解法**（PM-09）：inject.ts 注入頁面頂部浮動授權橫幅，使用者點按鈕 = 有效 user gesture → getUserMedia → SpeechRecognition。已授權的站直接啟動不彈橫幅
4. **站別記憶**：如果某站之前被 Chrome 記住 Block 麥克風，需手動到 site settings 清除

## 定價
| 方案 | 月費 | 報告/月 | 錄製上限 | MCP |
|---|---|---|---|---|
| 免費 | $0 | 30 次 | 30 秒 | ✗ |
| 個人 Pro | NT$80 | 50 次 | 2 分鐘 | ✓ |
| 重度 Pro | NT$150 | 200 次 | 5 分鐘 | ✓ |
| 團隊 | NT$100/人 | 無限 | 5 分鐘 | ✓ |

## 關鍵文件
- 接手指南：`docs/BugEzy_project_status.md`（最完整，新 Chat 先讀這份）
- 產品規格：`docs/BugEzy_產品規格書_v0.2.md`
- 架構：`ARCHITECTURE.md`
- 工程規則：`CLAUDE.md`
- PM 規則：`claudePM.md`
- 變更記錄：`CHANGELOG.md`
- 任務檔：`job/job-MMDD.md`

## 新對話起手
1. 讀 `docs/BugEzy_project_status.md`（全貌）
2. 讀最新 `job/job-MMDD.md`（上次做到哪）
3. 確認 FOX 要做哪一代哪個功能
4. 出 PM-XX → FOX 交給 Claude Code
