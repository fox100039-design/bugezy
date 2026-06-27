# BugEzy — Chrome Web Store 上架資料

> 用途：Chrome Web Store 開發者後台填寫上架表單時的文案來源（複製貼上）。
> 維護者：FOX。最後更新：2026-06-27（PM-67）。

## 擴充名稱
BugEzy — AI Bug 報告工具

## 簡短說明（132 字元內）
中文：語音錄 Bug，AI 幫你修。6 種模式 + MCP 整合，省 95% debug 時間。
英文：Voice-powered bug reports. 6 recording modes + MCP integration. Save 95% debug time.

## 詳細說明（中文）

BugEzy 是專為開發者設計的 Bug 報告工具。用語音描述 Bug，AI 自動分析並提供修復建議。

🎬 六種錄製模式
• 錄製 — 完整錄下 DOM 變化 + Console + Network + 語音
• 回溯 30s — Bug 已經發生？一鍵抓回最近 30 秒
• 截圖標注 — 畫筆、箭頭、框框標出問題
• 鍵盤模式 — 吵雜環境用文字描述
• 即時監控 — 自動偵測頁面 error，有問題才通知
• 終端機 — npx bugezy-watch 攔截 server crash

🤖 AI 直接讀報告（MCP 整合）
支援 Claude Desktop、Cursor、VS Code、Zed 等所有 MCP 工具。
AI 透過 MCP 讀取 Console error、Network error、語音描述，直接給修復建議。
每次查詢顯示 Token 估算，讓你知道省了多少。

💰 省 95% Token 費用
用 BugEzy MCP 讀報告只需 ~500 tokens，同樣的 Bug 用截圖貼給 AI 要 ~10,000 tokens。

📊 免費開始
• 免費版：每月 10 次錄製、截圖無限、即時監控
• 付費版 NT$80/月：全功能無限

🔒 隱私保護
• 密碼輸入自動遮蔽
• 報告預設私人
• 所有傳輸 HTTPS 加密

官網：https://bugezy-api.bugezy-api.workers.dev
使用指南：https://bugezy-api.bugezy-api.workers.dev/guide
常見問題：https://bugezy-api.bugezy-api.workers.dev/faq

## Detailed Description (English)

BugEzy is a bug reporting tool designed for developers. Describe bugs with your voice, and AI automatically analyzes and suggests fixes.

🎬 Six Recording Modes
• Record — Capture DOM changes + Console + Network + voice
• Rewind 30s — Bug already happened? Grab the last 30 seconds
• Screenshot — Annotate with pen, arrows, and boxes
• Keyboard mode — Text-only for noisy environments
• Live Monitor — Auto-detect page errors, notifies when issues arise
• Terminal — npx bugezy-watch captures server crashes

🤖 AI Reads Your Reports (MCP Integration)
Works with Claude Desktop, Cursor, VS Code, Zed, and all MCP-compatible tools.
AI reads Console errors, Network errors, and voice descriptions via MCP.
Token usage shown on every query — see how much you save.

💰 Save 95% on AI Token Costs
BugEzy MCP reads reports in ~500 tokens. Same bug via screenshots costs ~10,000 tokens.

📊 Free to Start
• Free: 10 recordings/month, unlimited screenshots & live monitoring
• Pro NT$80/month (~$3 USD): Unlimited everything

🔒 Privacy First
• Password fields auto-masked
• Reports private by default
• All data encrypted via HTTPS

Website: https://bugezy-api.bugezy-api.workers.dev
Guide: https://bugezy-api.bugezy-api.workers.dev/guide
FAQ: https://bugezy-api.bugezy-api.workers.dev/faq

## 分類
Developer Tools

## 語言
繁體中文、English

## 隱私政策 URL
https://bugezy-api.bugezy-api.workers.dev/privacy

## 首頁 URL
https://bugezy-api.bugezy-api.workers.dev

## 權限說明（Chrome 會問用戶為什麼需要這些權限）

> ⚠ 以下對應 `extension/manifest.json` **實際宣告** 的權限（`activeTab`、`scripting`、`storage`、`downloads`、`identity`）。
> Chrome Web Store 審核要求權限理由必須與 manifest 一致，故已依實際 manifest 校正（詳見本檔末「權限校正說明」）。

• activeTab — 錄製當前頁面的 DOM 和 Console
• scripting — 將錄製腳本（rrweb DOM 側錄 + Console/Network 攔截）注入到當前頁面
• storage — 儲存登入狀態和設定（chrome.storage.local）
• downloads — 將 Bug 報告 JSON 匯出到本機（給 AI 讀）
• identity — Google 帳號登入（chrome.identity.getAuthToken）

### 權限校正說明（給 FOX）
PM-67 規格原列的權限清單含 `tabs` 與 `offscreen`，但與目前 `extension/manifest.json` 不符，已校正：
- **`offscreen`**：第 2 代曾用，PM-08 已移除（語音改在 inject.ts MAIN world 跑，不再用 offscreen document）。manifest 已無此權限 → 不列。
- **`tabs`**：目前 manifest 未宣告 `tabs` 權限（跨頁錄製靠 content script 在每頁注入 + background `chrome.storage.local` buffer 接力，不需 `tabs` 權限）。`chrome.tabs.create`（開升級頁/標注頁）在 MV3 不需要 `tabs` 權限 → 不列。
- **補列 `scripting`、`downloads`**：manifest 實際有宣告，Chrome Web Store 會要求逐項說明用途。
- OAuth：manifest 另有 `oauth2` 區塊（client_id + scopes），非 `permissions` 陣列項目，於上架表單的 OAuth 同意畫面設定處理，不在本權限清單。

> 上架前請以 `extension/manifest.json` 的 `permissions` 陣列為準再核對一次。
