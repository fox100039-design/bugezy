# BugEzy Changelog

## 2026-07-05

Day 20（PM-153~168）。Bug 捕捉升級（漏網錯誤 + 效能兜底 + 網路環境 + 儲存狀態）+ MCP 時序麵包屑 + AI 導航摘要 + Stored XSS 縱深防禦 + 存取模型文案釐清 + MCP live/terminal 授權補強 + ECPay 原子性 + PII 規則擴充 + 首頁行銷更新 + MCP 必填 session + 上傳額度縱深。

- PM-169：**extension API_BASE 改用正式域名 `bugezy.dev`**（`extension/types.ts`）— 由 `bugezy-api.bugezy-api.workers.dev` 改為 `https://bugezy.dev`（同一 Worker 雙域名）。全 extension 僅此一處寫死（已搜尋確認，manifest 無 host_permissions 依賴、走 server 動態 CORS）。`npm run build` ✅（dist 6 檔改用新域名、0 殘留舊 URL）。未 deploy（純 extension，待重上架）。

- PM-168：**報告頁英文版（/report/:id 多語系）**（`server/index.ts`）— 全站最後一頁 i18n。因 PM-166 把報告頁 client 邏輯抽成外部 `report-page.js`（CSP `script-src 'self'` 不能 inline 傳語言），改用 server `getLang()` 注入 `<html data-bugezy-lang>` → `report-page.js` 讀屬性決定語言。①`REPORT_PAGE_HTML` 改函式 `reportPageHtml(lang)` + no-store 防跨語言快取；②`report-page.js` 加 `t(zh,en)`（讀 data-bugezy-lang），翻譯所有 UI 標籤（網路環境/儲存狀態/摘要/Token 估算/toggle 提示/空狀態/找不到報告/點擊放大）；③topbar 語言切換鈕 EN/中文；④**報告內容（title/description/console/network/voice）不翻**（使用者原始資料）；修正 Token 迴圈變數 `t` 遮蔽 `t()` 函式→改 `tk`；script src 加 `?v=168` 防新 HTML 配舊快取 JS。線上實測 ✅（EN/ZH 雙語 HTML + report-page.js 翻譯 + no-store + node --check）。`wrangler deploy`（`d42e451c`）。全站 8 頁 i18n 完成。

- PM-167：**CLI Terminal PII 遮罩（後端 stderr 敏感資料過濾，雙重防護）**（`cli/src/pii-mask.ts`(新) + `cli/src/index.ts` + `server/index.ts`）。後端 traceback 常夾帶 DB 密碼/雲端金鑰/API token，CLI 端原本明文上傳。①新 `maskStderr()`：DB 連線字串保 scheme+host 遮密碼、20 個敏感 env 保 KEY 遮值、token 格式（sk-/AIza/ghp_/AKIA/xox*/JWT）整遮、一般 PII（email/卡號/台灣手機身分證）局部遮；②CLI 捕捉後上傳前遮罩（終端機仍原樣透傳，只遮上傳副本）；③server `POST /api/terminal-logs` 入庫前同規則再遮一次（防舊版 CLI 明文）。node 實測 10 案全過（含正常 traceback 不誤遮）。`wrangler deploy`（`5757ada8`）+ CLI build。

- PM-166：**報告頁 CSP script-src 'self'（移除 unsafe-inline）+ session rotation**（`server/index.ts` + `extension/auth.ts` + `popup.ts`）。①報告頁兩段 inline `<script>`（render + lightbox）抽成 `/report-page.js` 外部端點，inline `onclick` 改事件委派/addEventListener；②報告頁改嚴格 CSP `script-src 'self'`（`html(body, strictScript)`；**行銷頁沿用 unsafe-inline**——各有 inline script 且無使用者資料注入點，只對渲染 user data 的報告頁套嚴格版）；③新增 `rotateSession`/`extractBearer` helper；④取消訂閱後 rotate token 回 `new_session_token`（**付款 callback 為 server-to-server 無 token/無回傳通道，無法 rotate，如實說明**）；⑤extension `applyRotatedToken` 收到就存入 storage。線上實測 ✅（report-page.js node --check 過、報告頁 script-src 'self' 且 inline onclick=0、行銷頁保留 unsafe-inline）。`wrangler deploy`（`da0588c2`）+ extension build。

- PM-165：**MCP session_token 改必填 + createReport server 端用量檢查**（`server/index.ts`）。①`list_reports`/`get_live_errors`/`get_terminal_logs` 的 `session_token` 由 optional 改 **required**（schema 拿掉 `.optional()`，不帶就 MCP 協議層擋下不回資料）——杜絕「知 email 即讀」殘留；②createReport 以認證身分（非 client 傳的 user_id）查 users，免費用戶上傳含 rrweb 報告且本月錄製+回溯額度皆用盡 → 403（server 端縱深）。**修正規格**：欄位 `recording_count`（非 record_count）；因回溯報告也有 rrweb 且 payload 無型別旗標，改以「錄製10+回溯5 皆用盡」為界避免誤擋合法回溯；跨月唯讀重置。線上實測 ✅（三 tool required、匿名上傳無回歸）。**限制**：count-based 檢查對「完全跳過 bumpUsage」無效（計數停 0），徹底堵需 createReport 改為權威計數點（列後續）。`wrangler deploy`（`570d70ab`）。

- PM-164：**首頁/features/install 行銷更新——展示新捕捉能力 + 後端開發者支援**（`server/index.ts`，全中英雙語）。①首頁新增「🔍 BugEzy 能捕捉什麼？」區塊（前端 11 項 + 後端 3 項 + AI 分析 3 項）；②框架區補 Nest.js/Go/Rust；③Hero 副標改「捕捉 95% 以上的 Web Bug — JS 錯誤/Promise 靜默/CORS/效能/網路/儲存狀態，AI 一鍵分析」；④/features 加「全方位 Bug 捕捉」卡（漏網錯誤/Web Vitals/環境快照/AI 導航）；⑤/install 加「🐍 後端開發者？試試 Terminal CLI」（Python/Node.js/Go `bugezy-watch` 範例）；⑥全站現況 MCP 數量一致 13（v1.0.0 歷史 changelog 條目保留 12）。`wrangler deploy`（`d4d4272f`），線上中英雙語實測全區塊 ✅。

- PM-163：**Fable5-#5+#8 ECPay 原子性 + PII 遮罩擴充**（`server/index.ts` + `extension/storage.ts`）。**#5 原子性**：三個 ECPay callback（月費/日票/定期定額）原「先 `update users` 再 `recordPayment`」→ payments 寫入失敗時 users 已升級卻無冪等記錄，重送時重複展延。改 `recordPayment` 回 `boolean`，callback **先寫 payments（status paid）成功才升級 users，失敗回 `0|ErrorMessage=Payment record failed`(HTTP 500) 讓綠界重送**（前置：payments 表須存在，研判 schema.sql 已套用）。**#8 PII**：`SENSITIVE_KEYS` 加 `jwt/bearer/refresh/access`；`SENSITIVE_VALUES` 加 Amex 15 位/台灣手機/台灣身分證/OpenAI sk-/Google AIza key。`wrangler deploy`（`1acc4cec`）+ `npm run build` ✅（node 實測 maskPII 新規則全中；三 callback CheckMacValue guard 未動）。

- PM-162：**Fable5-#2 MCP live/terminal session 驗證 + 付費檢查**（`server/index.ts`）— `get_live_errors`/`get_terminal_logs` 原只憑 `user_email` 就能讀他人即時 console/終端機 stderr（可能含密鑰），且 terminal MCP 端漏付費檢查。①兩 tool 加 `session_token`（optional）驗證——有帶就查 `sessions` 表比對 user_id（比照 PM-142 `list_reports`），抽共用 `sessionMatchesUser` helper；②`get_terminal_logs` 補 `isActiveUserId` 付費檢查（與 HTTP 端 PM-144 同函式，非付費回「付費功能」）；③錯誤全通用訊息不洩 Supabase error。線上 `/mcp` 實測 ✅（錯 token→驗證失敗、付費 gate 放行付費用戶、tools/list 皆含 session_token）。`wrangler deploy`（`855487e0`）。

- PM-161：**Fable5-#1 報告存取模型文案修正**（`server/index.ts`）— `GET /api/reports/:id` 是「持有連結即可看」的分享設計，但 FAQ/隱私政策卻宣稱「報告私人、只有你自己能看」，**實作與承諾不符**。保留分享設計、修正對外文案：①FAQ「誰能看到」中英改為「隨機加密 UUID 無法猜測，只有擁有連結的人才能查看，勿貼公開場合」；②隱私政策「資料分享」中英改為「報告列表僅本人可見（需登入）；單份報告持有連結者即可存取，類似 Google Docs『知道連結即可檢視』」；③getReport 內容回傳改 `jsonNoStore`（防邊緣快取跨用戶外洩，Fable5 #3）；④PATCH `/settings` 路由註解由過時的「有 share link 就能改不需登入」改為「需登入+owner」（核對 `updateReportSettings` 確實 401+403，Fable5 #6）。線上實測 ✅（FAQ/隱私中英文案、getReport no-store）。`wrangler deploy`（`ff5c609e`）。

- PM-160：**Fable5-#7 Stored XSS 三層修復**（`server/index.ts`）— 報告頁截圖 `src` 原未轉義，攻擊者可經 `screenshots[].dataUrl` 注入 `x" onerror="alert(1)"` 在 bugezy.dev 執行 JS。①報告頁 render 截圖 `src` 加 `esc()`——**並硬化 client 端 `esc()` 加轉 `"`/`'`**（原只轉 `<>&`，對屬性引號突破無效，同時保護 href 等所有屬性插值）；②`createReport` 入庫前用 `VALID_SCREENSHOT_SRC` 驗證 dataUrl（只留 `data:image base64` / `https` URL，非法值丟棄）；③全站 HTML 單一出口 `html()` 注入 **CSP**（`default-src 'self'` + `img-src data: https:` + `script/style 'unsafe-inline'` + `base-uri`/`object-src 'none'`），**並加 `form-action` 放行 ECPay 付款域名**（否則 default-src 會擋掉 checkout 自動跳轉綠界）；④排查其餘 src/href 插值皆已 esc 或為靜態。線上實測 ✅（惡意 dataUrl 被拒只留合法 1 張、CSP header 三頁皆present、esc 硬化）。`wrangler deploy`（`6bfc1e48`）。

- PM-159：**MCP 報告摘要 — AI 導航提示（規則引擎，零成本）**（`server/index.ts`）— 在 `get_timeline` / `get_report_overview` 最前面自動附「🔍 AI Bug 導航摘要」，AI 直接看結論定位根因不用盲讀時間軸。①`generateBugSummary()` 分析 Promise Rejection / CORS / network fail（依 404·500·401/403 給建議）/ 資源載入失敗 / 純 JS 錯誤 / 離線·慢網 / token 丟失 / 語音描述 / Web Vitals，無線索則「未偵測到明顯異常」+ 統計；②不呼叫 Workers AI（純規則零 API 費）；③get_report_overview 改 `select('*')` 供分析但只回 metadata + `ai_bug_summary`（不含原始陣列，維持省 token）。**修正規格 bug**：原 `lines.length<=3` 判斷放在 stats 之後恆不成立→「未偵測到明顯異常」永不顯示，改到 stats 前判斷 `<=2`。線上 `/mcp` 實測 5 情境 round-trip ✅（rejection/500/CORS/離線+token/空報告 摘要皆正確）。`wrangler deploy`（`b38d6757`）。

- PM-158：**MCP 新增第 13 個 tool `get_timeline`（時序麵包屑）**（`server/index.ts`）— 把一份報告的 Console/Network/語音/標記 按時間排序 + 網路環境 + 儲存摘要合成**一條人類可讀故事線**，AI 呼叫一次即掌握完整 Bug 脈絡（省去逐一呼叫 5+ tool）。①事件用相對時間 `[0.0s][0.5s][1.5s]`（startTime=最早正時間戳）；②表頭含網路（在線/類型/RTT/頻寬）+ 儲存（項數/Cookie 數/敏感值已遮罩）；③`chromeMultiplier` 加 `get_timeline:25`；④/install 工具數 12→13 + 清單加 get_timeline（中英）。**修正規格 3 處**：標記實為 `time_sec`(相對秒)+`note`（非 timestamp/label）→換算絕對時間再排序；欄位 `browser`（非 user_agent）；token 用 `chromeMultiplier`（`TOOL_TOKEN_ESTIMATES` 不存在）。線上 `/mcp` JSON-RPC 實測 round-trip ✅（5 事件正確排序 + 標記精準落點 + Token 省 96%）。`wrangler deploy`（`0a6b9318`）。

