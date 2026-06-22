# BugEzy 專案全貌與接手指南

> 最後更新：2026-06-17
> 維護者：FOX（Claude Chat PM 角色）
> 用途：新 Chat 對話開始時讀此檔，快速掌握全貌並接手開發

---

## §1 專案定位

**一句話**：亞洲專屬平價 MCP 語音除錯工具。開發者用中文語音錄 Bug → 自動產出 DOM 軌跡 + Console + Network + 中文字幕 → AI 透過 MCP 直接讀取修復。

**核心差異 vs Jam**：中文語音原生（Jam 中文殘破）、NT$80/月（Jam NT$450）、rrweb DOM 軌跡取代影片（儲存趨近零）、MCP Pull 模式（按需查詢省 token）。

---

## §2 七代迭代計畫（核心開發路線）

| 代 | 名稱 | 目標 | 狀態 |
|---|---|---|---|
| **① 能錄能存** | Chrome 擴充骨架 | rrweb DOM + Console + Network 攔截 → 打包 JSON | ✅ 完成 |
| **② 能聽能說** | 語音辨識 | Web Speech API 中文即時轉文字，收進 payload | ✅ 完成 |
| **③ 能存能看** | 後端 + 報告頁 | Cloudflare Workers + Supabase + R2 + React 報告頁 | ✅ 完成 |
| **④ AI 能讀** | MCP Server | Pull 模式 12 Tool（+ get_live_errors / get_terminal_logs / get_screenshots / get_usage_stats），每次回應附 token 省錢對比 = **MVP 封測** | ✅ 完成 |
| **⑤ 能收錢** | 付費上線 | Stripe 串接 + Chrome Web Store 上架 = **正式上線** | 待做 |
| **⑥ 更好用** | UX 優化 + 多模式 | 六種模式（錄製/回溯/截圖/即時監控/鍵盤/終端機CLI）+ 截圖三模式 + 即時字幕雙區 + 跨頁錄製 + 編輯頁時間軸標記 + AI精簡 + 乾淨toggle | 🔨 進行中（PM-53） |
| **⑦ 規模化** | 多語 + 企業 | 日韓越語音、跨境除錯鏈、企業自託管 | 待做 |

---

## §3 當前架構（第 2 代完成後）

```
Chrome 擴充（Manifest V3 + TypeScript + esbuild）
├── inject.ts（MAIN world）
│   ├── rrweb DOM 側錄
│   ├── Console 攔截（warn/error）
│   ├── Network 攔截（fetch/XHR 4xx+5xx）
│   └── SpeechRecognition 語音辨識（zh-TW）★ 第 2 代
├── content.ts（ISOLATED world）
│   ├── inject ↔ content postMessage 橋接
│   └── payload 存入 chrome.storage.local
├── background.ts（Service Worker）
│   ├── 錄製狀態管理（持久化 storage.local）
│   ├── popup ↔ content 訊息路由
│   └── Badge 顯示 REC
└── popup.ts + popup.html
    ├── 三態 UI：閒置 / 錄製中（計時）/ 完成（摘要）
    ├── 📋 複製 JSON
    └── 💾 匯出 JSON（給 AI 讀）★ PM-05

未建（第 3 代以後）：
├── server/        Cloudflare Workers API
├── web/           React 報告頁
└── mcp-server/    MCP Server（8 Tool Pull 模式）
```

### 資料流

```
使用者按「開始」
  → popup → background → content → inject(postMessage)
  → inject 啟動 rrweb + console/network 攔截 + SpeechRecognition
  → （如未授權麥克風：注入頁面頂部授權橫幅，使用者點允許）
  → 錄製中：DOM events 累積、warn/error 收集、4xx/5xx 收集、語音片段收集

使用者按「停止」
  → inject 打包 RecordingPayload（rrweb + console + network + voice + pageInfo）
  → postMessage → content 存入 chrome.storage.local
  → content → background 回填摘要（筆數 + 時長）
  → popup 顯示摘要

使用者按「匯出」
  → popup 從 storage 讀 payload → Blob → chrome.downloads
  → 落檔到 Downloads/bugezy-debug/payload-<ts>.json
  → Claude Chat 用 dc-light 讀取分析
```

