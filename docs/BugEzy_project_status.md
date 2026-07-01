# BugEzy 專案全貌與接手指南

> 最後更新：2026-07-01
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
| **② 能聽能說** | 語音辨識 | Web Speech API 中文即時轉文字，收進 payload；**Day 15 升級為雙引擎**（免費 Web Speech / 付費 offscreen + Groq Whisper 精準轉錄，一次授權全站通用）⑥ 提前完成「語音降級/精準化」 | ✅ 完成（+ Groq Whisper） |
| **③ 能存能看** | 後端 + 報告頁 | Cloudflare Workers + Supabase + R2 + React 報告頁 | ✅ 完成 |
| **④ AI 能讀** | MCP Server | Pull 模式 12 Tool（+ get_live_errors / get_terminal_logs / get_screenshots / get_usage_stats），每次回應附 token 省錢對比 = **MVP 封測** | ✅ 完成 |
| **⑤ 能收錢** | 付費上線 | Google 登入 + 產品首頁（含聯絡資訊）+ 隱私政策 + 用量限制 + 兩層定價 + 使用指南/FAQ 頁 + Web Store 上架文案/zip + **綠界 ECPay 金流（測試環境跑通：單次付款 + 定期定額月訂閱 + 取消訂閱，CheckMacValue 對官方測試向量驗證）**；**Chrome Web Store 已送審 + 綠界補件已重送（2026-06-29）**；換正式 key + 等兩邊審核通過仍待做 | 🔨 進行中（PM-75，待審） |
| **⑥ 更好用** | UX 優化 + 多模式 | 六種模式 + 截圖三模式 + 即時字幕雙區 + 跨頁錄製 + 編輯頁時間軸標記 + AI精簡/校正 + 乾淨toggle；上架前打磨（跨頁游標/CSP/語音穩定）；**Day 15 提前完成：Groq Whisper 精準語音 + 報告頁「高畫質 AI 分析」截圖勾選（使用者控制 AI 是否讀圖）**| ✅ 完成（PM-27~61, 68~70, 82~91） |
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

## §6e 第 6→5 代 Day 7（2026-06-24，PM-60~61）— AI 校正 + Google 登入

- **PM-60/60b/60c：🔧 AI 校正按鈕**（編輯頁，與 🤖 AI 精簡並列）— 新增 `POST /api/correct`（修語音辨識錯字/去贅字/還原術語，保留原意不摘要；可多次按、不鎖死）。
  - 模型：規格的 `llama-3.1-8b` 已 deprecated → 逐一實測 qwq-32b（輸出冗長推理不可用）、deepseek-r1-distill-qwen-32b（此帳號 5007 無此模型）、qwen3-30b、llama-3.3 → **選 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`**（非推理、與 summarize 同款、UTF-8 實測正確）。保留 `<think>` 剝除。
  - 踩雷：先前「亂碼」是 **Windows Git-Bash 測試環境的編碼坑**（curl request body 非 UTF-8 + 終端機顯示），非 server——用 Python 送 UTF-8 看原始 bytes 才驗得準。
- **PM-61/61b：Google OAuth 登入**（第 5 代「能收錢」前置）— `chrome.identity.getAuthToken` → `POST /api/auth/google`（Google userinfo 驗證 → 查/建 Supabase `users` → 回 session）→ 存 `chrome.storage.local`。popup 加 `loginView`/`mainView`（user-bar：頭像/名字/登出）；上傳報告帶 `user_id`（條件式，沒登入不碰欄位）。
  - 61b：`googleAuth` `.single()`→`.maybeSingle()`（新用戶查不到不拋 PGRST116）+ 外層 try/catch 回實際錯誤。
  - MVP 範圍：能登入 + 報告綁 user；JWT 正式 token / API 鑑權中間件 / 用量限制留後續（API 目前仍公開）。

### Server / MCP / Schema（Day 7 增量）
- 端點：`/api/correct`、`/api/auth/google`。
- Supabase：`users` 表（Google 登入）+ `reports.user_id`（schema.sql，FOX 手動跑）。
- ⑤「能收錢」起步：OAuth 登入 + 報告綁 user 完成；Stripe 付費 / Web Store 上架仍待做。

---

## §6f 第 5 代 Day 8（2026-06-25，PM-62~65）— 上架前最後衝刺：首頁 + 用量限制 + 隱私 + 定價

**目標**：補齊綠界 ECPay 審核與 Chrome Web Store 上架所需的對外頁面與付費前置（用量限制）。

- **PM-62：產品首頁 `GET /`**（`HOMEPAGE_HTML`）— 一頁式深色主題（與報告頁統一 `#0f0f1a`/`#7c3aed`/`#a78bfa`、無 JS、RWD）：Hero 標語 + 4 賣點 + CTA、六種錄製模式 grid、方案與定價、Footer（聯絡 email + 隱私政策連結 + 版權）。解 `/` 原本回 `{"error":"not found"}`。
- **PM-63：免費/付費用量限制系統** — `FREE_LIMITS`（錄製 10／回溯 5／MCP 20 月）+ `getUserIdFromHeader`（解 `Bearer base64(user_id:ts)`）；`GET /api/user/plan`（查方案 + 剩餘用量 + **跨月自動重置**）、`POST /api/user/usage`（遞增計數，免費版達上限回 **403 limit_reached**，付費版 unlimited）。popup 顯示「剩 N 次／已用完」+ 升級提示；background 錄製前 `checkRecordingUsage()`（未登入不擋、API 不通不擋）。schema 加 `users.recording_count/rewind_count/mcp_count/usage_reset_at`（FOX 手動跑）。**目前僅 recording 串前端**，rewind/mcp 後端就緒待接。
- **PM-64：隱私政策頁 `GET /privacy`**（`PRIVACY_PAGE_HTML`）— 中英雙語深色主題，7 節（收集資料/如何使用/儲存/分享/您的權利/Cookie/變更通知）；首頁 footer 連結由佔位 `#` 改為 `/privacy`。Chrome Web Store + 綠界審核要求的可訪問隱私政策 URL。
- **PM-65：首頁定價三層改兩層** — 免費版 NT$0 / 付費版 NT$80（與討論方案一致），移除 NT$150 重度 Pro；付費卡加紫色「立即升級」CTA。免費版額度與 PM-63 `FREE_LIMITS` 對齊。