- PM-157：**儲存空間快照 + PII 遮罩**（`extension/storage.ts`(新) + `inject.ts` + `types.ts` + `server/index.ts` + `schema.sql`）— 診斷「登入狀態突然消失／資料不見」（localStorage/sessionStorage/cookie 問題）。①共用 `getStorageSnapshot()` → localStorage/sessionStorage（`{key,size,value}[]`）+ cookie **只留名稱不留值**（try/catch 兜 SecurityError）；②`maskPII()` **三層本機遮罩**：敏感 key（password/token/secret/auth/card/cvv/ssn/session…）→整值 `***MASKED***`、>500 字元→截斷、值含 email/卡號/JWT→局部 `***`；③**遮罩全在 extension 端執行，server 只收遮罩後結果，敏感原值零外洩**；④錄製/回溯/監控三處 payload 帶 `storageSnapshot`；⑤server `createReport` 存 `storage_snapshot` JSONB（graceful fallback 不 500），`getReport` 回傳；⑥報告頁「💾 儲存狀態」區塊 `fmtItems` 列各項 + Cookies 名稱 + 遮罩提示。**判斷**：截圖標注頁（`chrome-extension://` 情境）讀不到被測站 storage，故不帶（免上傳誤導資料）。線上實測 round-trip ✅（`user_token:***MASKED***`、cookieNames 正確）。`wrangler deploy`（`cb910db5`）+ `npm run build` ✅。至此 PM-153~157 五卡完成：五類漏網錯誤 + 網路 + 儲存三維上下文。

- PM-156：**網路環境快照**（`extension/net.ts`(新) + `inject.ts` + `annotate.ts` + `types.ts` + `server/index.ts` + `schema.sql`）— 診斷小白最常見的「我這好好的、客戶那壞」（3G/高延遲/離線）。①抽共用 `getNetworkSnapshot()`（`navigator.onLine` + `navigator.connection`：online/effectiveType/rtt/downlink/saveData/type，不支援回 unknown/null）；②錄製 `startRecording` 抓 atStart、`stopRecording` 抓 atEnd → payload `networkSnapshot:{atStart,atEnd}` 一頭一尾留痕；③即時監控上傳 / 回溯 / 截圖標注各帶單次 `{atStart}`；④server `createReport` 存 `network_snapshot` JSONB（沿用 PM-82 graceful fallback，欄位不存在自動退回不 500），`getReport` 回 `networkSnapshot`；⑤報告頁「📡 網路環境」區塊 `fmtNet` 顯示 狀態🟢/🔴 + 類型 + 延遲 + 頻寬，atEnd 異動另列。線上實測 round-trip ✅（atStart 4g/wifi/online + atEnd offline/unknown 完整寫入取回）。`wrangler deploy`（`13aea42e`）+ `npm run build` ✅。至此 PM-153~156 四卡完成：五類漏網錯誤 + 網路環境上下文。

- PM-155：**資源載入失敗 + Web Vitals 效能捕捉**（`extension/inject.ts` + `types.ts`）— 補捉 #9 資源 404/CORS 破版（console 無明顯 error）+ #10 頁面太慢（LCP/CLS/FID 無數據）。①`addEventListener('error', ..., true)` capture phase 抓資源載入失敗（`instanceof HTMLElement` 排除 JS 錯誤）→ warn + `source:'resource-error'`；②`PerformanceObserver` 觀測 LCP/CLS/FID，LCP/CLS 於頁面隱藏或載入 5 秒定案回報一次（防 CLS 每次位移刷屏），FID 首次輸入即報；③超標→warn、良好→**info**（`ConsoleLog.level` 加 'info'）；④皆走 `collectConsoleLog`（PM-154 去重入口）；⑤error panel 加 🖼️ 資源 / ⚡ web-vitals 圖示（info 綠）；⑥`updateMonitorBadge` 排除 info（良好 vitals 不算錯誤）。tsc + build ✅。未 deploy。至此 console/JS/Promise/資源/效能五類漏網錯誤全兜住。

- PM-154：**unhandledrejection + window.onerror 全域錯誤兜底**（`extension/inject.ts` + `types.ts`）— 補捉小白最常漏的兩類：async 忘 catch 的 Promise 靜默失敗（#8）+ 框架 Error Boundary/errorHandler 吞掉的 JS 錯誤（#6）。①抽 `collectConsoleLog(entry)` 統一入口 + 去重（`level+訊息前100字` key，5 秒窗，`recentErrors` Set）；②`unhandledrejection` 監聽 → error + stack + `source:'unhandledrejection'`；③`window.addEventListener('error', ..., false)` 只抓 `target===window/document`（JS 錯誤）→ `source:'window.onerror'`（資源載入失敗留 PM-155）；④`ConsoleLog` 加 `source?`。兩監聽走同 collectConsoleLog → 自動享錄製/背景 buffer + 即時監控計數 + 去重。tsc + build ✅（dist 確認含 unhandledrejection/window.onerror/recentErrors）。未 deploy（純 extension）。

- PM-153：**console.warn 完整捕捉稽核**（無程式碼變更）— 核對 inject.ts console 攔截是否含 warn。結論：**四項需求早已實作**——`inject.ts:640` 已攔 `console.warn`（level:'warn' 進 bgConsoleLogs + 錄製 buffer）、監控 badge 算 `bgConsoleLogs`（含 warn）、error panel 顏色區分（error ❌ `#ef4444` / warn ⚠ `#f59e0b`，`inject.ts:262`）、server `console_logs` 原封存 + MCP `get_console_logs` 原封回（無 level 過濾）。`npm run build` ✅ 確認 dist 含 warn。⚠ 澄清：**瀏覽器引擎自印的 CORS/Mixed-Content 警告不經 JS console API，monkey-patch 抓不到**（需 DevTools Protocol，MV3 content script 做不到）；真正補捉 CORS 應在網路攔截層 catch rejected fetch（本卡 §5 network 不動，建議另開卡）。未 deploy。

## 2026-06-16

- 專案建立（`C:\dev\bugezy`）
- 目錄結構：extension / server / web / mcp-server / docs / job
- 工作流基礎：CLAUDE.md + claudePM.md + .mcp.json（獨立 memory）
- ARCHITECTURE.md 初版
- 產品規格書 v0.2（從 lottoshare_tools 搬入）
- PM-02：第 1 代 Chrome 擴充骨架（Manifest V3 + esbuild）
  - rrweb DOM 側錄 + Console（warn/error）+ Network（4xx/5xx）攔截
  - MAIN world 注入腳本攔截頁面 fetch/XHR/console，ISOLATED world 橋接 chrome API
  - background service worker 管理錄製狀態（持久化至 storage.local）
  - 極簡 popup UI：開始/停止錄製、計時、結果摘要、複製 JSON
  - `npm run build` → `extension/dist/`（載入解壓縮擴充功能測試）
- PM-03：UX 修正 — 錄製狀態可見 + 結果清楚呈現
  - icon Badge 顯示紅色「REC」，SW 重啟依持久化狀態還原 badge
  - popup 三態畫面：閒置 / 錄製中（計時器）/ 錄製完成（摘要 + 時長）
  - 完成畫面含 DOM/Console/Network 筆數、頁面 URL、錄製秒數
  - 新增「🗑️ 清除，重新錄製」按鈕（清 storage + badge → 回初始）
- PM-04：修 inject.ts 注入除錯 — rrweb/console/network 全空
  - inject/content 全程加 `[BugEzy]` 診斷 log（載入、握手、START/STOP、打包筆數）
  - inject 防重複注入（`window.__bugezyInjected`）
  - rrweb `record()` 與 fetch 攔截包 try/catch，啟動失敗不再靜默
  - 新增 READY/STARTED 握手（含 `rrwebOk`），content 可確認 inject 存活
- PM-05：popup 加「💾 匯出 JSON」按鈕
  - manifest 加 `downloads` 權限
  - 一鍵把 payload 寫到 `Downloads/bugezy-debug/payload-<ts>.json`（給 Claude Chat 用 dc-light 直接讀，免複製貼上爆對話長度）
  - 時間戳用 `YYYYMMDD-HHmmss`（避開 Windows 非法檔名 `:`）、`saveAs:false` 直接落檔
- PM-06：第 2 代 — 語音辨識（Web Speech API + offscreen document）
  - 新增 offscreen document（`offscreen.html`/`.ts`）跑 `webkitSpeechRecognition`（zh-TW、continuous）
  - background 管理 offscreen 生命週期、邊辨識邊把語音片段存進 `VOICE_KEY`
  - onend 自動 restart（撐過靜默）、onerror 不中斷錄製
  - payload 加 `voiceTranscript[]`（content 合併）、popup 摘要顯示「語音片段 N」
  - manifest 加 `offscreen` 權限
- PM-07：修語音收不到（PM-06 voiceTranscript 全空）
  - 根因：offscreen 是隱藏頁，Chrome 不為它彈麥克風授權 → `SpeechRecognition.start()` 靜默失敗
  - Fix 1：popup 開始錄製前先 `getUserMedia({audio:true})` 取權限（可見視窗才會彈授權），拿到即關閉 stream
  - Fix 2：offscreen 載入後送 `VOICE_READY`，background 等握手（3s 超時保險）才送 `VOICE_START`，解決競態
  - Fix 3：offscreen `onerror` 明確 blog `error+message`；`not-allowed`/`service-not-allowed` 不再自動 restart
- PM-08：語音改架構 — 砍 offscreen，SpeechRecognition 直接跑在 inject.ts（MAIN world）
  - 砍除 `offscreen.html`/`offscreen.ts`、manifest `offscreen` 權限、build offscreen entry
  - background/popup/content 移除全部 offscreen/VOICE_* 跨 context 邏輯（大幅簡化）
  - 語音收集移進 inject.ts，與 rrweb/console/network 同層；payload 直接帶 `voiceTranscript`
  - 麥克風授權改由網頁觸發（MAIN world 是頁面真實 window，API 保證可用）
  - 保留 `VoiceSegment` 型別、popup「語音片段」顯示不變
- PM-09：修語音 `not-allowed` — 注入頁面授權按鈕解 user gesture 問題
  - 根因：START 經 popup→background→content→inject 四層傳遞，user gesture context 已丟失，Chrome 拒絕啟麥克風
  - inject 收到 START 後先 `permissions.query`：已授權直接啟動；未授權注入頁面頂部浮層
  - 浮層「允許麥克風」按鈕的 click 才是有效 user gesture → `getUserMedia` 彈標準授權 → 啟動語音
  - 「跳過」按鈕可不錄語音、不阻擋 DOM/console/network；只動 `inject.ts`
- PM-10：第 3 代後端骨架（Cloudflare Workers + Supabase + R2）§6
  - 建 `server/`：package.json / tsconfig.json / wrangler.toml / schema.sql / src/index.ts
  - `POST /api/reports`：rrweb 存 R2、metadata + console/network/voice 存 Supabase，回 `{report_id, share_url}`
  - `GET /api/reports/:id`：合併 Supabase metadata + R2 rrweb 回完整報告
  - CORS 全開、無框架路由、`SUPABASE_ANON_KEY` 走 secret 不進碼
  - `npx tsc --noEmit` 通過（未執行 wrangler login/deploy/secret，由 FOX 手動）

## 2026-06-17

- PM-11：擴充上傳整合（錄完自動送 API）
  - 停止錄製後 background 自動 `POST /api/reports`（`API_BASE=http://127.0.0.1:8787`）
  - 上傳非同步、失敗不阻擋本機 payload；`RecordingSummary` 加 `uploadStatus`/`shareUrl`/`uploadError`
  - popup 顯示「⏳ 上傳中 → ✅ 已上傳 + 分享連結 + 📋 複製連結」/「❌ 上傳失敗（可手動匯出）」
  - 上傳中 popup 每秒輪詢 GET_STATE 更新狀態；manifest 不變（API CORS 全開，SW fetch 免 host 權限）
- PM-12：React 報告頁（`web/`）
  - Vite + React + TS 骨架，路由 `/report/:id`，`/api` proxy 到 localhost:8787
  - `RrwebPlayer`（rrweb-player + useRef/useEffect 掛載 DOM 回放）+ Console/Network/Voice 三面板
  - 深色主題（與 popup 統一）、載入中/找不到報告狀態
  - `npm run build`（tsc && vite build）通過
- PM-13：rrweb 回放改用 `@rrweb/replay`（去 Svelte 依賴）
  - `rrweb-player`（Svelte）在 React+Vite 靜默失敗 → 改用底層 `Replayer` class + 自製播放控制列
  - 播放/暫停 + 進度條 seek + 時間顯示，requestAnimationFrame 追蹤進度
  - 移除 `rrweb-player` 依賴；只動 `RrwebPlayer.tsx` + `index.css`