### RecordingPayload 結構

```typescript
interface RecordingPayload {
  rrwebEvents: unknown[];       // DOM 軌跡（rrweb type 2/3/4 events）
  consoleLogs: ConsoleLog[];    // { level, message, timestamp }
  networkErrors: NetworkError[]; // { method, url, status, responseBody, timestamp, duration }
  pageInfo: PageInfo;           // { url, title, browser, screenSize, timestamp }
  voiceTranscript: VoiceSegment[]; // { text, timestamp, isFinal }
}
```

---

## §4 檔案結構與關鍵文件

```
C:\dev\bugezy\
├── CLAUDE.md          ← Claude Code 工程規則
├── claudePM.md        ← Claude Chat PM 規則
├── ARCHITECTURE.md    ← 架構概覽
├── CHANGELOG.md       ← 完整變更記錄（PM-01~09）
├── docs/
│   ├── BugEzy_產品規格書_v0.2.md  ← 完整產品規格（市場/定價/功能/營收）
│   ├── BugEzy_project_status.md   ← 本文件（接手指南）
│   └── SKILL.md                    ← Claude Chat skill 定義
├── extension/
│   ├── src/
│   │   ├── inject.ts    (13.9K) ← 核心：MAIN world，rrweb+console+network+voice
│   │   ├── popup.ts     (5.5K)  ← popup UI 邏輯
│   │   ├── background.ts(4.6K)  ← SW 狀態管理
│   │   ├── content.ts   (2.5K)  ← ISOLATED bridge
│   │   ├── types.ts     (2.9K)  ← 共用型別
│   │   └── popup.html   (3.6K)  ← popup 頁面
│   ├── build.mjs                 ← esbuild 打包腳本
│   ├── manifest.json             ← MV3 manifest
│   └── dist/                     ← build 產出（載入此資料夾測試）
├── job/
│   └── job-0616.md    (60K+)    ← 第一天所有 PM 任務與 DONE 回報
└── debug/                        ← 匯出的 payload JSON（驗收用）
```

---

## §5 開發工作流

### 三 AI 架構
```
Claude Chat（Opus）= PM + 策略
  ↓ 寫 job/job-MMDD.md（PM-XX 任務規格）
Claude Code（Sonnet，在 Zed 編輯器）= 工程師
  ↓ 讀 job 執行，回報 DONE-XX
FOX = 創辦人 + 決策者 + 手動驗收
```

### 每日流程
1. **新對話起手**：Claude Chat 先讀本文件 + `ARCHITECTURE.md` + 最新 `job/job-MMDD.md`
2. **出任務**：Chat 寫 PM-XX 規格到 job 檔（含改動範圍、程式碼位置、鐵則、驗收條件）
3. **執行**：FOX 複製指令給 Claude Code → Code 讀 job 執行 → build → 回報 DONE-XX
4. **驗收**：FOX 手動測試（reload 擴充 → 操作 → 匯出 JSON 或 Jam 錄影）
5. **Chat 核對**：用 dc-light 讀 JSON / Jam console logs 確認
6. **收工**：更新 CHANGELOG + memory

### 關鍵指令模板
```
讀 job/job-MMDD.md 的 PM-XX，照規格做完並 npm run build，完成回報 DONE-XX。
```