### Server / Schema（Day 8 增量）
- 端點：`GET /`、`GET /privacy`、`GET /api/user/plan`、`POST /api/user/usage`（皆 server-only，extension 僅 popup/background/types 配合用量限制）。
- Supabase：`users` 加 4 欄用量計數（每月重置）。
- ⚠ 技術債：定價頁宣稱「報告保留 7／90 天」但**後端尚未實作自動過期清理**；「立即升級」/CTA/下載連結仍 `#` 佔位（待金流 + Web Store 上架）。

---

## §6g 第 5 代 Day 9（2026-06-27，PM-66~70）— 上架前文檔補齊 + 打磨

**目標**：補齊新手文檔 / 上架素材，並修掉三個上架前的體驗瑕疵（跨頁游標、CSP 相容、語音穩定）。

- **PM-66：使用指南 `GET /guide` + FAQ `GET /faq`**（`GUIDE_PAGE_HTML` / `FAQ_PAGE_HTML`，深色主題、RWD）— guide 四步驟卡片（安裝登入 → 六種模式各含適合/用法/錄到 → 編輯上傳 → 讓 AI 修 + MCP 設定框）+ 小技巧；faq **手風琴**（點擊展開、單一展開）四大類共 **14 題**（產品/隱私/付費/技術）。首頁 footer 改 `使用指南 | 常見問題 | 隱私政策` 三連結。已部署（`dd034701`）+ urllib 驗證。
- **PM-67：Chrome Web Store 上架文案**（新建 `docs/chrome-web-store.md`）— 擴充名稱 / 中英簡短說明 / 中英詳細說明 / 分類 Developer Tools / 語言 / 隱私政策 URL / 首頁 URL / **權限說明**。⚠ **據實校正權限清單**：規格原列的 `tabs`/`offscreen` 與 manifest 不符（offscreen PM-08 已移除、tabs 未宣告），校正為實際的 `activeTab / scripting / storage / downloads / identity`，並附校正說明（Web Store 審核要求權限理由與 manifest 逐項一致）。
- **PM-68：跨頁回放滑鼠游標修復**（只改 `edit-report.ts`）— 調查確認 `mouseTail` 是 Replayer 選項（inject 端不需設）、rrweb 預設就錄 mousemove。真因：跨頁每段新 FullSnapshot 後，使用者下次移動前無 MouseMove → 游標在段落開頭消失。修法 `injectCrossPageCursor()`：每個非首段 FullSnapshot 後注入合成 MouseMove（沿用上段座標 + 指向新頁 `<html>` 節點 id）。build ✅，待 FOX 實機驗收。
- **PM-69：CSP 網站相容性**（只改 `inject.ts`）— 調查確認**注入早已是宣告式 `content_scripts world:MAIN`**（不受頁面 CSP `script-src` 限制），規格「改用 executeScript」前提不成立、不執行（會退步）。真正缺口：inject.ts 兩處頁面 MAIN world `innerHTML`（語音面板 header、即時監控錯誤清單）在 **Trusted Types CSP 網站（如 GitHub）會拋錯** → 改用 DOM 節點 + `textContent` 建構（連帶移除不再需要的 `escapeHtml`）。build ✅，待 FOX 在 GitHub 驗收。
- **PM-70：語音辨識穩定度**（只改 `inject.ts`）— onend 自動重啟 + `autoRestartFails` 計數本已有；補上 **`onstart`**（真的啟動成功才歸零計數 + 切 🟢，比 start() 後立即歸零更準）、**onerror 分類**（`no-speech` 續跑 / `audio-capture` 提示但續試 / `not-allowed` 停止 / `aborted` 忽略 / 其他交 onend）、**統一狀態指示器 🟢 聽取中 / 🟡 重啟中 / 🔴 已停止**（`setVoiceStatus`，字幕區）。build ✅，待 FOX 實機驗收。