- PM-14：第 4 代 MCP Server（8 Tool Pull 模式）= MVP
  - §1 Workers 加 `GET /api/reports`（列最近報告，metadata only，`limit`/`url` 過濾）
  - `mcp-server/`：`@modelcontextprotocol/sdk` stdio server，8 個 tool（list/overview/console/network/voice/page/rrweb-summary/rrweb-events）
  - 每 tool 呼叫 Workers API 只回需要欄位（省 token）；`BUGEZY_API_URL` 環境變數
  - `npm run build` 通過；MCP handshake + tools/list 實測回傳 8 個 tool
- PM-15：Workers 加 `/mcp` 端點（Cloudflare Agents SDK）— 讓 Claude.ai 直接連
  - 用 `agents` 套件的 `createMcpHandler`（Streamable HTTP，無狀態，免 Durable Objects）
  - `/mcp` 路由掛 `McpServer`，註冊同 8 個 tool 但**直接讀 Supabase/R2**（不繞 HTTP）
  - tool 參數改用 zod shape（SDK 要求）；fetch handler 加 `ctx: ExecutionContext`
  - `npm install` + `npx tsc --noEmit` 通過（未部署，deploy 由 FOX）
- PM-16：截圖擷取（錄製中截圖 → 存報告 → 報告頁顯示）
  - extension：錄製中 popup「📸 截圖」→ background `captureVisibleTab` 存 `SCREENSHOTS_KEY`，上傳前併入 payload
  - server：截圖存 R2 `reports/<id>/screenshots.json`，Supabase 加 `screenshot_count`/`screenshots_r2_key`；GET 合併回傳；MCP overview 含截圖數
  - web：新增 `ScreenshotPanel`（縮圖列 + 點開大圖），插在 rrweb 回放與三欄之間
  - schema.sql 加截圖欄位（ALTER，FOX 手動跑）；extension build + server tsc + web build 三者通過
- PM-17：截圖標注（畫筆 + 箭頭 + 框框 + 文字）
  - 新增 `annotate.html`/`annotate.ts` 標注畫布：4 工具（freehand 畫筆 / 箭頭含三角頭 / 框框 / 文字 prompt）+ 顏色/粗細 + undo（history stack）+ 清除還原底圖
  - 截圖流程改為「📸 截圖 → 暫存 → 開新分頁標注 → ✅ 完成存回」；background 加 `SCREENSHOT_ANNOTATED`
  - build 加 annotate entry + 複製 annotate.html；只動 extension（server/web 已支援 screenshots）
- PM-18：分離錄製與截圖為兩個獨立功能（仿 Jam）
  - popup 閒置畫面改兩個並排入口：「🎬 錄製」「📸 截圖標注」，互不干擾
  - 截圖標注完成後**獨立上傳為一份報告**（annotate 直接 POST API + 帶頁面資訊），不再塞進錄製 payload
  - background 加 `SCREENSHOT_UPLOADED`（記最近一筆）；popup 閒置顯示「最近截圖」連結（5 分鐘內）
  - 錄製流程移除截圖：`RecordingPayload` 去 `screenshots`、`RecordingSummary` 去 `screenshotCount`，錄製中畫面移除截圖鈕；server/web 不改（向後相容）
- PM-19：截圖模式選擇器 + 區域截圖（兩點可捲動）+ 自由形狀
  - 「📸 截圖標注」→ background 通知 content 在頁面注入模式選擇列（整頁 / 區域 / 自由 / 取消）
  - content `injectScreenshotOverlay()` 拆三模式：整頁直接擷取；**區域兩點式**（點起點→自由捲動→點終點，跨 viewport 捲動逐段擷取 + dpr 拼接 + 裁切）；自由形狀（多邊形 clip，限可見範圍）
  - 擷取前移除 overlay DOM 避免入鏡；新增 `CAPTURE_SEGMENT`（background captureVisibleTab）+ `SCREENSHOT_READY`（開標注頁）訊息
  - 只動 types/background/content；inject/annotate/server/web/popup 不動
- PM-20：標注頁加文字說明欄 + 語音輸入
  - annotate 底部加「💬 問題描述」textarea + 🎤 語音輸入（Web Speech API zh-TW、interim 即時預覽、toggle、自動重啟）
  - 截圖獨立上傳 payload 加 `description`；server POST 存、GET 回；MCP overview/page_info select 加 `description`
  - schema.sql 加 `description TEXT`（ALTER）；web 報告頁 PageInfo 下方加「💬 開發者描述」區塊
  - 三端 build/tsc 通過；**server 已 `wrangler deploy` 部署**，curl 實測 description POST/GET round-trip 成功
- PM-21：標注頁自動錄語音 + 即時字幕（邊畫邊講邊看）
  - 標注頁載入後自動啟動語音辨識（不需手按 🎤）；🎤 改 toggle 暫停/續錄
  - 畫布底部加 `#liveCaptions` 浮動字幕條（`pointer-events:none` 不擋畫圖）：interim 即時顯示、final 寫入文字框 + 顯 ✅ 1.5 秒
  - 語音邏輯抽成 `startListening()`/`stopListening()`；只動 `annotate.ts` + `annotate.html`
- PM-22：UI 美化（popup + 報告頁）統一設計語言
  - 設計語言：`#0f0f1a` 深底 + `#7c3aed` 品牌紫 + 12px 圓角 + 漸層按鈕
  - popup：品牌 Header、320px、兩入口漸層 + hover 上浮、錄製中大計時器 + 脈動圓點、完成摘要卡 + 分享連結卡（所有 `popup.ts` 依賴的 ID 全保留）
  - 報告頁：sticky 品牌導航列、header 卡片化、面板圓角 + 標題底線、截圖 hover 放大、載入 spinner；`ReportPage` 條件渲染（截圖/rrweb 有資料才顯示）
  - 只動 `popup.html` + `web/index.css` + `ReportPage.tsx`；extension/server/types 不動
- PM-23：修標注頁語音中斷（工具按鈕不搶焦點）
  - annotate 工具列加容器層 `mousedown` `preventDefault`（排除 input/select），避免按鈕搶焦點打斷 SpeechRecognition；click 仍正常
- PM-24：錄製加即時字幕 + 停止後編輯頁
  - inject 錄製中注入 `#bugezy-live-caption` 浮動字幕（`interimResults=true`：interim 即時、final 顯 ✅ 1.5 秒、停止移除）
  - 停止錄製後 background 不直接上傳，改開新增的 `edit-report.html`（摘要 + 語音記錄 + 補充描述含 🎤 語音輸入）→「✅ 上傳報告」才送 API、「✗ 捨棄」清 storage
  - background 加 `UPLOAD_REPORT` handler；types 加 `UPLOAD_REPORT` + 匯出 `STATE_KEY`；build 加 edit-report entry
- PM-25：AI 精簡摘要（語音記錄一鍵變重點）
  - server 加 `POST /api/summarize`（Cloudflare Workers AI，繁中條列式精簡）；wrangler.toml 加 `[ai]` binding、Env 加 `AI`
  - edit-report + annotate 各加「🤖 AI 精簡」按鈕（漸層）；精簡結果寫入要上傳的描述欄位
  - **已部署 + 線上實測**：`/api/summarize` 回正確繁中重點摘要
  - 修正：規格用的 `@cf/meta/llama-3.1-8b-instruct` 已於 2026-05-30 deprecated → 改用 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- PM-26：驗證 PM 手動改動 + 修一個連帶 bug
  - 改動1（edit-report.ts AI 精簡成功後永久 disable）、改動2（inject.ts 語音中斷顯示重啟按鈕）皆驗證 TS 正確
  - 改動3（annotate.html 移除 AI 精簡按鈕）連帶造成 annotate.ts 仍 `$('summarizeBtn')` → 載入即 throw 使整頁失效 → 移除對應 JS 修復
  - tsc + build 通過；逐一驗證 annotate/edit-report 的 DOM ID 與 HTML 一致

## 2026-06-18

第 6 代「更好用」Day 4（PM-27~47）。重點：即時字幕雙區、編輯頁時間軸標記、跨頁錄製不丟資料、語音重啟穩定化、回放乾淨/原始 toggle。

- PM-27：錄製即時字幕分兩區（底部 interim + 右上 `#bugezy-voice-panel` 堆疊 final，可收合）
- PM-28：編輯頁時間軸標記（`@rrweb/replay` mini player + 📌 多時間點）；markers 全鏈 types/background/server/MCP/web；schema 加 `markers JSONB`；server 重新部署
- PM-29：標記 UX — 按 📌 彈 `prompt` + 上傳保留無文字的時間點（移除 filter）
- PM-30：字幕條改 flex + 永久 🔄 重啟按鈕 + `forceRestartVoice` + `setCaptionText`
- PM-31：三 Bug — 右上面板誤點卡死（header `pointer-events:none`、僅收合鈕可點）/ mini player 放大 / 語音 append 保留 cursor（edit-report + annotate）
- PM-32：抽 `createRecognition()` 工廠（全新 handlers）、刪 `showRestartButton`；修 🔄 重啟後語音死掉
- PM-33：`forceRestartVoice` 改 async — `getUserMedia` 刷新 + 500ms + `autoRestartFails` 計數
- PM-34：★跨頁不丟資料 — inject 即時 flush → content 轉發 → background `chrome.storage.local` buffer；STOP 時 `buildFullPayload()` 合併去重（voice/console/network/rrweb）
- PM-35：content.ts 載入 `GET_STATE` 自動恢復錄製（跳頁後新頁補送 START）
- PM-36：跳頁右上面板回填歷史語音（`REQUEST_VOICE_HISTORY` → `GET_VOICE_BUFFER` → `VOICE_HISTORY`）+ 恢復 poll 100→50ms
- PM-37：修 READY 競爭條件（inject 每 100ms 重發 READY + content 回 `READY_ACK` 握手）
- PM-38：修 mini player 放大鏡（依 rrweb Meta 原始解析度算 scale + 預載第一幀 + `mouseTail:false`）
- PM-39：語音記錄 textarea 移除 `readonly`（可手動修錯字）
- PM-40：語音面板下移 60→140px + mini player 🔍 2x 放大鈕
- PM-41：放大改為容器物理全寬（`max-width:100%`）+ 重算 scale
- PM-42：edit-report / annotate 補充說明語音套穩定模式（工廠 + getUserMedia + 失敗計數）
- PM-43：放大時 `.wrap` 撐到 95vw；語音 `onend` 失敗改 getUserMedia 刷新建新實例
- PM-44：rrweb `record()` 加 `block/ignoreSelector` 排除 BugEzy overlay；面板 140→200px
- PM-45：`mouseTail:true`（回放看得到游標）
- PM-46：回放「乾淨/原始」toggle — 移除 blockSelector、改在 edit-report 注入 CSS 到 Replayer iframe 控制顯示；MutationObserver 維持
- PM-47：乾淨模式改 `setInterval` 每 200ms 補注入（移除 MutationObserver）；排查發現游標 `.replayer-mouse` 在 `.replayer-wrapper` 內（非 iframe 內）→ 縮放改套 `.replayer-wrapper` 讓游標可見對齊
- 收工：文件同步（project_status §2/§6b、CHANGELOG、SKILL）+ commit

## 2026-06-20

第 6 代 Day 5（PM-48~53）。重點：測試專頁、六種使用模式（錄製/回溯/截圖/即時監控/鍵盤/終端機CLI）、MCP 由 8→10 tool、新增 `cli/` 子專案。

- PM-48：測試專頁 Test Harness（server）— `GET /test`、`/test/page2`、`/test/page3`（20 段長內容測捲動）、`/test/api/:status`（回指定 HTTP status 觸發 4xx/5xx）；抽 `TEST_STYLE` + `testShell()`；已部署 + curl 驗證
- PM-49：🔇 鍵盤模式 toggle（關閉語音）— `KEYBOARD_MODE_KEY`；popup 開關、`InjectCommand.keyboardMode`、inject START 跳過語音改顯示提示條、content 帶旗標（含 PM-35 跨頁恢復）、annotate/edit-report 一併檢查
- PM-50：⏪ 30 秒回溯（核心：inject 背景循環緩存）— 載入即背景 rrweb（`checkoutEveryNms`）+ console/network 永遠攔截、30s 環形 buffer；按⏪打包最近 30s → edit-report；錄製時停背景 rrweb、停止後重啟；types `REWIND_30S/REWIND_DONE/cmd:REWIND/REWIND_RESULT`；popup 三欄加橘色「⏪ 回溯 30s」
- PM-51：🔍 即時監控（AI 經 MCP 查當前頁 error）— popup toggle → background 每 10s 推 → `POST /api/live-errors` → MCP `get_live_errors`；不產報告/不上傳/token 極低。**架構修正**：規格全域 Map 跨 isolate 不共享（實測 POST 後 GET 仍 stale）→ 改 R2 單一物件（強讀後寫一致）；已部署 + curl 驗證
- PM-52：即時監控視覺回饋 — inject 頁面右下浮動 badge（綠✓/紅數字 + 閃動）+ 點擊展開 error 清單（escapeHtml 防注入）；攔截時 `updateMonitorBadge`；background 擴充圖示 badge 數字（非錄製時，`syncBadge` 還原）；`SET_MONITOR_BADGE`/`SHOW_MONITOR`/`HIDE_MONITOR` 串接
- PM-53：🖥 終端機 CLI Agent（新建 `cli/`）— `npx bugezy-watch -- <command>` 包住開發指令，stdout/stderr 透傳 + `ERROR_PATTERNS` 攔截 stderr/throw/crash、環形 buffer、每 10s + exit flush；`POST/GET /api/terminal-logs`（R2）+ MCP `get_terminal_logs`；已部署 + 端到端實測（CLI→API→GET stale:false）；devDeps 補 `@types/node`
- 收工：文件同步（project_status §2/§6c、CHANGELOG、SKILL）+ commit