### 驗收工具
- **dc-light**：讀本機檔案（JSON payload、原始碼、job 檔）
- **Jam MCP**：讀 Jam 錄影的 console logs / network / user events（Jam 付費版，team ID 見 memory）
- **匯出 JSON**：擴充 popup「💾 匯出 JSON」→ 落檔到 `C:\Users\FOX77\Downloads\bugezy-debug\` 或 `C:\dev\bugezy\debug\`

---

## §6 已完成事項（2026-06-16）

### PM-01：基礎工作流建立
- 專案目錄、CLAUDE.md、claudePM.md、ARCHITECTURE.md、產品規格書

### PM-02：第 1 代 Chrome 擴充骨架
- Manifest V3 + esbuild 打包
- inject.ts（MAIN world）：rrweb + Console(warn/error) + Network(4xx/5xx)
- content.ts（ISOLATED）：postMessage 橋接 + chrome.storage.local
- background.ts（SW）：錄製狀態持久化 + Badge
- popup：三態 UI + 複製 JSON

### PM-03：UX 修正
- Badge 紅色 REC、SW 重啟還原
- 完成摘要（DOM/Console/Network 筆數 + 時長 + URL）
- 清除按鈕

### PM-04：inject 注入除錯
- 全程 `[BugEzy]` 診斷 log + try/catch 硬化
- 防重複注入 + READY/STARTED 握手

### PM-05：匯出 JSON 按鈕
- `chrome.downloads` API → `bugezy-debug/payload-<ts>.json`
- 解決 payload 太大無法貼進 Claude Chat 的問題

### PM-06~07：語音 offscreen 方案（失敗，已砍）
- offscreen document 跑 SpeechRecognition → Chrome 隱藏頁不彈授權提示 → 放棄
- **教訓**：Chrome MV3 offscreen document 對 SpeechRecognition/getUserMedia 支援受限

### PM-08：語音改架構（成功基礎）
- 砍掉 offscreen，SpeechRecognition 直接跑在 inject.ts MAIN world
- 大幅簡化：語音與 rrweb/console/network 同層收集

### PM-09：解 user gesture 問題（最終成功）
- Chrome 要求麥克風由頁面上的直接點擊觸發
- inject.ts 注入浮動授權橫幅 →「允許麥克風」按鈕提供 user gesture
- `permissions.query` 判斷：已授權直接啟動，未授權才彈橫幅
- **驗收通過**：example.com 上成功辨識中文語音「有錄到來有錄到聲音嗎有錄到的話請跟我說如果有的話」

### PM-10：第 3 代後端骨架
- Cloudflare Workers API：POST /api/reports + GET /api/reports/:id
- Supabase：reports 表（metadata + console/network/voice JSONB）
- R2：rrweb events 大檔存儲（reports/<id>/rrweb.json）
- 程式碼完成、`npx tsc --noEmit` 通過；本機 curl round-trip 驗收通過（PM 用 dc-light curl 實測 POST+GET round-trip 成功）

### PM-11：擴充上傳整合（錄完自動送 API）
- 停止錄製後 background 自動 `POST /api/reports`，popup 顯示「⏳ 上傳中 → ✅ 已上傳 + 分享連結 + 複製連結」
- 失敗不阻擋本機 payload；`RecordingSummary` 加 `uploadStatus`/`shareUrl`/`uploadError`，上傳中每秒輪詢

### PM-12：React 報告頁（`web/`）
- Vite + React + TS，路由 `/report/:id`，`/api` proxy 到 Workers
- rrweb 回放 + Console/Network/Voice 三面板 + 深色主題

### PM-13：rrweb 回放改用 `@rrweb/replay`（去 Svelte 依賴）
- `rrweb-player`（Svelte）在 React+Vite 靜默失敗 → 改底層 `Replayer` class + 自製播放控制列（▶/⏸ + 進度條 + 時間）

### PM-14：第 4 代 MCP Server（8 Tool Pull 模式）= MVP
- Workers 加 `GET /api/reports`（列最近報告）；`mcp-server/` stdio server，8 tool（list/overview/console/network/voice/page/rrweb-summary/rrweb-events）
- 每 tool 只回需要欄位（省 token）；MCP handshake + tools/list 實測回 8 tool
- **驗收通過**：MCP `list_reports` 實測列出雲端 2 筆報告（example.com 含語音 + DOM 14 筆、test.com）

### PM-15：Workers 加 `/mcp` 端點（Cloudflare Agents SDK）
- 用 `agents` 套件的 `createMcpHandler`（Streamable HTTP，無狀態，免 Durable Objects），`/mcp` 掛同 8 tool 但直接讀 Supabase/R2
- SDK 實際 API 與規格範例有出入（`agents/mcp` 非 `@cloudflare/agents/mcp`、tool 參數要 zod shape），已依型別調整
- **已部署**：Claude.ai 可在 Connectors 加 `/mcp` 直接查報告（全鏈路打通）

### PM-16~17：截圖擷取 + 標注
- PM-16：錄製中 `captureVisibleTab` 截圖 → R2 `reports/<id>/screenshots.json`、Supabase `screenshot_count`/`screenshots_r2_key`；報告頁 `ScreenshotPanel` 縮圖
- PM-17：截圖後開標注分頁 `annotate.html`，canvas 四工具（畫筆/箭頭/框框/文字）+ undo + 清除

### PM-18：截圖與錄製分離
- popup 閒置兩入口「🎬 錄製」「📸 截圖標注」；截圖標注完成獨立上傳為一份報告（不再塞進錄製 payload）

### PM-19：截圖三模式
- content 注入模式選擇 overlay：整頁 / **區域兩點式可捲動**（跨 viewport 逐段擷取 + dpr 拼接 + 裁切）/ 自由形狀（多邊形 clip）

### PM-20~21：標注頁文字說明 + 語音 + 即時字幕
- PM-20：標注頁底部文字說明欄 + 🎤 語音輸入（存進報告 `description`）
- PM-21：標注頁載入自動錄語音 + `pointer-events:none` 浮動字幕條（interim 即時 / final 寫入文字框）

### PM-22：UI 美化
- 設計語言 `#0f0f1a` 深底 + `#7c3aed` 品牌紫 + 12px 圓角 + 漸層按鈕；popup 品牌 Header/雙入口漸層、報告頁品牌導航列/卡片化/載入 spinner