### Server / Extension / Docs（Day 9 增量）
- Server 端點：`GET /guide`、`GET /faq`（首頁 footer 加三連結）。
- Extension：`edit-report.ts`（跨頁游標）、`inject.ts`（CSP innerHTML→DOM + 語音 onstart/onerror/狀態指示）。manifest 不變（已是 `world:MAIN`）。
- Docs：新增 `docs/chrome-web-store.md`（上架文案）。
- ⚠ 技術債（Day 9 留）：PM-68/69/70 三項打磨**皆需 FOX 瀏覽器實機驗收**（跨頁游標、GitHub 錄製、語音 30s/停頓/跨頁）；線上 `/report/:id`（server 端 HTML）未享 PM-68 游標修復，要同效需在 `REPORT_PAGE_HTML` 另加前處理；CSP「部分功能受限」popup 提示與語音 backoff 退避未做。

---

## §6h 第 5 代 Day 10（2026-06-28，PM-71~72b）— Web Store 打包 + 綠界金流串接

**目標**：上架打包 + 把「能收錢」真正接起來（綠界 ECPay 測試環境跑通單次付款 + 定期定額月訂閱）。

- **PM-71：popup 更新通知 + Web Store zip**（只改 `popup.ts`/`popup.html` + 打包）— `checkVersionNotice()` 用 `chrome.storage.local` 的 `bugezy:lastVersion` 比對 manifest 版本，**有舊記錄且不同才跳卡片**（首裝不跳）。Web Store zip 用 PowerShell + .NET `ZipFile.CreateFromDirectory` 從 `dist/` 只取執行期 11 檔（排 `.map`）→ `C:\dev\bugezy\bugezy-v0.1.0.zip`（206.4 KB，manifest 在根）。`.gitignore` 加 `dist-zip/`+`bugezy-v*.zip`。⚠ 規格列的 offscreen/icons 實際不存在（offscreen PM-08 移除、manifest 未宣告 icons）故不含。
- **PM-72：綠界 ECPay 付費（測試環境）**（`server/src/index.ts` + `wrangler.toml` + `popup.ts`）— `GET /checkout?user_id=` 回自動提交綠界表單、`POST /api/ecpay/callback` 驗 CheckMacValue → `RtnCode=1` 更新 `users.plan='paid'` → 回 `1|OK`、`POST /checkout/result` 結果頁。popup 升級鈕改開 `/checkout?user_id=`。⚠ **CheckMacValue 依官方 AI Skill（ECPay-API-Skill guides/13）校正**：規格版漏了 TS 的 `~→%7e`、`'→%27`（encodeURIComponent 不編碼這兩個）→ 補齊 `ecpayUrlEncode`；Workers 用 `crypto.subtle`（async SHA256）。**對官方 8 個測試向量驗證**（6 個有 params 全 PASS）+ **線上 `/checkout` 的 CheckMacValue 與本地獨立重算一致**。wrangler.toml `[vars]` 加 4 個 ECPAY 變數（測試帳號 3002607）。
- **PM-72b：定期定額月訂閱**（只改 `server/src/index.ts`）— `/checkout` 加 `PeriodAmount/PeriodType=M/Frequency=1/ExecTimes=99/PeriodReturnURL`（PeriodAmount 必須=TotalAmount=80）；新增 `POST /api/ecpay/period-callback`（第 2 期起每月扣款通知）：驗 CheckMacValue → `RtnCode=1` 維持 paid／否則降級 free → 回 `1|OK`。第 1 次授權仍走 `/api/ecpay/callback`。對官方 `guides/01 §定期定額` 核對欄位 + 線上驗證（含 period 參數的 CheckMacValue 一致、bad mac→`0|ErrorMessage`、valid mac→`1|OK`）。
- **PM-73：取消訂閱**（`server/src/index.ts` + `schema.sql` + `popup.ts`/`popup.html`）— `users` 加 `ecpay_trade_no` + `plan_expires_at`（**FOX 手動跑 ALTER**）。callback 首期/續扣成功時記 `ecpay_trade_no` + 展延 `plan_expires_at`（+1 月）。新增 `POST /api/user/cancel`：呼叫綠界停止訂閱 → 標 `plan='cancelled'`（到期前仍享付費）→ 回可用到期日。`getUserPlan`/`bumpUsage` 的 isPaid 改 `paid||cancelled`；`getUserPlan` 加「cancelled 過期 → 自動降 free」+ 回 `expires_at`。popup 加 `#manageSubscription`（付費顯「取消訂閱」、cancelled 顯「已取消，可用到 YYYY/MM/DD」），取消鈕二次確認 → cancel API。⚠ **據官方 Skill 校正綠界取消端點**：規格寫 `/CreditDetail/DoAction`（一般信用卡交易作業），定期定額取消官方端點是 **`/Cashier/CreditCardPeriodAction`** 且需 `TimeStamp`（主機沿用 `ECPAY_PAYMENT_URL` origin）。線上驗證：cancel 無 auth→401、路由命中 DB；**偵測到新欄位尚未建（待 FOX 跑 ALTER），程式路徑已驗正確**。

