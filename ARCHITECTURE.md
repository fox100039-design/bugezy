# BugEzy Architecture

> 亞洲專屬平價 MCP 語音除錯工具
> 建立日期：2026-06-16
> 狀態：MVP 開發中

---

## §1 產品概述

中文版 Bug 回報工具。開發者用中文語音錄 Bug，自動產出 DOM 軌跡 + 網路錯誤 + Console Log + 中文字幕的完整報告，一鍵分享給隊友或 AI 助手直接修復。

## §2 技術架構

```
Chrome 擴充（Manifest V3）
    ├── inject.ts（MAIN world）：rrweb DOM 軌跡 + Network 攔截(4xx/5xx) + Console(warn/error) + Web Speech 即時字幕
    ├── content.ts（ISOLATED world）：橋接 + 依 plan/mode 算語音旗標（computeStartFlags）
    ├── offscreen.ts（隱藏頁）：getUserMedia + MediaRecorder 原始錄音（付費版 Whisper 路徑）
    ├── mic-permission.html（可見授權頁）：一次性麥克風授權（offscreen 隱藏頁不會彈授權）
    ├── background.ts（Service Worker）：狀態管理 + 語音引擎路由(getMicMode) + offscreen 起停
    └── popup（麥克風 toggle / 語音模式切換 / 高畫質 AI 分析 toggle / 升級·取消訂閱）
         ↓
Cloudflare Workers（API，server/src/index.ts）
    ├── /api/transcribe        → Groq Whisper（whisper-large-v3-turbo）語音轉文字
    ├── /api/reports(:id)      → 報告 CRUD + /settings(allow_screenshot_images)
    ├── /checkout、/api/ecpay/* → 綠界 ECPay 金流（單次 + 定期定額）
    ├── /、/guide、/faq、/privacy → 對外頁面（首頁/指南/FAQ/隱私）
    ├── Supabase（PostgreSQL + 自建 session）
    └── Cloudflare R2（rrweb / 截圖 大檔）
         ↓
    └── MCP Server（/mcp，Streamable HTTP，12 Tool，Pull 模式 + token 省錢 footer）
```

### §2a 語音雙引擎架構（PM-85~91）

```
popup 麥克風 toggle（預設 OFF）→ 開啟需一次授權（mic-permission.html，授給 chrome-extension://）
         │
   getMicMode(MIC_KEY + USER_PLAN_KEY + MIC_MODE_KEY)
         ├── 'off'       → 不錄語音
         ├── 'realtime'  → 免費版／付費版選即時字幕：inject 的 Web Speech API（頁面內即時字幕，零成本）
         └── 'whisper'   → 付費版選精準轉錄：offscreen MediaRecorder 錄原始音訊
                              → 停止 → POST /api/transcribe（Groq Whisper）→ 合併進 voiceTranscript(source:'whisper')
```
- **免費版**只有即時字幕（Web Speech）；**付費版/已取消**可在 popup 切「即時字幕 / 精準轉錄」。
- 一次授權（chrome-extension:// 綁擴充 ID）後所有網站通用，不再每站彈麥克風授權。
- Whisper 模式錄製顯紅點脈衝 bar「Whisper 錄音中」，停止顯「⏳ 轉錄中」。

## §3 目錄結構

```
extension/     Chrome 擴充（Manifest V3 + TypeScript）
server/        Cloudflare Workers API
web/           React 報告頁 + 分享連結
mcp-server/    MCP Server（8 個 Tool，Pull 模式）
docs/          規格文件
job/           每日任務檔
```

## §4 關鍵設計原則

1. **rrweb 取代影片**：錄 DOM 變化軌跡（JSON），不存影片，儲存趨近零
2. **語音雙引擎依方案路由**（PM-85~91）：免費版 = Web Speech API 即時字幕（零成本）；付費版可選即時字幕或 Groq Whisper 精準轉錄（offscreen 錄音 + `/api/transcribe`）。麥克風一次授權後全站通用
3. **智能過濾**：只擷取 console.error 和 4xx/5xx，過濾 200 OK
4. **MCP Pull 模式**：初始只傳 ~1,000 token 摘要，AI 按需查詢細節
5. **語言 Token 壓縮**：亞洲語言先轉極簡英文技術術語再餵 AI

## §5 MCP Server Tool Schema

```
get_report_summary    → 報告摘要（~1,000 token）
get_network_errors    → 網路錯誤清單
get_console_errors    → Console 錯誤清單
get_user_events       → 用戶事件時間軸
get_transcript        → 語音全文
get_screenshots       → 截圖 URL
search_reports        → 搜尋報告
list_recent_reports   → 最近報告
```

## §6 開發進度

| 日期 | 內容 |
|---|---|
| 2026-06-16 | 專案建立、基礎工作流設定 |
| 2026-06-16~25 | ①②③④ 代完成（錄製/語音/後端報告頁/MCP 12 Tool = MVP）+ ⑥ 六模式/跨頁/編輯頁/AI 精簡校正 + ⑤ 起步（Google 登入/首頁/隱私/用量限制/兩層定價） |
| 2026-06-28~29 | ⑤ 綠界 ECPay 金流（單次 + 定期定額 + 取消訂閱，CheckMacValue 對官方測試向量驗證）+ Chrome Web Store 打包送審 + popup 付費狀態三態 + 擴充圖示 |
| 2026-06-30 | 首頁受眾擴展（所有 Web 框架）+ **bugezy.dev 域名上線**（綁同 Worker）+ 報告頁截圖「高畫質 AI 分析」勾選 + **語音架構升級：Groq Whisper 雙引擎**（offscreen 錄音 + `/api/transcribe` + mic-permission 一次授權 + 付費版模式切換） |

> 部署：Cloudflare Workers `bugezy-api`（**bugezy.dev** + `bugezy-api.bugezy-api.workers.dev` 雙域名）；每日 03:00 UTC cron 保活 Supabase。
> （隨開發持續更新）