## 2026-06-22

第 6 代 Day 6（PM-54~59）。上架前補齊：MCP token 省錢透明度、月度用量統計、get_screenshots、報告頁（Server 直接 serve HTML + DevTools 分頁）。MCP 由 10→12 tool。

- PM-54：每個 MCP tool 資料回應附 token 估算 + 對比 Claude in Chrome 省錢 footer（`estimateTokens`/`formatTokenFooter`/`txtWithTokens`，10 tool 全套用）；已部署 + 真實 MCP 連線驗證
- PM-55：edit-report 上傳前顯示各區塊 token 明細（語音/console/network/說明/標記/DOM）+ 總計 + 省%（`renderTokenEstimate`）；據實微調讀 `descInput.value`（payload 無 description 欄）
- PM-56：每次 MCP 呼叫記錄 Supabase `mcp_usage`（`logMcpUsage`，txtWithTokens 移進 createMcpServer 捕獲 env）+ `GET /api/usage/monthly`（`getMonthlyUsage`）+ MCP `get_usage_stats`；schema 補建表（非阻擋：表不存在不會壞）
- PM-56b：修記錄沒寫入——`void` fire-and-forget 被 Workers 提前終止；改 `txtWithTokens`/`get_usage_stats` 為 `await logMcpUsage`；線上實測 `/api/usage/monthly` totalCalls 0→1 記錄成功
- PM-57：MCP Tool 12 `get_screenshots`（讀 R2 截圖；`include_images` 預設 false 只回 metadata 省 token，true 回 base64 圖片 + 圖片 token 估算）；raw `/mcp` tools/list + metadata 模式線上驗證
- PM-58：web React `ReportPage` 改 Jam 風格 DevTools Tab 分頁（Info/Console/Network/Voice/截圖，自動選有資料 tab）+ index.css；標註 Worker 未服務 SPA
- PM-59：**Server 直接 serve `/report/:id` HTML**（`REPORT_PAGE_HTML`，深色 Tab + Token + vanilla JS 讀 `/api/reports/:id`）→ 解 share_url 在 Worker origin 404；據實修正規格 snake_case→camelCase（API 實回 camelCase，否則整頁無資料）；curl 驗證 200/html、API 不受影響
- 收工：文件同步（project_status §2/§6d、CHANGELOG、SKILL）+ commit

## 2026-06-24

Day 7（PM-60~61）。上架前：🔧 AI 校正按鈕 + Google OAuth 登入（第 5 代「能收錢」前置）。

- PM-60/60b/60c：編輯頁 🔧 AI 校正按鈕（與 AI 精簡並列）+ `POST /api/correct`（修錯字/去贅字/還原術語、可多次按不鎖死）。模型逐一實測（qwq-32b 輸出冗長推理不可用、deepseek 5007 無此模型、qwen3 與 llama-3.3 皆乾淨）→ 選 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（非推理、與 summarize 同款）；保留 `<think>` 剝除。釐清：先前「亂碼」是 Windows Git-Bash 測試環境編碼坑、非 server（Python UTF-8 驗證正確）
- PM-61/61b：Google OAuth 登入 — manifest `oauth2`+`identity`；`chrome.identity.getAuthToken` → `POST /api/auth/google`（Google userinfo 驗 → 查/建 Supabase `users` → session）；popup `loginView`/`mainView`（user-bar 頭像/名字/登出）；上傳報告帶 `user_id`（條件式）。61b：`.single()`→`.maybeSingle()`（新用戶不拋 PGRST116）+ 外層 try/catch 回實際錯誤。schema 補 `users` 表 + `reports.user_id`。MVP：能登入+報告綁 user；JWT/鑑權/用量限制留後續
- 收工：文件同步（project_status §6e、CHANGELOG、SKILL）+ commit

## 2026-06-25

第 5 代 Day 8（PM-62~65）。上架前最後衝刺：產品首頁、免費/付費用量限制、隱私政策頁、定價改兩層。綠界 ECPay 已送審（待 3-7 工作天）。

- PM-62：產品首頁 `GET /`（`HOMEPAGE_HTML`）— 一頁式深色主題（與報告頁統一、無 JS、RWD）：Hero + 4 賣點 + CTA、六種錄製模式 grid、方案與定價、Footer（聯絡 email + 隱私政策連結 + 版權）；解 `/` 原回 `{"error":"not found"}`。已部署（`edbd780e`）+ curl 驗證 200/html，其他路由不受影響
- PM-63：免費/付費用量限制系統 — `FREE_LIMITS`（錄製 10／回溯 5／MCP 20 月）+ `getUserIdFromHeader`（解 `Bearer base64(user_id:ts)`）；`GET /api/user/plan`（查方案 + 剩餘用量 + 跨月自動重置）、`POST /api/user/usage`（遞增，免費版達上限回 403 `limit_reached`、付費版 unlimited）。popup 顯示「剩 N 次／已用完」+ 升級提示（`#upgradeHint`）；background `checkRecordingUsage()` 錄製前檢查（未登入/API 不通皆不擋）；`StateResponse.limitReached`。schema 加 `users.recording_count/rewind_count/mcp_count/usage_reset_at`（FOX 手動跑）。目前僅 recording 串前端，rewind/mcp 後端就緒待接。已部署（`c5fac8be`）+ curl 驗證（無 token 401、未知用戶 404）
- PM-64：隱私政策頁 `GET /privacy`（`PRIVACY_PAGE_HTML`）— 中英雙語深色主題，7 節（收集/使用/儲存/分享/權利/Cookie/變更通知）；首頁 footer 連結由佔位 `#` 改 `/privacy`。Chrome Web Store + 綠界審核要的可訪問隱私政策 URL。已部署（`2588ea7e`）+ urllib UTF-8 驗證中英文關鍵字全中
- PM-65：首頁定價三層改兩層 — 免費版 NT$0 / 付費版 NT$80（移除 NT$150 重度 Pro），付費卡加紫色「立即升級」CTA（`.plan-cta`）；免費版額度與 PM-63 `FREE_LIMITS` 對齊。已部署（`00afebc4`）+ urllib 驗證 NT$150/重度 Pro 已移除、兩層條目全中
- 技術債：定價宣稱「報告保留 7／90 天」但後端尚未實作自動過期清理；CTA/下載/升級連結仍 `#` 佔位（待金流 + Web Store 上架）
- 收工：文件同步（project_status §2/§6f、CHANGELOG、SKILL）+ commit

## 2026-06-27

第 5 代 Day 9（PM-66~70）。上架前文檔補齊（使用指南/FAQ/Web Store 文案）+ 三項打磨（跨頁游標/CSP 相容/語音穩定）。打磨類皆 build 過、待 FOX 瀏覽器實機驗收。

- PM-66：使用指南 `GET /guide` + FAQ `GET /faq`（`GUIDE_PAGE_HTML`/`FAQ_PAGE_HTML`，深色 RWD）— guide 四步驟卡片（安裝登入 → 六模式各含適合/用法/錄到 → 編輯上傳 → 讓 AI 修 + MCP 設定框）+ 小技巧；faq 手風琴（點擊展開、單一展開）四大類 14 題。首頁 footer 改 `使用指南 | 常見問題 | 隱私政策` 三連結。只改 `server/src/index.ts`。已部署（`dd034701`）+ urllib 驗證（`/guide` 5353b、`/faq` 4793b 含 `faq-q` 計數 14、既有路由仍 200）
- PM-67：Chrome Web Store 上架文案（新建 `docs/chrome-web-store.md`）— 擴充名稱/中英簡短+詳細說明/分類 Developer Tools/語言/隱私+首頁 URL/權限說明。⚠ 據實校正權限：規格原列 `tabs`/`offscreen` 與 manifest 不符（offscreen PM-08 已移除、tabs 未宣告）→ 校正為實際 `activeTab/scripting/storage/downloads/identity` 並附校正說明（Web Store 審核要求權限理由與 manifest 逐項一致）。只建檔
- PM-68：跨頁回放滑鼠游標修復（只改 `extension/src/edit-report.ts`）— 調查確認 `mouseTail` 是 Replayer 選項（inject 端不需設）、rrweb 預設就錄 mousemove；真因是跨頁每段新 FullSnapshot 後使用者下次移動前無 MouseMove → 游標段落開頭消失。修法 `injectCrossPageCursor()`：每個非首段 FullSnapshot 後注入合成 MouseMove（沿用上段座標 + 指向新頁 `<html>` 節點 id）。tsc + build ✅，待實機驗收
- PM-69：CSP 網站相容性（只改 `extension/src/inject.ts`）— 調查確認注入早已是宣告式 `content_scripts world:MAIN`（不受頁面 CSP `script-src` 限制），規格「改用 executeScript」前提不成立、不執行（會退步）。真正缺口：inject.ts 兩處頁面 MAIN world `innerHTML`（語音面板 header、即時監控錯誤清單）在 Trusted Types CSP 網站（如 GitHub）會拋錯 → 改 DOM 節點 + `textContent` 建構（連帶移除不再需要的 `escapeHtml`）。tsc + build ✅，待 GitHub 驗收
- PM-70：語音辨識穩定度（只改 `extension/src/inject.ts`）— onend 自動重啟 + `autoRestartFails` 計數本已有；補 `onstart`（真的啟動成功才歸零計數 + 切 🟢，比 start() 後立即歸零更準）、onerror 分類（`no-speech` 續跑/`audio-capture` 提示但續試/`not-allowed` 停止/`aborted` 忽略/其他交 onend）、統一狀態指示器 🟢 聽取中/🟡 重啟中/🔴 已停止（`setVoiceStatus`，字幕區）。tsc + build ✅，待實機驗收
- 技術債：PM-68/69/70 皆需瀏覽器實機驗收；線上 `/report/:id` 未享 PM-68 游標修復（要同效需在 `REPORT_PAGE_HTML` 另加前處理）；CSP「部分功能受限」popup 提示與語音 backoff 退避未做
- 收工：文件同步（project_status §2/§6g、CHANGELOG、SKILL）+ commit

## 2026-06-28

第 5 代 Day 10（PM-71~73）。Chrome Web Store 打包 + 綠界 ECPay 金流串接（測試環境跑通：單次付款 + 定期定額月訂閱 + 取消訂閱）。CheckMacValue 依綠界官方 AI Skill 校正並對官方測試向量 + 線上獨立重算雙重驗證。