### Server / Extension（Day 10 增量）
- Server 端點：`GET /checkout`、`POST /api/ecpay/callback`、`POST /checkout/result`、`POST /api/ecpay/period-callback`、`POST /api/user/cancel`。helper：`ecpayUrlEncode`/`generateCheckMacValue`(async crypto.subtle)/`timingSafeEqualStr`/`formatEcpayDate`/`escapeAttr`/`oneMonthLaterISO`。`Env` + `wrangler.toml` 加 4 個 ECPAY 變數。
- Supabase：`users` 加 `ecpay_trade_no TEXT` + `plan_expires_at TIMESTAMPTZ`（PM-73，**FOX 手動跑**）；`plan` 多一個 `'cancelled'` 狀態（已取消未到期＝仍享付費）。
- Extension：`popup.ts`（更新通知 + 升級鈕開結帳 + 管理訂閱/取消）、`popup.html`（更新通知 + 管理訂閱 CSS）。manifest 不變。
- 產物：`bugezy-v0.1.0.zip`（gitignore，不進版控）。
- ⚠ 技術債（Day 10 留）：① 正式上線要把 ECPAY 4 值換正式 key（HASH_KEY/IV 建議改 `wrangler secret`）；② **定期定額降級策略**目前「任一期失敗即降 free」，綠界實務是連續失敗 6 次才終止合約 → 上線前宜改寬限期/連續失敗 N 次（需加欄位記連續失敗數）；③ 取消後若綠界端取消失敗仍續扣，period-callback 成功會把 cancelled 翻回 paid → 宜「period-callback 成功時若現況 cancelled 則維持」；④ 測試環境只扣第一期，period-callback 需正式環境/後台模擬才驗得到；⑤ 升降級後用戶需重開 popup 才反映方案（無即時推播）；⑥ **PM-73 的 2 個 ALTER 待 FOX 跑**（未跑前已登入用戶打 plan/usage/cancel 會 500，extension 端靜默降級不崩）；⑦ PM-71 更新通知 + Day 9 三項打磨仍待瀏覽器實機驗收。

