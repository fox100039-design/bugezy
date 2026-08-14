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
    ├── inject.ts（MAIN world）：rrweb DOM 軌跡 + Network 攔截(4xx/5xx) + Console(warn/error/info) + Web Speech 即時字幕
    │   └── Day 20 Bug 捕捉升級：unhandledrejection + window.onerror + 資源載入失敗(capture) + Web Vitals(LCP/CLS/FID) + 去重入口 collectConsoleLog
    ├── net.ts / storage.ts（共用 MAIN world）：網路環境快照(navigator.connection) + 儲存快照(localStorage/sessionStorage/cookieNames，PII 本機 maskPII 遮罩)
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
    └── MCP Server（/mcp，Streamable HTTP，13 Tool，Pull 模式 + token 省錢 footer）
         └── Day 20 get_timeline（時序麵包屑：所有資料合成一條故事線）+ generateBugSummary 規則引擎（AI Bug 導航摘要，貼在 get_timeline / get_report_overview 最前面，零 API 成本）
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
6. **Supabase 安全鐵律（PM-93）**：
   > 所有 public table 一律 `ENABLE ROW LEVEL SECURITY`，**不加任何 policy（= deny all）**。唯一能存取資料的途徑是 Worker 的 **`service_role` key**（天生繞過 RLS）。anon key 完全鎖死（任何 SELECT/INSERT/UPDATE/DELETE 皆 deny）。
   >
   > - 新增 table 時**必須**跟著 `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;`，不需寫 policy。
   > - Worker 連線 key 統一走 `supaKey(env)` = `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY`；**正式環境必須設 `SUPABASE_SERVICE_ROLE_KEY`**（`wrangler secret put`），否則開 RLS 後 Worker(anon) 會被自己鎖死。
   > - 鎖死腳本：`server/rls-lockdown.sql`（含動態對所有 public table 開 RLS）。
7. **認證信任鏈（PM-133）**：
   > **絕不信任客戶端傳來的 user_id**。登入唯一入口 `POST /api/auth/session` 收 Google access token → `verifyGoogleToken` 驗 `aud/azp === GOOGLE_CLIENT_ID`（防其他 App 的 token 重放）→ 取 Google `sub` 當 user_id → 發不可猜測的 DB session token（`sessions` 表，90 天）。
   >
   > - 所有需認證的 API 走 `getAuthUserId(request, env)` = `verifySession`（查 `sessions` 表）；**無 base64 fallback**（假 base64 token 一律 401）。
   > - 私有（依 user 過濾）回應一律 `jsonNoStore()`（`Cache-Control: no-store`），防 Cloudflare 邊緣快取以 URL 為鍵把 A 的資料跨服給 B（`/api/reports`、`/api/user/plan`）。
   > - AI 端點（transcribe/summarize/correct）皆需登入；Whisper `transcribe` 另限 `isActiveUser`（付費才可，防 Groq 荷包型 DoS）。
   > - CORS 只放行 `bugezy.dev` + `*.workers.dev` + `chrome-extension://`（`getCorsHeaders`，統一出口注入）；500 錯誤一律回 `GENERIC_500`（原始錯誤只 `console.error`）。
8. **活動代碼 + 票券錢包（PM-265~267）**：
   > 免費期發放採「**兌換 → 存進錢包 → 想用才啟用**」兩段式，而非兌換即開始計時——用戶可先囤票，之後才啟用，不浪費。
   >
   > - `promo_codes`（代碼定義，FOX 管理）+ `user_tickets`（`SAVED`→`ACTIVE`→`USED`，`UNIQUE(user_id, code)` 防重複兌換）。
   > - **到期日疊加**：啟用時 `expires_at = MAX(現有到期日, NOW()) + duration_days`，與 ECPay 付費期正確接續而非覆蓋。
   > - **付費資格有兩條來源**，務必分清楚：`isActiveUserId()` = ECPay **或** 有效票券（給功能守門用）；`isEcpayActiveUserId()` = **僅** ECPay（給 ECPay callback 的孤兒自癒守門用）。若 callback 誤用前者，持有免費票券的用戶付款會被判定「已啟用」而跳過升級 → **收錢不開通**。
   > - `max_uses` 遞增走 **CAS**（`.update({n: prev+1}).eq('current_uses', prev)` + 重試 + 失敗補償），因為 PostgREST 不能做欄位運算，check-then-increment 併發下會超發。
   > - 新增付費守門時**三處後端額度檢查**（`bumpUsage`/`handleTranscribe`/`createReport`）都要一併認票券，否則前端顯示無限制、後端回 403。
9. **FOX 即時推播（PM-268~270）**：
   > 重要用戶事件（新用戶／新報告／代碼兌換／票券啟用／三種付款）即時推到 FOX 的 Discord。
   >
   > - 統一入口 `notifyFox(env, title, body, priority)` / `notifyFoxForUser(env, userId, title, makeBody, priority)`；未設 `DISCORD_WEBHOOK_URL` → 靜默跳過。
   > - **一律用 `ctx.waitUntil`**（`env.__ctx` per-request 注入）：Workers 回應送出後會終止 isolate，**沒被 await 也沒交給 waitUntil 的 fetch 會被中斷**；但直接 await 又會把推播延遲加到使用者請求上。
   > - **推播失敗必須 `console.error`**——PM-269 的教訓：靜默 `.catch(() => {})` 讓「ntfy 被回 429」完全查不出來，多花一輪加除錯端點才找到。
   > - **不要用 ntfy.sh**：它按來源 IP 計每日配額，Workers 走共用 Cloudflare IP，額度早被用光 → 每則都 429（code 42908）。
   > - 付款類推播一律放在 **DB 更新成功之後**，否則升級失敗回 500 讓綠界重送時會推出假的「付款成功」。
   > - **cron（`scheduled()`）裡不能用 `notifyFox()`**（PM-284）：它靠 `env.__ctx.waitUntil` 送出，而 `__ctx` **只在 `fetch()` 入口設定**——在 `scheduled()` 裡要嘛不存在，要嘛是同一 isolate 前次 fetch 留下的**已結束 ctx**，兩種情況推播都可能送不出去。cron 沒有回應延遲壓力，直接 `await sendDiscord()`。
   > - **「推播 + 標記已通知」類的排程，必須先確認 webhook 已設定**（PM-284）：`sendDiscord` 未設 `DISCORD_WEBHOOK_URL` 時是靜默 return，若照樣標記「已通知」，等於在推播開通前把所有提醒**無聲消耗掉**，之後永遠不會再送。