### PM-23：修標注頁語音中斷
- 工具列容器層 `mousedown` `preventDefault`（排除 input/select），按鈕不搶焦點 → 不打斷 SpeechRecognition

### PM-24：錄製即時字幕 + 停止後編輯頁
- inject 錄製中浮動字幕（interim/final）；停止後不直接上傳，改開 `edit-report.html`（摘要 + 語音記錄 + 補充描述含 🎤）→「上傳報告」才送 API

### PM-25：AI 精簡摘要
- server `POST /api/summarize`（Cloudflare Workers AI，繁中條列精簡）；edit-report + annotate 加「🤖 AI 精簡」鈕
- **已部署 + 線上驗證**；規格的 `llama-3.1-8b-instruct` 已 deprecated（2026-05-30）→ 改用 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

### PM-26：Bug 修復 + 驗證
- edit-report AI 精簡成功後永久 disable、inject 語音中斷顯示「🔄 重新啟動語音」按鈕（PM 手改，已驗 TS）
- **抓出連帶 bug**：annotate.html 移除 AI 鈕後，annotate.ts 仍 `$('summarizeBtn')` → 載入即 throw 使整頁失效 → 移除對應 JS 修復

---

## §6b 第 6 代 Day 4（2026-06-18，PM-27~47）

### 即時字幕雙區 + 標記（PM-27~31）
- PM-27：錄製即時字幕分兩區——底部 interim + 右上 `#bugezy-voice-panel` 堆疊已確認 final（可收合）
- PM-28：編輯頁時間軸標記——edit-report mini rrweb player（`@rrweb/replay`）+ 📌 多時間點，markers 全鏈（types/server/MCP/web）
- PM-29：修標記 UX（按 📌 彈 `prompt` + 保留無文字的時間點）
- PM-30：字幕條 flex 化 + 永久 🔄 重啟按鈕 + `forceRestartVoice`
- PM-31：修三 Bug（右上面板誤點卡死→header `pointer-events:none` 僅收合鈕可點；mini player 放大；語音 append 保留 cursor）

