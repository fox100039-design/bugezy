# BugEzy 專案全貌與接手指南

> 最後更新：2026-06-16
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
| **③ 能存能看** | 後端 + 報告頁 | Cloudflare Workers + Supabase + R2 + React 報告頁 | 🔨 進行中（API 完成，擴充上傳+報告頁待做） |
| **④ AI 能讀** | MCP Server | Pull 模式 8 Tool，AI 按需查詢 = **MVP 封測** | 待做 |
| **⑤ 能收錢** | 付費上線 | Stripe 串接 + Chrome Web Store 上架 = **正式上線** | 待做 |
| **⑥ 更好用** | UX 優化 | 即時字幕 overlay、隱私遮罩、AI 標題、Markdown 匯出 | 待做 |
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

## §8 第 3 代進度（能存能看）

### 已完成
- PM-10：Workers API + Supabase schema + R2 設定，POST/GET 端點程式碼完成、tsc 通過（本機 curl 驗收待 FOX 啟用 §5 後執行）

### 待做
- PM-11：擴充上傳整合（錄完自動送 API）
- PM-12：React 報告頁（rrweb-player 回放 + 時間軸）

### 目標
把 payload 從本機 JSON 檔變成雲端報告，有分享連結、可回放。

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
| 後端 API | Cloudflare Workers | 待做（第 3 代） |
| 資料庫 | Supabase (PostgreSQL + Auth) | 待做（第 3 代） |
| 檔案儲存 | Cloudflare R2 | 待做（第 3 代） |
| Web 報告頁 | React + Vite | 待做（第 3 代） |
| MCP Server | TypeScript + MCP SDK (8 Tool) | 待做（第 4 代） |
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