- PM-71：popup 版本更新通知 + Chrome Web Store zip（只改 `popup.ts`/`popup.html` + 打包）— `checkVersionNotice()` 用 `chrome.storage.local` 的 `bugezy:lastVersion` 比對 manifest 版本，有舊記錄且不同才跳 `.update-notice` 卡片（首裝不跳）。zip 用 PowerShell + .NET `ZipFile.CreateFromDirectory` 從 `dist/` 取執行期 11 檔（排 `.map`）→ `bugezy-v0.1.0.zip`（211,369 bytes / 206.4 KB，manifest 在根、可拖進 chrome://extensions）。`.gitignore` 加 `dist-zip/`+`bugezy-v*.zip`。⚠ 規格列的 offscreen/icons 實際不存在故不含（offscreen PM-08 已移除、manifest 未宣告 icons）。tsc + build ✅
- PM-72：綠界 ECPay 付費串接（測試環境）（`server/src/index.ts` + `wrangler.toml` + `popup.ts`）— `GET /checkout?user_id=` 回自動提交綠界表單；`POST /api/ecpay/callback` 驗 CheckMacValue → `RtnCode=1` 更新 `users.plan='paid'` → 回 `1|OK`；`POST /checkout/result` 結果頁。popup 升級鈕改開 `/checkout?user_id=<session.user_id>`。⚠ **CheckMacValue 依官方 ECPay-API-Skill guides/13 校正**：規格版漏了 TS 的 `~→%7e`、`'→%27`（encodeURIComponent 不編碼）→ 補齊 `ecpayUrlEncode`；Workers 用 `crypto.subtle`（async SHA256）+ `timingSafeEqualStr` 驗章。對官方 8 個測試向量驗證（6 個有 params 全 PASS，含撇號/波浪號/空格）+ 線上 `/checkout` CheckMacValue 與本地獨立重算一致。`[vars]` 加 4 個 ECPAY（測試帳號 3002607）。已部署（`d50ef757`）
- PM-72b：定期定額月訂閱（只改 `server/src/index.ts`）— `/checkout` 加 `PeriodAmount=80`(=TotalAmount)/`PeriodType=M`/`Frequency=1`/`ExecTimes=99`/`PeriodReturnURL`；新增 `POST /api/ecpay/period-callback`（第 2 期起每月扣款通知）：驗 CheckMacValue → `RtnCode=1` 維持 paid／否則降級 free → 回 `1|OK`。第 1 次授權仍走 `/api/ecpay/callback`。對官方 `guides/01 §定期定額` 核對欄位 + 線上驗證（含 period 的 CheckMacValue 一致、bad mac→`0|ErrorMessage`、valid mac→`1|OK`）。已部署（`0f87d3df`）
- PM-73：取消訂閱（`server/src/index.ts` + `schema.sql` + `popup.ts`/`popup.html`）— `users` 加 `ecpay_trade_no`+`plan_expires_at`（**FOX 手動跑 ALTER**）。callback 首期/續扣成功記 trade_no + 展延到期日（+1 月）。新增 `POST /api/user/cancel`：呼叫綠界停止訂閱 → 標 `plan='cancelled'`（到期前仍享付費）→ 回可用到期日。`getUserPlan`/`bumpUsage` 的 isPaid 改 `paid||cancelled`；`getUserPlan` 加「cancelled 過期→自動降 free」+ 回 `expires_at`。popup 加 `#manageSubscription`（付費顯「取消訂閱」、cancelled 顯「已取消，可用到 YYYY/MM/DD」），二次確認 → cancel API。⚠ 據官方 Skill 校正綠界取消端點：規格寫 `/CreditDetail/DoAction`（一般信用卡交易作業）→ 定期定額取消官方端點是 **`/Cashier/CreditCardPeriodAction`** 且需 `TimeStamp`（主機沿用 `ECPAY_PAYMENT_URL` origin）。已部署（`3c15976e`）；線上驗證 cancel 無 auth→401、路由命中 DB；偵測新欄位待 FOX 跑 ALTER（程式路徑已驗正確）
- 技術債：正式上線換 ECPAY 正式 key（HASH_KEY/IV 建議改 `wrangler secret`）；**PM-73 的 2 個 ALTER 待 FOX 跑**（未跑前已登入用戶打 plan/usage/cancel 會 500，extension 端靜默降級不崩）；定期定額降級策略目前「任一期失敗即降 free」，宜改寬限期/連續失敗 N 次（綠界連續失敗 6 次才終止合約）；取消後綠界端失敗仍續扣會把 cancelled 翻回 paid（宜 period-callback 成功時若現況 cancelled 則維持）；測試環境只扣第一期；升降級後用戶需重開 popup 才反映；PM-71 更新通知 + Day 9 三項打磨待實機驗收
- 收工：文件同步（project_status §2/§6h、CHANGELOG、SKILL）+ commit

## 2026-06-29

第 5 代 Day 11（PM-74~75）。綠界補件（首頁聯絡資訊）+ 修付費用戶 popup UI bug，Chrome Web Store 已送審、綠界補件已重送。

- PM-74：首頁加聯絡資訊（只改 `server/src/index.ts` 的 `HOMEPAGE_HTML`）— footer 內、隱私政策連結上方新增明顯的 `.contact-info` 紫框卡片：聯絡我們 + 📧 `fox100039@gmail.com` + 📱 `0983-101-085`（`tel:+886983101085` 可撥）+ 服務時間「週一至週五 09:00-18:00」（綠界要求販售網址聯絡資訊與註冊資料一致）。已部署（`6dfd69ab`）+ urllib 驗證（卡片在 `/privacy` 連結上方、含全部欄位）
- PM-75：修付費用戶仍顯示升級提示（只改 `extension/src/popup.ts` 的 `loadPlan()`）— plan 狀態判斷由「看 `plan.limits` 是否 null」改成**直接以 `plan.plan` 為準**三態分流：paid → ✨ + 隱藏升級提示 + 管理訂閱（可取消）；cancelled → ✨ + 隱藏升級提示 + 顯示到期日（隱藏取消連結）；free → 剩餘次數 + 升級提示（`plan.limits?.recording` 防呆）。`npm run build` + `tsc` ✅；zip 重打包 → `bugezy-v0.1.0.zip`（212,052 bytes / 207.1 KB，popup.js 13.0→15.3kb）
- 上架/審核狀態：Chrome Web Store 已提交審查、綠界 ECPay 補件已重送（皆 2026-06-29），等候審核 + 換正式 key
- 技術債（沿用）：PM-73 的 2 個 ALTER 待 FOX 跑（PM-75 付費 UI 效果依賴它）；定期定額降級寬限期、cancelled 被 period-callback 翻回 paid、報告過期清理、rewind/mcp 用量前端、`/report/:id` 游標前處理；一批待瀏覽器實機驗收
- 收工：文件同步（project_status §2/§6i、CHANGELOG、SKILL）+ commit

## 2026-06-30

第 5/6 代 Day 15（PM-80~91，12 卡）。首頁受眾擴展 + bugezy.dev 域名 + 截圖 AI 勾選 + **語音架構升級（Groq Whisper 雙引擎）**。server 部分已部署；extension 部分皆 build 過、**未重上架 Web Store**（等當前審核過再一起打包）。

- PM-80：首頁受眾定位更新（只改 `HOMEPAGE_HTML`）— 主標語改「Web 開發者的 AI Bug 報告工具／前端後端一起抓，10 分鐘修好 Bug」；新增「支援所有 Web 開發框架」區塊（前端 React/Vue/Angular/Next/Nuxt/Svelte + 後端 Django/Flask/FastAPI/Laravel/Rails/Spring/Express/Node）+ MCP 工具列 + RWD。已部署（`c3fd3617`）
- PM-81：bugezy.dev 域名切換稽核（**唯讀調查**，產出 `docs/domain-migration-checklist.md`）— 核心：後端全用 `url.origin` 故域名無關，真正要改只有 `extension/src/types.ts` 的 `API_BASE` 一處；OAuth/ECPay 回調皆自動連動；舊 workers.dev route 建議長期保留
- PM-82：報告頁截圖可視化勾選 + MCP 連動（`server/src/index.ts` + `schema.sql`）— `reports.allow_screenshot_images BOOLEAN`（FOX 跑 ALTER）；報告頁 Screenshots 分頁加勾選 + token 提示 + `PATCH /api/reports/:id/settings`；MCP `get_screenshots` 兩層判斷（勾選 OR `include_images`）+ 防呆 fallback。已部署（`eb870142`）
- PM-83：popup「高畫質 AI 分析」toggle（extension）— 鍵盤模式下方加 toggle，截圖上傳帶 `allow_screenshot_images`；`createReport` 非破壞性退回重試（欄位未建不中斷上傳）；報告頁文字同步
- PM-84：MCP `get_screenshots` 文字同步「高畫質 AI 分析」（server 字串）。已部署（`86c22eee`）
- PM-85：**Server Groq Whisper `POST /api/transcribe`**（麥克風架構升級 1/3）— `Env.GROQ_API_KEY`（secret）；multipart/raw 音訊 + 大小檢查 + `whisper-large-v3-turbo`/`language=zh`；錯誤路徑線上驗證（GROQ_API_KEY 已設定有效）。已部署（`ec1da982`）
- PM-86：**Extension offscreen 錄音 + popup 麥克風 toggle**（2/3）— 新增 `offscreen.html/ts`（`getUserMedia`+`MediaRecorder` webm/opus）；background `ensureOffscreen`/`MIC_START`/`MIC_STOP`→`/api/transcribe`；popup 標題列麥克風滑動 toggle；manifest 加 `offscreen` 權限
- PM-87：**語音引擎依 plan 路由**（3/3）— 免費版 Web Speech（inject SpeechRecognition）/付費版 offscreen+Groq；plan 由 popup `loadPlan` 持久化 `USER_PLAN_KEY`（規格的 `bugezy:user` 不存在，據實校正）；content `computeStartFlags` + inject `micEnabled` 閘 + RECORDING_DONE 合併 whisper（`VoiceSegment.source`）
- PM-88：修復 offscreen 麥克風授權失敗 — 移除無效 `audioCapture`（Chrome Apps 專用）；新增 `mic-permission.html/ts` 可見授權頁（隱藏 offscreen 頁不彈授權）；background `ensureMicReady`/`MIC_PERMISSION_GRANTED`
- PM-89：授權時機從錄製改到 popup 麥克風 toggle（修「錄製中開授權頁搶焦點導致停止失效」）— `REQUEST_MIC_PERMISSION`；`ensureMicReady` 不再開頁
- PM-90：麥克風預設 OFF（`MIC_KEY` 三處 `!== false`→`=== true`，含 content 一致性補）+ 授權頁停留 1.5s→3s
- PM-91：付費版語音模式切換（即時字幕/精準轉錄）+ Whisper 錄音反饋 — popup `#micMode`（付費+mic ON 才顯示，存 `MIC_MODE_KEY`）；`getMicMode` 路由（off/realtime/whisper）；inject `showWhisperCaptionBar`（紅點脈衝）+ `WHISPER_TRANSCRIBING`（停止顯「⏳ 轉錄中」）
- 待辦（次日）：即時字幕授權橫幅改居中 modal、Whisper 音量跳動指示器、錄製中 popup 模式按鈕 disable
- 技術債（沿用）：PM-73 的 2 個 ALTER + PM-82 的 `allow_screenshot_images` ALTER 待 FOX 跑；extension PM-85~91 整套未重上架 Web Store（offscreen 權限變更需重審）；domain 遷移待雙審核過後執行
- 收工：CHANGELOG + ARCHITECTURE + project_status 同步 + commit + push

## 2026-07-01

第 5/6 代 Day 16（PM-93~107，15 卡）。**Supabase RLS 安全根治** + Whisper 音量條 + install/features 雙頁 + 截圖修復 + 工具列特效反覆打磨 + 錄製 UX 一連串修復。server 部分（PM-93/96/98/99）已部署；extension 部分皆 build 過、**未重上架 Web Store**。

- PM-93：**Supabase 全 table RLS 鎖死 + 安全根治（Critical）**（`server/src/index.ts` + `schema.sql` + 新 `rls-lockdown.sql` + ARCHITECTURE）— ⚠ 發現規格前提錯誤：Worker 實際用 **anon key 非 service_role**（`schema.sql` 曾 `DISABLE RLS on users` 為鐵證），直接開 RLS 會鎖死自己全站 500。校正：新增 `supaKey(env)=SUPABASE_SERVICE_ROLE_KEY||SUPABASE_ANON_KEY`（service_role 未設自動退回 anon，安全過渡），產出 `rls-lockdown.sql`（含動態 DO block）+ ARCHITECTURE §4-6「Supabase 安全鐵律」。已部署（`9a2dc3f6`）。**FOX 待辦：先 `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` 再跑 rls-lockdown.sql（順序不可顛倒）**
- PM-95：即時字幕麥克風授權橫幅改居中 modal 遮罩（`inject.ts showMicPermissionOverlay` 頂部橫條→全頁 `rgba(0,0,0,0.6)` 遮罩 + 紫框居中卡片，按鈕邏輯零改）
- PM-96：新增 `/install` 安裝指南（五步 + MCP 設定 `bugezy.dev/mcp` + 12 工具）+ `/features` 功能總覽（八區塊）+ 首頁/guide/faq/privacy footer 統一導覽。已部署（`568cc421`）
- PM-97：**Whisper 錄音即時音量條**（offscreen AudioContext/Analyser 每 200ms 送 `MIC_VOLUME` → background `recordingTabId` 轉發 → content CustomEvent → inject 5 條音量條，安靜矮紅/講話綠跳），取代 PM-91 靜態脈衝紅點
- PM-98：**修截圖報告在 `list_reports` 消失**（`annotate.ts` + `server` + 新 `backfill-user-id.sql`）— ⚠ 根因是漏 `user_id` 非規格說的 `user_email`（reports 無此欄，list_reports 靠 email→user_id 過濾）；annotate 上傳補帶 `user_id`(session)+Authorization header + server `createReport` 防呆從 Bearer token 補 user_id。已部署（`33fde879`）。**FOX 待辦：跑 `backfill-user-id.sql` 補舊孤兒報告**
- PM-99：報告頁截圖點擊開空白頁 → 頁內 lightbox（base64 data URL 無法 `window.open`；縮圖 `onclick` 改 `openLightbox` + `</body>` 前加全頁遮罩放大圖，點遮罩/ESC 關）。已部署（`2ccbb942`）
- PM-100：截圖標注頁「問題描述」左側加語音/鍵盤臨時切換鈕（`voice-toggle` ⌨️/🎙️，復用既有 `startListening/stopListening`；授權失敗自動退鍵盤，刻意排除 no-speech 免殺 onend 自動重啟）
- PM-101→102→103→104：**工具列入場特效四連迭代**（純視覺打磨）— 101 邊框漸層掃光（深色看不清）→ 102 亮紫脈衝（不夠搶眼）→ 103 自適應底色（深橘光脈衝/淺紅跑馬燈 `@property`+conic-gradient）→ **104 定案**：刪跑馬燈/isDarkBackground，只留橘光脈衝 `applyOrangePulse` + popup「✨ 工具列特效」開關（`TOOLBAR_EFFECT_KEY` 預設 ON）
- PM-105：修錄製中開麥克風觸發授權頁卡死（popup toggle 先 `GET_RECORDING_STATE`，錄製中只存 `MIC_KEY` 偏好不開授權頁，下次錄製才授權）
- PM-106：錄製中鎖定 popup 全部設定（`lockSettings` 於 `render()` 依 `state.recording` disable mic/模式/鍵盤/監控/高畫質/特效 + `settingsHint`「🔒 錄製中設定已鎖定」）
- PM-107：按錄製時 mic OFF 提示（鍵盤模式除外）— `startBtn` 抽 `doStartRecording`，mic OFF+非鍵盤模式先彈 `micPrompt`（開啟並錄製/直接錄製）
- 未做：PM-94（綠界測試 key→正式 key）本日未執行，Worker 仍 `3002607`/`payment-stage`，正式收款未生效
- 技術債（沿用+新增）：PM-73/82 ALTER 待跑；**PM-93 service_role secret + rls-lockdown.sql 待 FOX 跑（順序關鍵）**；**PM-98 backfill-user-id.sql 待跑**；PM-94 綠界正式 key 待換；extension 整套未重上架 Web Store；無 git remote（push 無法執行）
- 收工：CHANGELOG + ARCHITECTURE + project_status 同步 + commit + push