---

## §6i 第 5 代 Day 11（2026-06-29，PM-74~75）— 綠界補件 + 上架送審

**目標**：補齊綠界審核要求的聯絡資訊、修付費用戶 UI bug，兩邊（Chrome Web Store / 綠界）送審。

- **PM-74：首頁加聯絡資訊**（只改 `server/src/index.ts` 的 `HOMEPAGE_HTML`）— footer 內、隱私政策連結上方新增 **明顯的 `.contact-info` 紫框卡片**：聯絡我們 + 📧 `fox100039@gmail.com` + 📱 `0983-101-085`（`tel:` 可撥）+ 服務時間「週一至週五 09:00-18:00」。綠界要求販售網址聯絡資訊與註冊資料一致。已部署（`6dfd69ab`）+ urllib 驗證（卡片在 `/privacy` 連結上方）。
- **PM-75：修付費用戶仍顯示升級提示**（只改 `extension/src/popup.ts` 的 `loadPlan()`）— plan 狀態判斷由「看 `plan.limits` 是否 null」改成**直接以 `plan.plan` 為準**（source of truth）三態分流：paid → ✨ + 隱藏升級提示 + 管理訂閱（可取消）；cancelled → ✨ + 隱藏升級提示 + 顯示到期日（隱藏取消連結）；free → 剩餘次數 + 升級提示。`npm run build` + `tsc` ✅，**zip 重打包** → `bugezy-v0.1.0.zip`（207.1 KB，popup.js 13.0→15.3kb）。

### 上架/審核狀態（2026-06-29）
- **Chrome Web Store**：已提交審查（zip `bugezy-v0.1.0.zip`）。
- **綠界 ECPay**：補件（聯絡資訊）已重送，等候審核。
- 兩邊審核通過 + 換綠界正式 key 後即可正式收錢上線。

### 增量（Day 11）
- Server：`HOMEPAGE_HTML` footer 加 `.contact-info`（PM-74）。
- Extension：`popup.ts` `loadPlan()` 改以 `plan.plan` 分流（PM-75）；zip 重打包。
- ⚠ 技術債（沿用 Day 10）：PM-73 的 2 個 ALTER 仍待 FOX 跑（PM-75 的付費 UI 效果依賴它 + 實際 paid/cancelled 用戶）；定期定額降級寬限期、cancelled 被 period-callback 翻回 paid、報告過期清理、rewind/mcp 用量前端、`/report/:id` 游標前處理；一批仍待瀏覽器實機驗收（更新通知、跨頁游標、GitHub 錄製、語音、完整刷卡/取消、付費 UI）。

---

## §6j Day 15（2026-06-30，PM-80~91）— 首頁受眾擴展 + bugezy.dev 域名 + 截圖 AI 勾選 + 語音架構升級（Groq Whisper 雙引擎）

**目標**：擴大首頁受眾、bugezy.dev 域名上線、報告頁讓使用者控制 AI 是否讀截圖、把語音從「每站授權的 Web Speech」升級為「一次授權的雙引擎（Web Speech / Groq Whisper）」。

