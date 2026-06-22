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
