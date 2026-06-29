# BugEzy Changelog

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