- **PM-80 首頁受眾定位**（`HOMEPAGE_HTML`）：主標語改「Web 開發者的 AI Bug 報告工具」；新增「支援所有 Web 開發框架」區塊（前端 7 + 後端 8 框架標籤）+ MCP 工具列 + RWD。已部署 `c3fd3617`。
- **PM-81 bugezy.dev 域名稽核**（唯讀，產出 `docs/domain-migration-checklist.md`）：核心結論——後端全用 `url.origin` 故域名無關，真正要改只有 `extension/src/types.ts:API_BASE` 一處；OAuth/ECPay 回調自動連動。
- **PM-82~84 截圖「高畫質 AI 分析」**：`reports.allow_screenshot_images`（FOX 跑 ALTER）+ 報告頁勾選 + `PATCH /api/reports/:id/settings`；MCP `get_screenshots` 兩層判斷（**使用者勾選 OR AI 帶 `include_images`**）+ 文字統一為「高畫質 AI 分析（高 Token）」；popup 加同名 toggle，截圖上傳帶入（createReport 非破壞性退回重試）。已部署 `eb870142`/`86c22eee`。
- **PM-85~91 語音架構升級（麥克風 1/3~3/3 + 4 個修正/增強）**：
  - **1/3 server**：`POST /api/transcribe`（Groq `whisper-large-v3-turbo`，`Env.GROQ_API_KEY` secret），已部署 `ec1da982`。
  - **2/3 extension**：`offscreen.html/ts`（getUserMedia + MediaRecorder webm/opus）+ background offscreen 管理 + popup 麥克風 toggle。
  - **3/3 路由**：`getMicMode()`（off/realtime/whisper）；免費版 Web Speech、付費版可選；plan 由 popup `loadPlan` 持久化 `USER_PLAN_KEY`（規格的 `bugezy:user` storage 不存在，據實校正）。
  - **修正鏈**：PM-88 移除無效 `audioCapture` + 新增 `mic-permission.html` 可見授權頁（隱藏 offscreen 不彈授權）；PM-89 授權時機改到 popup toggle（修「錄製中開頁導致停止失效」）；PM-90 麥克風預設 OFF + 授權頁停留 3s；PM-91 付費版「即時字幕/精準轉錄」模式切換 + Whisper 錄音中(紅點脈衝)/轉錄中反饋。

### 語音雙引擎（§2a 對應）
- **免費版**：Web Speech API 即時字幕（inject MAIN world，零成本、每站第一次需頁面授權橫幅）。
- **付費版/已取消**：popup 可切「即時字幕」或「精準轉錄（Groq Whisper）」；Whisper 走 offscreen 錄原始音訊 → 停止 → `/api/transcribe` → 合併 `voiceTranscript(source:'whisper')`。一次授權（綁 `chrome-extension://`）後全站通用。

### 增量（Day 15）
- Server（已部署）：`/api/transcribe`、`/api/reports/:id/settings`、`get_screenshots` 兩層判斷、首頁框架區塊。Supabase：`reports.allow_screenshot_images`（FOX 跑 ALTER）。
- Extension（皆 build 過、**未重上架 Web Store**）：新增 `offscreen.html/ts`、`mic-permission.html/ts`；manifest 加 `offscreen` 權限；popup 麥克風 toggle + 語音模式 + 高畫質 AI toggle；語音引擎路由全鏈。
- 域名：**bugezy.dev 已綁同 Worker 上線**（與 `…workers.dev` 雙域名並行）。
- ⚠ 技術債（Day 15）：① extension PM-85~91 整套**未重上架 Web Store**（offscreen 權限變更需重審，等當前審核過再一起打包）；② PM-82 的 `allow_screenshot_images` ALTER + PM-73 的 2 個 ALTER 待 FOX 跑；③ domain 遷移（改 `API_BASE`→bugezy.dev）待雙審核過後執行；④ 待辦：即時字幕授權橫幅改居中 modal、Whisper 音量跳動指示器、錄製中 popup 模式按鈕 disable；⑤ 一批語音/截圖功能待瀏覽器實機驗收。

---

## §6k Day 16（2026-07-01，PM-93~107）— Supabase RLS 安全根治 + Whisper 音量條 + install/features 雙頁 + 截圖修復 + 工具列特效 + 錄製 UX

**目標**：修 Supabase Critical 安全警告、補齊上手文檔、修一批截圖/錄製體驗與麥克風授權時機問題、把 Day 15 待辦（授權 modal、音量條）做完。