## 2026-07-04

Day 19（PM-136~152）。SEO + 多語系 + i18n + 語言暫鎖 + 清敏感檔 + MCP/監控日誌認證 + CLI 付費限定 + 金流冪等 + 登出撤銷/PATCH 認證 + 截圖 Whisper + manifest 更新 + ECPay 時區 + **全站對外頁英文版完成**。

- PM-152：**/guide + /faq + /privacy 英文版（全站 7 頁 i18n 完成）**（只改 `server/src/index.ts`，延續 PM-150/151）— `GUIDE_PAGE_HTML`→`guidePage(lang)`、`FAQ_PAGE_HTML`→`faqPage(lang)`、`PRIVACY_PAGE_HTML`→`privacyPage(lang)`（原中英雙語堆疊改「只顯示對應語言」）；三頁加語言切換鈕 + `getLang()` + `no-store`。**🔴 FAQ 英文版無任何競品名稱**（延續 PM-130）。已部署（`fc38e200`）+ curl 驗證（en/zh、privacy 單語言、FAQ 0 Jam、切換鈕、no-store、html lang）。tsc ✅。至此首頁/install/features/changelog/guide/faq/privacy 七頁全部中英雙語（報告頁動態內容不做）。

- PM-151：**/features + /changelog 英文版**（只改 `server/src/index.ts`，延續 PM-150 i18n）— `FEATURES_PAGE_HTML`→`featuresPage(lang)`（八功能卡全 `t(zh,en)`）、`CHANGELOG_PAGE_HTML`→`changelogPage(lang)`（版號/日期不翻，只翻功能描述）；兩頁加右上角語言切換鈕 + `getLang()` 自動偵測 + `no-store` 防跨語言快取。已部署（`a7bbf78e`）+ curl 驗證（en/zh、?lang、切換鈕、版號不翻、no-store、html lang）。tsc ✅。剩 guide/faq/privacy（Phase 3）。

- PM-150：**server 首頁 + /install 英文版（Accept-Language 自動切換）**（只改 `server/src/index.ts`）— 國際使用者第一眼全中文會跳出。①新 `getLang(request)`（`?lang=en|zh` 覆蓋優先，否則 `Accept-Language` zh*→中文其餘→英文）；②`HOMEPAGE_HTML`→`homePage(lang)`、`INSTALL_PAGE_HTML`→`installPage(lang)`，本地 `t(zh,en)` 三元切換全部文字（含 title/meta/og/`<html lang>`/AI 安裝 prompt 中英兩版/定價/12 工具清單）；③右上角固定語言切換按鈕（中↔英）；④首頁/install 設 `Cache-Control: no-store`（依語言變動，避免 CF 快取跨語言誤送——CORS 出口的 `Vary: Origin` 會蓋掉 `Vary: Accept-Language`）。其餘頁面（features/guide/faq/privacy/changelog）依 §5 Phase 2。已部署（`954a4c46`）+ curl 驗證 9 項（en/zh 自動、?lang 強制、切換鈕、/install、meta、no-store、html lang）。tsc ✅。

- PM-149：**formatEcpayDate 改 UTC+8 台灣時間（P3-2）**（只改 `server/src/index.ts`）— 綠界 `MerchantTradeDate` 預期台灣時間，但 Workers edge 為 UTC，跨日邊界訂單日期差一天、對帳出錯。修法：`new Date(d.getTime()+8*3600*1000)` + `getUTC*`（不管 edge 在哪都輸出台灣時間）。CheckMacValue/session·day_pass 到期（ISO UTC 正確）不動。已部署（`c9186b9a`）+ 驗證（UTC 13:50→TW 21:50、部署健康）。tsc ✅。

- PM-148：**manifest 更新 — version 1.1.0 + 描述英文化 + `<all_urls>` 審核說明（P3-3）**（`manifest.json` + `docs/chrome-web-store.md`）— ①version `0.1.0`→`1.1.0`（與 `/api/version` latest 一致，popup 不再亮「有新版」）；②description 改中英雙語（Web Store 搜尋吃關鍵字）；③`<all_urls>` 單一用途說明寫進 web-store doc（中文理由 + 英文審核回覆），順手校正該檔過期的 `offscreen 已移除` 說明（PM-86 已重新加回付費版 Whisper 錄音，manifest 現有此權限）。permissions/content_scripts/oauth2 不動。build ✅（dist manifest 1.1.0 + 雙語 description）。未 deploy（純 extension）。

- PM-147：**截圖標注語音改走 Whisper（付費版）**（只改 `extension/annotate.ts`）— 截圖標注的語音描述原本一律 Web Speech，付費版也沒享 Whisper。修法：載入讀 `USER_PLAN_KEY`+`MIC_MODE_KEY` → `useWhisper = 付費 && micMode==='whisper'`（與錄製流程同邏輯）；`startListening`/`stopListening` 改成分派器（原 Web Speech 邏輯改名 `*WebSpeech`），付費+toggle→新 `startWhisper`/`stopWhisper`（MediaRecorder→POST /api/transcribe 帶 `audio` 欄+`language`+`getAuthHeaderOnly`→append 進描述），免費/toggle off 走 Web Speech（現狀）。Whisper 模式不自動錄音（避免超 25MB，按 🎤 手動起訖）；saveBtn 改 await 等轉錄完成。tsc + build ✅（dist annotate.js 含 MediaRecorder/transcribe/startWhisper）。未 deploy（server 不變）。實機付費分流待瀏覽器。

- PM-146：**登出撤銷 server session（P2-3）+ PATCH settings 加認證（P2-5）**（`server` + `extension/popup`）— ①新 `POST /api/auth/logout`（`handleLogout` 從 sessions 表刪 token，登出即撤銷、舊 token 立即失效、無 token 也冪等 ok）；②extension 登出先 `POST /api/auth/logout`（帶 getAuthHeaders）再清本地；③`PATCH /api/reports/:id/settings` 加 `getAuthUserId`（401）+ owner 驗證（report.user_id 不符 → 403），原本任何有 report_id 者可翻轉截圖曝光設定。已部署（`e9e16904`）+ build ✅ + curl 驗證（logout 冪等 ok、匿名/假 token PATCH 401）。tsc ✅。⚠ 副作用：報告頁公開分享頁的「高畫質 AI 分析」勾選（PATCH）因無 token 會 401（owner-only 預期後果；owner 改在擴充上傳時設定）。

- PM-145：**ECPay callback 冪等 + payments 表 + 金額比對（P2-1）**（`server/src/index.ts` + `schema.sql`）— callback 無冪等/重放防護，綠界回 `1|OK` 前重送 → 日票每次 +24h、月費每次 +1 月；且無金額比對/訂單表。修法：①新 `payments` 表（PK merchant_trade_no）+ helper `paymentAlreadyPaid`/`recordPayment`（upsert，失敗只記 log 不阻斷）；②`ecpayCallback`（月費）加冪等查重 + `TradeAmt!==80` 拒 + 記錄 paid/failed；③`handleDayPassCallback` 同（金額 20、day_pass）；④`ecpayPeriodCallback` 續扣加冪等——**key 用 `MerchantTradeNo-Gwsr` 組合**（每期重用同一 MerchantTradeNo，只用它會誤判續扣為重送），金額讀 `Amount`（>0&&≠80 才擋，缺欄不誤殺）+ 記 monthly_renewal。已部署（`05058668`）+ 驗證（三 callback 假 mac 仍 0|ErrorMessage、驗章第一道）。tsc ✅。**FOX 待辦：跑 `CREATE TABLE payments` + RLS**（未跑 callback 照常但無冪等）。

- PM-144：**終端機 CLI 付費限定 + bugezy-watch 更新（token/版號）**（`server` + `cli`，CLI 只改檔不發佈）— ①server `/api/terminal-logs` POST/GET 在認證後加 `isActiveUserId` 付費檢查（免費 403「終端機 CLI 為付費功能」；新增以 user_id 查表的 helper）；②CLI `bugezy-watch`：`BUGEZY_TOKEN` 改必填（缺→印提示+exit 1 不啟動子程序）、flushBuffer 一律帶 Authorization、收 403→印升級提示+exit；③package.json name `@bugezy/cli`→`bugezy-watch`、version `0.1.0`→`1.1.0`、description 英文版，rebuild dist。已部署（`0ae4b394`）+ 驗證（匿名 terminal-logs 401、CLI 無 token exit 1、有 token 正常跑）。tsc ✅。**FOX 待辦：`cd cli && npm publish`（需 npm login）**；擴充尚無「複製 Session Token」按鈕（UX 待辦）。

- PM-143：**即時監控/終端機日誌改 per-user R2 key + 加認證（P1-2）**（`server` + `extension/background` + `cli`）— 原本 `live-errors/latest.json`、`terminal-logs/latest.json` 全站共用單一 key + 零認證 → A 的 error/stderr（可能含密鑰）被 B 讀到。修法：①POST/GET `/api/live-errors`、`/api/terminal-logs` 加 `getAuthUserId`（401）+ R2 key 改 `{live-errors|terminal-logs}/${userId}/latest.json`（GET 走 jsonNoStore）；②`readLiveErrors/readTerminalLogs` 改接 userId；③MCP `get_live_errors/get_terminal_logs` 加 required `user_email` → `lookupUserId` 查 user_id → 讀 per-user key；④extension `background` live-errors POST 補 `getAuthHeaders`；⑤CLI `bugezy-watch` 加 `BUGEZY_TOKEN` env 帶 Authorization（未設印警告）。已部署（`327f901d`）+ curl/MCP 驗證（匿名 401、缺 email schema Invalid、不存在 email 查無此使用者）。tsc ✅。**FOX 待辦：重新發佈 CLI（用法改 `BUGEZY_TOKEN=… npx bugezy-watch`）**；舊全域 R2 key 30 秒自然 stale。

- PM-142：**MCP `list_reports` 綁身分驗證 + 錯誤脫敏（P1-1/P2-4）**（只改 `server/src/index.ts` MCP 段）— MCP 無標準 session 認證、list_reports 僅靠 email 當通行證（知道 email 就能列他人報告）。務實修法：①schema 加 `session_token`（optional，向下相容）——以 email 查到 user 後，有帶 token 就查 `sessions` 表比對 user_id，不符回「session_token 驗證失敗」；②兩處 `查詢失敗: ${err.message}` → `console.error` + 通用訊息（掃全 MCP 段無其他 `.message` 外洩）；③其他 tools 靠 report_id 不可猜 + PM-132 已鎖 REST 等效安全，不動。已部署（`d5f3dfeb`）+ MCP JSON-RPC 驗證（正確 email+錯 token→驗證失敗、不存在 email→空、不帶 token→向下相容）。tsc ✅。殘留限制：待 MCP 客戶端能穩定帶 token 再升 required。