10. **官網頁面的四個既有陷阱（PM-272/279/280）**：
   > 改 `server/src/index.ts` 的行銷頁時，這四個坑每次都會再踩一遍：
   >
   > - **CSP 沒有 `frame-src`** → 未指定會回退 `default-src 'self'`，任何外部 iframe（YouTube 等）**直接被擋**，只留空白框、錯誤僅在 console。要嵌入就得把該網域加進 `frame-src`（與 `frame-ancestors 'none'` 無關，那條管的是「誰能嵌入我們」）。
   > - **`Response.redirect()` 的 headers 是 immutable** → 統一出口會 `headers.set()` 注入 CORS，碰到它會拋錯讓整支回 **500**。要重導請用 `new Response(null, { status: 301, headers: { Location } })`。（檔案最上方 workers.dev 那個沒事，因為它在 CORS 包裝之外。）
   > - **template literal 會吃掉 regex 反斜線** → 內嵌 script 的 `\.` 在 TS 原始碼要寫成 `\\.`，否則 render 出來只剩 `.`，`/(a\.b\/c)/` 的 `/` 會提前結束 regex 變語法錯誤（PM-200 也踩過同一個）。
   > - **一鍵複製不要讀 DOM `textContent`** → 會複製到排版縮排甚至整段空白（PM-192/199/200）。一律 `data-copy-text="${encodeURIComponent(text)}"` + 事件委派，並保留 `execCommand` fallback（`navigator.clipboard` 失敗時若仍顯示「已複製」等於騙使用者）。
11. **繁簡轉換的驗證方法（PM-282 修正）**：
   > `T2S_CHARS` 是**依站上文案產生的子集**（非完整繁簡表），新增中文文案必須驗證，否則簡體版會夾雜繁體字。
   >
   > **不要逐字比對**——OpenCC 有詞組級規則，逐字掃不出來。正確做法是**用專案自己的 `T2S_TERMS`+`T2S_CHARS` 轉換整句，再與 `opencc.OpenCC('t2s')` 的結果逐句 diff**；差異只該出現在 `T2S_TERMS` 刻意的用語對應（如 `擴充功能`→`扩展程序`）。
12. **商店包不得含 source map（PM-283）**：
   > `extension/build.mjs` 的 esbuild 設定用 `sourcemap: watch`——**正式打包不產 `.map`**（上架的 `.map` 等於公開原始 TypeScript），`--watch`（dev）才產。
   >
   > 打包 zip 時另需**排除 `icons/proposals/` 與 `icons/icon-source.svg`**（PM-251）——build 會遞迴複製整個 `icons/`，把設計原稿一起帶進 `dist/`。正確產物為 **22 entries**。
   >
   > **送審前務必逐一確認 `manifest.permissions` 每一項都有實際呼叫**（PM-286）：v1.1.5 首次送審就是被以「要求但未使用 `scripting` 權限」退件。宣告式 `content_scripts`（含 `world: MAIN`）**不需要** `scripting` 權限——只有 `chrome.scripting.executeScript/insertCSS/registerContentScripts` 才需要。檢查時要一次掃完**全部**權限，只修被點名的那一個，下一輪很可能又被別的退。
13. **多語 SEO：canonical 是 URL 的屬性，不是語言的屬性（PM-289）**：
   > 本站以 `Accept-Language` 決定**顯示**哪個語言（`getLang` → `detectLang`），但 **canonical 絕不能吃這個訊號**。
   >
   > - `canonicalTag(path, explicit, langs)` 的 `explicit` 來自 **`explicitLang(request)`——只讀 query 的 `?lang=`，不做偵測**。裸網址 → canonical 是裸網址；`?lang=zh` → canonical 是 `?lang=zh`。
   > - **為什麼**：canonical 若跟著偵測結果走，① 裸網址會 canonical 到 `?lang=xx`，而 sitemap `<loc>` 與 hreflang `x-default` 指的都是裸網址 → **x-default 的目標自我否定、失效**（GSC 報「替代網頁（有適當的標準標記）」）；② 同一個 URL 對不同 `Accept-Language` 吐出**不同** canonical，Googlebot 以多語言爬取時會拿到矛盾訊號。
   > - **鐵則：`x-default` 的目標必須自我 canonical**。改動 canonical 或 hreflang 後，逐頁比對 `x-default` 與 `canonical` 是否相等。
   > - `langs.includes(explicit)` 這道守門不可省：該頁不支援的語言（如 `/blog?lang=ja`，blog 只有繁中）要併回裸網址，否則會產生**沒有任何 hreflang 指向的孤兒 canonical**。
   > - 新增頁面函式時，`canonLang` 要從路由一路傳進去（**不要**用 module 級變數暫存 request——同 isolate 併發有風險）。
   > - **`Vary: Accept-Language` 必須設在統一出口的 CORS 注入「之後」**，否則會被 `getCorsHeaders()` 的 `Vary: Origin` 覆寫；且只加在 HTML（API 的 JSON 不隨語言變動）。
14. **不要碰的三種 schema（PM-288 審計）**：
   > `HowTo`（Google 2023-09 已棄用）、自家網站的 `Review`/`AggregateRating`（self-serving，Google 不採計，別為了星星造假）、以及**不要再為了 SERP 新增 `FAQPage`**——Google 已於 **2026-05-07 對所有網站停用 FAQ 複合式結果**；`/faq` 既有的保留即可（對 AI 抓取仍有語意價值），但別期待點閱。
15. **隱私政策必須逐字對得上程式碼（PM-291）**：
   > `/privacy` 被 Chrome Web Store 審核時，會與 **manifest permissions** 和 **Dashboard 的 Privacy practices** 做三方比對。三者只要有一處對不上就會被退。
   >
   > - **不要宣告不存在的權限**——manifest 目前**沒有** `host_permissions`；真正需要說明的是 `content_scripts` 的 **`<all_urls>`**（審核員最在意的一項）。
   > - **第三方要據實列全**：語音轉文字是 **Groq**（`api.groq.com`，美國）、AI 文字校正／精簡才是 **Cloudflare Workers AI**；**Discord webhook 會把使用者 email 送出**；由 IP 推得國家碼（不儲存 IP）。舊版曾寫「不會將資料傳送給其他 AI 服務商」，與 Groq 的事實牴觸。
   > - **不要在政策裡承諾未實作的行為**（例如自動刪除）。政策是有拘束力的文件，寫了卻沒做，比不寫更糟。
   > - 改動 permissions、新增第三方服務、或改變資料保留方式時，**都要回頭更新 `/privacy` 與 Dashboard**。