- **PM-93 Supabase RLS 安全根治（Critical）**：⚠ 發現規格前提錯——Worker 實際用 **anon key 非 service_role**（`schema.sql` 曾 `DISABLE RLS on users` 為鐵證）。若直接開 RLS 會鎖死自己全站 500。校正：新增 `supaKey(env)=SUPABASE_SERVICE_ROLE_KEY||SUPABASE_ANON_KEY`（未設 service_role 自動退回 anon，安全過渡，已部署 `9a2dc3f6`）；產出 `server/rls-lockdown.sql`（含動態 DO block 對所有 public table 開 RLS）；ARCHITECTURE §4-6 加「Supabase 安全鐵律」。**FOX 待辦（順序不可顛倒）：先 `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` → 再跑 `rls-lockdown.sql`**。
- **PM-95 即時字幕授權橫幅改居中 modal**（Day 15 待辦①）：`inject.ts showMicPermissionOverlay` 頂部橫條→全頁遮罩 + 紫框居中卡片，按鈕邏輯零改。
- **PM-96 `/install` + `/features` 雙頁**：安裝指南（五步 + MCP 設定 `bugezy.dev/mcp` + 12 工具）+ 功能總覽（八區塊）+ 首頁/guide/faq/privacy footer 統一導覽。已部署 `568cc421`。
- **PM-97 Whisper 即時音量條**（Day 15 待辦②）：offscreen `AudioContext/Analyser` 每 200ms 送 `MIC_VOLUME` → background(`recordingTabId` 轉發) → content(CustomEvent) → inject 5 條音量條（安靜矮紅/講話綠跳），取代靜態脈衝紅點。
- **PM-98 修截圖報告在 `list_reports` 消失**：⚠ 根因是漏 `user_id` 非規格說的 `user_email`（reports 無此欄；`list_reports` 靠 email→user_id 過濾）。annotate 上傳補帶 `user_id`(session)+Authorization header + server `createReport` 防呆從 Bearer token 補 user_id。已部署 `33fde879`。**FOX 待辦：跑 `server/backfill-user-id.sql` 補舊孤兒報告**。
- **PM-99 報告頁截圖點擊改頁內 lightbox**：base64 data URL 無法 `window.open`（開空白頁）；改 `openLightbox` + `</body>` 前全頁遮罩放大圖，點遮罩/ESC 關。已部署 `2ccbb942`。
- **PM-100 截圖標注頁語音/鍵盤臨時切換鈕**：問題描述左側加 `voice-toggle`（⌨️/🎙️），復用既有 `startListening/stopListening`；授權失敗自動退鍵盤（刻意排除 no-speech 免殺 onend 自動重啟）。
- **PM-101→104 工具列入場特效四連迭代**（純視覺）：邊框掃光（看不清）→ 紫脈衝（不搶眼）→ 自適應底色（深橘光/淺紅跑馬燈）→ **104 定案**：只留橘光脈衝 `applyOrangePulse` + popup「✨ 工具列特效」開關（`TOOLBAR_EFFECT_KEY` 預設 ON）。
- **PM-105 錄製中開麥克風不再卡死**：popup toggle 先 `GET_RECORDING_STATE`，錄製中只存 `MIC_KEY` 偏好不開授權頁（下次錄製才授權）。
- **PM-106 錄製中鎖定 popup 全部設定**：`lockSettings` 於 `render()` 依 `state.recording` disable 全 toggle/模式鈕 + `settingsHint`「🔒 錄製中設定已鎖定」。
- **PM-107 按錄製時 mic OFF 提示**（鍵盤模式除外）：`startBtn` 抽 `doStartRecording`，mic OFF+非鍵盤模式先彈 `micPrompt`（開啟並錄製/直接錄製）。

### 增量（Day 16）
- Server（已部署）：`supaKey` service_role fallback + `/install` + `/features` + footer 統一 + 報告頁 lightbox + `createReport` user_id 防呆。新 SQL 腳本：`server/rls-lockdown.sql`、`server/backfill-user-id.sql`（皆待 FOX 跑）。
- Extension（皆 build 過、**未重上架 Web Store**）：Whisper 音量條全鏈（`MIC_VOLUME`）、授權 modal、annotate user_id/語音切換鈕、工具列橘光脈衝 + 開關、錄製中鎖設定、mic OFF 提示；新 storage key `TOOLBAR_EFFECT_KEY`、新訊息 `MIC_VOLUME`/`GET_RECORDING_STATE`。
- ⚠ 技術債（Day 16）：① **PM-93 service_role secret + `rls-lockdown.sql` 待 FOX 跑（順序關鍵，先切 key 再開 RLS，否則全站 500）**；② **PM-98 `backfill-user-id.sql` 待跑**（否則舊截圖報告仍不在 list_reports）；③ **PM-94（綠界測試 key→正式 key）本日未執行**，Worker 仍 `3002607`/`payment-stage`，正式收款未生效；④ PM-73/82 ALTER 沿用待跑；⑤ extension 整套仍未重上架 Web Store；⑥ PM-95~107 一批 extension 功能待瀏覽器實機驗收；⑦ **無 git remote，push 無法執行**（commit 已在本地）。

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