- PM-141：**清除 `debug/` 敏感檔 + `.gitignore` 加硬（P1-5，推 GitHub 前置）**（無程式碼變更）— `debug/` 內有 Google OAuth client secret 明文 + 7 個真實報告 payload + 截圖。**先確認 `debug/` 從未被 git 追蹤**（`.gitignore` 早有 `debug/`，`git ls-files` = 0，故 secret 未進 git history、僅本機磁碟）。①`rm -rf debug/` 整個刪；②`.gitignore` 補 `*.secret`/`client_secret_*.json`/`.env`/`.env.*`/`.DS_Store`/`Thumbs.db` 並分區註記；③commit `eb31761`（diff 僅 .gitignore）。⚠ 提醒 FOX：那把 client secret 建議去 Google Cloud Console 輪替（曾在本機明文存在）。

- PM-140：**語言選擇鎖定（只開放中文/粵語/英文）**（extension `popup.html` + server）— 綠界特約商店未申請、日韓越無法付款，先鎖三語。①popup `#langSelect` ja/ko/vi 加 `disabled` + 「（即將開放）」，zh/yue/en 排前；②`.lang-select option:disabled` 灰色；③server `ALLOWED_LANGS` 由 6→`['zh','yue','en']`（ja/ko/vi fallback zh）。i18n 架構/`SPEECH_LANG_MAP` 保留完整（開放金流時只需解鎖 + 加回白名單）。已部署（`7812c5c8`）+ build ✅ + tsc 通過。

- PM-139：**i18n 深化——AI 輪盤多語預設 + inject/content/annotate 全覆蓋**（只改 extension 5 檔）— 接續 PM-138（popup 靜態）：①`i18n.ts` 加 `DEFAULT_PROMPTS`（zh/en 各 4 則）+ 工具列/監控/字幕/授權/annotate/alert 共 ~50 新 key；②popup 語言切換時 AI 輪盤「只有未自訂（== 舊語言預設）才重置」為新語言預設；③content 注入 `data-bugezy-lang` 到 DOM + `storage.onChanged` 即時更新（MAIN world 的 inject 無 chrome.storage，靠讀此 attr）；④inject `getBugezyUILang()`+`it()` 譯即時監控/錄製字幕/麥克風授權；content `ct()` 譯截圖工具列；⑤annotate.html 16 `data-i18n`+placeholder + annotate.ts `applyAnnotateTranslations`；⑥popup 取消訂閱 confirm/alert 改 `t()`。tsc + build ✅；101 個引用 key 全對得上字典（跨檔稽核）。未 deploy（純前端）。日韓越 UI 字典待補。

- PM-138：**popup 英文 UI（多語系翻譯架構 + 中英切換）**（只改 extension）— 接續 PM-137：語音可切多語但 UI 全中文。①新增 `i18n.ts`（`UILang`/`getUILang`/`t()` + 55 條中英字典）；②popup.html 49 處加 `data-i18n`（含 icon 按鈕包 span、cancelled 徽章拆前綴+日期）；③popup.ts `currentUILang` + `applyTranslations()`，langSelect 連動 `getUILang→applyTranslations→loadPlan`；④動態文字（用量/日票倒數/版本通知/時長/登入狀態）改用 `t()`。粵語跟繁中共用中文 UI，日韓英越用英文 UI（未來加語言只需擴字典）。tsc + build ✅（dist popup.html 49 data-i18n、popup.js 含 applyTranslations/英文字典）。未 deploy（純前端）。實機中英切換待瀏覽器。範圍：上傳/複製 transient 提示 + 日韓越 UI 字典未納入。

- PM-137：**語音語言選擇（粵語/日/韓/英/越，開拓亞洲市場）**（`server/` + `extension/`）— Groq Whisper 同模型支援 99 語、Web Speech 改 `lang` 即可。①server `handleTranscribe` 改從 multipart `language` 欄讀取 + 白名單 `['zh','yue','ja','ko','en','vi']`（非白名單 fallback zh）；②`types.ts` 加 `LANG_KEY`/`SupportedLang`/`SPEECH_LANG_MAP` + `InjectCommand.speechLang`；③popup 進階設定加 `#langSelect` 下拉（存 `bugezy:language`，錄製中鎖定）；④`background` Whisper 呼叫帶 storage 語言；⑤**inject 在 MAIN world 無 chrome.storage** → `content.computeStartFlags` 讀語言經 `SPEECH_LANG_MAP` 轉 BCP-47 塞進 `InjectCommand.speechLang` 帶入，inject `createRecognition` 用 `currentSpeechLang`（原寫死 zh-TW）。已部署（`93a1e68b`）+ extension build ✅ + tsc 通過。實機驗收（語言切換/Whisper·Web Speech 套用）待瀏覽器。範圍：annotate/edit-report 描述欄語音仍 zh-TW（不在本卡 §6）。

- PM-136：**SEO — sitemap.xml + robots.txt + meta tags**（只改 `server/src/index.ts`）— bugezy.dev 上線一週搜尋引擎搜不到。①新增 `GET /sitemap.xml`（`sitemapXml()`，7 個對外頁 URL + changefreq/priority，`application/xml`）；②`GET /robots.txt`（`robotsTxt()`，`Allow: /` + `Disallow: /api//mcp//report/` + Sitemap 指引，`text/plain`）；③首頁補完整 SEO（description 改行銷版 + keywords + og:title/description/type/url + canonical）；install/features 改 SEO 友善 title + description + canonical；changelog/guide/faq/privacy 補 description + canonical。已部署（`a35f9d9b`）+ curl 驗證（sitemap 7 URL/正確 Content-Type、robots 含 Sitemap、各頁 canonical/meta 到位）。tsc ✅。**FOX 手動**：Google Search Console + Bing Webmaster 提交 sitemap。

- FOX 待辦 / 技術債（Day 19 收尾）：
  - **Supabase SQL**：PM-145 `CREATE TABLE payments`（+RLS）待跑（未跑 callback 照常但無冪等/對帳）；沿用 Day 18 的 `CREATE TABLE sessions`（未跑登入拿不到 DB token）。
  - **CLI 重新發佈**：PM-144 `bugezy-watch@1.1.0`（`cd cli && npm publish`，需 npm login）；用法改 `BUGEZY_TOKEN=<擴充複製的 session token> npx bugezy-watch -- <command>`。擴充尚無「複製 Session Token」按鈕（UX 待辦）。
  - **extension 未重上架**：PM-137~148（多語系語音 + i18n + Whisper 截圖 + manifest 1.1.0）整套 build 過未打包送審；上架用 manifest 1.1.0 zip。
  - **日韓越暫鎖**（PM-140）：金流特約商店開通後解鎖 popup `disabled` + server `ALLOWED_LANGS` 加回 + 補日韓越 UI 字典。
  - **報告頁 PATCH toggle**（PM-146 副作用）：公開分享頁的「高畫質 AI 分析」勾選因無 token 會 401（owner-only 預期後果）；owner 改在擴充上傳時設定。
  - 沿用 Day 18：PM-133 user_id=Google sub（舊報告脫鉤 + 登入需 token aud=client_id 實機驗收）、Cloudflare Rate Limiting、綠界 4 secret + service_role secret + rls-lockdown.sql。
- 收工：CHANGELOG + ARCHITECTURE + project_status 同步 + commit + push（remote 已設）。

## 2026-07-03

Day 18（PM-128~135，8 卡）。**Fable 5 雙輪安全稽核 → 逐一修復**。核心：認證信任鏈重構（session token 取代假 base64 + Google token audience 驗證 + user_id 由 Google sub 推導、不信任客戶端）、報告/方案/AI 端點全加認證與存取控制、CORS 收緊、錯誤脫敏、body size 上限、私有端點防邊緣快取。server 全部已部署；extension 全部 build 過、**未重上架 Web Store**。詳見 `docs/security-audit-round1.md`（若已產）與各卡。