16. **破壞性排程的安全設計（PM-292）**：
   > 會永久刪除使用者資料的 cron（`cleanupExpiredReports`）必須：
   >
   > - **預設 dry-run**（`REPORT_CLEANUP` 不等於 `'on'` 就只統計不刪）。否則「部署」與「開始永久刪資料」是同一個動作，中間沒有煞車。
   > - **先刪 R2 再刪 DB**：反過來的話 DB 記錄一消失就再也查不到 R2 key，檔案永久孤兒化。`R2.delete` 冪等，失敗下次重試即可。
   > - **無法判定歸屬就不刪**：`reports.user_id` 可為 null（PM-133 認證上線前的舊資料），無法判定方案即無法判定保留期，一律略過並在摘要回報筆數。
   > - **單次設上限並明講**（500 筆／次），達上限時在通知裡寫明「剩餘明天繼續」，不做無聲截斷。
   > - 用 `.in()` 批次刪除 + 一次查完所有相關用戶方案，**查詢數固定**；逐筆查會撞 Workers 的 subrequest 上限。

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
| 2026-07-01 | **Supabase RLS 安全根治**（§4-6 鐵律：全 table ENABLE RLS + Worker 改 `supaKey` service_role/anon fallback + `rls-lockdown.sql`）+ Whisper 錄音**即時音量條**（offscreen Analyser→`MIC_VOLUME`）+ `/install` 安裝指南 & `/features` 功能總覽雙頁 + 截圖修復（`list_reports` 補 `user_id` + 報告頁點圖改頁內 lightbox）+ 工具列橘光脈衝特效（popup 開關）+ 錄製 UX（錄製中鎖設定 + mic OFF 提示 + 授權時機修復） |
| 2026-07-02 | **綠界 ECPay 正式環境遷移**（key 從 wrangler.toml 明文→`wrangler secret`；FOX 手動 secret put 4 值）+ **日票 NT$20/24hr 三部曲**（一次性付款 `/api/day-pass/create·callback` + `day_pass_expires_at` + `isActiveUser()` + 首頁三欄 + popup 雙鈕/倒數 + `day-pass-checkout` 跳板頁）+ 首頁/`install`「🤖 讓 AI 幫你安裝」複製區 + 支援工具列統一 7 項（+Antigravity/Gemini CLI）+ **AI 指令輪盤**（popup 底部，可編輯/顏色/一鍵複製，`bugezy:ai-prompts`）+ 進階設定 accordion + 即時監控**文字狀態條 + 上傳報告**（inject→content→background 打包 `/api/reports`）+ Token 金額標 `USD $` + **新版通知亮燈 + `/api/version` + `/changelog`** + popup 版號顯示 |
| 2026-07-03 | **Fable 5 安全稽核 + 認證信任鏈重構**（PM-128~135）。**登入信任鏈**：`POST /api/auth/session` 收 Google access token → server `verifyGoogleToken` 驗 `aud/azp === GOOGLE_CLIENT_ID`（防其他 App token 重放）→ 用 Google sub 當 user_id 發 DB session token（存 `sessions` 表，90 天）；刪假 base64 token + `getUserIdFromHeader` + `googleAuth`/`/api/auth/google` + 過渡 `GET /checkout`。**存取控制**：`GET /api/reports` 加認證 + `.eq(user_id)` 只回自己的；transcribe/summarize/correct 加 `getAuthUserId`（transcribe 另 `isActiveUser` 403 付費限定）。**打磨**：CORS 收緊（動態 origin 白名單，統一出口注入）、500 錯誤脫敏（`GENERIC_500`）、POST body 上限（全域 10MB / 報告 5MB / transcribe 25MB）、私有端點 `jsonNoStore`（防邊緣快取跨用戶外洩）。extension 全面改用 DB session token（`auth.ts getAuthHeaders`/`getAuthHeaderOnly`）。 |
| 2026-07-05 | **Bug 捕捉升級（6→10 分）+ MCP 時序/摘要**（PM-153~159）。**漏網錯誤全兜住**：`inject.ts` console.warn 稽核 + `unhandledrejection` + `window.onerror`（JS 錯誤）+ 資源載入失敗（capture phase）+ Web Vitals（LCP/CLS/FID，超標 warn/良好 info），統一走去重入口 `collectConsoleLog`（`ConsoleLog.level` 加 `info`、`source` 標來源）。**兩維環境快照**：`net.ts` 網路快照（online/effectiveType/rtt/downlink，錄製 atStart+atEnd）+ `storage.ts` 儲存快照（localStorage/sessionStorage/cookieNames，**PII 本機 `maskPII` 遮罩**——敏感 key/JWT/email/卡號/>500 字元，server 零外洩）；server 存 `network_snapshot`/`storage_snapshot` JSONB（graceful fallback）、報告頁「📡 網路環境」/「💾 儲存狀態」區塊。**MCP 12→13 tool**：`get_timeline`（console/network/語音/標記按相對時間 `[0.0s]` 排序成一條故事線 + 網路/儲存摘要）+ `generateBugSummary()` 規則引擎（rejection/CORS/network fail 依碼建議/resource/離線/token 丟失/Web Vitals → AI Bug 導航摘要，貼 get_timeline 及 get_report_overview 最前面，**零 API 成本**）。全程線上 `/mcp` JSON-RPC 實測 round-trip。 |
| 2026-07-05 | **Fable5 第三輪安全全清 + 報告頁 i18n + CLI PII + 域名遷移**（PM-160~169）。**Stored XSS 三層**（#7）：報告頁截圖 src `esc()` + client `esc()` 硬化轉引號 + `createReport` 驗證 dataUrl 格式 + **全站 CSP**（`html()` 注入，`form-action` 放行 ECPay）。**存取模型釐清**（#1）：FAQ/隱私中英改「持有連結即可查看」對齊分享設計 + `getReport` 改 `jsonNoStore`。**MCP 授權**（#2）：`get_live_errors`/`get_terminal_logs` 加 `session_token` 驗證 + terminal 補付費檢查；三個 email-based tool（含 `list_reports`）`session_token` 由選填改**必填**。**上傳額度縱深**：`createReport` 以認證身分擋免費用戶超額 rrweb 上傳。**ECPay 原子性**（#5）：三 callback 改「先寫 payments 成功才升級 users，失敗回 500 讓綠界重送」（`recordPayment` 回 boolean）。**PII 擴充**（#8）：`storage.ts` 加 jwt/bearer/refresh/access + 台灣手機/身分證/Amex/OpenAI/Google key。**CLI stderr 遮罩**（PM-167）：`cli/pii-mask.ts` `maskStderr()`（DB URI 保 scheme+host 遮密碼 / env 保 KEY 遮值 / token 整遮）+ server 端 `POST /api/terminal-logs` 入庫前雙重遮罩。**CSP 硬化 + session rotation**（PM-166）：報告頁 client 邏輯抽 `/report-page.js` 外部檔、報告頁 CSP `script-src 'self'`（拿掉 unsafe-inline，行銷頁保留）；`rotateSession` helper，取消訂閱後 rotate token 回 `new_session_token`（extension `applyRotatedToken` 存新 token）。**報告頁 i18n**（PM-168）：`reportPageHtml(lang)` + `data-bugezy-lang` 傳給 report-page.js 的 `t(zh,en)`，UI 標籤中英切換、內容不翻——**全站 8 頁 i18n 完成**。**域名**（PM-169）：extension `API_BASE` → `bugezy.dev`。 |
| 2026-07-07 | **Chrome Web Store 1.1.0 過審 → 1.1.1 打包送審 + manifest key 統一 ID + 資安/商業/麥克風修復**（PM-187~200）。**收工新增**（PM-197~200 + 版號）：popup「📋 複製 MCP 設定」下方加使用時機備註灰字（`mcp-config-hint` i18n，PM-197）；Whisper 錄音正常卻 voice_count=0 → 全鏈路（offscreen→background→server）埋 `console.*` 診斷 log + 收斂靜默失敗（`STOP_RECORDING` 不再丟棄轉錄結果、`res.text()` 先讀再 parse 防非 JSON 被吞、存檔收緊為 `ok && text.trim()`，PM-198）；extension 編輯報告頁分享連結加「📋」複製鈕（hidden input + `select`+`execCommand`，非 clipboard API，PM-199）；全站商店連結對接正式詳情頁——/install「前往 Chrome Web Store →」由通用首頁 `chromewebstore.google.com/` 改 `.../detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj`（永久不變，PM-200，`wrangler deploy 0be0cd64`）；版號 `1.1.0`→`1.1.1`（`manifest.json` + `/api/version` latest，`wrangler deploy 9de89e2f`，`bugezy-1.1.1.zip` 已打包待重上架）。**Session token 移出 URL**（PM-187，P0）：`/reports` token 由 `?token=` 改 URL fragment（`#token=`，不送 server/不入 Referrer）→ client `resolveSessionToken()` 存 `localStorage['bugezy_session_token']` + `history.replaceState` 清 URL → 新增 `GET /api/my-reports`（Bearer，`jsonNoStore`）client 端 `textContent` 建表。**報告分享付費牆**（PM-188，P0 資安＋商業）：`getReport(reportId, request, env)` 加認證——owner 看自己不論付費、非 owner 訪客→403 `login_required`、已登入非付費→403 `upgrade_required`（複用 `isActiveUserId`，403 走 `jsonNoStore`）；`report-page.js` `resolveSessionToken` 帶 Bearer + 403 付費牆（免費安裝/了解方案兩 CTA）。**JSON 匯出付費**（PM-189，P1，extension）：`copyBtn`/`exportBtn` 加 `isPaidMember` 檢查——免費 → `showJsonPaidOverlay`（🔒 會員鎖頭），付費 → `confirmJsonDisclaimer`（敏感資料免責警語，每次都彈）。**MCP URL token 方案 B**（PM-190，P1）：`/mcp` 從 `?token=` 讀入 per-request env 副本 `__mcp_session_token`（避免共用 env 併發競態）→ `list_reports`/`get_live_errors`/`get_terminal_logs` 改 `token = env.__mcp_session_token || args.session_token`（URL 優先，`session_token` 改 optional）；`/install` MCP 設定 `.mcp-cfg` + 登入自動補 `?token=`；popup「📋 複製 MCP 設定」一鍵複製含 token（PM-191）。**Whisper 麥克風**（PM-192/193，extension）：offscreen `AudioContext` 無 gesture 預設 suspended → 音量條全 0，`startVolumeMeter` 加 `await resume()`；`startRecording` 回報真實 `{ok,error}`（不再吞掉 getUserMedia 失敗）；「允許這次使用」→ offscreen 拿不到權限 → background `micFallback` → content 無縫改即時字幕（頁面 SpeechRecognition）+ 頁面橘色提示 + popup「精準轉錄需選永久允許」小字。**維運**：Chrome Web Store 1.1.0 過審，manifest 加 `key` 綁定固定 ID `hfnkjlbbpehkflgfbjenfmnmjkdjadcj`（全站商店連結同步）；`/install` 一鍵複製改 `data-copy-text`（encodeURIComponent 存按鈕 attribute、`decodeURIComponent` 讀，解耦 DOM）+ 修 template literal 內 token-fill regex 反斜線被吞的隱藏 bug（`\.`→`\\.`）；舊 `bugezy-api.workers.dev` → `bugezy.dev` 301 redirect（MCP/API 除外）。extension（PM-187/189/191/192/193 + manifest key）整套待重上架；server 部分改動待 deploy。 |
| 2026-07-08 | **AI 客服手冊 + 首頁 AI Skill 專區 + CWS 1.1.2（截圖流程統一）**（PM-201~210）。**SKILL.md**（PM-201）：給 AI 讀的使用手冊，根目錄 `SKILL.md` + server 內嵌 `SKILL_MD` 常數 → `GET /skill`（`renderMarkdown` 極簡 md→html 排版 + 一鍵複製 + Claude Desktop 安裝教學）+ `GET /skill/download`（`Content-Disposition: attachment`）+ 全站 footer + sitemap（`a4879590`）。**首頁**（PM-202）：`#skill` AI Skill 專區（下載/了解更多 CTA）+ Hero 四大特色並列（六模式 × 13 MCP × 語音 × AI Skill）+ 捕捉能力 Skill 提示（`b76c3bf1`）。**版號 1.1.2**（PM-203）：manifest name/description 改寫（description 精簡至 114 字符 CWS 132 上限內）+ `/api/version`（`9fe349df`）。**截圖流程統一到編輯報告頁**（PM-204）：annotate「完成儲存」→「下一步」，改存 `STORAGE_KEY` 導到 `edit-report.html`（`isScreenshot` → 截圖預覽取代 rrweb 播放器，語音/描述/Token/AI 校正/上傳皆複用）；截圖 Whisper 綠色音量條（PM-205，AnalyserNode+rAF，公式同 inject）；截圖語音併入補充說明、編輯頁「語音記錄」標示「📸 截圖模式：語音已在補充說明」中英（PM-208，取代 PM-206/207/207b 的語音拆分嘗試）；上傳成功按鈕卡「上傳中」修復（PM-209，成功 UI 抽 `showUploadSuccess` + `await` 包 try/catch + `resp?.ok` 防呆）；截圖麥克風提示與錄製一致（PM-210，`micPromptFor: 'record'|'screenshot'` 分派 + annotate 語音自動啟動改讀 `MIC_KEY`）。`RecordingPayload` 加選填 `screenshots?`/`description?`/`allow_screenshot_images?`。extension（PM-203~210）待重上架（`bugezy-1.1.2.zip` 已打包）。 |
| 2026-07-09 | **SEO 深度優化 + 國際化 5 修 + Fable5 第四輪安全 6 修 + v1.1.3**（PM-211~220）。**SEO**（PM-211~213）：全站 10 頁 `ogMeta()` 注入 Open Graph + Twitter Card + `GET /icon-128.png`（內嵌 base64，og:image 用）；首頁 JSON-LD SoftwareApplication（三 Offer）+ Organization；FAQPage JSON-LD 由 /skill 移到 **/faq**（`faqPage` 依 lang 動態產生 14 題，與可見手風琴逐字一致，符合 Google「markup 須可見」）。`jsonLd()` helper（`<`→`<`）。**國際化**（PM-214~218）：`/api/transcribe` 對 zh/yue 加 `prompt` 引導繁體輸出（Groq language 不控簡繁）；edit-report SR lang 跟隨 popup（`speechToSrLang`：zh-TW/yue-Hant-HK/en-US）+ 全頁 UI i18n（`er-*`）；inject `setVoiceStatus` + mic-permission 頁 i18n（`it()`/`mperm-*`）；`/api/correct`+`/api/summarize` 依 `language` 切英文 prompt（extension 帶 `reportLang`）；`SPEECH_LANG_MAP.yue` `zh-HK`→`yue-Hant-HK`。**安全 Fable5 第四輪**（PM-219）：createReport user_id 強制以認證身分覆蓋（防冒名）；ECPay 三 callback 孤兒自癒（`updateUserPlan` 檢查 error→500 + 冪等重放，`isActiveUserId` 守門）；MCP 三工具改 `verifySessionByToken`（含到期）；`/api/usage/monthly` 加認證；report-page.js `screen_size` 補 `esc`；CSP `frame-ancestors 'none'`。**v1.1.3**（PM-220）：manifest + `/api/version` → 1.1.3，`bugezy-1.1.3.zip`（33 檔）待重上架。server deploy `45803196`→`108b6481`→`d190af1f`→`2f2cb33f`→`41bbb963`→`bc1c9165`→`4756a5a2`。 |
| 2026-07-10 | **官網小白友善重構 + /features 專業版完整頁 + README/SKILL 產品級改寫**（PM-222~227）。純內容/文檔層（extension 未動，仍 v1.1.3）。**首頁**（PM-222）：`homePage()` 重寫為 7 區塊漸進式揭露（Hero 講人話直連 CWS → 三步驟 → 4 組截圖交替展示 → 6 賣點 → 語言 badge → CTA → footer），技術細節（六模式/MCP/rrweb/框架）全移往 /features；6 張截圖存 **R2** + 新增 `GET /screenshots/:name.png`（白名單防穿越 → `env.R2.get` → image/png，不內嵌 base64 避免 bundle 爆量）。**/features**（PM-223）：重寫為 9 區塊完整技術規格頁（頁首/六模式/捕捉 10-10/**MCP 13 Tools 表**/語音引擎/CLI/安全隱私/定價/CTA），供進階開發者與 AI 讀取；首頁 §4 加「查看完整功能 →」導流。**/changelog**（PM-224）：補 v1.1.3 entry（SEO/國際化 5 修/安全 6 修，中英雙語）。**README**（PM-225）：由中文開發筆記改寫為國際標準開源產品 README（英文，MCP 13 Tools 表 + config JSON + Pricing + Security），commit `dea35db`。**SKILL.md**（PM-226）：加版本資訊、新增「語音功能與語言」+「安全與隱私」兩區塊、**MCP 工具表修正**（移除不存在的 `get_metadata`、補真實 `get_page_info`、`get_usage_stats` 註明需登入，以 `grep server.tool` 核對）；server 端 `SKILL_MD` 常數改用 **Python 腳本從 SKILL.md 重新生成**（自動 escape 反引號/`${`），`/skill` 與 `/skill/download` 單一來源一致。server deploy `2bcb0639`→`885938c3`→`790dc8d9`→`42b7a89a`。 |
| 2026-07-12 | **Official MCP Registry 發布 + 目錄收錄 + 行銷上線**（PM-228~229）。純發布/行銷層（產品程式未動）。**MCP Registry**（PM-228）：BugEzy 正式登錄官方 MCP Registry（PulseMCP 等目錄上游源）——`dev.bugezy/bugezy` v1.1.3、remote streamable-http `https://bugezy.dev/mcp`、status active。`server/server.json`（`$schema`+name+remotes+repository+websiteUrl）；驗證途徑 GitHub OIDC 因 PAT 無 `workflow` scope 被擋 → 改 **HTTP 域名驗證**（Ed25519 金鑰 + Worker `GET /.well-known/mcp-registry-auth` serve 公鑰 → `mcp-publisher login http` + `publish`），私鑰/binary/token 用完即刪不進 repo。server deploy `cb2a8400`（.well-known 公鑰路由）。**目錄+行銷（FOX）**：Glama MCP 目錄（7 分鐘過審）、awesome-mcp-servers PR #9919、FB 粉專 + 首則付費廣告（8 天 $42 USD）。 |
| 2026-07-15 | **四語擴展達成七語全覆蓋**（PM-232~236）：簡體 zh-CN + 日 ja + 韓 ko + 越 vi。**zh-CN**（PM-232）：不手寫字串，用執行期繁→簡轉換器 `toSimplified()`（`extension/src/t2s.ts`：opencc 414 字對照表 + 6 條大陸用語詞彙，Extension/Server 共用）；`t()` 對 zh-CN 走 `toSimplified(entry.zh)`；Server 新增 `makeT(lang)` 工廠取代全站 13 處 `t()` + `htmlLang()`（`<html lang>` 依語言）+ Whisper 簡體 prompt+輸出再轉簡 + AI 校正/精簡簡體 prompt。**ja/ko/vi**（PM-233~235）：手譯（日敬體 です/ます、韓 합니다체、越南語聲調 UTF-8；技術術語保留英文）——Extension i18n dict 每語補 ~140 條 key（`t()` 分支 + `DEFAULT_PROMPTS` + popup 解鎖選項 + `speechToSrLang`）；Server 官網用「繁體原文→X 文」查表 `JA_MAP`/`KO_MAP`/`VI_MAP`（各 136 條，`makeT` 以既有 `t()` 第一參數查表、缺則 fallback 英文，**零改動頁面主體**，涵蓋首頁 + 完整功能頁）+ `detectLang` `\bja\b`/`\bko\b`/`\bvi\b` 優先判定（不誤傷中文）+ `htmlLang` + Whisper `ALLOWED_LANGS` 各語解鎖+引導 prompt + AI 校正/精簡各語 prompt。**七語全覆蓋**：繁中/粵/英/簡中/日/韓/越。extension 四次 build 待重上架（仍 v1.1.3）；server deploy `02720582`→`ce1fe70c`→`9728f239`→`7fb7078a`。 |
| 2026-07-17 | **即時字幕（Web Speech）五項體驗優化與 bug 修復**（PM-237~242）。純 extension（只改 `extension/src/inject.ts`）；FOX 多語實測回報。**PM-237**：①`interimResults=true` + `onresult` interim 分支——說話時底部字幕即時顯示辨識中文字（不推 segments/面板），無 final 時才更新（不蓋 `✅`）。②右上語音面板可拖曳（module 級 `voicePanelPos` 位置記憶、header 當 drag handle `cursor:grab`、面板/header `pointer-events` none→auto 而內容區顯式保留 none、`mousemove/mouseup` 只拖曳期間掛 window、`Math.min/max` 夾視窗內）。**PM-238**：修 🔄 重啟 race condition——`forceRestartVoice` Step 1 先 `voiceActive=false`（讓舊實例 onend `!voiceActive` return 不復活），失敗路徑/Step 4 再恢復，破除兩實例搶麥克風的無限「Restarting…」。**PM-239**：右上面板第一段被 `VOICE_HISTORY` 覆寫——`textContent=` 改「合併」（面板有文字則歷史放前保留既有）。**PM-240**：韓語效能崩潰——①interim `setCaptionText` 節流 150ms（組合型文字每秒數十次 onresult 淹沒 DOM；final 不受限）②`onstart` 不再無條件歸零 `autoRestartFails`、改 `onend` 判 session>1s 才歸零，短命 session 累積到 3 次停手，破除瞬間 onstart→onend 無限循環。**PM-241**：越南語 interim 不 finalize——「stale interim 自動升級」（3 秒穩定未變即當 final 推送）+ 停錄/重啟/真 final 皆 `clearInterimPromote()`（真 final 清 timer 防 en/zh/ja 停頓重複）。extension 待重上架（仍 v1.1.3）。 |
| 2026-07-18 | **七語語音三入口全面對齊**（PM-243~249）。純 extension。把語音修復套到三處各自獨立的 SpeechRecognition：即時字幕（`inject.ts`）、編輯報告補充說明（`edit-report.ts`）、截圖標注（`annotate.ts`）。**zh-CN 繁轉簡**（PM-243/244）：Chrome `lang='zh-CN'` 回傳仍繁體，`onresult` final/interim 過 `toSimplified()`（守門 `zh-CN`，其他語言零影響）。**粵語/越南語 stale interim 自動升級**（PM-245，搬 inject PM-241）：`yue-Hant-HK`/`vi` 很少送 isFinal，interim 穩定 3 秒即自動寫入文字框。**去重**（PM-246，edit-report + inject 同步）：升級後 Chrome 補發同段 isFinal → 重複，加 `promotedText`/`promotedTime` 5 秒窗去重；拆 `cancel*Timer`（保留 promoted）與 `clear*Promote`（完整清）破解規格衝突。**語言守門**（PM-247）：自動升級改只對 `Set(['yue-Hant-HK','vi'])`，否則英文停頓部分文字被去重誤殺完整句。**annotate 七修一次到位**（PM-248）：語言跟隨（原寫死 zh-TW→`SPEECH_LANG_MAP[LANG_KEY]`）+ zh-CN 繁簡 + interim 節流 150ms + onstart/onend 短命 session 防韓語循環（SRInst 補 `onstart`）+ 粵越升級 + 去重 + 字幕條 i18n（沿用既有七語 key）。三入口自此完全一致。extension 待重上架（仍 v1.1.3）。 |
| 2026-07-19 | **v1.1.4 打包上架 + 全站版本同步 + 截圖 Whisper i18n**（PM-250~255）。**PM-250**：截圖 Whisper 4 處提示（錄音/轉錄/付費/操作）補 i18n（`an-whisper-*` 五語 key，zh-CN toSimplified、yue 走 zh），補完 PM-248 遺漏。**PM-251**：`manifest` 1.1.3→**1.1.4** + 確認 FOX 新 Icon（綠蟲+麥克風+深紫）+ 產出 `bugezy-v1.1.4.zip`（33 entry，排除 build 遞迴帶入 dist 的 `icons/proposals/`+`icon-source.svg` 設計原稿）→ FOX 送審 Chrome Web Store。**PM-252**：`/api/version` latest→1.1.4（`b403ad56`，舊版 popup 更新提示）。**PM-253**：`/changelog` 新增 `v1.1.4 — 2026-07-19` 中英雙語區塊 + 首頁/features footer→v1.1.4（`8f8de54d`）。**PM-254**：SKILL_MD（/skill）版本→v1.1.4 + 修正過時支援語言（日韓越實際 Day 29 已開）改七語全支援 + 補 v1.1.4 語音體驗段落（`ce3d63bc`）；全站掃 1.1.3 只改當前版本指標、保留 `(v1.1.3 修)` 史實與歷史發版條目。三次 server deploy 把「extension 送審 / /api/version / 官網 changelog+footer / AI 客服手冊」四處版本全對齊 v1.1.4。 |
| 2026-07-20 | **SEO 部落格上線 + 官網七語全面化 + 子頁面多語化**（PM-256~262）。純 server（只改 `server/src/index.ts`）。**/blog**（PM-256/257）：新增 `BlogPost` 資料結構 + `BLOG_POSTS[]` + 列表頁/單篇頁（正文段落粗體、完整 SEO meta、**JSON-LD Article**、CTA、上下篇導航）+ 路由/404 + sitemap；填入 5 篇繁中 SEO 長文（Vibe Coding 除錯痛點、AI Debug 成本、截圖浪費額度、新手 Console、AI 要更多資訊）。**簡體字掃描**（PM-258）：用 opencc `t2s(C)===C && s2t(C)!==C` 精準判定簡體專用字（排除 T2S/JA/KO/VI 表），修 SKILL_MD 4 處誤植（`简体中文`/`音声記録`→繁體），保留簡繁共用字與刻意簡體 Whisper prompt；7 footer 加部落格連結。**七語全面化**（PM-259）：features/首頁語言徽章 7 語全亮（補簡中）+「三種語言」→「七種語言」+ 首頁六語 lang-switch（繁/简/EN/日/한/VI 當前高亮）+ sitemap 加首頁三語。**聯絡精簡**（PM-260）：首頁 contact-info 移除電話/服務時間只留 Email。**子頁多語**（PM-261）：install（59）+ faq（37）手譯 ja/ko/vi 各 95 條補入翻譯表（`makeT` 自動生效、faq JSON-LD 同步）+ helper `langSwitchBar` 套 features/install/faq + sitemap 加 9 URL。server deploy `34d014c9`→`56c614d4`→`b5f1d00f`→`787cf4b4`→`a822c63b`→`9c49814b`。 |
| 2026-07-28 | **多語 SEO 收尾**（PM-263~264）。純 server。hreflang + `x-default` + self-canonical（`hreflangTags()`/`canonicalTag()` + `LANGS_6`/`LANGS_3`/`LANGS_ZH`/`HREFLANG_CODE`）讓 Google 正確辨識同頁不同語版本；`sitemapXml()` 改由 `SitemapPage{path,langs,freq,pri}` 驅動並列出所有語言版本 + `xhtml:link` 互指，**複用同一組 `LANGS_*` 常數**確保 sitemap 與頁面 canonical 永遠一致。 |
| 2026-08-08 | **活動代碼 + 票券錢包系統 + FOX 即時推播**（PM-265~270）。**票券**（PM-265~267）：`promo_codes` + `user_tickets` 兩表（RLS deny-all、`UNIQUE(user_id, code)`、索引，預塞 `FIRSTMONTH`/`BUZZ100`；卡片 SQL 的 `users(id)`/`UUID` 兩處錯誤已修為 `users(user_id)`/`TEXT`）；API `redeem`（CAS 控 `max_uses` 併發超發）/`activate`（到期日**疊加** MAX(現有, NOW())+days）/`wallet`；`isActiveUserId` 併入票券，**另拆 `isEcpayActiveUserId` 給 ECPay callback 守門防「收錢不開通」**；popup 票券錢包 UI（兌換/先存著/立即啟用/庫存列表/≤10 天到期提醒、19 key × 5 語）+ 補通後端三處只認 ECPay 的付費守門。**推播**（PM-268~270）：7 觸發點（新用戶/新報告/兌換/啟用/月費/日票/續扣）+ `ctx.waitUntil` 非阻塞 + 延遲查 email；先接 ntfy 但**根因查出 ntfy.sh 按來源 IP 計配額、Workers 共用 IP 額度已滿 → 永遠 429（42908）**（PM-269，順手把靜默吞錯改成 `console.error`），改用 **Discord Webhook embed**（PM-270，移除 `encodeNtfyHeader`，7 觸發點未動）。server deploy `27f3a1c8`→`7a998663`→`62459098`→`eb09b632`→`e0b74201`。待 FOX：Supabase 建表 + `DISCORD_WEBHOOK_URL` + extension 重上架。 |
| 2026-08-09 | **票券體驗打磨 + 安裝碼 + 官網指南大整併 → v1.1.5**（PM-272~282）。**官網**：新增 `/testimonials` 用戶心得（YouTube 嵌入，補 CSP `frame-src`）；`/guide` 加 9 顆一鍵複製（`data-copy-text` + 事件委派 + execCommand fallback）+ ⚡ 快速開始 + 🆘 AI 求助提示詞；**`/install` 併入 `/guide` 並 301**（移除 `installPage` 324 行，搬移 PM-190/191 token 自動補齊，sitemap 移除 /install）。**票券 UI**：折疊收合（localStorage）、啟用二次確認（兩條路徑收斂到單一 API 呼叫點）、付費會員改「✨ 已是會員」（另開 `isEcpayPaid`，不可用含票券的 `plan.isPaid`）、到期文案移除暗示自動扣款的字眼。**安裝碼**：`users.install_code`（`BZ-XXXX`，字母表排除易混淆字元、條件式 update 防併發、失敗不影響登入）+ 用戶查詢/admin 反查（未設 `ADMIN_TOKEN` 一律 404）+ Discord 通知帶碼。**修復**：popup 初次載入 free UI 未渲染——`loadPlan` 併發去重、安裝碼併進 `/api/user/plan`（`/api/user/*` 3 支→1 支）、失敗不再靜默且重試一次、失敗時渲染安全預設。**發版**：`manifest` 1.1.5 + `bugezy-v1.1.5.zip`（33 entries）+ `/api/version`/footer/changelog/SKILL 全站版號同步。server deploy `fa5ca8c5`→`d1e1f383`→`5d3991c5`→`3945fad8`。 |
| 2026-08-10 | **商店包瘦身 + 票券到期自動提醒**（PM-283~285）。**PM-283**：`build.mjs` 改 `sourcemap: watch`，正式打包不再產 `.map`（上架等於公開原始 TypeScript，v1.1.0 起每版皆然）；重新打包 v1.1.5 **33 entries/1148.8 KB → 22/407.8 KB（−64%）**，並驗證無殘留註解、無內嵌 map、包完整性無損。**PM-284**：`notifyExpiringTickets()` 每日 cron 掃 ACTIVE 且 10 天內到期的票券推 Discord（email + 剩餘天數 + 庫存票數）後標記 `expiry_notified`；`ticket-expiry-notify.sql`（ALTER + partial index）。修掉三個坑——未設 webhook 就整段跳過（否則提醒被無聲消耗）、cron 用 `await sendDiscord` 而非 `notifyFox`（`__ctx` 只在 fetch 設定）、消掉每張票各查 email/庫存的 N+1。server deploy `5ff89d71`。 |
| 2026-08-12 | **Chrome Web Store 審核修正**（PM-286~287）。v1.1.5 首次送審被以「要求但未使用 `scripting` 權限」退件 → `manifest.permissions` 6 項減為 5 項。查證後確認 `chrome.scripting` 與 `executeScript`/`insertCSS`/`registerContentScripts` 在 src/dist/cli/mcp-server 皆 **0 次命中**（content script 是宣告式注入，本就不需該權限）；另逐一驗過其餘 5 項權限確有使用，避免下一輪被別的權限退件。重新打包 `bugezy-v1.1.5.zip`（22 entries / 407.8 KB，與前一版逐檔零差異）。版號不動、server 未改動。 |
| 2026-08-13 | **SEO 審計 + P0 修復**（PM-288~290）。依 `claude-seo` v2.2.4 的檢查清單實跑三份掃描（安裝腳本被權限擋下，已完成安全性檢視）：完整審計 **B 級**、Schema **A− 級**、hreflang **C 級**。修掉兩個 Critical——① `http://` 未導向 HTTPS（FOX 於 Cloudflare 開 Always Use HTTPS，實測 301 生效）；② **canonical 吃偵測語言**導致裸網址 canonical 到 `?lang=xx`、與 sitemap/x-default 矛盾使 x-default 失效，且 canonical 隨 `Accept-Language` 變動 → 新增 `explicitLang()`（只讀 query），`canonicalTag` 改為回顯請求的 `?lang=`，不支援的語言併回裸網址；補 `Vary: Accept-Language, Origin`（須在 CORS 注入之後）。實測 10 頁 x-default 與 canonical 完全一致、return tag 仍雙向互指。server deploy `55f9208f`。 |
| 2026-08-14 | **Chrome Web Store 隱私合規 + 報告保留期限落地**（PM-291~293）。**PM-291**：`/privacy` 改寫為 §1~§11（權限對照表／6 家第三方附連結／Limited Use 中英／兒童隱私）；動筆前核對原始碼，修正卡片 3 處事實錯誤——manifest 無 `host_permissions`（真正該說明的是 `<all_urls>`）、**語音轉文字是 Groq 而非 Workers AI**（舊版政策的「不傳給其他 AI 服務商」為不實敘述）、「保留 7/90 天」當時尚未實作；另補揭露 Discord 會送出使用者 email。繁簡整句比對 opencc 掃 119 句補 5 字（414→420，兩表同步）。**PM-292**：報告清理 cron（免費 7 天／付費含票券 90 天，連同 R2 附件），**預設 dry-run**、先 R2 後 DB、`user_id` 為 null 不刪、單次 500 筆上限、查詢數固定不隨筆數增長；`/privacy` §5 同步改回明確期限並揭露「依刪除當下方案判定」。server deploy `e1353035`→`c808becb`。 |
| 2026-07-06 | **免費版留存 + 全球化 + Python 9→10 + 我的報告 + 截圖 PII 防護 + 維運**（PM-170~186）。**用量留存**（PM-170）：`bumpUsage` 每月自動重置（≥30 天歸零 recording/rewind/mcp_count）+ `checkRewindUsage` 回溯檢查 + popup 三卡片「剩 N 次」（≤2 紅）+ 用完升級引導 overlay（日票/月費/每月重置）。**全球化付費**（PM-171~172）：付費資格改 **IP 國家偵測**（`request.cf.country`，`isPayCountry(['TW'])`），非台灣顯示「International Payments Coming Soon」；`getUserPlan` 回 `country`、`homePage(lang, request)` 定價依國家、`/checkout`+`day-pass/create` 加 `country!=='TW'` 403。**文案**（PM-173）：「MCP」→「MCP AI 讀取」白話並列（配額/用量文案，技術設定保留）。**問題回報**（PM-174）：`GET /feedback` 表單 + `POST /api/feedback`（不需登入、存 Supabase `feedback` 表 + country）。**我的報告**（PM-184）：`GET /reports?token=`（`verifySessionByToken` 驗證→server 渲染列表：時間/標題/描述/badges/查看，noindex+no-store）+ popup 「📋 我的報告」按鈕。**官方測試頁**（PM-180）：`testPage1(lang)` 涵蓋 Promise/資源/Web Vitals/網路/儲存/Python CLI 全捕捉能力（中英）。**Python 9→10**（PM-176~179）：`cli/parse-traceback.ts`（Python traceback / Node Error → `{type,message,frames[file,line,func,code]}`）+ `cli/detect-env.ts`（語言/版本/OS/套件快照）→ CLI 上傳 `parsed_errors`+`runtime`（先遮罩再解析）；server `formatTerminalLogs` 結構化回傳 + `generateTerminalSummary` 規則引擎（Python 16 種 + Node 5 種錯誤白話+修復+📍位置）貼 `get_terminal_logs` 最前面。**截圖 PII 防護**（PM-181/185/186）：截圖報告附帶 console/network（content `queryInjectLiveErrors`→SCREENSHOT_READY→background 快取→annotate `GET_COLLECTED_ERRORS`）；`detectSensitiveFields`/`getSensitiveRects`（content 掃 7~13 類敏感 input）→ 偵測警告 + `annotate` 手動 🔒 馬賽克筆刷 + **自動遮罩**（原頁 viewport 座標換算，整頁截圖才遮，可撤銷還原）。**維運**（PM-182/183）：cron 清理過期 sessions（`delete().lt(expires_at, now)`）+ `/mcp` body 1MB→413（補 CF rate-limit 只覆蓋 /api/）。**修**（PM-175）：輪盤語言切換改明確 flag（取代 JSON.stringify 誤判）。CLI（PM-176/177）待 `npm publish`；extension 整套待重上架。 |
| 2026-07-04 | **SEO + 全站國際化 + 安全 P1-P2 收尾**（PM-136~152）。**SEO**：`/sitemap.xml`+`/robots.txt`+ 各頁 meta/canonical + GSC 驗證標籤（已收錄）。**多語系語音**：popup 語言下拉（zh/yue/日韓英越，日韓越暫鎖待金流）→ server Whisper `language` 白名單、Web Speech `lang` 經 `data-bugezy-lang` 傳入 MAIN world inject。**擴充 i18n**：`i18n.ts`（`t()`/`getUILang`）+ popup/monitor/toolbar/annotate 全 `data-i18n`/`it()`/`t()`；AI 輪盤多語預設。**對外頁英文版**：`getLang()`（Accept-Language + `?lang=` 覆蓋）+ 七頁 `t(zh,en)` 函式（首頁/install/features/changelog/guide/faq/privacy）+ 語言切換鈕 + `no-store`。**安全**：MCP `list_reports`/`get_live_errors`/`get_terminal_logs` 綁 email/session、live-errors/terminal-logs 改 per-user R2 key + 認證（terminal-logs 付費限定）、登出撤銷 server session（`/api/auth/logout`）、PATCH settings owner 驗證、**ECPay callback 冪等 + `payments` 表 + 金額比對**（續扣用 `MerchantTradeNo-Gwsr`）、`formatEcpayDate` 改 UTC+8、清 `debug/` 敏感檔。**其他**：截圖標注付費版走 Whisper、manifest 1.1.0 + 描述英文化、CLI `bugezy-watch` 加 `BUGEZY_TOKEN`。 |

> 部署：Cloudflare Workers `bugezy-api`（**bugezy.dev** + `bugezy-api.bugezy-api.workers.dev` 雙域名）；每日 03:00 UTC cron 保活 Supabase。
> （隨開發持續更新）