### 語音重啟穩定化（PM-32~33、42~43）
- PM-32：抽 `createRecognition()` 工廠（全新 handlers，不複製舊閉包）、刪 `showRestartButton`
- PM-33：🔄 改 async — `getUserMedia` 刷新音訊管線 + 500ms 延遲 + `autoRestartFails` 計數
- PM-42：同模式套到 edit-report / annotate 補充說明語音（工廠 + getUserMedia + 失敗計數）
- PM-43：語音 `onend` 連續失敗 3 次自動 getUserMedia 刷新重建（不必手動）

### 跨頁錄製（PM-34~37）★架構
- PM-34：即時 flush（inject→content→background `chrome.storage.local` buffer），STOP 時 `buildFullPayload()` 合併去重（四類）→ 頁面跳轉不丟資料
- PM-35：content.ts 載入 `GET_STATE` 自動恢復錄製（新頁補送 START）
- PM-36：跳頁右上面板回填歷史語音（`REQUEST_VOICE_HISTORY`/`GET_VOICE_BUFFER`/`VOICE_HISTORY`）+ poll 50ms
- PM-37：修 READY 競爭條件（inject 重複發 READY + content 回 `READY_ACK` 握手）

### 編輯頁 mini player 體驗（PM-38~41、44~47）
- PM-38：修放大鏡——依 rrweb Meta 事件原始解析度算 `scale` + 預載第一幀 + `mouseTail:false`
- PM-39：語音記錄 textarea 移除 `readonly`（可手動修錯字）
- PM-40：語音面板下移（top 60→140px）+ mini player 🔍 2x 放大鈕
- PM-41：放大改為容器物理全寬（`max-width:100%`）+ 重算 scale
- PM-43(§1)：放大時 `.wrap` 也撐到 95vw，player 才真的變大
- PM-44：rrweb `record()` 加 `block/ignoreSelector` 排除 BugEzy overlay（後於 PM-46 改回）；面板 top 140→200px
- PM-45：`mouseTail:true`（回放看得到游標）
- PM-46：回放「乾淨/原始」toggle——移除 blockSelector、改在 edit-report 注入 CSS 到 Replayer iframe 控制顯示
- PM-47：乾淨模式改 `setInterval` 每 200ms 補注入（取代 MutationObserver）；**排查發現游標 `.replayer-mouse` 在 `.replayer-wrapper` 內、非 iframe 內** → 縮放改套 `.replayer-wrapper` 讓游標可見對齊

### Server / Schema
- `reports` 加 `markers JSONB`（PM-28，已 `ALTER TABLE`）；`/api/reports` 與 `/mcp` `get_report_overview` 回傳 markers

---

## §6c 第 6 代 Day 5（2026-06-20，PM-48~53）— 多模式 + CLI

**六種使用模式**：🎬 錄製 / ⏪ 30秒回溯 / 📸 截圖標注 / 🔍 即時監控 / 🔇 鍵盤模式 / 🖥 終端機 CLI。

- **PM-48：測試專頁**（server）— `GET /test`、`/test/page2`、`/test/page3`（長內容測捲動）、`/test/api/:status`（觸發 4xx/5xx）。可預測的 Bug 場景，之後測試都用它。
- **PM-49：鍵盤模式 toggle**（關閉語音）— popup 開關（`KEYBOARD_MODE_KEY`），inject START 帶 `keyboardMode` 跳過語音改顯示提示條；annotate/edit-report 也檢查。適合吵雜/不便說話環境。
- **PM-50：⏪ 30 秒回溯**（核心 inject 背景循環緩存）— inject 載入即背景緩存 rrweb（`checkoutEveryNms`）+ console/network（永遠攔截，30s 環形 buffer）；按「⏪ 回溯」打包最近 30s → edit-report，不必預先按錄製。錄製時停背景 rrweb、停止後重啟。
- **PM-51：🔍 即時監控**（AI 隨時查當前頁 error）— popup toggle → background 每 10s 推 live errors → `POST /api/live-errors` → MCP `get_live_errors`。**不產報告、不上傳、token 極低**。架構修正：規格全域 Map 跨 isolate 不共享（實測 stale）→ 改 **R2 單一物件**（強讀後寫一致）。
- **PM-52：即時監控視覺回饋** — 頁面右下浮動 badge（綠✓/紅數字 + 閃動）+ 點擊展開 error 清單；擴充圖示 badge 數字（非錄製時）。
- **PM-53：🖥 終端機 CLI Agent**（新建 `cli/`）— `npx bugezy-watch -- <command>` 包住開發指令，透傳輸出 + 攔截 stderr/throw/crash → `POST /api/terminal-logs` → MCP `get_terminal_logs`。