- PM-135：**AI 端點加認證（P1-3 防 Groq/Workers AI 成本濫用）**（`server/` + `extension/`）— transcribe/summarize/correct 三端點原本無認證，任何人可狂打消耗 Groq 額度/Cloudflare AI（荷包型 DoS）。①三端點開頭加 `getAuthUserId`（401）；②transcribe 額外查 `isActiveUser` → 非付費回 403「Whisper 為付費功能」（免費版走前端 Web Speech 本不該打 Groq）；③transcribe 失敗改回通用「語音轉錄失敗」不洩漏 Groq detail（P2-4）；④extension 補帶 token：`auth.ts` 加 `getAuthHeaderOnly()`（multipart 不含 Content-Type），`background.ts` transcribe（offscreen Whisper，fetch 實在 background SW 執行故讀得到 SESSION_TOKEN_KEY）、`edit-report.ts` correct/summarize 皆補 `getAuthHeaders`。已部署（`065f3cab`）+ build ✅ + curl 驗證（三端點匿名 401、假 token 401、Groq detail 已移除）。
- PM-134：**getUserPlan 防快取 + popup 月費會員狀態**（`server/` + `extension/`）— paid 用戶「看不到會員狀態」真因是 `getUserPlan` 用 `json()` 被 Cloudflare 邊緣快取（回舊/他人狀態）。修法：①getUserPlan 全 return 改 `jsonNoStore`（私有 plan 不被邊緣快取，同 PM-132）+ 回傳補 `plan_expires_at`（與 `expires_at` 並存）；②popup paid/cancelled UI 早在 PM-73/75/111 已完整（`paidBadge`+取消訂閱 link、`cancelledBadge`+到期日、`cancelSubBtn` 二次確認 → POST /api/user/cancel），本卡僅打磨徽章文字「付費版」→「付費版會員」+ 到期日改讀 `plan_expires_at ?? expires_at`。已部署（`7bf26d6f`）+ build ✅ + curl 驗證（no-store 標頭在、匿名/舊 base64 401）。⚠ PM-133 後 FOX 舊 paid 綁舊 UUID，新 Google-sub user 預設 free，需重設 plan 才看得到 paid（乾淨切換後果）。
- PM-133：**認證信任鏈重構（P0-2+P0-3+P1-4，帳號接管根因）**（`server/` + `extension/`）— 根本修法：改「server 驗 Google token audience → 從 Google 推導 user_id → 發 DB token」，全程不信任客戶端 user_id + 移除 base64 fallback。①wrangler.toml `[vars]` 加 `GOOGLE_CLIENT_ID`（= manifest oauth2.client_id）；②新 `verifyGoogleToken`（tokeninfo 驗 aud/azp === client_id，防其他 App token 重放）；③`createSession` 改收 `{google_token,name}` 不收 user_id，`user_id=Google sub`；④刪 `getUserIdFromHeader` + `googleAuth`/`POST /api/auth/google`，`getAuthUserId` 只 `verifySession`；⑤刪過渡 `GET /checkout?user_id=`；⑥extension 登入改 `doLogin`（google_token 送 server，profile 只 client 端顯示）+ 靜默續期 `refreshSessionSilently`；⑦`auth.ts getAuthHeaders` 只讀 DB token（刪 base64 fallback）。已部署（`3d14c901`）+ build ✅ + curl 驗證（假/缺 google_token 401/400、只傳 user_id 400、舊 base64 401、GET checkout 404、/api/auth/google 404）。⚠ user_id 語意由 UUID 改 Google sub（舊報告與新 user_id 脫鉤，屬乾淨切換）；登入實機驗收需真實 OAuth（token aud 須 = client_id）。
- PM-132：**`GET /api/reports` 加認證 + user 過濾（P0-1 全站報告外洩）**（只改 `server/src/index.ts`）— 原本無認證無過濾，匿名者可 `?limit=50` 列舉全站 report_id 再逐一讀完整內容。修法：`listReports` 簽名改 `(request, env)`，`getAuthUserId` 未登入 → 401，查詢加 `.eq('user_id', userId)` 只回自己的報告。getReport 單筆不動（分享連結需要，report_id 不可猜 + 不再洩漏他人 ID = 等效「有連結才看得到」）；MCP list_reports 留 PM-134。**額外**：實測此端點被 Cloudflare 邊緣快取（私有端點以 URL 為鍵快取會跨用戶外洩）→ 新增 `jsonNoStore()`（`Cache-Control: no-store`），listReports 全 return 走它。已部署（`8fd5cca0`）+ curl 驗證（匿名/假 token 401、舊 base64 只回自己空陣列、getReport 隨機 id 仍 404 非 401、no-store 標頭在）。tsc ✅。
- PM-131：**POST body 大小上限（防灌爆 R2 / 濫用）**（只改 `server/src/index.ts`）— Fable 5 稽核 P1❹/P2❼。①`fetch()` 統一路由最前加全域 POST body 10MB 上限（讀 Content-Length，`/api/transcribe` 除外→ 413 請求過大）；②`createReport` 開頭加 5MB 上限（→ 413 報告大小超過 5MB）；③確認 `handleTranscribe` 既有 25MB + 100 bytes 兩道檢查仍在（未動）。新增 `MAX_POST_SIZE`/`MAX_REPORT_SIZE` 常數。已部署（`05039693`）+ curl 驗證（6MB 報告 413、11MB 非 transcribe 413、小報告過 size 進邏輯、transcribe 11MB 豁免 10MB）。tsc ✅。**FOX 手動待辦**：Cloudflare Dashboard Rate Limiting 5 條 IP 限流（非程式碼）。
- PM-130：**安全打磨：CORS 收緊 + FAQ 去競品 + 錯誤脫敏**（只改 `server/src/index.ts`）— Fable 5 稽核 P1❸/P2❿/P2❽。①CORS `*` → `getCorsHeaders(request)` 動態判斷（只放行 bugezy.dev + workers.dev + 任意 chrome-extension://，其餘回退 bugezy.dev；加 PATCH/Authorization/Vary:Origin）；`json()` 只留 Content-Type，CORS 改在 `fetch()` 統一出口注入（主路由包 IIFE + `headers.set` 覆蓋），MCP 端點移到 IIFE 前不套自訂 CORS（避免破壞 Claude.ai）；②FAQ「跟 Jam 有什麼不同」→「BugEzy 最大的優勢」改自身優勢，全站無 Jam；③14 處 500 回應原始 `error.message`/`String(err)` → `console.error` 記 log + 回通用 `GENERIC_500`（400/401/404 不變、MCP 依規格不動）。已部署（`c81e0d89`）+ curl 驗證（bugezy.dev/chrome-extension echo、evil.com 回退、OPTIONS PATCH+Authorization、FAQ 0 Jam；部署後短暫舊值為 CF 邊緣快取，加 cache-buster 即新結果）。tsc ✅。
- PM-129：**Extension 端改用 session token 認證**（`extension/`，server 不動）— 接續 PM-128：①`popup` 登入後 POST `/api/auth/session` 換 DB token 存 `SESSION_TOKEN_KEY`（`ensureSessionToken`，登入 force、啟動補換取）；②新 `extension/src/auth.ts` `getAuthHeaders()` 統一所有 API header（優先新 token、過渡退回舊 base64）；③全站 6 處替換舊 `Bearer ${session.session_token}`（loadPlan/cancelSub/checkRecordingUsage/uploadReport/UPLOAD_MONITOR_REPORT/annotate/day-pass-checkout）；④**月費升級改 POST**——原 `GET /checkout?user_id=`（暴露 user_id）改開新跳板頁 `checkout.html`+`checkout.ts`（讀 session→POST `/checkout` 帶 token→送出綠界表單，沿用日票跳板做法避免 popup blob 撤銷）；⑤登出一併清 `SESSION_TOKEN_KEY`。build.mjs 加 `checkout` entry。tsc + `npm run build` ✅（dist 含 checkout.html/js）。**未 deploy（依指示）；未重上架**。⚠ 需 FOX 先跑 PM-128 sessions 表 SQL，否則 `/api/auth/session` 500→靜默退回 base64（不崩）。
- PM-128：**session token 認證**（`server/src/index.ts` + `schema.sql`）— 原 `getUserIdFromHeader` 只做 base64 decode 無簽章驗證，任何人可偽造 Authorization header 冒充他人（金流端點皆受影響）。修法：①新增 `POST /api/auth/session`（`createSession`：驗/建 user → 產雙 UUID 隨機 token 存新 `sessions` 表，90 天到期 → 回 `{session_token}`）；②新增 `verifySession`（async，查 sessions 表、過期自動刪、token<10 字拒）；③新增 `getAuthUserId`（async fallback：優先 session token，退回舊 base64 過渡）；④全站 5 處呼叫改 `await getAuthUserId`（createReport fallback / getUserPlan / bumpUsage / handleDayPassCreate / ecpayCancel）；⑤月費 checkout 新增 `POST /checkout`（session 驗證，不把 user_id 放 URL），`ecpayCheckout` 簽名改 `(userId, origin, env)`，**保留 `GET /checkout?user_id=` 做過渡 fallback**；⑥schema.sql 加 `sessions` 表 + RLS。已部署（`6d9705f9`）+ curl 驗證（缺 body 400 / 無 auth 401 / 假 token 401 / POST checkout 無 auth 401 / GET checkout 無 user_id 400 / 舊 base64 打到 DB 404）。sessions 表未建時 verifySession graceful 回 null 自動走 base64 fallback 不 500。**FOX 待辦：Supabase 跑 `CREATE TABLE sessions` + `ENABLE RLS`**（未跑前 /api/auth/session 建 token 會 500，既有 fallback 不受影響）。
- 技術債 / FOX 待辦（Day 18 收尾）：
  - **PM-128 `sessions` 表 SQL 待跑**（`CREATE TABLE sessions` + `ENABLE RLS`；未跑前 `/api/auth/session` 建 token 會 500 → 登入拿不到 DB token）。
  - **PM-133 user_id 語意變更**：新登入用 Google sub，FOX 舊 paid 狀態綁在舊 UUID row → 新 user 預設 free；要看到付費狀態需把新 user_id 的 `plan` 設 paid（或重走綠界月費）。舊報告（綁舊 UUID）與新 user_id 脫鉤，屬乾淨切換。
  - **PM-133 登入實機驗收**：`chrome.identity` token 的 `aud/azp` 必須 = manifest client_id（= 已設的 GOOGLE_CLIENT_ID）才能登入——信任鏈唯一未測點。
  - **PM-131 §2 Cloudflare Dashboard Rate Limiting**（5 條 IP 限流，非程式碼）。
  - **extension 整套未重上架 Web Store**（PM-129~135 的 checkout.html/session token/AI 端點帶 token 等皆需重打包送審）；上架時 manifest version 需對齊 `/api/version` latest。
  - 沿用：PM-94 綠界 4 secret、PM-93 service_role secret + rls-lockdown.sql、PM-73/82/109 ALTER、PM-98 backfill；無 git remote（push 無法執行）。
- 收工：CHANGELOG + ARCHITECTURE + project_status + job-0703 各卡回報同步 + commit（push 待有 remote）

## 2026-07-02

第 5 代 Day 17（PM-94 + 108~127，21 卡）。**綠界 ECPay 正式環境遷移** + **日票 NT$20/24hr 三部曲** + AI 指令輪盤（一路打磨）+ 進階設定折疊 + 即時監控狀態條&上傳報告 + 新版通知&/changelog。server 部分已部署；extension 部分皆 build 過、**未重上架 Web Store**。

- PM-94（部分）：**綠界 key 從 `wrangler.toml` 明文遷移到 `wrangler secret` + 切正式環境**——刪 wrangler.toml 四行 ECPay 明文（測試值）+ deploy 清舊 vars binding（Version `8882f769`，Vars 只剩 SUPABASE_URL）；確認 Env 型別 + 全 code 走 `env.ECPAY_*`（src 無寫死測試值）。**§3 四個 `wrangler secret put`（正式 MerchantID 3505501/HashKey/HashIV/`payment.ecpay.com.tw`）由 FOX 手動執行**；未跑前 ECPay 讀不到 key（過渡狀態）。wrangler.toml 變更隨 PM-94 收尾一起 commit。
- PM-108：首頁定價「立即升級」`href="#"` → 「安裝後即可升級 →」`/install` + `pricing-hint` + 免費版加「免費安裝 →」`free-btn`（首頁無法直接付款，先裝擴充）。已部署（`3f683e30`）
- PM-109：**日票 NT$20 後端（1/3）**——`day_pass_expires_at` schema + `POST /api/day-pass/create`（`ChoosePayment:ALL` 一次性、非定期定額）+ `/callback`（開通 24h）+ `/day-pass-success` + `isActiveUser()` 統一 plan 判斷（paid‖cancelled‖day_pass 未到期）+ `getUserPlan` 到期自動降 free。複用 `generateCheckMacValue`/`timingSafeEqualStr`。已部署（`7e0aedff`）。**FOX 待辦：跑 `day_pass_expires_at` ALTER**
- PM-110：**日票前端（2/3）**——首頁定價區加日票第三欄（沿用 `.plans` auto-fit grid，橘框卡 +「⚡ 試試看」badge + `NT$20/24hr` + `day-btn`，付費卡加「✨ 最划算」badge）。已部署（`70eec402`）
- PM-111：**日票 popup UI（3/3）**——升級區改「⚡ 日票／✨ 月費」雙鈕 + 日票中 ⚡badge 倒數（`剩餘 Hh Mm Ss`，到期 reload）+ 鎖月費。⚠ 因 `/api/day-pass/create` 是 POST+auth（不能像月費 GET 直開分頁），新增 `day-pass-checkout.html/ts` 跳板頁（讀 session POST 建單 → 手動 submit 綠界表單、繞 MV3 CSP inline）
- PM-112：首頁 + `/install` 加「🤖 讓 AI 幫你安裝」一鍵複製提示詞區塊（Chrome 商店連結 + MCP config JSON + copy-btn clipboard + ✅ 反饋）
- PM-113：支援工具列表全站統一為 7 項（+**Google Antigravity / Gemini CLI**）；首頁 `.ai-tools` 標籤雲 + `.ai-install-tools` + `/install` 頂部描述/Step5/config 行皆改（guide/faq/privacy 依規格不動）。已部署（`d8e2841d`）
- PM-114→121：**AI 指令輪盤（popup 底部）一路迭代**——114 建輪盤（4 則預設可編輯 + ◀▶ + 一鍵複製全文，`bugezy:ai-prompts`）→ 115 複製鈕右移 + 顏色標記（`PromptItem{text,color}`，`normalizePrompts` 向下相容舊 `string[]`）→ 116 編輯中 ◀▶ 同步 textarea + 自動存 → 117 複製鈕移標題列 + 標題改文案 → 118 標題加大 + SVG 疊框 icon + 收合/釘選 → 119 修標題直排 bug（`min-width:0`+nowrap+ellipsis，標題縮短）→ 120 三行式重排 + 複製鈕加大帶文字 → **121 定案**：刪釘選、永遠展開、標題「一鍵複製指令貼給 AI」
- PM-122：popup 四個設定 toggle 折疊進 `⚙️ 進階設定` accordion（預設收合，`bugezy:settings-open` 持久化；toggle id 不動故邏輯零改）
- PM-123：即時監控浮動 icon（`🐛 ✓`/`🐛 N`）改文字狀態條——無錯誤綠靜態「🟢 BugEzy 監控中」/有錯誤橘脈衝「⚠️ 發現 N 個錯誤（點我查看）」（點擊開既有 error 面板；inject 為 MAIN world 無 chrome.runtime，未做規格的 OPEN_LATEST_REPORT 死路徑）
- PM-124：即時監控 error panel 加「📤 上傳報告讓 AI 分析」——inject 打包 payload → `window.postMessage` → content → background POST `/api/reports`（綁 `user_id`，PM-98 教訓）→ 回鏈更新按鈕；新 `UPLOAD_MONITOR`/`MONITOR_UPLOADED`/`UPLOAD_MONITOR_REPORT` 訊息
- PM-125：報告頁 + MCP Token 估算金額全站 `≈ $` → `≈ USD $`（7 處）。已部署（`cde47463`）
- PM-126：**新版通知亮燈 + `/changelog` 頁**——server `/api/version`（latest 1.1.0）+ `/changelog`（v1.1.0/v1.0.0）+ 全頁 footer 加「更新日誌」；popup `checkNewVersion` 版號≠manifest 亮紫藍漸層 `update-badge` 點擊開 changelog。已部署（`24d845b9`）
- PM-127：popup 亮燈條改「🆕 目前 v{cur} → 新版 v{latest} 可用」+ 底部永遠顯示「BugEzy v{version}」（`#popup-version`）
- 技術債（沿用+新增）：**PM-94 §3 綠界 4 個 secret 待 FOX 跑**（未跑前結帳失敗）；**PM-109 `day_pass_expires_at` ALTER 待跑**；沿用 PM-73/82 ALTER、PM-93 service_role secret + rls-lockdown.sql、PM-98 backfill-user-id.sql；extension 整套（日票 popup + 輪盤 + accordion + 監控上傳 + 版本亮燈）未重上架 Web Store；上架時 manifest version（現 `0.1.0`）需與 `/api/version` latest（`1.1.0`）對齊；無 git remote（push 無法執行）
- 收工：CHANGELOG + ARCHITECTURE + project_status 同步 + commit（push 因無 remote 無法執行）