### Server / MCP
- 新增端點：`/test*`、`/api/live-errors`（POST/GET，R2）、`/api/terminal-logs`（POST/GET，R2）。
- MCP Tool 由 8 → **10**：加 `get_live_errors`、`get_terminal_logs`（皆讀 R2，跨 isolate 一致）。
- 新增子專案 `cli/`（@bugezy/cli，TypeScript + tsx，`bin: bugezy-watch`）。

---

## §6d 第 6 代 Day 6（2026-06-22，PM-54~59）— 上架前：Token 透明度 + 報告頁

**Token 省錢透明度（PM-54~56b）**：
- PM-54：每個 MCP tool 資料回應尾端附 token 估算 + 對比 Claude in Chrome 的省錢 footer（`estimateTokens`/`txtWithTokens`，倍率表 list_reports=5…get_terminal_logs=40）。
- PM-55：edit-report 上傳前顯示各區塊（語音/console/network/說明/標記/DOM）token 明細 + 總計 + 省 %。
- PM-56：每次 MCP 呼叫記錄到 Supabase `mcp_usage`；`GET /api/usage/monthly` 月度彙總；MCP `get_usage_stats`。
- PM-56b：修記錄沒寫入——Workers 回應後立刻終止，`void` fire-and-forget 來不及；改 `await logMcpUsage`（線上實測 totalCalls 由 0→1）。

**MCP 新工具（PM-57）**：`get_screenshots`（讀 R2 截圖；`include_images` 預設 false 只回 metadata 省 token，true 才回 base64 圖片 + 圖片 token 估算）。**MCP 共 12 Tool**。

**報告頁（PM-58~59）**：
- PM-58：web React `ReportPage` 改 Jam 風格 DevTools Tab 分頁（Info/Console/Network/Voice/截圖，自動選有資料 tab）。
- PM-59：**Server 直接 serve `/report/:id` HTML**（自包含深色主題 + Tab + Token，vanilla JS 讀 `/api/reports/:id`）→ 解決 share_url 在 Worker origin 404（web React 版暫不使用）。據實修正規格的 snake_case 欄位（API 實回 camelCase，否則整頁無資料）。

### Server / MCP（Day 6 增量）
- 端點：`/report/:id`、`/api/usage/monthly`。
- MCP **10 → 12 Tool**：加 `get_screenshots`、`get_usage_stats`。
- Supabase `mcp_usage` 表（PM-56，FOX 已建）；即時暫存 live-errors/terminal-logs 用 R2 單一物件（跨 isolate 一致）。

---

## §7 已知問題與技術債

| # | 問題 | 嚴重度 | 說明 |
|---|---|---|---|
| 1 | ruten.com.tw 麥克風被鎖 | 低 | 之前失敗嘗試導致 Chrome 記住 Block，手動清除即可。正式用戶不會遇到 |
| 2 | rrweb stop 時 SecurityError | 低 | ruten 有跨域 iframe，rrweb 嘗試存取時拋 SecurityError，已被 catch 不影響功能 |
| 3 | 麥克風權限歸屬網站 | 可接受 | MAIN world 的設計決策，每站第一次要授權。開發者工具的使用者理解這件事 |
| 4 | consoleLogs 只抓 warn/error | 設計決策 | 故意不抓 log/info（太多雜訊），未來可在設定中開放 |
| 5 | networkErrors 只抓 4xx/5xx | 設計決策 | 不存 200 OK（太多），未來可加「全部請求」模式 |
| 6 | Groq Whisper 降級未實作 | 待做 | Web Speech API 需要網路（Google 雲端辨識），離線時無法用。Groq 降級留第 6 代 |

---

## §8 第 3+4 代進度（能存能看 + AI 能讀）— ✅ 已完成

### 已完成（全鏈路打通）
- PM-10：Workers API（POST/GET reports）+ Supabase schema + R2，curl round-trip 通過
- PM-11：擴充錄完自動上傳，popup 顯示分享連結
- PM-12 + PM-13：React 報告頁（`@rrweb/replay` 回放 + Console/Network/Voice 面板）
- PM-14：MCP Server（stdio，8 tool）— `list_reports` 實測列出雲端報告
- PM-15：Workers `/mcp` 端點（Agents SDK，已部署）— Claude.ai Connectors 可直接連

> **里程碑**：錄製 → 上傳 → 雲端報告頁 → AI（MCP）按需查詢，整條閉環已驗證可用 = MVP 達成。

### 下一步（第 5 代）
- 付費上線：Stripe 串接 + Chrome Web Store 上架（見 §10 定價）
- 技術債：Groq Whisper 離線降級（§7 #6）

### 目標（達成）
把 payload 從本機 JSON 檔變成雲端報告，有分享連結、可回放、AI 可讀。

### 元件
1. **Cloudflare Workers API**：接收 payload、存 Supabase、上傳 rrweb JSON 到 R2
2. **Supabase**：PostgreSQL（reports/screenshots/network_requests 表）+ Auth
3. **Cloudflare R2**：存 rrweb JSON 檔（省出口費）
4. **React 報告頁**：rrweb-player 回放 + console/network 時間軸 + 語音字幕

### 資料流變化
```
目前：inject → content → chrome.storage.local → 匯出 JSON
第 3 代：inject → content → chrome.storage.local → background 上傳 API
         → Workers 解包 → Supabase 存 metadata → R2 存 rrweb
         → 回傳 report URL → popup 顯示分享連結
```

---

## §9 技術棧總覽

| 元件 | 技術 | 狀態 |
|---|---|---|
| Chrome 擴充 | Manifest V3 + TypeScript + esbuild | ✅ 完成 |
| DOM 側錄 | rrweb 2.0-alpha | ✅ 完成 |
| 語音辨識 | Web Speech API (zh-TW) | ✅ 完成 |
| 語音降級 | Groq Whisper API | 待做（第 6 代） |
| 後端 API | Cloudflare Workers | ✅ 完成 |
| 資料庫 | Supabase (PostgreSQL + Auth) | ✅ 完成（Auth 留第 5 代） |
| 檔案儲存 | Cloudflare R2 | ✅ 完成 |
| Web 報告頁 | React + Vite（`@rrweb/replay`） | ✅ 完成 |
| MCP Server | stdio + Workers `/mcp`（8 Tool） | ✅ 完成 |
| 付費 | Stripe | 待做（第 5 代） |

---

## §10 定價策略

| 方案 | 月費 | 報告/月 | 錄製上限 | MCP | 保存期 |
|---|---|---|---|---|---|
| 免費 | $0 | 30 次 | 30 秒 | ✗ | 7 天 |
| 個人 Pro | NT$80 | 50 次 | 2 分鐘 | ✓ | 90 天 |
| 重度 Pro | NT$150 | 200 次 | 5 分鐘 | ✓ | 365 天 |
| 團隊 | NT$100/人 | 無限 | 5 分鐘 | ✓ | 365 天 |

---

## §11 新對話起手 checklist

新的 Claude Chat 對話接手 BugEzy 時：

1. ✅ 讀本文件（`docs/BugEzy_project_status.md`）了解全貌
2. ✅ 讀 `ARCHITECTURE.md` 了解技術架構
3. ✅ 讀最新的 `job/job-MMDD.md` 了解上一次做到哪
4. ✅ 確認 FOX 要做哪一代的哪個功能
5. ✅ 出 PM-XX 任務到 job 檔 → FOX 交給 Claude Code 執行

---

*本文件由 Claude Chat（PM 角色）維護，每次階段性收工時更新。*
