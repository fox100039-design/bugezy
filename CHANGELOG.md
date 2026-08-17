# BugEzy Changelog

## 2026-08-17（瀏覽器錯誤 PII 遮罩）

**PM-367**：把 PM-366 列為「待 FOX 決策」的那一項做掉。全套 **567 / 0**（新增 `_verify367` 47 項）。

- **共用同一組 regex**（驗收條件 7）：把 `cli/src/pii-mask.ts` 的四組 pattern 改為 export，bridge vendor 逐字同步（防漂移測試仍過），`pii-browser.ts` 直接 import。**`maskStderr` 自己的輸出一個字都沒變**，終端機仍是 `***MASKED***`。
- **保留型別標籤是關鍵，不是裝飾**：`<masked:JWT>` 讓 AI 知道「這裡本來是 JWT，可能過期或格式錯」；一坨 `***` 只剩「有東西被遮掉了」。**遮罩不該讓工具失去用處**——這正是 PM-366 當時先不動手的原因。
- 🔴 **網址只遮 query 的敏感參數值，`path` 一個字元都不能改** —— `correlate_errors` 靠 path 配對前後端錯誤，動了 path 等於把那支工具弄壞。參數名保留（AI 要知道是 `api_key` 還是 `signature` 出問題）。
- 🔴 **先分級再遮罩** —— 順序反過來，PM-351 的自訂嚴重度規則會比對到已被遮掉的字串而失效。
- **多做兩個套用點**：卡片列了四個，另外補上 `start_auto_detect` 的 `critical_errors` 與 `correlate_errors` 的 `frontend.url` —— 那兩支回的是**同一批資料**，不遮的話 PII 只是換一支工具流出去。
- **Stripe key／Bearer／Basic 等瀏覽器情境的額外樣式放在 `pii-browser.ts`，不塞進共用檔** —— 共用檔同時被已發布的 CLI 使用，往裡面加樣式等於改變既有使用者的上傳行為。
- 🔴 **追出困擾多輪的 `get_web_vitals` 端到端不穩定的真正原因**：**背景／被遮住的視窗不會 paint**。Chrome 在視窗未取得焦點時節流算繪，`first-contentful-paint` entry 從頭到尾不會產生，LCP/FCP 就永遠是 null——**等多久都沒用**（PM-366 的有界輪詢因此只治好一半）。試過「先重新導航再量」反而更糟（多一次載入 → 出現載入逾時與 ready_state 不穩），已撤回。**這是環境條件、不是產品缺陷**，工具回 null 而非編數字是正確行為。改為標示 **LIMIT**（既不計 pass 也不計 fail，但一定印出來），並在受限時仍嚴格驗證其餘指標（TTFB／CLS／載入時間／FID 誠實說明）確實正常。`get_page_health` 的分數同理（`poor_vitals` 扣分源自量不到的指標）。

## 2026-08-17（安全盤點 + 修復）

**PM-365~366**：攻擊面盤點 5 大類 15 項，修掉 1 個 P0、1 個 P1、2 個 P2；3 項接受風險並記錄理由。全套 **514 / 0**（新增 `_verify366` 18 項）。

- **PM-365** 盤點（未改碼）。逐項讀原始碼查證，不憑推測。**已經站得住的**：`navigate_to` 白名單、content script 無 `all_frames`（跨域 iframe 點不到）、password 欄位值全數遮蔽、`captureVisibleTab` 截不到瀏覽器 UI、終端機 stderr 與指令回聲皆遮罩。
- **PM-366** 修復：
  - 🔴 **P0：Bridge WebSocket 加 Origin 驗證。** `ws://127.0.0.1` 被瀏覽器視為 potentially trustworthy、**不受 mixed-content 阻擋**——使用者造訪的**任何網站**都能連上 19850。而連線處理是「新連線取代舊連線」，所以惡意頁面可以把真的 Extension 踢下線，並**冒充它餵給 AI 捏造的頁面內容**（不是 RCE，但足以讓 AI 基於偽造的事實工作）。已擋。實測四種網頁 Origin 全被拒、擴充功能放行，**並驗證被拒的連線無法踢掉既有連線**——那才是真正的傷害面。最重要的回歸：**真實 Chrome 擴充功能仍連得上**（190 項端到端全過）。
  - 🔴 **P1：`memory_export` 限制在專案目錄內**，且不覆蓋既有的非備份檔。原本 `path.resolve` 不設限 → 可覆蓋磁碟任何檔案。**這條擋的是提示注入**：AI 讀得到頁面內容，頁面內容攻擊者可控。
  - P2：`memory_save`／`memory_update` 加長度上限、`memory_import` 加 50 MB 上限（**先 stat 再讀**——先讀進來才檢查等於沒檢查）。
  - ⚠ **三項明確不修並附理由**：本機程式可連 bridge（Origin 擋不住，需 token 交握）、`start_terminal_monitor` 可執行任意指令（那是功能本身）、瀏覽器 console／網路 URL 未遮罩 PII（**待 FOX 決策**：錯誤裡的 token 往往正是要查的東西，遮掉會讓工具沒用）。
  - 🔴 **順手修掉既有的測試不穩定**：`get_web_vitals` 端到端約每 3 次 FAIL 一次。原本用 `sleep(1500)` 處理導航競態——**固定等待只是把競態變慢，不是消除它**（PM-347 學過一次）。改成有界輪詢等到真的 paint；頁面若根本沒 paint 仍會 FAIL，不掩蓋真問題。連跑三次皆 190/0。

## 2026-08-17（Phase 6 方案分層 + 免費版用量）

**PM-362~364**：bridge 新增 `tier-gate.ts`（工具數不變，仍 51）；Workers 端雲端 MCP **13 → 14**（新增 `get_usage_quota`），已 deploy `07ff249b`。全套 **0 failed**：`_verify_phase1` 190、`_verify309` 151、`_verify327` 21、`_verify350` 27、`_verify355` 81、**`_verify362` 26**（真的 spawn 六個不同方案的 bridge）。規格書 §9 Phase 6 的 PM-P／PM-Q 標 ✅。

- **PM-362** 方案分層：`TOOL_TIER_MAP` **涵蓋全部 51 支**，驗收拿註冊清單與對照表**雙向比對** —— 新增工具忘了分層會直接測試失敗，而不是默默套用預設值。**預設仍關閉**（理由同 PM-321：本機拿不到真實 tier）。
  - `ping` / `get_page_url` 永遠不擋：擋掉的話使用者連「為什麼 bridge 不能用」都查不出來。
  - 🔴 **`start_auto_detect` 依參數分層**：`quick` = Pro、`full` = Max。只靠對照表會變成「整支工具都要 Max」，把 Pro 用戶的 quick 模式一起擋掉。已分別測 pro+quick 放行、pro+full 擋下、省略 depth 視同 quick。
  - **兩處 fail closed**：沒列在表裡的工具當 Pro、`BUGEZY_USER_TIER` 給不認得的值當 free。反過來寫都會讓閘門形同虛設。
- **PM-363** 免費版用量：**10 次/月的限制 PM-63／PM-170 就已上線**（`bumpUsage`，含票券/日票/付費無限與自動重置），本次補的是查詢介面 **`get_usage_quota`**。
  - **唯讀**：查詢不消耗額度、**也不觸發重置** —— 否則「看一下還剩幾次」就會把重置日往後推。
  - 無限判定重用 `bumpUsage` 的同一組邏輯（含 `hasActiveTicket`）：PM-267 踩過「popup 說無限、後端第 11 次擋掉」的前後端不一致。
  - 「email 不存在」與「token 不符」**回同一句話**，不幫人確認某個 email 有沒有註冊。
  - ⚠ **兩處卡片與實際不符，未改並已回報**：① 重置是**30 天滾動制**不是曆月 1 號（改了會位移每個現有免費用戶的重置日）② **MCP 讀取有計入用量**（卡片寫不計），與 `/pricing`、`/faq`、`/privacy` 三個公開頁面的公告衝突。
- **PM-364** 收工。

## 2026-08-17（§14 八層記憶矩陣 完工）

**PM-355~361**：bridge 工具總數 **37 → 51**（+13 記憶工具 +1 `memory_stats`）。全套 **0 failed**：端到端 `_verify_phase1` **190**、jsdom `_verify309` **151**、終端機 `_verify327` **21**、嚴重度 `_verify350` **27**、記憶矩陣 `_verify355` **81**。規格書 §9 加 **§14 ✅**，並新增 **§14.13 實作註記**列出十處落差。

- **PM-355** `.bugezy/` 基礎建設：從 CWD 往上找（跟 git 找 `.git/` 一樣），找不到就是空白記憶、等第一次 `memory_save` 才建立。本機 **7 個 JSON，沒有 L3**（決策 4：客服知識庫在雲端）。`.gitignore` 內容是 `*` + `!.gitignore` —— **必須自我忽略**，否則規則檔連同被忽略，下一個 clone 的人就沒有這道防線。
  ⚠ **`auto_merge` 目前是保留欄位**（§14.12.4 的自動合併未實作），這件事直接寫進 `config.json` 的 `_note`，免得使用者設了以為有效。
- **PM-356** `memory_save` / `memory_learn` ＋ 淘汰。**淘汰看 `last_hit_at` 不看 `created_at`** —— 三年前寫但每月命中的經驗，價值遠高於上週寫完再也沒用過的那條（已用「舊但熱／新但冷」兩條資料實測）。只有 L1 有筆數上限、只有 L7 有保存天數（§14.12.4 就只定義這兩條）。**`L3` 收在 enum 裡再明確擋掉**，不然 AI 只會看到 zod 的「Invalid enum value」而一直重試。
- **PM-357** `memory_search` / `memory_get`。topic ×3、tags ×2、內文 ×1。**search 更新 hit_count、get 不更新**（精準提取不算使用頻率）；搜不到時回空陣列＋「還沒學過，不是搜尋失敗」。
- **PM-358** 三支守衛。🔴 **這張卡最重要的一件事：`passed: true` 不能等於「我檢查不了」。** L6／L4 的規則多半是自然語言，機器評不了；實作改成兩段式——標了 `regex:` 的機器逐條查，其餘原文放進 `rules_needing_ai_review` 交還給 AI，summary 明講「還有 N 條只能人工判讀」。少了這段，AI 會把「沒辦法檢查」讀成「檢查過沒問題」。
  另：`memory_audit` 內建四類機密樣式（L6 空著時也有東西可查）、**只掃 diff 的 `+` 行**、**違規不回原始行**（回了等於把機密再複製一份進 context）；`memory_perf_check` **會判斷指標方向**（ops/s 變大是進步不是衰退）、**單位不同直接拒絕比較**；**三支一個檔案都不寫**。
- **PM-359** `memory_update` / `delete` / `list` / `clear`。list 的 content 截到 200 字省 token；**`memory_clear` 沒帶 `confirm: true` 直接拒絕，並告訴你會損失幾條**。
- **PM-360** `memory_export` / `memory_import`。merge 同 id 跳過、overwrite 覆蓋；**匯入檔裡的 L3 列為 ignored 而非寫進本機**。🔴 匯出檔落在專案根目錄、**不受 `.bugezy/.gitignore` 保護**，又含 L1 真實檔名修法與 L6 資安鐵律 —— 回傳帶明確警告。
- **PM-361** 全套驗收 ＋ 收工。端到端把 bridge 的 CWD 指到暫存專案，**避免在 repo 裡真的長出一個 `.bugezy/` 被 commit 進去**。

## 2026-08-17（Phase 5 嚴重度 + 自動化 完工）

**PM-350~354**：bridge 工具總數 **30 → 37**（+7 Phase 5）。全套 **0 failed**：端到端 `_verify_phase1` **159**、jsdom `_verify309` **151**、終端機 `_verify327` **21**、嚴重度 `_verify350` **27**。規格書 §9 **Phase 5 標 ✅**。

- **PM-350** 嚴重度自動分類（§6）：`get_error_summary` + 三支錯誤工具每筆帶 `severity`。**分類器放 bridge 而非 content script** —— 瀏覽器／終端機／zone 三條路徑要共用同一套判定，而終端機錯誤根本不經過瀏覽器，唯一交會點就是 bridge。`get_page_health` 改用權重計分（critical −10／minor −3／info 0）。
  🔴 **端到端抓到自己造成的矛盾**：分數重算了，但 `summary` 那句話是 content script 依**舊分數**組的 —— 回傳會同時出現「90 分」的句子和另一個 `score`。**AI 通常只讀 summary**，等於直接拿到錯的數字。已把句首數字一起換掉。
- **PM-351** 自訂規則：`add_severity_rule` / `list_severity_rules` / `remove_severity_rule`。自訂**優先於內建**；`ignore` 的錯誤**整筆濾掉**而非只標記（使用者說忽略，就不該再出現在任何結果裡）；**不合法的 regex 當沒命中**，不讓一條打錯的規則害所有錯誤查詢都掛掉；規則存**記憶體、重啟清空**，刻意不寫檔。
- **PM-352** `start_auto_detect` / `get_detect_report`：**不新增任何偵測能力**，只把 `map_page_zones` → `get_browser_errors` → `get_web_vitals` → `get_zone_health`（full 再加每個非健康 zone 的 `analyze_element`）串成一次呼叫，價值在省掉 AI 的多輪往返。定名 `start_auto_detect` 而非卡片草稿的 `start_monitor`，避免與 Phase 3 的 `watch_zones` 混淆。
- **PM-353** `correlate_errors`：前端 4xx/5xx ←→ 終端機 traceback。時間窗口內 **+ URL path 命中後端訊息／堆疊** → `high`；只有時間窗口 → `medium`；3 倍窗口內 → `low`。**未配對的兩邊都計數** —— 只回配對結果會讓人誤以為「沒關聯就是沒問題」。沒有終端機監控時回**具體下一步**而非空陣列（空陣列有歧義：沒配到？還是沒在監控？）。
- **PM-354** 收工：規格書 §9 Phase 5 標 ✅、ARCHITECTURE 補嚴重度／自動偵測／關聯診斷三節、CHANGELOG。

## 2026-08-17（Phase 3 Zone Grid 完工）

**PM-341~347**：bridge 工具總數 **22 → 30**（+8 Zone Grid）。jsdom 驗證 **151 項 0 failed**；端到端 127/1（唯一 FAIL 待擴充功能重新載入）。規格書 → **v1.3**，§9 的 Phase 1/2/3 全數標 ✅。

- **PM-341** `map_page_zones`：依 §15.2 四層規則分區。**巢狀的內層 zone 會被去掉**（否則同一錯誤同時屬於兩區、歸類沒有唯一解）；**`zone_id` 依名稱保持穩定**（否則 §15.4 時間軸每次換頁就斷）；規則 3 只看 body 直接子層（全頁掃描會把頁面切得太碎）。`unassigned_count` **一律回傳，不做「0 就省略」**。
- **PM-342** error 歸類 —— 🔴 **§15.3 原本的「stack trace 反推 DOM」做不出來**（stack 只有檔名:行:列，瀏覽器沒有 frame→節點的 API）。改為**在錯誤發生當下抓現場**：資源錯誤用 `event.target`（最準）／事件用 capture 記下的最後互動元素／fetch 用 `activeElement`／抓不到 → Unassigned。**記 selector 字串而非元素本身** —— 這筆資料要經 postMessage 跨 world，DOM 節點不可序列化。新增的是**可選欄位**，既有錯誤收集完全不變。
- **PM-343** `get_zone_health` / `get_zone_errors`：`unassigned` 是**獨立欄位、永遠回傳**，且工具描述寫死一句「全綠不代表沒問題，一定要讀 unassigned」—— §15.8 的規則是「✅ 就跳過」，而抓不到現場的往往正是 `setTimeout`／Promise 深處這類最難查的錯誤。
- **PM-344** Zone 覆蓋層：§15.5 兩處矛盾照正解實作（`pointer-events` 分兩層、樣式不注入 `<style>` 字串）。四層覆蓋層 z-index 分層：Zone < 高亮 < 圖釘 < 面板。
- **PM-345** `watch_zones` / `get_zone_changes` / `stop_watching_zones`：**Pull 模式是唯一可行解**（MCP 沒有 server→模型的推播通道），描述用大寫 PULL-based 講明，避免 AI 啟動後傻等通知。讀取即清空；**未啟動監控時回明確說明而非空陣列**（空陣列在此有歧義）。
- **PM-346** `suggested_action`：healthy 回 `null` 省 token；**Unassigned 的建議指向 `get_zone_errors` 而非 `pin_analyze`**（它沒有 selector，硬給一個會讓 AI 拿著不存在的 selector 去釘 —— 看似有幫助卻把 AI 導進死路的建議，比沒有建議更糟）。
- **PM-347** 收工。🔴 **順手抓到一個自己造成的回歸**：新加的端到端在 zone 區段開頭多做了一次 `navigate_to`，但分頁本來就在該頁 —— 這次多餘的重載把 `performance` 的 paint entries 清掉，導致 `get_web_vitals` 的 LCP/FCP 變成 `null`。移除後即恢復。**工具本身的行為是誠實的**（拿不到就回 null 而非編一個數字），否則這個回歸完全看不出來。

> **待 FOX**：**重新載入擴充功能**（`npm run build:dev` 產物已備妥）→ Zone Grid 的端到端即可補完。這次不需要重連 MCP。

## 2026-08-17（Phase 2 完工 + Phase 3 視覺化）

**PM-334~339**：bridge 工具總數 **17 → 22**（11 瀏覽器 + 3 終端機 + **6 圖釘** + **2 面板**）。jsdom 真實 DOM 驗證 **115 項 0 failed**。

- **PM-334** `patrol_pins`：一次巡檢全部圖釘並標出**與上次相比的變化**。
  🔴 **測試抓到真 bug**：`pin_analyze` 在元素消失時只回一個裸錯誤、**沒有把既有圖釘標成 `stale`** —— 巡檢看到的還是舊的 `active`、`changed: false`，等於「元素不見了但沒人發現」。已修。
  另：`alert_count` 數的是**狀態有變**而非「有問題」的圖釘 —— 一個一直 warning 的圖釘不該每次巡檢都觸發警報。
- **PM-335** `remove_pin` / `clear_pins`。
  🔴 **卡片的 `status: 'resolved'` 在目前模型裡不存在**（PM-329 已改為 `warning`，`resolved` 當時沒有任何路徑會設定它）。照字面接受會得到一個**永遠篩不到東西的過濾器**：AI 拿到 `cleared: 0` 卻無從得知是「沒有符合的」還是「這個值根本沒用」。改為**明確報錯並列出合法值**。
- **PM-336** Phase 2 收工（規格書 §9 Phase 2/3 標 ✅、CHANGELOG、ARCHITECTURE）。
- **PM-337** 藍框巡察動畫（純視覺，不新增 MCP 工具）：已整合進 `click_element`（0.5s）／`analyze_element`（2s）／`pin_element`（1s）／`patrol_pins`（依序）。同時上限 5 個先進先出；**動畫用 `CSSStyleSheet` 而非注入 `<style>` 字串**（Trusted Types 網站會擋）；**找不到元素時靜默略過** —— 純視覺功能不該讓它的失敗影響呼叫端真正的工作。
- **PM-338** 圖釘狀態顏色（綠 `#00c853` / 黃 `#ffd600` / 紅 `#ff1744` / 灰 `#9e9e9e`）+ `patrol_pins` 的 summary 加狀態 emoji。卡片色表列的 `resolved → 淡綠`同樣因為該狀態不存在而未實作。
- **PM-339** 右下角即時面板：**shadow DOM 隔離**（注入的是任意使用者的網站，一般 DOM 會被對方 CSS reset 弄爛，我們的樣式也可能反向汙染）；預設收合、可展開／拖動／關閉；每 10 秒更新；`show_debug_panel` / `hide_debug_panel` 兩支工具供 AI 控制。

> **待 FOX**：① **重新載入擴充功能**（`npm run build:dev` 產物已備妥）② **重連 MCP** —— 目前 port 19850 由本 session 的 MCP server（舊版 17 支）占用，新工具的端到端因此尚未執行。

## 2026-08-16（Phase 2 圖釘 + PM-D2 終端機）

**PM-326~332**：bridge 工具總數 **11 → 17**（11 瀏覽器 + 3 終端機 + 3 圖釘）。全套回歸 **216 項 0 failed**（`_verify_phase1` 111 + `_verify309` 84 + `_verify327` 21）。server 已 deploy（Version `b5529590`）。

- **PM-326** bugezy-watch CLI 盤點（未改碼）。關鍵發現：**CLI 全檔只有一個 POST，沒有任何讀取通道** —— 沿用它就得做「CLI 推 Workers → bridge 拉 Workers」，多一次往返且**資料會離開本機**。而 bridge 自己就是 Node process，直接 spawn 攔 stderr 即可。這一點決定了 PM-327 的路徑。
- **PM-327** `start_terminal_monitor` / `get_terminal_live_errors` / `stop_terminal_monitor`（**21/21**，真的 spawn 子程序）。
  🔴 **測試抓到真外洩**：錯誤內容有遮罩，但**回聲的 `command` 欄位是原封不動回傳的** —— `DATABASE_URL=postgres://u:pw@h/db npm run dev` 這種寫法極常見，而該欄位每次查詢都會回傳給 AI，等於**把憑證反覆送進 context**。四處回傳全部補遮罩。
  另：**`parse-traceback.ts` / `pii-mask.ts` 是複製而非 import**（bridge 要 `npm publish`，相對路徑在發布包裡不存在），並用逐字比對測試防漂移；窗口 120 秒；保留 `unparsed_stderr`（解析器只支援 Python／Node，只回 `errors` 會讓 Go／Rust 使用者以為沒事）；Windows 用 `taskkill /T` 收孫程序。
- **PM-328** `bugezy.dev/test-errors` 測試頁部署，**313-3 LIMIT → PASS**（抓到真實 404）。
  🔴 **卡片的 `fetch('https://httpstat.us/500')` 會被 CSP 擋掉**（`connect-src 'self'`），得到的是 CSP 違規的 TypeError 而非要測的 5xx —— 改為全同源並新增 `/api/test-error-500`。另加 `noindex, nofollow`（HTTP 標頭 + meta 兩層）、不進 sitemap、中英雙語「這不是 bug」警告。
- **PM-329** Phase 2 圖釘系統設計（未改碼）。
- **PM-330** `pin_element`：覆蓋層外層 `pointer-events:none`／圓點 `auto`（PM-304 的結論）、**一律 DOM API 不用 `innerHTML`**（Trusted Types 網站會擋，PM-69 的坑）、重複釘同一 selector 更新而非新增。
- **PM-331** `pin_analyze` + `get_pin_results`（複用 `analyze_element`，不另寫分析）。
  🔴 **新增 `stale` 狀態**：SPA 換頁後被釘的元素會從 DOM 消失 —— 那既不是正常也不是「元素有問題」，回成 error 會讓 AI 去查一個不存在的東西。改為轉灰標 `stale` 且**不刪除**（AI 需要知道釘的東西不見了）。
- **PM-332** 全套回歸 216/216。
  🔴 **發現一個自己造成的回歸**：PM-330 的一般 `node build.mjs` **靜默把 dist 的 dev manifest 蓋掉**，FOX 重載後 `take_screenshot` 又變回權限受限 —— 而且看起來像功能壞掉、不像 build 參數問題。已加 `npm run build:dev`，且一般 build 偵測到「先前是 dev manifest」會明確警告。

> **bridge 17 支工具**：`ping` · `get_page_url` · `navigate_to` · `click_element` · `read_page` · `type_text` · `take_screenshot` · `get_browser_errors` · `analyze_element` · `get_web_vitals` · `get_page_health` · `start_terminal_monitor` · `get_terminal_live_errors` · `stop_terminal_monitor` · `pin_element` · `pin_analyze` · `get_pin_results`
> ⚠ **PM-321 的 `isActiveUserId({ active, tier })` 已隨 PM-328 一併 deploy 上線**（向下相容，4 處呼叫端皆已改用 `.active`）。
> **待 FOX**：以 `npm run build:dev` 產物重新載入擴充功能 → `take_screenshot` 的 LIMIT 即可轉 PASS。其餘既有待辦不變。

## 2026-08-16（Phase 1 完工）

**v2 Phase 1 核心完成（PM-305~324）**：`bugezy-bridge` 共 **11 支 MCP 工具**，**11 支全部通過真實 Chrome 端到端驗收**（`take_screenshot` 需開發版 manifest 的 `<all_urls>`；上架版仍受 `activeTab` 限制）。規格書 v0.8 → **v1.1**。server 未 deploy（`isActiveUserId` 改動待下次 deploy）。

- **PM-305** §3 ＋ §12 A-3：Native Messaging → localhost WebSocket，與 PM-297~299 的實作對齊；**修正卡片三處與程式碼不符**（WebSocket client 在 `background.ts` 非 `content.ts`、位址是 `127.0.0.1` 非 `localhost`（後者會先解析到 IPv6 `::1` 而連不上）、延遲來源標錯）。
- **PM-306** Day 43 收工。
- **PM-307~309** `navigate_to` / `click_element` / `read_page`（端到端 71/71）。
  - **`navigate_to`**：`tab.url`/`tab.title` 需 `tabs` 權限、只有 `activeTab` 時 Chrome **靜默回空字串**，改問 content script；bridge 逾時改為**逐指令可設**（原本 10 秒會先於擴充功能的 30 秒載入上限觸發，讓 AI 拿到錯誤的失敗原因）。
  - **`click_element`**：disabled／不可見／尺寸 0 的元素 `el.click()` **不會拋錯也不會有反應** —— 一律先檢查再點，**不假裝成功**。
  - **`read_page`**：卡片的「每個元素印 `textContent`」會**逐層重複整頁文字**，50000 額度在前幾個元素就吃光；改為只印直屬文字。interactive 元素另附**經驗證唯一命中**的 selector（`[tag#id.class]` 只是描述，`.btn` 可能命中十個）。
- **PM-310** 端到端驗收基礎建設；**harness 的 `proc.kill()` 在 Windows 收不掉子程序**，改 `taskkill /T /F` 並加受限的 port 回收（只回收自己洩漏的，不動 Claude Code 的 MCP server）。
- **PM-311** `type_text`：**只做 `el.value = x` 再 dispatch 事件在 React 上無效** —— React 的 `_valueTracker` 會判定「值沒變」而忽略整個事件，畫面有字但 state 沒動。改走 prototype 原生 setter 繞過 tracker。
- **PM-312** `take_screenshot`：實測確認 `captureVisibleTab` **需 `activeTab` 或 `<all_urls>`，而 bridge 呼叫永遠沒有使用者手勢**；圖片改走 MCP 原生 image content（塞進 JSON 會灌爆 context）。
- **PM-313** `get_browser_errors`：沿用 `inject.ts` 既有攔截，**但發現緩存是 30 秒滾動視窗** —— 不揭露的話「空陣列」會被讀成「這頁沒問題」。不回傳 `requestBody`/`responseBody`（可能含 token／個資）。
- **PM-314** 移除 bridge 舊 `get_live_errors`（驗收 113/113）；`content.ts` 的 `GET_LIVE_ERRORS` **保留不動**（即時監控仍在用）。
- **PM-315** `analyze_element`：`event_listeners` 改為物件並明講**空清單不代表沒有處理器**（現代網站都用 `addEventListener`，content script 列舉不到）。
- **PM-316** `get_web_vitals`：**`buffered: true` 是關鍵** —— 少了它，LCP/CLS/FID 在任何「載入完才呼叫」的情境都回 null，而那正是唯一的使用情境。資源大小揭露為**低估值**（跨網域無 `Timing-Allow-Origin` 時 `transferSize` 為 0）。
- **PM-317** `get_page_health`：一鍵健檢 0~100。**`alt=""` 是合法的裝飾性圖片**（算成問題會在做得越好的網站上誤報越多）；「input 沒 label」有五種合法寫法；**`null` 的指標不列入扣分**（否則每個還沒被互動的頁面都平白失分）。
- **PM-318** 端到端驗收 171/171。
- **PM-319** `read_page` 補 `ready_state`（DONE-310 留項）—— 少了它，AI 分不出「這頁真的空」與「還沒載完」。
- **PM-320** §13.2 回填截圖權限實測結論：三條路線**都繞不開 `<all_urls>`**，門檻不在「分頁可不可見」而在「有沒有使用者手勢」；FOX 決策：不急上架、1~3 個月維持 v1.1.5。
- **PM-321** 方案等級判斷雛形：`isActiveUserId` 回傳 `{ active, tier }`。**物件恆為 truthy，4 處呼叫端全部改為 `.active`** —— 漏改會讓付費檢查永遠不擋人且完全不報錯。bridge 9 支 v2 工具套閘門，預設關閉。
- **PM-322** 開發版 manifest（`DEV=true` 合併 `<all_urls>`），**上架版永不被寫回**。
- **PM-323** 全工具端到端驗收：**178 項全數通過、0 failed**（`_verify_phase1.mjs` 106 + `_verify309.mjs` 72）。以開發版 manifest 重新載入後，`take_screenshot` 由 `LIMIT` 轉 `PASS`（1600×765 PNG，解碼後 IHDR 尺寸與回報值一致），`ready_state` 兩項亦轉 PASS。**程式碼從 PM-312 起未改一字，只換 manifest 就從「權限被拒」變正常** —— 反向證實 PM-312／320 的實測結論方向正確。
- **PM-324** 規格書 §9 Phase 1 進度更新（PM-A~D + B2 完成，PM-D2 待辦）。

> **bridge 工具總數 11**：`ping` · `get_page_url` · `navigate_to` · `click_element` · `read_page` · `type_text` · `take_screenshot` · `get_browser_errors` · `analyze_element` · `get_web_vitals` · `get_page_health`

> **待 FOX**：① `server` 尚未 deploy（`isActiveUserId` 改動）② 其餘既有待辦不變（v1.1.5 送審、`DISCORD_WEBHOOK_URL`、`ticket-expiry-notify.sql`、`REPORT_CLEANUP`、`ADMIN_TOKEN`、HSTS、GSC）。
> **Phase 1 剩餘**：PM-D2（bugezy-watch 即時化）。

## 2026-08-16

Day 43（PM-302~306）。**純規格書日**——v2/v3 規格書 v0.5 → **v0.9**，`§1~§15` 完整、**48 個 MCP 工具**、**決策 1~6 全定案**。extension／server／bridge 皆未動，未 deploy。

- **PM-302 §14 The Octa-Memory Matrix（八層記憶矩陣）**（v0.5→v0.6）。L1 Debug 經驗庫／L2 專案知識庫／L3 客服知識庫／L4 商業邏輯庫／L5 外部依賴庫／L6 資安合規庫／L7 效能帳本庫／L8 團隊協作庫，每層「為什麼需要 → 記憶內容 → 實戰威力」三段式；7 個 `memory_*` 工具、自動學習循環、Phase A~D。新增 `.mem` 系列 CSS（每層左側色條 + 分類標籤）。
  **抓到與已定案規則的衝突**：卡片的 7 個工具全帶 `bugezy:` 前綴，但 **§5 決策 2（PM-296 定案）已明訂工具名一律 snake_case、不加前綴**——照抄會讓同一份文件的 §5 與 §14 互相打臉，且實作時必有人照 §14 寫出帶前綴的工具。7 個全部去掉前綴並留說明。

- **PM-303 §14.12 記憶管理 + 決策 4~6 定案**（v0.6→v0.7）。**決策 4** 記憶混合式儲存（雲端＝L1 匿名＋L3；本機 `.bugezy/`＝L1 原始細節＋L2 L4 L5 L6 L7 L8）、**決策 5** L1 兩層式共享、**決策 6** BugEzy 只建議絕不動使用者程式碼。記憶工具 +6（update／delete／list／clear／export／import）→ 記憶層 13 個。
  **兩個照抄會做錯的細節**：① **`.bugezy/.gitignore` 放空檔案完全沒用**——目錄內的 `.gitignore` 必須自己排除自己（`*` ＋ `!.gitignore`），否則記憶檔照樣被 `git add -A` 掃進去，而那裡面有 L1 的真實檔名與 L6 的資安鐵律；② **匿名化只清「檔名／變數名」欄位擋不住外洩**——L1 的 symptom 欄位本身就內嵌識別資訊（`Cannot read 'map' of undefined at CheckoutPage.tsx:42`），必須對全文遮蔽。並提醒**匿名 L1 上雲是新的資料蒐集行為**，依 §4-15 `/privacy` 必須在上線前同步更新。另註明匯出檔含 L1 原始細節與 L6 鐵律，**比想像中敏感**，要比照憑證檔對待。

- **PM-304 §15 Zone Grid — AI 的空間座標系統**（v0.7→v0.8）。按 DOM 語意自動分區（語意標籤 → `role` → class/id → 視覺象限四層規則）、Zone 健康狀態與時間軸、半透明覆蓋層、與圖釘／§6 嚴重度整合、5 個 zone 工具；§9 Phase 3 改為「視覺化 ＋ Zone Grid」。
  **§15.3 的 error 歸類照字面實作會得到一個永遠回 `null` 的歸類器**：**stack trace 裡沒有 DOM 元素**（只有檔名:行:列），`fetch()` 也沒有「發起它的元素」。已改寫為「在錯誤發生的當下抓現場」，四條路徑都對得上專案既有能力（`event.target`／capture 階段的資源 `error` 事件／rrweb 互動軌跡／`Unassigned`）。**`Unassigned` zone 不能省**——§15.8 的規則是「✅ 就跳過，省 token」，被吞掉的 error 會主動讓 AI 跳過一個其實有問題的頁面。另修正兩處矛盾（`pointer-events:none` 與「點擊展開」互斥，需外層 none／badge auto 兩層；覆蓋層須用 DOM API 建，Trusted Types 網站會擋掉 `innerHTML`——PM-69 踩過）與一個漏掉的情境（**SPA 換頁後 selector 全失效，`watch_zones` 會安靜地監控已消失的區域並回報「一切正常」**）。

- **PM-305 §3 ＋ §12 A-3：Native Messaging → localhost WebSocket**（v0.8→**v0.9**）。§3 架構圖、安裝方式、運作方式全面對齊 PM-297~299 的實作，延遲 `<50ms` → **`<10ms`**，新增「為何棄用 Native Messaging」四列對照表；A-3 標為歷史紀錄（**保留不刪**，它記錄了完整的否決理由）。
  **卡片本身有三處與程式碼不符**：① **WebSocket client 在 `background.ts` 不在 `content.ts`**——這不是名詞之爭，PM-298 搭便車重連機制存在的理由就是連線方為會被回收的 service worker；② **位址是 `127.0.0.1` 不是 `localhost`**，後者在許多系統上先解析到 IPv6 `::1` 而 bridge 綁 IPv4，連線會失敗且錯誤訊息看不出原因；③ 「PM-299 實測 8ms」來源標錯（PM-299 真實 Chrome `ping` **2 ms**；8~14 ms 是 PM-297 模擬 extension 的端到端測試）。順手清掉 §1／§8／§9 三處連帶不一致，全庫 `50ms`、`localhost:19850` 歸零。

- **PM-306 Day 43 收工**：CHANGELOG ＋ ARCHITECTURE ＋ git push。

> **待 FOX**：所有既有待辦不變（v1.1.5 重新送審、`DISCORD_WEBHOOK_URL`、`ticket-expiry-notify.sql`、`REPORT_CLEANUP`、`ADMIN_TOKEN`、HSTS、GSC）。bridge 若要對外發布需 `npm publish`。
> **Phase 1 動工前需先實測**：出任務模式的截圖走哪條路（`captureVisibleTab` 截不到背景分頁，`chrome.debugger` 要重新審核，獨立視窗方案未實測）。
> **Phase A（記憶）動工前**：`/privacy` 需先為匿名 L1 上雲補揭露。
> **Phase 3（Zone Grid）動工順序**：PM-Y 的 error 歸類是地基，要先做完再做覆蓋層。

## 2026-08-15

Day 42（PM-294~301）。**v2 里程碑：從 Bug Reporter 走向 AI Debug Partner**——規格書定案 + `bugezy-bridge` 骨架落地並通過實機驗收。extension 改動未重新打包（仍 v1.1.5 送審中），server 未動、未 deploy。新增 `bridge/`。

- **PM-294 v2/v3 規格書（md）**（`docs/BugEzy_v2_v3_規格書.md`）。定義 v2「即時本機通道」與 v3「主動式 debug 夥伴」。**逐條對照現有程式碼查證後寫下 A-1~A-7 七條更正**，避免規格書建在錯誤前提上；同時列出三個必須由 FOX 拍板的決策。

- **PM-295 升級為 HTML 知識庫**（`docs/bugezy_v2_v3_product_spec.html`，§1~§12）。補上全棧 debug 章節；§12 附錄收錄 A-1~A-7 與三個決策（金色決策框）。

- **PM-296 三項決策定案**（HTML + md 兩份同步）。①`get_live_errors` 加 `source` 參數（`cache` 預設／`browser` 即時），並補上**「bridge 連不上要自動退回 cache 並註明，而不是報錯」**——這正是選它而非「改名並存」的理由，不寫下來實作時很容易做成拋錯。②工具名全 snake_case 不加前綴（17/17 命中，舊 camelCase 零殘留）。③定價分層。
  順帶處理一個決策清單漏掉的工具：`getNetworkFails` 沒有對應的新名——查證後認定不是遺漏，`get_live_errors` 的描述本來就同時涵蓋 Console 與 Network，故併入而非另開一支（已在文件標明此為推得）。
  > 檔案裡有**兩個 PM-296**：後者標題移除「收工」且明寫「不動 CHANGELOG」，判定為修訂版並照後者執行——故 PM-294~296 的 CHANGELOG 補在此處。

- **PM-297 `bugezy-bridge` 骨架**（新增 `bridge/`：`index.ts`／`mcp-server.ts`／`extension-link.ts`／`types.ts`／README；`extension/background.ts` 加 bridge client）。任何 MCP 相容 AI ──stdio──► bridge ──WebSocket 127.0.0.1:19850──► Extension ──► 目標網頁，**資料完全不經過 BugEzy 伺服器**。3 個工具：`ping`／`get_page_url`／`get_live_errors`。
  **選 localhost WebSocket 而非 Native Messaging 或 HTTP 輪詢**：前者需 `nativeMessaging` 權限（**會觸發 Web Store 重新審核**）＋各 OS 註冊 host manifest；後者撐不過 MV3（service worker 閒置 30 秒回收，`setInterval` 隨之消失，`chrome.alarms` 最短 30 秒補不上）。WebSocket 連 localhost 不需任何新權限，且 **Chrome 116 起 WebSocket 活動會重置 service worker 閒置計時器**。端到端 14/14 通過，延遲 8~14 ms。

- **PM-298 實機驗收 + port 占用小修**。port 被占用時**不再 exit**：多個 AI 工具會各自 spawn 一個 bridge，只有第一個綁得到 port，後起的若直接死掉，AI 端只看到空白的「Failed to connect」查不出原因；改為保持 MCP server 活著並 `disable(reason)`，讓每次呼叫都回一句人看得懂的話。
  **接上真實 Chrome 後抓到兩個假測試測不到的缺陷**：
  ① `get_page_url` 回空字串——`chrome.tabs.query({active:true})` 在只有 `activeTab` 權限時**不報錯、而是回傳 `url`/`title` 為空的物件**。加 `tabs` 權限＝重新審核，故改走 `chrome.tabs.sendMessage(tabId,{type:'GET_PAGE_INFO'})` 由 content script 回報 `location.href`／`document.title`，不需新權限且順帶驗證該分頁有無 content script。**根因是我的假 extension 回了假網址，把我的假設而不是 Chrome 的真實行為寫進了測試。**
  ② 重連的 `setTimeout` 指數退避**會跟著 service worker 一起被回收**——正是我當初用來否決 HTTP 輪詢的同一個陷阱。改為**搭便車**：把 `ensureBridge()` 掛在本來就會喚醒 service worker 的事件上（`onStartup`/`onInstalled`/`onMessage`/`tabs.onActivated`/`tabs.onUpdated`）。

- **PM-299 複驗 + 收工**。真實 Chrome + 真 MCP JSON-RPC 全數通過（6/6）：`get_page_url` → `{"url":"https://bugezy.dev/guide","title":"使用指南 · BugEzy"}`（修前為空）、bridge 顯示「✅ Extension 已連線」（搭便車重連生效，由開啟分頁喚醒 service worker 觸發）、`ping` 延遲 2 ms、`get_live_errors` 讀到當前分頁的真實 console 警告。CHANGELOG + ARCHITECTURE（§2b bridge 架構、§3 目錄、§4 原則 17~20）+ git push。

- **PM-300 §13 雙模式操作**（`docs/bugezy_v2_v3_product_spec.html` v0.3→v0.4 + md 同步）。**偵察模式**（不帶 `tab_id`＝讀用戶當前分頁，不搶焦點，即 bridge 目前行為）／**出任務模式**（`navigate_to` 開背景分頁並回傳 `tab_id`，後續操作都帶著它）。選「可選參數」而非兩套工具，理由同 §5 決策 1：工具數量翻倍會稀釋 AI 的選擇準確度，可選參數則天然向下相容。
  **§13.4 的比較表 5 項有 4 項與事實不符，查證後重寫**——卡片把 **Claude in Chrome 擴充**跟 Anthropic 另一個**隔離雲端沙箱**產品（Cowork 雲端 session／Claude Code 內建瀏覽器）混為一談：對方**能**讀用戶當前分頁、**共享**真實 Chrome 的登入狀態、**能**同時操作多分頁（需拖進分頁群組），只有「不搶焦點」證據分歧。**這四項若當真，等於把 Phase 1 的行銷主張與開發優先順序全押在對手早就有的能力上。** 真正站得住腳的差異化仍是 §8 那幾項（Console／Network 錯誤攔截、文字讀 DOM、歷史報告、跨 AI 平台），已在 §8 補交叉引用。
  另補三個卡片未提、但會直接卡住 Phase 1 的實作陷阱：① **`take_screenshot` 截不到背景分頁**（`captureVisibleTab` 只截可見分頁；切過去＝搶焦點，`chrome.debugger` ＝重新審核＋黃色橫幅，**改開 `windows.create({focused:false})` 獨立視窗最划算但需實測**）② 背景分頁會被 Chrome 節流 ③ 共享 session 代表 **AI 以用戶真實身分操作真實帳號**，破壞性動作需防線（留給 v3）。並定義邊界情況，其中最要緊：**`tab_id` 指到已關閉分頁必須明確報錯，絕不可默默退回當前分頁**——那會讓 AI 在用戶的分頁上執行原本要在自己分頁跑的破壞性操作。

- **PM-301 圖釘類／監控類補 `tab_id`**（v0.4→**v0.5**）。PM-300 標記的待決策由 FOX 拍板補上，`tab_id` 適用範圍收斂為**操作 5 + 偵測 4 + 圖釘 3 + 監控 3 ＝ 15 個工具**（唯一例外 `get_live_errors(source='cache')` 讀歷史報告，與分頁無關）。
  順帶補上這兩類**有狀態**才會有的規則：每個分頁各自一份監控／圖釘；**`stop_monitor()` 省略 `tab_id` 時只停當前分頁、不可一次停光全部**（否則 AI 在偵察模式隨手停一次，會把出任務模式跑到一半的監控一起殺掉）；分頁關閉時須自動收斂，否則出任務跑完關掉分頁會留下永遠不結束的監控。

> **待 FOX**：① 前述所有既有待辦不變（v1.1.5 重新送審、`DISCORD_WEBHOOK_URL`、`ticket-expiry-notify.sql`、`REPORT_CLEANUP`、`ADMIN_TOKEN`、HSTS、GSC）② bridge 若要對外發布需 `npm publish`（目前僅本機可用）。
> **已知限制**：Extension 端的 bridge port 固定 19850，`BUGEZY_BRIDGE_PORT` 只換得動 bridge 這一側。

## 2026-08-14

Day 41（PM-291~293）。**Chrome Web Store 隱私合規 + 報告保留期限落地**。extension 未動（v1.1.5 待審），server deploy `e1353035`→`c808becb`。

> PM-288~290（SEO 審計與 P0 修復）已記於下方 `2026-08-13` 區塊，依實際完成日歸檔，此處不重複。

- **PM-291 隱私政策全面升級**（`server/index.ts` `privacyPage` 3232→13571 字元 + `extension/t2s.ts`）。因「隱私權政策未包含必要資訊」被 Chrome Web Store 退件，改寫為 **§1~§11**：聯絡資訊、**權限對照表**、資料用途、6 家第三方（各附隱私政策連結）、儲存與保留、使用者權利、資料分享、Cookie、**Limited Use 聲明（中英）**、兒童隱私、政策變更。

  **動筆前逐項核對原始碼，抓到卡片 3 處事實錯誤**——這份政策才剛被退，照抄會再退一次：
  ① 卡片列了 `host permission (https://bugezy.dev/*)`，但 **manifest 根本沒有 `host_permissions` 欄位**（宣告不存在的權限＝新的三方矛盾）；而卡片**漏了真正該說明的 content_scripts `<all_urls>`**，那才是審核員最在意的。
  ② 卡片寫「AI 語音校正（Cloudflare Workers AI）」，實際**語音轉文字是 Groq**（`api.groq.com`，`whisper-large-v3-turbo`，美國公司），只有文字校正／精簡才是 Workers AI；**舊版政策更寫著「不會將資料傳送給其他 AI 服務商」——這是不實敘述**，已刪除並將 Groq 列入第三方。
  ③ 卡片要寫「報告保留 7/90 天」，但全庫**查無任何刪除 `reports` 的程式碼**——在隱私政策承諾不存在的自動刪除比不寫更糟，故先依實際行為撰寫（PM-292 實作後才改回）。
  另據實補上卡片未提的三項：**Discord webhook 會送出使用者 email**、由 IP 推得國家代碼（不儲存 IP）、CLI 記錄上傳前於本機遮蔽機密字串。
  繁簡：依 §4-11 整句比對 opencc 掃 **119 句**，補 5 字（`兌歲營練訓`，server 與 extension 兩表同步 414→**420**）；`蒐集→收集`、`回覆→回應`（**`覆` 是上下文相依**，加通用對照會把「覆蓋」轉錯）。

- **PM-292 報告自動清理 cron**（`server/index.ts`）。免費 **7 天**／付費（含有效票券）**90 天**，逾期報告連同 R2 附件每日清除並推 Discord 摘要；`/privacy` §5 中英簡同步改回明確期限。
  **安全設計（多數為卡片未要求）**：**`REPORT_CLEANUP` 未設 = dry-run**，只統計不刪——不可逆的資料刪除不該因為一次 deploy 就默默開跑；**先刪 R2 再刪 DB**（反過來 DB 一刪就查不到 R2 key，檔案永久孤兒化）；**`user_id` 為 null 的舊報告一律不刪**並在摘要標明筆數（PM-133 前的報告無擁有者，無法判定方案就不做無主刪除）；單次上限 500 筆且達上限時摘要明講；消掉卡片的 N+1（每筆各查一次 plan）→ **查詢固定 4 次不隨筆數增長**。另在 `/privacy` 多寫一句誠實揭露：保留期依**刪除當下**方案判定，降級後付費期間的舊報告會改以 7 天計算，請先匯出。

- **PM-293 Day 41 收工**：CHANGELOG + ARCHITECTURE + git push。

> **待 FOX**：① Dashboard 更新 Privacy practices（勾選建議見 job-0813 DONE-291）+ 重新送審 ② 先設 `DISCORD_WEBHOOK_URL` 才看得到 dry-run 摘要 ③ 觀察數天後再 `wrangler secret put REPORT_CLEANUP` = `on` ④ HSTS ⑤ GSC 驗證修正

## 2026-08-13

Day 40（PM-288~290）。**SEO 審計 + P0 修復**——找出並修掉兩個會讓 Google 誤判的 Critical。extension 未動（仍 v1.1.5 待審），server deploy `55f9208f`。

- **PM-288 SEO 審計**（唯讀，未改任何程式碼）。`claude-seo` v2.2.4 已 clone 到 `C:\dev\claude-seo`，但**執行 `install.ps1` 被 Claude Code 權限分類器擋下**（安裝腳本已完成安全性檢視：pin 在 tag、只做 venv + pip + playwright、不動 PATH/憑證；副作用是裝進 `~/.claude/` 全域、下載數百 MB）。改為**讀其檢查清單、依同一方法論實跑三份掃描**：
  - **完整網站審計 — B 級**。基礎紮實（10 頁全 200、每頁 canonical + 9 og、圖片 6/6 有 alt 且 lazy、robots/sitemap 正確且無遺漏頁、首頁 15.6 KB/466 ms、零外部 JS）。Critical：`http://` 直接回 200 未導向 HTTPS 且無 HSTS。Warning：`og:image` 只有 128×128（社群分享無大圖卡）、8/10 頁 description 長度不合、6/10 頁 title 長度不合、`/skill` 有 2 個 H1、無 `Content-Language`。
  - **Schema — A− 級**。`SoftwareApplication`+`Organization`（首頁）、`Article`（5 篇文章）皆有效。建議補 `BreadcrumbList`；**明確不建議**加 `HowTo`（Google 2023-09 已棄用）或自家 `Review`/`AggregateRating`（self-serving 不採計）；`/faq` 的 `FAQPage` 保留但**已無 SERP 效果**（Google 2026-05-07 對所有網站停用 FAQ 複合式結果）。
  - **hreflang — C 級**。self-referencing／x-default／語言代碼／return tag 雙向互指**全數正確**（PM-263/264 的底子沒問題），但踩到下述 canonical 矛盾。

- **PM-289 SEO P0 修復**（`server/index.ts`）。**根因**：`canonicalTag` 吃的是「偵測後的語言」，導致 ①裸網址永遠 canonical 到 `?lang=xx`，而 sitemap `<loc>` 與 hreflang `x-default` 指的都是裸網址 → **x-default 的目標自我否定、失效**（極可能就是 GSC 通知的來源）；②**canonical 隨 `Accept-Language` 變動**，Googlebot 以不同語言爬同一 URL 會拿到矛盾訊號。**修法**：新增 `explicitLang(request)`（只讀 query、**完全不做偵測**），`canonicalTag` 改為回顯請求上的 `?lang=`——canonical 是 URL 的屬性，不該受請求標頭影響；語言偵測（`getLang`）完全未動。另加 `langs.includes()` 守門，讓該頁不支援的語言（如 `/blog?lang=ja`）併回裸網址，避免產生**沒有任何 hreflang 指向的孤兒 canonical**。`canonLang` 由路由一路傳進 11 個頁面函式（不用 module 級變數暫存 request——同 isolate 併發有風險），全由 TypeScript 把關。並補 `Vary: Accept-Language, Origin`，**必須放在統一出口的 CORS 注入之後**（否則會被 `getCorsHeaders` 的 `Vary: Origin` 覆寫），且只加在 HTML（API 不隨語言變動）。**實測**：7 種 `Accept-Language` canonical 一律裸網址而 `<html lang>` 仍正確跟著變、6 語各自 self-canonical、**10 頁的 x-default 與 canonical 完全一致**（修前全部不一致）、return tag 仍雙向互指、13 路由無回歸。FOX 已於 Cloudflare 開啟 Always Use HTTPS（實測 301 生效）。

- **PM-290 Day 40 收工**：CHANGELOG + ARCHITECTURE + git push。

> **待 FOX**：① 開啟 **HSTS**（C-1 剩下的一半）② GSC 按「驗證修正」③ 其餘不變（v1.1.5 送審、`DISCORD_WEBHOOK_URL`、`ticket-expiry-notify.sql`、`ADMIN_TOKEN`）
> **未做的 P1/P2**：1200×630 OG 圖、title/description 校正、文章頁 `BreadcrumbList`、`/skill` 多餘 H1。

## 2026-08-12

Day 39（PM-286~287）。**Chrome Web Store 審核修正**——v1.1.5 首次送審被以「要求但未使用 `scripting` 權限」退件。版號不動（仍 v1.1.5），server 未改動。

- **PM-286 移除未使用的 `scripting` 權限**（`extension/manifest.json` 一行）。`permissions` 由 6 項減為 5 項（`activeTab` / `storage` / `downloads` / `identity` / `offscreen`）。**沒有直接照改，先自行查證**：`chrome.scripting` 在 `extension/src`、`extension/dist`、`cli`、`mcp-server` **0 次命中**，擴大掃 `executeScript`/`insertCSS`/`registerContentScripts` **同樣 0 次**——因為兩個 content script 都是 **manifest 宣告式注入**（`content.js` ISOLATED、`inject.js` MAIN 皆在 `content_scripts` 宣告），這條路徑本就不需要該權限。**另把其餘 5 個權限也逐一驗過確有使用**（避免改完再被以別的權限退件）：`activeTab`→`tabs.query`+`captureVisibleTab`、`storage`→112 處、`downloads`→JSON 匯出、`identity`→Google 登入/登出清 token、`offscreen`→Whisper 錄音；另 10 處 `chrome.tabs.create` 不需宣告 `tabs` 權限，目前也確實沒宣告。重新打包 `bugezy-v1.1.5.zip`（**22 entries / 407.8 KB，與前一版逐檔零差異**，僅 manifest 內容變動；`.map` 仍 0、未含設計原稿）。

- **PM-287 Day 39 補收工**：CHANGELOG + git push。

> **待 FOX**：上傳 `bugezy-v1.1.5.zip` **重新送審**；其餘待辦不變（`DISCORD_WEBHOOK_URL`、`ticket-expiry-notify.sql`、`ADMIN_TOKEN`、popup 實機驗收、兩支 verify 腳本）。

## 2026-08-10

Day 38（PM-283~285）。**商店包瘦身 + 票券到期自動提醒**。extension 版號不動（仍 v1.1.5，尚未上架）；server deploy `5ff89d71`。

- **PM-283 正式打包不再產 source map**（`extension/build.mjs` 一行）。`sourcemap: true` → `sourcemap: watch`——正式打包不產 `.map`（上架等於**公開原始 TypeScript**，自 v1.1.0 起每版皆然），`--watch`（dev）保留以便本機除錯。**並重新打包 v1.1.5**：PM-281 的 zip 已含 11 個 `.map` 且 FOX 尚未上傳，只改 build 設定的話送審的仍是舊包 → 重打後 **33 entries / 1148.8 KB → 22 / 407.8 KB（−741 KB，−64%）**。已驗證：`dist/` 零個 `.map`、無指向 404 的殘留 `sourceMappingURL` 註解、無內嵌 data URI map、`manifest.json` 與各 HTML 引用的檔案皆在包內、PM-273~278 六項新功能仍在。（全文搜尋仍會命中 `sourceMappingURL`/`sourcesContent`/`src/*.ts`，逐一查證皆非外洩——前兩者在 rrweb 打包進來的 postcss 程式碼內部，後者是 esbuild 的模組分隔註解，只有檔名。）

- **PM-284 票券到期前 Discord 提醒**（`server/index.ts` + `ticket-expiry-notify.sql`）。`notifyExpiringTickets()` 掃 ACTIVE 且 10 天內到期、尚未通知的票券 → 推 Discord（帶 email、剩餘天數、到期日、庫存票數）→ 標記 `expiry_notified`，掛進每日 cron（`0 3 * * *`）。**修掉卡片三個問題**：①**未設 `DISCORD_WEBHOOK_URL` 就整段跳過**——否則 `sendDiscord` 靜默 return，卻仍把票標成已通知，等於在推播開通前把提醒全部消耗掉且無聲無息；②**cron 用 `await sendDiscord()` 而非 `notifyFox()`**——後者靠 `env.__ctx.waitUntil`，而 `__ctx` 只在 `fetch()` 入口設定，在 `scheduled()` 裡不存在或是同 isolate 前次 fetch 留下的過期 ctx，推播送不出去；③**消掉 N+1**（每張票各查 email/庫存 → 兩次 `.in()` 後記憶體分組）。另加 partial index（只索引未通知的 ACTIVE 票）、查詢與標記失敗皆 `console.error`（欄位未建時不再看起來像「沒有票」）。

- **PM-285 Day 38 收工**：CHANGELOG + ARCHITECTURE + git push。

> **待 FOX**：① 上傳**重新打包後**的 `bugezy-v1.1.5.zip`（407.8 KB）② Supabase 跑 `ticket-expiry-notify.sql` ③ **`wrangler secret put DISCORD_WEBHOOK_URL`**（至今未設，PM-270 的 7 個事件推播與本卡的到期提醒都還沒生效）

## 2026-08-09

Day 37（PM-272~282）。**票券體驗打磨 + 安裝碼 + 官網指南大整併 → v1.1.5 送審**。extension `manifest` 1.1.4→**1.1.5**、產出 `bugezy-v1.1.5.zip`（33 entries，待 FOX 上傳）；server 多次 deploy（`fa5ca8c5`→`d1e1f383`→`5d3991c5`→`3945fad8`）。

- **PM-272 用戶心得頁**（`server/index.ts` + `extension/t2s.ts`）。新增 `/testimonials`（`TESTIMONIALS` 陣列 + 引號卡片 + `youtubeEmbed` 16:9 圓角 `youtube-nocookie`）+ 首頁入口 + CTA（影片 30 天 / 心得 10 天）+ canonical/hreflang + sitemap。**修卡片兩個會讓功能失效的問題**：①全站 CSP 沒有 `frame-src`，會回退 `default-src 'self'` **把 iframe 整個擋掉**（只剩黑框，錯誤僅在 console）→ 補 `frame-src https://www.youtube-nocookie.com`；②`T2S_CHARS` 是 414 字子集，新文案帶進表外字使簡體版顯示「**歡**迎…」→ 補「歡→欢」（server 與 extension 兩表同步到 415）。`youtubeEmbed` 另支援 `/shorts/`、`/embed/`。

- **PM-273 票券錢包折疊**（`popup.html/.ts` + `i18n.ts`）。`#ticketToggle` 標題列 + `#ticketBody` 折疊區，狀態存 `localStorage`（同步讀取，避免 `chrome.storage` 非同步造成的展開狀態閃動）；收合時標題列顯示「🟢 代碼 剩 N 天」+「庫存 N」badge，展開後收起避免重複。輸入代碼欄位刻意留在折疊區外；**完全沒有票券時整條折疊列隱藏**（否則點開是空的）。

- **PM-274 啟用二次確認**（`popup.html/.ts` + `i18n.ts`）。庫存票「啟用」與兌換後「立即啟用」**兩條路徑都改走 `askActivate()`**，`activateTicket()` 全檔只剩「確認啟用」一個呼叫點，無法繞過。確認框放折疊區外（兩條路徑都看得到）+ `scrollIntoView`（否則可能在畫面外）+ 先關閉再啟用（防連點送兩次）+ 重新兌換時清掉殘留確認框。

- **PM-275 付費會員隱藏啟用鈕**（`popup.ts`）。另開 `isEcpayPaid`（`plan === 'paid' | 'cancelled'`）而**不是**沿用 `plan.isPaid`——後者在 server 端把「持有有效票券」也算付費，誤用會把票券用戶的啟用鈕一起藏掉。付費會員的庫存列改「✨ 已是會員」標籤（不建立按鈕）、標題加「備用額度」，兌換後只留「💾 儲存備用」。

- **PM-276 安裝碼**（`server/index.ts` + `install-code.sql` + popup）。`users.install_code`（`BZ-XXXX`，綁 user_id 永不變）；`randomInstallCode` 用 `crypto.getRandomValues`、**字母表排除 0/O/1/I/L**（這碼要口頭唸與手打）；`ensureInstallCode` 用條件式 update（`.is('install_code', null)`）讓併發只寫一次 + 碰撞重試 5 次，**任何失敗只回 null 絕不影響登入**。`GET /api/user/install-code`（含舊用戶補發）、`GET /api/admin/verify-install`（**未設 `ADMIN_TOKEN` 一律 404，不預設開放**；token 不符也回 404 避免端點被探測）。Discord「🆕 新用戶」通知帶上安裝碼。popup 安裝碼列放在折疊區外 + 複製鈕。**自查修掉**：原本把 `install_code` 併進 `createSession` 的查詢，欄位未建時整筆查詢會失敗 → 既有用戶被判成新用戶 → 每次登入都推假的「新用戶」通知。

- **PM-277 popup 初次載入未渲染修復**（`popup.ts` + `server/index.ts`）。四個症狀（次數/升級鈕/安裝碼/票券錢包）恰好都只在 `loadPlan()` 成功路徑渲染 → 整支沒跑完。popup 開啟時併發打多支 `/api/`（`loadPlan` 被呼叫**兩次** + PM-276 新增的 install-code），而 `/api/` 有 rate limit；失敗又被兩條靜默路徑吞掉。修：**`planInflight` 併發去重**、**安裝碼併進 `/api/user/plan`**（`/api/user/*` 請求 **3 支降為 1 支**）、失敗改 `console.warn` 並重試一次（401 視為未登入不重試）、失敗時 `renderPlanFallback()` 渲染安全預設不留白、抽出 `renderPlanUI()` 讓初次載入與語言切換走同一條路徑。

- **PM-278 到期提醒文案修正**（`popup.ts` + `i18n.ts`）。到期只是回到 free，不會自動扣款，但文案寫「到期後以月費 NT$80 計算」與「啟用庫存票可**避免扣月費**」。改為「⚠ 免費體驗將於 N 天後結束」+「如需保持完整功能，可升級為訂閱會員」／「💾 你有 N 張庫存票券可啟用，延長免費使用」，並**移除**三個誤導性 key（留著空殼只會讓月費字眼被貼回來）。

- **PM-279 /guide 一鍵複製**（`server/index.ts`）。9 顆複製鈕（MCP 網址 ×2、六個工具、AI 提示詞；Claude Desktop 複製 JSON、Claude Code 複製指令）+ ⚡ 30 秒快速開始 + 🆘「搞不定？把這段話丟給你的 AI」。**不用卡片的 `onclick` + 讀 `textContent`**（PM-192/199/200 踩過會複製到排版空白），改 `data-copy-text` + 事件委派 + `execCommand` fallback（卡片版無 fallback，失敗仍顯示「已複製」會騙使用者）；顯示與複製共用同一份來源常數。

- **PM-280 /install 併入 /guide**（`server/index.ts`，移除 `installPage` 324 行）。`/guide` 重組為：🤖 複製貼給 AI → ⚡ 30 秒快速開始 → 📖 詳細五步（安裝/登入/六模式/編輯上傳/MCP）→ 🆘 求助 → 💡 小技巧；`/install` **301** 到 `/guide`（保留 `?lang=`）。**修卡片的 `Response.redirect()` 會回 500**——它的 headers 是 immutable，而統一出口會 `headers.set()` 注入 CORS。**搬移 PM-190/191 的 token 自動補齊**（卡片沒提，直接 301 會靜默弄丟），並一併改寫 `data-copy-text`（否則畫面帶 token、複製到的沒有）；修 template literal 吞掉 regex 反斜線。首頁加 `.btn-guide` 入口；7 處站內連結改寫；sitemap 移除 `/install`、`/guide` 權重 0.6→0.9。**取捨**：原 `/install` 為 6 語，`/guide` 僅 3 語，日韓越使用者會回退英文。

- **PM-281 v1.1.5 打包**。`manifest` 1.1.4→1.1.5 + `bugezy-v1.1.5.zip`（33 entries，**排除 build 遞迴帶入的 7 個設計原稿**；與已過審的 1.1.3 逐檔比對零差異）；permissions 無新增（不觸發權限重審）；6 項新功能逐一在 zip 內驗證。

- **PM-282 版號同步 + 收工**：`/api/version`→1.1.5、首頁/features footer→v1.1.5、`/changelog` 新增 v1.1.5 中英區塊、`SKILL_MD`+`SKILL.md` 版本與 `/install`→`/guide` 連結同步、CHANGELOG + ARCHITECTURE + git push。

> **待 FOX**：① 上傳 `bugezy-v1.1.5.zip` 送審 ② `wrangler secret put ADMIN_TOKEN`（要用安裝碼反查才需要）③ Discord webhook 與票券 UI 實機驗收

## 2026-08-08

Day 36（PM-265~270）。**活動代碼 + 票券錢包系統上線 + FOX 即時推播**。新增「兌換代碼 → 存進錢包 → 想用才啟用」的免費期發放機制（DB + API + popup UI），並替 7 個重要事件接上即時推播。server 多次 deploy（`27f3a1c8`→`7a998663`→`62459098`→`eb09b632`→`e0b74201`）；extension 待重上架（仍 v1.1.4）。

- **PM-265 DB 設計**（`server/promo-tickets.sql` + `verify-promo-tickets.mjs` + `schema.sql`）。`promo_codes`（代碼定義：`duration_days`/`code_type` public|personal/`max_uses`/`is_active`/`code_expires_at`）+ `user_tickets`（票券錢包：`status` SAVED|ACTIVE|USED/`activated_at`/`expires_at`/`UNIQUE(user_id, code)`）+ 索引 `idx_user_tickets_user_status` + RLS deny-all（§4-6）+ 預塞 `FIRSTMONTH`/`BUZZ100`。**修正卡片兩處會直接執行失敗的 SQL**：`REFERENCES users(id)`→`users(user_id)`（無 `id` 欄）、`user_id UUID`→`TEXT`（PM-133 起 = Google sub）。DDL 需 FOX 在 Dashboard 執行（PostgREST 不做 DDL）；以 `pglast`（libpg_query＝Postgres 官方 parser）實際解析驗證語法。

- **PM-266 兌換/錢包 API**（`server/index.ts`）。`POST /api/promo/redeem`（驗代碼存在/啟用/未過期/未達上限/未重複兌換 → 發 SAVED 票）、`POST /api/promo/activate`（**到期日疊加**：基準 = MAX(現有到期日, NOW()) + duration_days）、`GET /api/promo/wallet`（active/saved/free_until）。`hasActiveTicket`/`expireDueTickets` 併入 `isActiveUserId`，`getUserPlan` 回傳 `tickets`。**`max_uses` 改 CAS 併發控制**（PostgREST 不能做欄位運算，check-then-increment 會超發）：`.update({n: prev+1}).eq('current_uses', prev)` 最多重試 5 次 + 插入失敗補償回退。**拆出 `isEcpayActiveUserId()`** 給 ECPay 三個 callback 的孤兒自癒守門——否則「持有免費票券的用戶付款」會被當成已啟用而跳過升級，**收了錢卻沒開通**。

- **PM-267 popup 票券錢包 UI**（`extension/src/popup.html/.ts` + `i18n.ts` + `annotate.ts`）。輸入代碼兌換 → 選「先存著」或「立即啟用」→ 庫存列表逐張啟用 → 使用中票券顯示剩餘天數（≤10 天橘色提醒）；19 個 `promo_*` i18n key × 5 語；`applyTranslations` 支援 `data-i18n-ph`。**補通後端三處只認 ECPay 的付費守門**（`bumpUsage`/`handleTranscribe`/`createReport` rrweb）+ annotate Whisper 加 `plan === 'ticket'`——否則 popup 顯示無限制、server 卻回 403。

- **PM-268 即時推播 7 觸發點**（`server/index.ts`）。🆕 新用戶 / 🐛 新報告 / 🎫 代碼兌換 / 🚀 票券啟用 / 💰 月費付款 / 💰 日票付款 / 💰 續扣成功；`notifyFox` + `notifyFoxForUser`（延遲查 email：先確認有設推播才查 DB，且查詢一併進 `waitUntil`，不佔回應路徑）。**改用 `ctx.waitUntil` 而非卡片的 `void notifyFox(...)`**——Workers 回應後終止 isolate 會中斷未追蹤的 fetch（本專案 mcp_usage 踩過），但純 await 又違反「不阻塞」驗收。三個付款推播一律放在 **DB 更新成功之後**，否則升級失敗回 500 讓綠界重送時會推出假的「付款成功」。

- **PM-269 推播沒送達除錯**（`server/index.ts`）。加臨時除錯端點抓到 ntfy 回應 `{"code":42908,"http":429,"error":"daily message quota reached"}`——**根因：ntfy.sh 按「來源 IP」計配額，而 Workers 出網走共用 Cloudflare IP，該 IP 額度早被用光**（本機同 API 200 vs Worker 429，差別只有來源 IP）。排除 topic 未讀到/夾空白/ctx 取不到/編碼/呼叫位置五項嫌疑。修：加 `NTFY_TOKEN` 支援、**失敗改 `console.error`**（上一版全靜默吞掉才導致查不出來）、抽 `sendNtfy()` 讓「查 email→送推播」成單一 promise（原本巢狀 `waitUntil` 時序脆弱）；除錯端點用完刪除。

- **PM-270 改用 Discord Webhook**（`server/index.ts`）。`DISCORD_WEBHOOK_URL` 取代 `NTFY_TOPIC`/`NTFY_TOKEN`；`sendDiscord()` 送 embed（標題/內文/顏色/時間戳，priority≥4 橘、其餘 Discord 藍）；**`encodeNtfyHeader` 整個移除**——走 JSON body，中文與 emoji 原生支援，不再需要 RFC 2047。`notifyFox`/`notifyFoxForUser` 簽名不變，**7 個觸發點一行未動**；額外加 Discord embed 的 title 256/description 4096 字元截斷（超長會整包回 400，通知直接消失）。

- **PM-271 Day 36 收工**：CHANGELOG + ARCHITECTURE + git push。

> **待 FOX**：① Supabase 跑 `promo-tickets.sql` 建表 ② `wrangler secret put DISCORD_WEBHOOK_URL` ③ extension 重上架（Day 29~36 的 dist 變更累積中）

## 2026-07-28

Day 35（PM-263~264）。**多語 SEO 收尾**（純 server）。**PM-263 hreflang**：全站多語頁面補 `<link rel="alternate" hreflang>` + `x-default` + self-canonical（helper `hreflangTags(path, langs)` / `canonicalTag(path, lang, langs)` + 語言集合常數 `LANGS_6`/`LANGS_3`/`LANGS_ZH`/`HREFLANG_CODE`），讓 Google 正確辨識同頁不同語版本而非重複內容。**PM-264 sitemap 補齊**：`sitemapXml()` 改以 `interface SitemapPage{path,langs,freq,pri,langPri?}` 驅動，每頁列出所有語言版本並加 `xhtml:link` 互指；**直接複用 PM-263 的 `LANGS_*` 常數作單一事實來源**，確保 sitemap URL 與頁面 canonical 永遠一致（已交叉比對驗證）。另：FB 文案、icon 提案（FOX）。

## 2026-07-20

Day 34（PM-256~262）。**SEO 部落格上線 + 官網七語全面化 + 子頁面多語化**。純 server（只改 `server/src/index.ts`）；多次 deploy（`34d014c9`→`56c614d4`→`b5f1d00f`→`787cf4b4`→`a822c63b`→`9c49814b`）。

- **PM-256 /blog 架構**（`server/index.ts`）。新增部落格：`interface BlogPost{slug,date,title,description,blocks}` + `BLOG_POSTS[]` 集中管理；`/blog` 列表頁（深色主題、日期排序、標題/摘要/連結）；`/blog/{slug}` 單篇頁（正文 `renderBlogPara` 段落粗體 + 完整 SEO meta + **JSON-LD Article schema** + CTA + 上/下篇導航 + 返回列表）；路由（列表 / 單篇 / 404）；sitemap 加 /blog + 5 篇。

- **PM-257 五篇 SEO 文章上線**（`server/index.ts` BLOG_POSTS）。填入實際內容：Vibe Coding 隱藏成本 / AI Debug 成本 3 倍 / 別再截圖 Debug / 新手不需看懂 Console / 為什麼 AI 要更多資訊——皆繁中長文（各 4 小標 + 段落），主打「截圖只有表面、完整錯誤脈絡才修得快」，導流 BugEzy。

- **PM-258 Blog 入口 + 全站簡體字掃描**（`server/index.ts`）。7 個頁面 footer 加「📝 部落格」連結；用 opencc（`t2s(C)===C && s2t(C)!==C` 判定簡體專用字，排除 T2S/JA/KO/VI 表）掃出 4 處誤植簡體/日文（SKILL_MD 的 `简体中文`×3、`音声記録`），改繁體；保留簡繁共用字（台/群/吃）與刻意簡體 Whisper prompt。

- **PM-259 七語標籤全亮 + 首頁六語切換**（`server/index.ts`）。/features + 首頁語言徽章 `soon`→`active` 並補簡中 → 7 語全亮；「支援三種語言…即將開放」→「支援七種語言」（同步 JA/KO/VI 表 key）；首頁 lang-switch 由「中↔EN」改 6 語連結列（繁/简/EN/日/한/VI，當前高亮）；sitemap 加 `/?lang=ja/ko/vi`。日/韓/越首頁本已由 PM-233~235 的翻譯表渲染。

- **PM-260 隱藏電話/服務時間**（`server/index.ts`）。首頁 `.contact-info` 移除 📱 電話與服務時間兩行，只留 📧 Email（一處改涵蓋五語）；清理 JA/KO/VI 表孤兒翻譯 key。

- **PM-261 子頁面多語化 /features·/install·/faq**（`server/index.ts`）。/features 本已多語（PM-233~235）；install（59 條）+ faq（37 條）手譯 ja/ko/vi 各 95 條補入 JA/KO/VI 表（頁面用 `makeT` 自動生效，faq 的 FAQPage JSON-LD 同步多語）；新增 helper `langSwitchBar(lang)` 六語切換列套到這三頁；sitemap 加 9 URL（三頁 × ja/ko/vi）。

- **PM-262 Day 34 收工**：CHANGELOG + ARCHITECTURE + git push。

## 2026-07-19

Day 33（PM-250~255）。**v1.1.4 打包上架 + 全站版本同步 + 截圖 Whisper i18n 補完**。extension `manifest` 1.1.3→1.1.4、產出 `bugezy-v1.1.4.zip`（FOX 已送審 Chrome Web Store）；server 三次 deploy（`b403ad56`→`8f8de54d`→`ce3d63bc`）把 `/api/version`、官網 changelog/footer、SKILL_MD 全部同步到 v1.1.4。

- **PM-250 截圖 Whisper 提示文字 i18n**（`annotate.ts` + `i18n.ts`）。PM-248 修 7 只 i18n 了 Web Speech 字幕條，Whisper 區塊 4 處提示（錄音中/轉錄中/付費限定/操作提示）仍硬寫中文。新增 4 個 i18n key（`an-whisper-recording`/`-transcribing`/`-paid-only`/`-prompt`，zh/en/ja/ko/vi 五欄，zh-CN 由 toSimplified 自動、yue 走 zh），annotate.ts 4 處改 `t(key, annotateUILang)`。

- **PM-251 新 Icon + v1.1.4 打包**（`manifest.json`）。version 1.1.3→1.1.4；確認 icons/ 三尺寸為 FOX 新版（綠蟲+麥克風+深紫）；`npm run build` 後打包 `bugezy-v1.1.4.zip`（33 entry，排除 build 遞迴帶入 dist 的 `icons/proposals/` 與 `icon-source.svg` 設計原稿）。

- **PM-252 Server `/api/version` → 1.1.4**（`server/index.ts`）。`GET /api/version` 的 `latest` 1.1.3→1.1.4（`b403ad56`），讓舊版用戶 popup 更新提示指向 1.1.4。

- **PM-253 官網 changelog + footer 同步 v1.1.4**（`server/index.ts`）。`/changelog` 最上方新增 `v1.1.4 — 2026-07-19` 中英雙語區塊（即時字幕體驗優化 / 多語語音強化 / 新 Icon，涵蓋 Day 31~33）；首頁 + /features footer `v1.1.3`→`v1.1.4`（`8f8de54d`）。

- **PM-254 SKILL_MD（/skill AI 客服手冊）v1.1.4 更新**（`server/index.ts`）。頂部「最新版本」→ v1.1.4；**修正過時的支援語言**（原寫日韓越「即將開放」，實際 Day 29 起七語全開）→ 列出七語全支援；新增「v1.1.4 語音體驗更新」段落（interim 即時字幕 / 面板拖曳 / 粵越自動升級 / 簡體繁轉簡 / 截圖語音對齊）。全站掃 1.1.3——只改當前版本指標，保留 4 處 `(v1.1.3 修)` 史實註記與 changelog 的 v1.1.3 歷史發版條目（`ce3d63bc`）。

- **PM-255 Day 33 收工**：CHANGELOG + ARCHITECTURE + git push。

## 2026-07-18

Day 32（PM-243~249）。**七語語音三入口全面對齊**——把 zh-CN 繁轉簡、粵語/越南語 stale interim 自動升級、升級後去重等修復，套到即時字幕（inject.ts）、編輯報告補充說明（edit-report.ts）、截圖標注（annotate.ts）三處各自獨立的 SpeechRecognition。純 extension；六次 `npm run build` + `tsc --noEmit` 皆過，dist 更新待 FOX 重上架（仍 v1.1.3）。

- **PM-243 即時字幕 zh-CN 繁轉簡**（`inject.ts`）。Chrome Web Speech `lang='zh-CN'` 只控辨識引擎、回傳 `transcript` 仍繁體。import `toSimplified`，`onresult` final/interim 在 `currentSpeechLang === 'zh-CN'` 時繁轉簡（其他語言零影響）——底部字幕 + 右上面板皆簡體。

- **PM-244 edit-report 補充說明 zh-CN 繁轉簡**（`edit-report.ts`）。edit-report 有自己獨立的 SpeechRecognition，同套 `toSimplified`——final append 與 `🔴 interim` 狀態皆簡體。判斷用 `reportLang`（LANG_KEY 原始碼）。

- **PM-245 edit-report 粵語/越南語 stale interim 自動寫入**（`edit-report.ts`）。粵語（`yue-Hant-HK`）/越南語（`vi`）的 Chrome 很少送 `isFinal`、只持續 interim → 文字框永遠空。搬入 inject.ts PM-241 機制：interim 穩定 3 秒未變即自動 append 到 `descInput`（保留游標保位）+ 真 final/停錄清 timer。

- **PM-246 stale interim 升級後 isFinal 去重**（`edit-report.ts` + `inject.ts` 同步）。升級寫入後 Chrome 在 session 結束會補發同一段文字的 `isFinal` → 重複（FOX 實測粵語第一句重複）。新增 `promotedText`/`promotedTime` 追蹤，final handler 5 秒內相同/子集則跳過。拆 `cancel*Timer()`（保留 promoted 供去重）與 `clear*Promote()`（停錄完整清），破解「開頭清 promoted 導致去重失效」的規格衝突。inject.ts 即時字幕面板同機制一併修。

- **PM-247 stale interim 自動升級改為僅限粵語/越南語**（`inject.ts` + `edit-report.ts`）。原本對所有語言啟用，英文常有 >3 秒停頓 → timer 升級部分文字 → 真 final（完整句）被 PM-246 去重誤殺（只剩 2 個字）。加 `NEEDS_INTERIM_PROMOTE = Set(['yue-Hant-HK','vi'])` 語言守門，只有這兩語才升級。

- **PM-248 annotate.ts 截圖語音全面對齊（七項修復一次到位）**（`annotate.ts`）。截圖語音辨識完全沒跟上 PM-237~247：①`rec.lang` 由寫死 `zh-TW` 改跟隨 popup（`SPEECH_LANG_MAP[LANG_KEY]`）②zh-CN 繁轉簡 ③interim 節流 150ms（防韓語組字風暴）④`onstart` 記啟動時間、onend 判 session >1s 才歸零失敗計數（防韓語短命循環；SRInst 型別補 `onstart`）⑤粵語/越南語 stale interim 3 秒升級（帶語言守門）⑥升級後去重 ⑦字幕條硬寫中文改 `t()`（沿用既有七語 key）。i18n.ts 無需改。三入口語音自此完全一致。

- **PM-249 Day 32 收工**：CHANGELOG + ARCHITECTURE + git push。

## 2026-07-17

Day 31（PM-237~242）。**即時字幕（Web Speech）五項體驗優化與 bug 修復**，FOX 多語實測回報。純 extension（只改 `extension/src/inject.ts`）；四次 `npm run build` + `tsc --noEmit` 皆過，dist 更新待 FOX 重上架（仍 v1.1.3）。

- **PM-237 interim 即時字幕 + 語音面板可拖曳**。①`createRecognition()` 的 `rec.interimResults` `false`→`true`；`onresult` 迴圈加 interim 分支——`isFinal===false` 累積到區域變數即時顯示於底部字幕條（像 YouTube 字幕），**不**推 segments/面板/flush，只在本次事件無 final 時 `setCaptionText('🟢 '+interim)`（避免蓋掉 `✅` 確認文字 1.5 秒）。②右上語音面板（音声記録）改可拖曳：新增 module 級 `voicePanelPos` 記憶位置（頁面存活期間跨錄製）；面板/header `pointer-events:none`→`auto`、header 加 `cursor:grab` 當 drag handle（內容區 `bugezy-voice-content` 顯式保留 `none` 防誤選）；`mousedown`（排除收合鈕）記 offset→`mousemove` 更新 `left/top` 並用 `Math.min/max` 夾在視窗內→`mouseup` 結束，監聽器只在拖曳期間掛 window 結束即移除（不洩漏）；收合/展開與 `position:fixed` 不變。

- **PM-238 修復 🔄 重啟按鈕無限循環（race condition）**。`forceRestartVoice()` 的 `recognition.stop()` 觸發舊實例 `onend`，因 `voiceActive` 仍 `true` → 對舊 rec `start()` 自動重啟；隨後又建新實例 start() → 兩個 SpeechRecognition 搶麥克風互相觸發 onend → 無限「Restarting…」。修法：Step 1 先 `voiceActive=false`（讓舊實例 onend `!voiceActive` 直接 return），getUserMedia 失敗路徑補 `voiceActive=true`，Step 4 建新實例前 `voiceActive=true`。

- **PM-239 修復右上面板第一段語音被 VOICE_HISTORY 覆寫**。`showCaptionBar()` 發 `REQUEST_VOICE_HISTORY`（四層非同步 message），若第一段 final（`+=` 追加面板）先於回應到達，原 `textContent =`（覆寫）把第一段吃掉。改「覆寫」為「合併」：面板為空才直接填；已有文字則 `historyText + '\n' + currentText`（歷史放前保留既有）。

- **PM-240 修復韓語即時字幕效能崩潰**。①interim 節流：韓語組合型文字（ㅎ→하→한→한국어）每組字步驟都觸發 onresult（每秒數十次）淹沒 DOM → interim 的 `setCaptionText` 最多每 150ms 一次（final 不受限）。②onend 防快速循環：原 `onstart` 無條件歸零 `autoRestartFails` 讓計數永遠到不了 3；改為 `onstart` 只記 `lastRecognitionStartTime` 不歸零，`onend` 算 session 時長——只有 >1s 正常 session 才歸零，短命 session（<1s）累積計數到 3 次後停手。

- **PM-241 越南語 interim 自動升級 final（stale interim 超時）**。Chrome 越南語模型很少主動送 `isFinal`，長停 interim → 右上面板收不到文字。新增「stale interim 自動升級」：interim 文字每變動就重設 3 秒 timer，3 秒穩定未變即視為 final（推 segments/flush/面板/`✅`）；停錄、forceRestart、**收到真 final**皆呼叫 `clearInterimPromote()` 清 timer（真 final 清除避免 en/zh/ja 停頓後過期 timer 重複送出），回呼另以 `voiceActive` 守門。其他語言正常 1~2 秒 finalize，timer 永不觸發。

- **PM-242 Day 31 收工**：CHANGELOG + ARCHITECTURE + git push。

## 2026-07-15

Day 29（PM-232~236）。**四語擴展達成七語全覆蓋**：簡體中文 zh-CN + 日語 ja + 韓語 ko + 越南語 vi。Extension 每語補完整 UI 翻譯、Server 官網（首頁 + 完整功能頁）補對應翻譯、Whisper/AI 校正/精簡各語 prompt、`Accept-Language` 自動偵測。extension 四次 `npm run build`（dist 更新待 FOX 重上架，仍 v1.1.3）；server deploy `02720582`→`ce1fe70c`→`9728f239`→`7fb7078a`。

- **PM-232 簡體中文 zh-CN**（`extension/src/t2s.ts` 新增 + `i18n.ts` + `server/src/index.ts`）。不手寫 150+ 條字串，改用**執行期繁→簡轉換器** `toSimplified()`——opencc 對專案實際漢字產生 414 字對照表 + 6 條大陸用語詞彙覆蓋（設定→设置、進階→高级、擴充→扩展、程式→程序、檔案→文件、擴充功能→扩展程序），Extension + Server 共用同表。Extension：`UILang`/`SupportedLang`/`SPEECH_LANG_MAP` 加 zh-CN、`t()` 對 zh-CN 走 `toSimplified(entry.zh)`、popup 下拉加「🇨🇳 简体中文」。Server：`PageLang` 加 zh-CN、`detectLang`（`zh-cn`/`zh-hans`→簡體）、新增 `makeT(lang)` 工廠取代全站 13 處 `t()`、`htmlLang()`（`<html lang>` 依語言）、Whisper 簡體 prompt + 輸出再過 `toSimplified()` 保險、AI 校正/精簡簡體 prompt。

- **PM-233 日語 ja**（`extension/src/i18n.ts` + `server/src/index.ts`）。日語為手譯（敬體 です/ます，技術術語保留英文）。Extension：dict 全 ~140 條 key 補 `ja` 欄位、`t()` 加 ja 分支、`DEFAULT_PROMPTS` 加 ja、popup 解鎖「🇯🇵 日本語」、`speechToSrLang` 加 ja。Server：官網用「繁體原文→日文」查表 **`JA_MAP`**（136 條，`makeT('ja')` 以既有 `t()` 第一參數查表、缺則 fallback 英文，**零改動頁面主體**）涵蓋首頁 + 完整功能頁；`detectLang` `\bja\b`→ja；`htmlLang('ja')`；Whisper `ALLOWED_LANGS` 解鎖 ja + 日語 prompt；AI 校正/精簡日語 prompt。

- **PM-234 韓語 ko**（同 PM-233 模式）。합니다체。Extension dict 補 `ko`（~140 條）；Server 新增 **`KO_MAP`**（136 條，key 集與 JA_MAP 一致）；`detectLang` `\bko\b`→ko；Whisper 解鎖 ko + 韓語 prompt；AI 校正/精簡韓語 prompt。

- **PM-235 越南語 vi**（同模式，達成七語）。越南語聲調符號 UTF-8。Extension dict 補 `vi`（~140 條）；Server 新增 **`VI_MAP`**（136 條）；`detectLang` `\bvi\b`→vi；Whisper 解鎖 vi + 越南語 prompt；AI 校正/精簡越南語 prompt。**七語全覆蓋達成**：繁體中文 / 粵語 / English / 简体中文 / 日本語 / 한국어 / Tiếng Việt。

- **PM-236 Day 29 收工**：CHANGELOG + ARCHITECTURE + git push。

**驗收共通**：`?lang=` 手動切換 + `Accept-Language` 自動偵測皆通過；`<html lang>` 六語全對（zh-Hant/zh-Hans/ja/ko/vi/en）；日/韓/越判定優先於 zh 且不誤傷中文用戶；覆蓋率腳本確認官網翻譯無遺漏（僅 `EN` 切換 label 與 zh===en 技術字串刻意 fallback 英文）。

## 2026-07-12

Day 26（PM-228~229）。**Official MCP Registry 發布 + 目錄收錄 + 行銷上線**。純發布/行銷層（產品程式未動；server 僅加一條驗證路由）。

- **PM-228 Official MCP Registry 發布**（`server/server.json` + `server/index.ts`）。BugEzy 正式登錄官方 MCP Registry（PulseMCP 等目錄的上游源）：`dev.bugezy/bugezy` v1.1.3，remote streamable-http `https://bugezy.dev/mcp`，status active（API 實查 `registry.modelcontextprotocol.io/v0/servers?search=bugezy` 確認）。**驗證途徑**：GitHub Actions OIDC 因本機 PAT 無 `workflow` scope 被擋 → 改用 **HTTP 域名驗證**（namespace = bugezy.dev 反向 DNS `dev.bugezy`，品牌更佳且可自主完成）：Ed25519 金鑰對 + Worker 新增 `GET /.well-known/mcp-registry-auth` serve 公鑰（`v=MCPv1; k=ed25519; p=…`）→ `mcp-publisher login http` → `publish`（description 縮至 ≤100 字過 422 校驗）。私鑰/CLI binary/token 用完即刪不進 repo，公鑰路由留在 Worker（deploy `cb2a8400`）。
- **目錄收錄 + 行銷（FOX 執行）**：Glama MCP 目錄登錄（7 分鐘過審）；awesome-mcp-servers PR #9919 提交（含 Glama badge）；Facebook 粉絲專頁建立 + 第一則付費廣告上線（8 天 $42 USD）。

## 2026-07-10

Day 25（PM-222~227）。**官網小白友善重構 + /features 專業版完整頁 + README 產品級大改 + SKILL.md v1.1.3**。純內容/文檔層（extension 未動，仍為 v1.1.3）；server deploy `2bcb0639`→`885938c3`→`790dc8d9`→`42b7a89a`。

- **PM-222 官網首頁小白友善重構（漸進式揭露 + 6 張截圖）**（`server/index.ts` homePage）。朋友反饋「太專業、小白看不懂」→ 首頁改成「概念吸引 → 有興趣再看細節」。`homePage()` 完全重寫為 **7 區塊**（中英雙語）：①Hero（「遇到 Bug，說不清楚？」/「Can't explain the bug?」+ CTA 直連 Chrome Web Store 商店頁 + 「免費版每月 10 次錄製 · 不需信用卡」，**不放截圖保持乾淨**）②三步驟（🎙️按下錄製／📋自動整理／🤖 AI 幫你修）③截圖展示（4 組**圖左文右↔圖右文左交替**：`ss-recording`/`ss-report-top`/`ss-report-bottom`/`ss-ai-fix`）④賣點 6 格（語音/一鍵錄製/13 MCP/省 93%/隱私/免費起）⑤語言（`ss-languages` + 3 active badge 中/粵/英 + 3 灰 coming-soon 日/韓/越）⑥CTA 收尾（`ss-store` 商店預覽 + CWS/GitHub/指南/隱私連結）⑦footer（保留綠界要求的聯絡資訊 + v1.1.3 版號）。**截圖 serve**：6 張存 R2（`wrangler r2 object put` → `public/screenshots/*.png`）+ 新增 `GET /screenshots/:name.png`（白名單檔名正則防路徑穿越 → `env.R2.get` → `image/png` + 快取 1 天）——不內嵌 base64 以免 Worker bundle 爆量（6 張共 948KB）。head 保留 ogMeta + JSON-LD + canonical；`@media(max-width:720px)` 三欄/賣點→單欄、截圖行堆疊。舊的六模式/捕捉/框架/MCP/AI-install 區塊移除（內容移往 /features）。

- **PM-223 /features 升級為完整技術規格頁**（`server/index.ts` featuresPage）。承接 PM-222 移出的專業內容，重寫為 **9 區塊**（中英雙語）：①頁首（「BugEzy 完整功能介紹」/「Full Feature Overview」+「給進階開發者、AI 助手、技術評估者」）②六種錄製模式（3×2 mode-grid：錄製/回溯 30s/截圖/鍵盤/監控/CLI）③Bug 捕捉能力 10/10（Console/Network/資源載入/Web Vitals/DOM rrweb/Storage PII/語音/截圖馬賽克）④**MCP 整合 13 Tools**（每個 `<code>` + 一句話 + `MCP 連接：https://bugezy.dev/mcp`）⑤語音引擎（Web Speech 免費 / Groq Whisper 付費 / AI 校正+精簡 + 3 active/3 soon 語言 badge）⑥Python/Node CLI（`npm install -g bugezy-watch` + 結構化解析/環境快照/PII 遮罩）⑦安全與隱私（Fable5 9.5+/RLS/CSP frame-ancestors/PII/session fragment）⑧定價三卡 ⑨頁尾 CTA。新增 `.mode-grid`/`.clist`/`.tool`/`.badge2`/`.plan3` CSS（手機單欄）；首頁 §4 賣點加「查看完整功能 →」導流 /features。

- **PM-224 /changelog 補 v1.1.3**（`server/index.ts` changelogPage）。最上方（v1.1.0 之前）新增 **v1.1.3 — 2026-07-09** entry，中英雙語分 3 組：🌐 SEO 深度優化（全站 OG/Twitter Card、首頁 JSON-LD 過 Google Rich Results、/faq FAQPage 14 題、/icon-128.png）／🌍 國際化修復 5 項（Whisper 繁體、edit-report 語音語言+UI i18n、授權頁+字幕條 i18n、AI prompt 依語言、粵語 `yue-Hant-HK`）／🔒 安全修復 6 項（user_id 強制覆蓋、ECPay 孤兒自癒、MCP 過期 token、usage 認證、screen_size esc、CSP frame-ancestors）。

- **PM-225 GitHub README 產品級大改**（`README.md`）。由早期中文 monorepo 開發筆記**整份改寫**為國際標準開源產品 README（英文，給外部開發者/MCP 目錄/Google 爬蟲看）：標題 + tagline「Capture bugs by talking. Let AI fix them.」+ 連結列 → How It Works（3 步）→ **MCP Server 13 Tools 表格** + endpoint + Claude/Cursor/Windsurf 的 JSON config → Features 7 項 → Python/Node CLI → Pricing 表 → Security 5 項 → Tech Stack → Links → License。commit `dea35db`。

- **PM-226 SKILL.md v1.1.3 更新 + /skill 同步**（`SKILL.md` + `server/index.ts` `SKILL_MD`）。①頂部加「最新版本：v1.1.3（2026-07-09）」②新增「語音功能與語言」區塊（支援語言 active/coming-soon、兩種引擎、Whisper zh/yue 強制繁體、粵語 `yue-Hant-HK`、AI 校正/精簡依語言切 prompt、編輯報告頁多語）③新增「安全與隱私」區塊（Fable5 9.5+/session fragment/報告分享付費牆/CSP frame-ancestors/RLS 全 6 表/PII 遮罩）④**MCP 工具表修正**：移除實際不存在的 `get_metadata`、補上真實的 `get_page_info`、`get_usage_stats` 註明需登入——以 `grep server.tool` 核對 server 實際註冊的 13 個 tool。**server 同步**：Python 腳本讀更新後 SKILL.md → escape 反引號/`${` → 重新生成 `SKILL_MD` 常數（避免 PM-201 手動 escape 之痛），`/skill` + `/skill/download` 單一來源一致。

## 2026-07-09

Day 24（PM-211~220）。**SEO 深度優化（OG/Twitter Card + JSON-LD）+ 國際化 5 修 + Fable5 第四輪安全 6 修 + extension v1.1.3**。server 多次 deploy（`45803196`→…→`4756a5a2`）；`bugezy-1.1.3.zip` 待重上架。

- **SEO（PM-211~213）**：全站 10 對外頁 `<head>` 加 **Open Graph + Twitter Card**（`ogMeta()` helper，title/description 依規格英文、`&quot;` 轉義；FB/LINE/Threads/X 分享預覽卡）+ 新增 `GET /icon-128.png`（內嵌 base64 品牌 icon，讓 og:image 不 404）（PM-211，`45803196`）。首頁加 **JSON-LD SoftwareApplication**（含三 Offer：Free 0/Monthly 80/Day Pass 20 TWD）**+ Organization**；`jsonLd()` helper（`<`→`<` 防提前結束）（PM-212，`108b6481`）。**FAQPage JSON-LD** 從 /skill 移到 **/faq**——因 Google 要求 markup 須為頁面可見內容，改由 `faqPage` 依 lang 動態產生，14 題 Q&A 與可見手風琴逐字一致（PM-213，`d190af1f`）。

- **國際化（PM-214~218）**：**Whisper 繁體輸出**——`/api/transcribe` 對 zh/yue 加 `prompt: '以下是繁體中文的語音轉錄內容。'` 引導繁體（Groq language 只控辨識不控簡繁）（PM-214，`2f2cb33f`）。**edit-report 語言跟隨 popup**（extension）——`createEditRecognition` 的 SR lang 由寫死 `zh-TW` 改 `speechToSrLang(LANG_KEY)`（zh-TW/yue-Hant-HK/en-US）+ 全頁 UI i18n（`er-*` 鍵、`applyEditTranslations` + `T()` 動態文字）（PM-215）。**麥克風授權頁 + 即時字幕浮動條 i18n**（extension）——inject `setVoiceStatus`（🟢 聽取中…等）改 `it()`、`mic-permission.html/ts` 讀 LANG_KEY 套 `mperm-*`（PM-216）。**AI 修正/精簡英文 prompt**——`/api/correct`、`/api/summarize` 依 body `language` 切英文 prompt；extension 帶 `language: reportLang`（PM-217，`41bbb963`）。**粵語即時字幕代碼**——`SPEECH_LANG_MAP.yue` `zh-HK`→**`yue-Hant-HK`**（原是香港中文，講粵語辨識不到）（PM-218）。

- **安全 Fable5 第四輪（PM-219，`bc1c9165`）**：①createReport `payload.user_id` 一律以認證身分覆蓋（`authUserId ?? undefined`），不信任 client 冒名綁定；②ECPay 三 callback 孤兒態——`updateUserPlan` helper 檢查 `users.update` error 失敗回 500 讓綠界重送 + 冪等短路加孤兒自癒（`isActiveUserId` 守門防重複展延）；③MCP list_reports/get_live_errors/get_terminal_logs 的 inline sessions 查表改 `verifySessionByToken`（含到期檢查）；④`/api/usage/monthly` 加 `getAuthUserId` gate（401）；⑤report-page.js `screen_size` 補 `esc()`；⑥`CSP_VALUE` 補 `frame-ancestors 'none'`（防點擊劫持）。

- **PM-220 extension v1.1.3**：`manifest.json` + `/api/version` latest → 1.1.3（`4756a5a2`）；`npm run build` clean → `bugezy-1.1.3.zip`（33 檔，含 PM-215~218）待 FOX 重上架 Chrome Web Store。

## 2026-07-08

Day 23（PM-201~210）。**AI 客服手冊（SKILL.md）+ 首頁 AI Skill 專區 + CWS 1.1.2 送審（含截圖流程統一到編輯報告頁）+ 截圖體驗打磨**。版號 `1.1.1`→`1.1.2`（`manifest.json` name/description 改寫 + server `/api/version`；`bugezy-1.1.2.zip` 待重上架）。

- PM-210：**截圖模式麥克風提示流程與錄製一致**（`popup.ts`/`annotate.ts`）。截圖按鈕改與錄製共用「麥克風目前關閉」提示（mic OFF + 非鍵盤才彈）；新增 `micPromptFor: 'record'|'screenshot'` + `runMicPromptAction()`，提示的「開啟並錄製 / 直接錄製（不錄語音）」依來源導向 `doScreenshot()` 或 `doStartRecording()`（不再寫死錄製）；annotate 語音自動啟動加讀 `MIC_KEY`——mic OFF → 不自動錄（顯示「🔇 語音已關閉（可按 🎤 開啟）」，保留手動 🎤），讓「直接錄製（不錄語音）」對截圖真正生效。純 extension，`npm run build` ✅，待重上架。

- PM-209：**截圖報告上傳成功後按鈕卡「上傳中...」修復**（`edit-report.ts`）。根因：`await sendMessage` 無 try/catch、`resp` 無防呆；截圖 payload 大、round-trip 久，訊息通道關閉致 `sendMessage` reject/回 undefined → `resp.ok` throw 中斷 handler → 按鈕永卡「⏳ 上傳中」。修法：成功 UI 抽 `showUploadSuccess(shareUrl)`（錄製/截圖共用）、`await` 包 try/catch、判斷改 `resp?.ok`——任何情況（成功/失敗/訊息遺失）按鈕都復原。純 extension，`npm run build` ✅，待重上架。

- PM-208：**截圖報告語音記錄改「截圖不適用」**（`annotate.ts`/`edit-report.ts`）。收斂 PM-206/207/207b 的語音拆分（越修越複雜易錯）為簡單決策：annotate `voiceTranscript` 改回 `[]`、`description = descInput.value.trim()`（含語音+手動完整內容），移除 `voiceAccumulated`/`isManuallyEdited`（含 keydown listener）；edit-report 截圖報告時「語音記錄」區顯示「📸 截圖模式：語音內容已包含在補充說明中 / Screenshot mode: voice content is included in the description below」（`getUILang(LANG_KEY)` 中英）+ readOnly + 隱藏 AI 校正/精簡。純 extension，`npm run build` ✅，待重上架。（PM-206：截圖語音存入 voiceTranscript；PM-207/207b：語音/手動分離嘗試——均已被 PM-208 取代。）

- PM-205：**截圖標注頁 Whisper 錄音綠色音量條**（`annotate.ts`/`annotate.html`）。`#liveCaptions`（Whisper 錄音提示浮層）內加 5 條 `.vol-bar`（規格同 popup/inject）；`startVolumeMeter(whisperStream)` 用 `AudioContext`+`AnalyserNode(fftSize:256)`+`requestAnimationFrame`，`level=min(avg/128,1)`，過門檻高度跳動、`level>0.3` 綠 `#3fb950` 否則紅（與 inject 同公式）；`startWhisper` 開、`stopWhisper` 停。純 extension，`npm run build` ✅，待重上架。

- PM-204：**截圖流程統一——標注完導到編輯報告頁**（`annotate.ts`/`edit-report.ts`/`types.ts`）。截圖標注「完成儲存」改「📤 下一步」（`annotate-next` i18n），不再直接 `POST /api/reports`，改把截圖 payload 存進 `STORAGE_KEY`（與錄製同一入口）+ 清 `STATE_KEY` → 開 `edit-report.html`；移除 annotate 內上傳與 `SCREENSHOT_UPLOADED`。edit-report `init` 判 `isScreenshot`（無 rrweb + 有 screenshots）→ `showScreenshotPreview()` 用截圖 `<img>` 取代 rrweb 播放器、隱藏播放/標記控制、摘要改「截圖/Console/Network/頁面」；其餘（語音/描述/Token/AI 校正/上傳+複製鈕）完全複用。`RecordingPayload` 加選填 `screenshots?`/`description?`/`allow_screenshot_images?`。設計：改存既有 `STORAGE_KEY`（非規格的新 key）以符合「上傳邏輯不動」；類型判別用啟發式不新增 server 欄位。純 extension，`npm run build` ✅，待重上架。

- PM-203：**manifest name/description/version 1.1.2 + `/api/version`**（`extension/manifest.json` + `server/index.ts`）。name→「BugEzy — AI Bug Reporter | 語音除錯工具」；description→精簡版「Voice-powered bug reporter with MCP AI — record bugs, AI analyzes and fixes. 6 modes, 13 tools. 語音 Bug 回報，AI 一鍵修復。」（**114 字元，符合 CWS 132 上限**；初版 186 字超限已依 FOX 指定精簡）；version `1.1.1`→`1.1.2`；`/api/version` latest 同步。`bugezy-1.1.2.zip` 已打包待重上架。server `wrangler deploy 9fe349df`（線上 `GET /api/version`→`{"latest":"1.1.2"}`）。

- PM-202：**首頁 AI Skill 專區 + 四大特色 + 捕捉能力 Skill 提示**（`server/index.ts` homePage）。MCP 區塊後加 `#skill`「🤖 專屬 AI Skill — 讓 AI 當你的 24 小時客服」卡片（四項清單 + 「下載 SKILL.md →」`/skill/download` + 「了解更多 →」`/skill`）；Hero 副標改四大特色並列「六種錄製模式 × 13 個 MCP AI 工具 × 語音辨識 × AI Skill」；「能捕捉什麼」capture-grid 後加 Skill 提示 + 下載連結。中英。`wrangler deploy b76c3bf1`。

- PM-201：**BugEzy SKILL.md — AI 客服手冊**（根目錄 `SKILL.md` + `server/index.ts`）。建立給 AI 讀的完整手冊（什麼是 BugEzy + 官網連結 / 讀報告方法 / MCP 13 工具表 / 六模式 / 故障排除 / 能捕捉什麼 / 定價）；Worker 無檔案系統故內嵌為 `SKILL_MD` 常數。新增 `GET /skill`（`skillPage`：極簡 Markdown→HTML 渲染器 `renderMarkdown` 排版全文 + 一鍵複製 `data-copy-text` + 下載鈕 + Claude Desktop 安裝步驟教學，中英）+ `GET /skill/download`（`text/markdown` + `Content-Disposition: attachment; filename="SKILL.md"`）；全站 7 頁 footer 加「🤖 AI 客服手冊」→ `/skill`；sitemap 加 `/skill`。踩雷：SKILL_MD 內大量反引號 template literal escape，首版誤 3 反斜線→ Python 一次修 50 處。`wrangler deploy a4879590`。

## 2026-07-07

Day 22（PM-187~200）。**Chrome Web Store 1.1.0 過審 →（收工）打包 1.1.1 送審 + manifest key 統一 ID + 一連串資安/商業/體驗修復**。收工另更新版號 `1.1.0`→`1.1.1`（`extension/manifest.json` + server `/api/version` latest，`wrangler deploy 9de89e2f`，線上實測 `GET /api/version`→`{"latest":"1.1.1"}`；舊版用戶經 `/api/version` 收更新通知）。

- 版號：**`1.1.0` → `1.1.1`**。`extension/manifest.json` version + `server/index.ts` `GET /api/version` 的 `latest` 同步升版；extension `npm run build`、server `wrangler deploy`（`9de89e2f`，cron 保留）。待 FOX 重上架 CWS（`extension/bugezy-1.1.1.zip` 已打包）。

- PM-200：**全站「安裝 Chrome 擴充」按鈕對接正式 Web Store 連結**（`server/index.ts`）。全檔稽核 `chromewebstore.google.com`——通用首頁連結**僅 1 處**：/install Step 1「前往 Chrome Web Store →」CTA（原 `href="https://chromewebstore.google.com/"`）→ 改為正式商店詳情頁 `https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj`（此 URL 永久不變、不隨版本更新）；其餘 4 處（首頁 + /install 的 AI 安裝提示）本就已是 detail URL。首頁 CTA（安裝擴充/免費安裝/升級）皆連 `/install` 安裝指南頁（含加到 Chrome + MCP 設定漏斗），未改（刻意保留 onboarding 漏斗，/install 商店按鈕現已指向 detail 頁 → 整條 首頁→/install→正式商店 已對接）。線上實測 /install href = detail URL、全站無通用首頁連結。`tsc` clean → `wrangler deploy`（`0be0cd64`）。

- PM-199：**編輯報告頁分享連結加複製按鈕**（`extension/edit-report.ts`）。PM-196 只加在 server 報告頁，extension 編輯報告頁「✅ 已上傳！分享連結：URL」漏了。上傳成功分支在 `<a>` 後動態建 hidden `<input readonly>`（持 shareUrl，`position:absolute;width/height:1px;opacity:0` 視窗內可選取，非 display:none/離屏——沿用 PM-192 教訓確保 `select()`+`execCommand` 生效）+ 紫色「📋」按鈕（`#7c3aed`，與報告頁一致）；click → `select()`+`setSelectionRange`+`document.execCommand('copy')`（**非 clipboard API**，try/catch 防呆）→ 變「✅」2s 恢復「📋」。純 extension，`tsc` clean → `npm run build` ✅（dist `copyInput`/`copyBtn`/`setSelectionRange`/`execCommand` 確認）。待重上架。

- PM-198：**精準轉錄（Whisper）錄音正常但無文字產生 — 全鏈路埋 log + 收斂靜默失敗**（`extension/offscreen.ts`/`background.ts`）。症狀：音量條有跳（PM-193 修好、錄音正常）但停止後 voice_count=0。逐段查 offscreen→background→server，**程式路徑本身無寫死 bug**（Blob 有效產生、mimeType 正確、有帶 `Authorization: Bearer`+FormData、`API_BASE='https://bugezy.dev'` PM-169 後正確、server transcribe 邏輯正常），真因是**整條「停止→轉錄→存檔」幾乎零 log 且靜默吞掉失敗**。修：①offscreen `stopRecording` 印 `blob size/type/chunks`；②background `stopMicAndTranscribe` 印送出前 size、`hasAuth`、改 `res.text()` 先讀再 `JSON.parse`（非 JSON 的 401/502 不再 throw 被吞、改印 status+body）、無條件印 `response status/ok/text`、存檔條件收緊為 `ok && text.trim()`（避免存空字串殘留下一場）、ok=false/空文字印明確 warn；③`STOP_RECORDING` handler 印 `micMode` 且**不再丟棄** `stopMicAndTranscribe` 回傳（印 ok/textLen/error）；④`RECORDING_DONE` 印是否併入 Whisper 文字。log 用 `console.*`（非 gated `blog`）實機 DevTools 直接可見，FOX 錄一段後看哪行斷掉即定位根因（size=0 / hasAuth=false / 401 / 403 / Groq 空結果）。純 extension，`tsc` clean → `npm run build` ✅（dist wiring 確認）。待重上架 + 實機驗收。

- PM-197：**popup「📋 複製 MCP 設定」加使用時機備註**（`extension/popup.html`/`i18n.ts`）。小白不知道進階設定的「複製 MCP 設定」何時用 → 按鈕下方加灰色 11px 小字 `<p class="mcp-hint" data-i18n="mcp-config-hint">`「當 AI 無法讀取你的報告時，按此複製，貼給你的 AI 重新設定」（EN: If AI cannot read your reports, copy this and paste to your AI to reconfigure）+ `.mcp-hint` CSS。i18n 1 鍵中英。純 extension，`npm run build` ✅（dist popup.html/js 含 `mcp-config-hint`）。待重上架。

- PM-196：**報告頁分享連結一鍵複製 + 我的報告勾選批次刪除**（`server/index.ts`）。**§1** 報告頁 `/report/:id` 底部加分享連結 input + 「📋 複製連結」（`report-page.js?v=196`：render 成功才顯示、填 `location.origin+'/report/'+id`、複製用 `select()`+`execCommand('copy')` **非 clipboard API、非 inline onclick**——報告頁 CSP `script-src 'self'` 不允許 inline handler，故寫在外部 JS 用 addEventListener，按完變「✅ 已複製！」2s 恢復）。**§2** 我的報告 `/reports` 每行加 checkbox + 表頭全選 + 底部「🗑️ 刪除選取 (N)」（≥1 勾才顯示）+ `confirm('確定刪除 N 份？此操作無法還原')` → DELETE 後 `location.reload()`。**§3** 新增 `DELETE /api/reports`（`deleteReportsApi`：Bearer `verifySession` → `.eq(user_id).in(report_id, ids)` 只刪自己的、`report_ids` 最多 50 筆、回 `{deleted:N}`；無 token→401、無 ids→400）。**§4** i18n 中英。線上實測：/reports delete UI + /report share 複製 wiring、DELETE 無/錯 token→401、中英雙語皆present。`tsc` clean → `wrangler deploy`（`27605259`，同時帶上先前已 commit 未 deploy 的 FOX 手改：guide/faq URL + install regex 修 + 舊 URL redirect）。（技術債：刪除只刪 DB 列，R2 rrweb/screenshots 物件成孤兒——報告已 404 不可存取，孤兒僅少量儲存成本。）

- PM-195：**編輯報告頁 Token 估算加 USD 單位（與最終報告頁一致）**（`extension/edit-report.ts`）。停止錄製後的編輯/補充說明頁 `renderTokenEstimate` 底部總計與 Claude in Chrome 對比原本只顯示 `≈ $0.0049`，最終報告頁（server）是 `≈ USD $0.0049` → 兩處改 `≈ USD $` 對齊。計算邏輯/最終報告頁/MCP 皆不動。純 extension，`tsc` clean → `npm run build` ✅（dist `USD $`×2 確認）。待重上架。

- PM-194：**鍵盤模式與麥克風 toggle 互斥聯動**（`extension/popup.ts`）。勾「⌨ 鍵盤模式（關閉語音）」時麥克風仍 ON 不合理。修：①勾鍵盤模式 → 若麥克風 ON 則 `micToggle.checked=false` + `dispatchEvent('change')`（走既有關閉邏輯，含存 `MIC_KEY`）；②手動開麥克風 → 若鍵盤模式勾選則 `keyboardMode.checked=false` + `dispatchEvent('change')`（存 `KEYBOARD_MODE_KEY`）；③取消鍵盤模式不自動開麥克風（使用者自己決定）。用 dispatchEvent 復用兩個既有 handler 的存 storage 邏輯 → 狀態同步、reload 一致；互斥設計無事件迴圈（對方被設 false 後反向條件不成立）。純 extension，`tsc` clean → `npm run build` ✅（dist wiring 確認）。待重上架。

資安：`/reports` 等頁 session token 移出 URL query（改 fragment + localStorage + `history.replaceState`，P0，PM-187）；`/report/:id` 報告分享改「owner 或付費會員才能讀」付費牆（P0 資安＋商業，PM-188）。商業化：JSON 複製/匯出改付費會員專用 + 每次操作敏感資料免責警語（P1，PM-189）；MCP URL 帶 `?token=`（方案 B，AI 零操作讀報告，`session_token` 參數改 optional，PM-190）+ popup「📋 複製 MCP 設定」一鍵複製含 token（PM-191）。麥克風：精準轉錄（Whisper）offscreen 音量條不動修復（`AudioContext.resume()`，PM-192）+ 「允許這次使用」時自動 fallback 即時字幕 + 頁面橘色提示 + popup 授權小字（PM-193）。維運：Chrome Web Store extension ID 統一 `hfnkjlbbpehkflgfbjenfmnmjkdjadcj`（manifest 加 `key` 綁定固定 ID）；`/install` 一鍵複製徹底修好（`data-copy-text` 解耦 DOM，並修 template literal 內 regex 反斜線被吞的隱藏 bug）；舊 `bugezy-api.workers.dev` → `bugezy.dev` 301 redirect（MCP/API 除外）。

- PM-193：**精準轉錄麥克風授權引導 — 選「允許這次使用」時 fallback 即時字幕 + 提示**（`extension/background.ts`/`content.ts`/`types.ts`/`popup.html`/`popup.ts`/`i18n.ts`）。根因：Chrome「允許這次使用」= 單次單頁面權限，offscreen document 是另一個頁面 → 拿不到 → Whisper 麥克風開不了（選「允許這個網站使用」才正常，瀏覽器設計限制無法繞過）。修法：①background `startRecording` 收到 offscreen 回報 `getUserMedia` 失敗（`micRes.ok=false` 或例外）→ 設 `whisperMicFailed`，`START_RECORDING` 帶 `micFallback:true`；②content 收到 `micFallback` 且原為 whisper → **無縫改用即時字幕**（`useOldVoice=true`/`whisperMode=false`，走頁面 SpeechRecognition——頁面有單次權限所以可用），錄製不中斷；③content 在頁面頂部顯示橘色提示條 8 秒（`showMicFallbackTip`，i18n `mic-fallback-tip`）；④popup 語音模式選擇下方加小字「💡 精準轉錄需選永久允許」（`micPermHint`，跟 micMode 一起顯示）；i18n 中英。純 extension，`tsc` clean → `npm run build` ✅（dist wiring 確認）。待重上架。

- PM-192（精準轉錄麥克風修復）：**Whisper 模式音量條不動 / 麥克風疑似沒開**（`extension/offscreen.ts`/`background.ts`）。根因：offscreen document **無 user gesture** → `new AudioContext()` 預設 `suspended` 狀態，AnalyserNode 不被推進、`getByteFrequencyData()` 全 0 → 5 條音量條永遠平的（即時字幕的音量走「頁面」AudioContext、頁面有 gesture 故正常——正是「即時字幕正常、精準轉錄不動」的差異）。修：`startVolumeMeter` 在 `state==='suspended'` 時 `await audioCtx.resume()` 讓 context 運轉。另修觀測性：`startRecording` 的 `getUserMedia` 失敗原本被吞掉、handler 秒回 `{ok:true}` → background 誤以為成功；改為 handler `await startRecording()` 回報真實 `{ok,error}`、background 檢查 `micRes.ok` 失敗即 log（授權被撤/裝置佔用/擴充 ID 變動導致權限失效等會現形）。純 extension，`tsc` clean → `npm run build` ✅（dist offscreen/background wiring 確認）。待重上架。

- PM-192：**/install「一鍵複製，貼給你的 AI」按鈕修復**（`server/index.ts`）。問題：按下無視覺回饋、貼出空白。修法：①copy handler 改 IIFE 確保綁定；②複製 `#ai-install-prompt` 完整安裝指令（含 Chrome Web Store 連結 + MCP JSON）；③`navigator.clipboard.writeText` 失敗 → fallback（隱藏 `readonly` textarea + `select()` + `execCommand('copy')`），無 clipboard API 也走 fallback，解「貼出空白」；④按鈕按下變綠色「✅ 已複製！」（`.copied` #238636）2s 後恢復原文字；⑤`.copy-btn:active { transform:scale(0.97); opacity:0.8 }` 沉下去回饋 + `transition`。線上實測 /install 中英：fallbackCopy/execCommand/flashDone/active/copied 皆present、複製內容含商店連結 + mcpServers JSON。`wrangler deploy`（`fae65da2`）。**續修**（`403b46da`）：回報「有回饋但貼出空白」根因＝fallback textarea 用 `opacity:0` + `left:-9999px`，部分瀏覽器 `select()` 失效 → `execCommand('copy')` 回 true（假成功觸發回饋）但剪貼簿實空；改 textarea 為「視窗內 1px 可選取」（`position:fixed;top/left:0;width/height:1px`，不用 opacity/off-screen）+ `setSelectionRange`，確實 select+copy；加 `console.log` 診斷（文字長度/預覽/走哪條路徑：clipboard OK / fallback ok）。CSP 確認：/install `script-src` 含 `'unsafe-inline'` 未擋 inline script、clipboard API 不受 CSP 管轄，故不需外部 JS/hash（排除 CSP 因素）。**三修**（`0bea1edc`）：仍空白 → 改最穩健方案，複製源與 DOM 完全解耦。安裝指令抽成 `const aiPrompt`（installPage + homePage 各一），`<pre>` 與按鈕共用；按鈕加 `data-copy-text="${encodeURIComponent(aiPrompt)}"`；click handler 改 `getText()` 優先 `btn.dataset.copyText`（`decodeURIComponent`）、DOM textContent 僅 fallback。首頁同法修（含 robust fallback + active/copied CSS）。PM-190 token 填入後同步 `setAttribute('data-copy-text', …)` 保持顯示與複製一致。線上實測 /install + 首頁：`data-copy-text` decode 560 字（含商店連結 + mcpServers JSON）、handler 讀 `dataset.copyText`。**四修**（`ff8c6dd2`）：/install 登入狀態仍空白——根因＝install 比首頁多一段「PM-190 token 填入後 `setAttribute('data-copy-text', encodeURIComponent(cpre.textContent))`」的同步（只在登入時跑），把靜態 data-copy-text 覆寫掉（未登入不跑故正常、登入才空白，正是首頁沒有的差異）。修法：移除該同步 + PM-190 `.mcp-cfg` forEach 跳過 `#ai-install-prompt`（`if (el.id === 'ai-install-prompt') return`），讓它的複製來源＝server render 的靜態 `data-copy-text`、textContent 全程不被 JS 動——與首頁完全一致；其餘 `.mcp-cfg` 設定區塊照常自動補 token。線上實測 /install：新 skip 行 present、舊 sync 0、data-copy-text 靜態 560 字。**五修**（`8e1693f1`）：FOX 手動改的 install 除錯版（`var COPY_TEXT = ${JSON.stringify(aiPrompt)}` + `alert`，且按鈕拿掉 data-copy-text）壞掉——alert 不彈=JS 語法錯。改回與 homePage **字元級一模一樣**：按鈕加回 `data-copy-text="${encodeURIComponent(aiPrompt)}"`、複製 script 用 `getText()` 讀 `btn.dataset.copyText`、刪 `var COPY_TEXT`/`alert`。Python 比對兩頁複製 IIFE `IDENTICAL: True`；線上 /install COPY_TEXT/alert 0 筆、data-copy-text decode 560 字。

- fix：**Chrome Web Store extension ID 更新**（`server/index.ts`）。全站 4 處 Chrome Web Store 連結的 extension ID `mpkakmmfllghcdaeicdlnpogneeanhmb` → `hfnkjlbbpehkflgfbjenfmnmjkdjadcj`（首頁 + /install 的 AI 安裝提示中英各 2 處）。/install「一鍵複製」按鈕（`navigator.clipboard.writeText` 複製 `#ai-install-prompt` textContent）複製到的內容因此帶正確商店連結。線上實測 /install + 首頁 新 ID present、舊 ID 0。`wrangler deploy`（`63c74467`）。

- PM-191：**popup 進階設定「📋 複製 MCP 設定」一鍵複製（含 token）**（`extension/popup.ts`/`popup.html`/`i18n.ts`）。配合 PM-190 URL token，讓使用者一鍵拿到帶 token 的完整 MCP JSON 貼給 Claude/Cursor（AI 零操作讀報告）。進階設定區加 `#copyMcpBtn`；點擊讀 `chrome.storage.local['bugezy:session-token']` → 組 `{"mcpServers":{"bugezy":{"url":"https://bugezy.dev/mcp?token=<token>"}}}`（`JSON.stringify` 縮排 2）→ 寫剪貼簿 → 顯示綠色「✅ 已複製！貼到 Claude/Cursor 設定即可」（4s 後隱藏）；未登入（無 token）→ 不複製空設定，改橘色提示「請先登入 BugEzy 再複製」。i18n 3 鍵中英。純 extension，`tsc` clean → `npm run build` ✅（dist wiring 確認），待重上架。

- PM-190：**MCP URL 帶 session_token（方案 B — AI 零操作讀報告）（P1）**（`server/index.ts`）。PM-165 把 MCP session_token 改必填、安全但 AI 每次要手動帶 token；改為業界標準做法（Asana/Jira/GitHub MCP）把 token 放 MCP URL。①**§1 handler 入口**：`/mcp` 從 URL query 讀 `?token=` → 存進「per-request env 副本」`mcpEnv = { ...env, __mcp_session_token: urlToken }`（用副本非改共用 env，避免同 isolate 併發 request 跨 tool await 期間互相覆寫 token 的競態）→ `createMcpServer(mcpEnv)` + `handler(request, mcpEnv, ctx)`。②**§2 三個需 token 的 tool**（list_reports / get_live_errors / get_terminal_logs）：`const token = env.__mcp_session_token || args.session_token || ''`（URL 優先 → 參數向下相容），`session_token` schema 改 `.optional()`。③**§3 /install 頁**：MCP 設定/網址加 `.mcp-cfg` class + 內嵌 script——已登入（同源 localStorage `bugezy_session_token`，PM-187 seed）→ 自動把本頁所有 `bugezy.dev/mcp` 補上 `?token=<token>`（冪等 regex），未登入維持乾淨 `/mcp`（token 現 optional）+ 提示文。④**§4 log**：確認 `/mcp` 不 `console.log` request URL（無 token 進 log）。verifySession/功能邏輯/extension/ECPay/報告頁 皆不動。線上實測（真實 MCP JSON-RPC）：initialize 200；list_reports 無 token→「請在 MCP URL 加上 ?token=」（證 optional 生效）、`?token=invalid`→「驗證失敗」（證讀 URL token）、param token→「驗證失敗」（證向下相容）；/install 6 處 mcp-cfg + token script + 提示。`tsc` clean → `wrangler deploy`（`c7c44abe`）。

- PM-189：**JSON 複製/匯出改為付費功能 + 敏感資料免責警語（P1）**（`extension/popup.ts`/`popup.html`/`i18n.ts`）。原「📋 複製 JSON」「💾 匯出 JSON」免費開放 → 任何人可取完整未遮罩 payload（console/network 敏感資料）；此為進階用途，限付費會員並加免責。`loadPlan` 計 `isPaidMember`（月費 paid / 取消未到期 cancelled / 日票未到期 day_pass）；免費用戶點 → `showJsonPaidOverlay`（沿用 PM-170 升級 overlay，標題改「此為會員進階功能」+ 日票/月費 CTA，非台灣 coming soon）不執行；付費用戶點 → `confirmJsonDisclaimer()`（⚠️ 敏感資料免責警語彈窗，[取消]/[我了解，繼續]，**每次都顯示**，法律免責不設「不再提示」）→ 確認才複製/匯出。免費按鈕顯示 `🔒 複製 JSON（會員）`/`🔒 匯出 JSON（會員）`（`updateJsonLockUI`，於 `applyTranslations` 後套用避免被靜態翻譯還原）。i18n 7 鍵中英。MCP 輪盤「複製指令」/複製分享連結/報告頁/Server/MCP 皆不動。`tsc` clean → `npm run build` ✅（dist popup.js/html wiring 確認）。純 extension，待重上架。

- PM-188：**報告分享閱讀權限——非擁有者需付費會員才能讀（P0 資安＋商業）**（`server/index.ts`）。原 `/report/:id` 是「有連結就能看」→ 任何人拿 UUID 即可讀完整 console/network/語音，貼公開論壇就外洩；同時做付費動機（想看別人分享的報告 → 需成為會員 → 病毒式引流）。`getReport()` 加認證：讀 `Authorization: Bearer`（可選）→ `verifySessionByToken`；**owner 看自己不論付費狀態放行**；非 owner 訪客（無/無效 token）→ 403 `login_required`；已登入非 owner 且非付費 → 403 `upgrade_required`（複用既有 `isActiveUserId`，不重寫付費檢查）；403 走 `jsonNoStore` 防邊緣快取跨使用者外洩。報告頁 `report-page.js`（`?v=188`）加 `resolveSessionToken()`（同 PM-187：`#token` fragment 優先→清 URL→否則同源 localStorage）帶 Bearer；403 顯示付費牆（🔒 標題 + 說明 + 「免費安裝 BugEzy」/「了解會員方案」兩 CTA + 「已是會員請從擴充登入」，中英）。owner 身分靠 PM-187 存於 bugezy.dev localStorage 的 token（同源可讀，開 📋 我的報告即 seed）。MCP tools（自帶 session_token + 付費檢查）/ `/api/my-reports` / `createReport`（免費可上傳）/ ECPay 皆不動。線上實測：兩份真實報告 visitor/錯 token → 403 `login_required` no-store、fake id → 404（存在性先於認證）、`report-page.js?v=188` 含 resolveSessionToken/renderPaywall/Authorization。`tsc` clean → `wrangler deploy`（`5d015795`）。

- PM-187：**修復 /reports session token 放 URL 的資安洩漏（P0）**（`server/index.ts` + `extension/popup.ts`）。原 `/reports?token=xxx` 把 session token 放 query string → 洩漏於瀏覽器歷史/Referrer/截圖分享。改法：①**popup** 改開乾淨 `bugezy.dev/reports#token=xxx`（fragment 不送 server、不入 Referrer/歷史）；②**/reports** 由 server 端渲染改為 **client bootstrap shell**——內嵌 `resolveSessionToken()` 依序讀 `?token=`/`#token=`（讀到即存 `localStorage['bugezy_session_token']` + `history.replaceState` 清 URL）→ 否則讀 localStorage → 皆無顯示「請先從 BugEzy 擴充登入」；有 token 則以 `Authorization: Bearer` 打新端點 `GET /api/my-reports` 取 JSON、client 端用 `textContent`/DOM 建表（XSS 安全）；③新增 `myReportsApi`（Bearer 驗證，401 無授權，私人資料 `no-store`）；④語言切換連結只帶 `?lang=` 絕不帶 token。稽核確認 `/feedback`（公開免登入）與 `/report/:id`（分享用 latestReportUrl，無 token）本就無 URL token 洩漏。`verifySession`/MCP token 驗證/ECPay 流程皆不動。線上實測：GET /reports 200 text/html no-store（含 resolveSessionToken/reportsContainer/history.replaceState）、中英登入提示、`/api/my-reports` 無/錯 token→401、網址列不含 token。`tsc` clean → `wrangler deploy`（`b107139d`）+ extension `npm run build`（dist `reports#token` 確認、無殘留 `?token=`）。

## 2026-07-06

Day 21（PM-170~186）。**免費版留存 + 全球化 + Python 9→10 + 我的報告 + 截圖 PII 防護 + 維運**。
用量：每月自動重置 + 回溯檢查 + 用完升級引導 overlay（PM-170）。全球化：付費資格改 IP 國家偵測（非台灣 coming soon，PM-171~172）、「MCP AI 讀取」白話並列（PM-173）。體驗：問題回報頁 /feedback（PM-174）、輪盤語言切換 bug 修（PM-175）、我的報告列表頁 /reports + popup 入口（PM-184）、官方測試頁大更新涵蓋所有捕捉能力（PM-180）。Python 9→10 分：CLI stderr 結構化解析（traceback→JSON，PM-176）+ 環境快照（版本/套件/OS，PM-177）+ MCP 結構化回傳（PM-178）+ Terminal AI 導航摘要（21 種錯誤白話，PM-179）。截圖強化：附帶 console/network 錯誤（PM-181）、敏感欄位偵測+馬賽克筆刷（PM-185）+ 自動遮罩可撤銷（PM-186）。維運：sessions cron 清理 + MCP 端點 1MB 限制（PM-182/183）。

- PM-186：**截圖敏感欄位自動遮罩（預設安全 + 可撤銷）**（`extension/content.ts`/`annotate.ts`/`i18n.ts`）。PM-185 只提醒 → 進階為自動遮罩。content `getSensitiveRects()` 截圖時收集敏感欄位 viewport 座標（+原頁 viewport 尺寸）存 storage；annotate 載入截圖後按比例（用原頁尺寸換算）`applyMosaic` 自動在敏感座標畫馬賽克 + 頂部「🔒 已自動遮罩 N 個」+「撤銷遮罩」（還原原圖）。**安全 gate**：只在整頁截圖（scaleX≈scaleY）自動遮，區域/自由裁切座標會錯位故略過（避免假安全）。PM-185 手動馬賽克筆刷 + 警告保留（雙保險）。`npm run build` ✅。未 deploy（純 extension，待重上架）。

- PM-185：**截圖敏感偵測 + 馬賽克筆刷（偵測到才提醒）**（`extension/content.ts`/`annotate.ts`/`annotate.html`/`i18n.ts`）。截圖可能拍到密碼/API key/卡號 → 截圖前掃 DOM 防護。`detectSensitiveFields()`（content.ts，掃 password/token/secret/key/card/cvv/data-sensitive 共 7 類 input）→ 偵測到才彈 ⚠️ 警告 overlay（繼續截圖/取消）+ 設 flag，**沒偵測到不打擾直接截**；annotate 工具列加「🔒 馬賽克」筆刷（拖曳塗該網格方塊平均色）；偵測到時標注頁頂部橘色提示條；i18n 中英。`npm run build` ✅（dist 3 檔 wiring 確認）。未 deploy（純 extension，待重上架）。

- PM-184：**「我的報告」列表頁 + popup 入口**（`server/index.ts` + `extension/popup.html`/`popup.ts`/`i18n.ts`）。使用者沒地方回看歷史報告 → 新增 `GET /reports?token=`（抽 `verifySessionByToken` 驗證→查 reports→server 渲染表格：時間/標題/描述/badges ❌🌐🎙️📸🎬/查看連結，中英雙語 + 語言切換）；無/無效 token 顯示提示頁；popup 加「📋 我的報告」按鈕（帶 session token 開網頁）；robots.txt `Disallow: /reports` + `noindex` + `no-store`；全站 footer 加連結。線上實測無 token 提示(中英)/無效 token 過期/robots/no-store/footer 皆 ✅。`wrangler deploy`（`262e684e`）+ extension build。

- PM-182/183：**Sessions cron 清理 + MCP 端點防護**（`server/index.ts`）。**PM-182**：`scheduled` cron（每日 03:00 UTC）追加清理過期 sessions（`delete().lt('expires_at', now)`，log Cleaned N；verifySession 即時清理保留為雙保險）。**PM-183**：①稽核 13 個 MCP tool 成功回傳皆走 `logMcpUsage`（mcp_usage 表計數），**get_timeline 確認有、無遺漏**；②`/mcp` 入口加 body 1MB 限制（Content-Length>1MB→413，補 Cloudflare rate-limit 只覆蓋 /api/ 的缺口）。線上實測 /mcp >1MB→413、正常→200。（釐清：users.mcp_count 配額對 report_id-based tool 無使用者身分故無法遞增，實際用量計數靠 mcp_usage 表，已完整。）`wrangler deploy`（`cf37486b`）。

- PM-181：**截圖報告附帶 Console + Network 錯誤**（`extension/content.ts`/`background.ts`/`annotate.ts`/`types.ts`）。截圖報告原本只有畫面+語音+快照，不帶 console/network（annotate.ts 寫死空陣列）→ 補上讓 AI 精準定位。實作對齊真實架構（content 擷取→background 開 annotate→annotate 上傳）：content 截圖時經 `queryInjectLiveErrors`（GET_LIVE_ERRORS→LIVE_ERRORS_RESULT）取 inject 的 bgConsoleLogs/bgNetworkErrors，附到 `SCREENSHOT_READY`；background 快取 + 新增 `GET_COLLECTED_ERRORS` handler；annotate 上傳前取用填入 payload。`console_logs`/`network_errors` 存同欄位 → MCP get_console_logs/get_timeline + 報告頁自動受益（server/MCP 不改）。`npm run build` ✅（dist 4 檔 wiring 確認）。未 deploy（純 extension，待重上架）。

- PM-180：**官方測試頁大更新（涵蓋所有捕捉能力 + Python CLI 指引 + 中英雙語）**（`server/index.ts`）。`TEST_PAGE_1` 常數改函式 `testPage1(lang)`，新增 6 區塊：⚡Promise 靜默失敗（PM-154）/🖼資源載入失敗 404（PM-155）/📡Web Vitals CLS·LCP（PM-155）/🌐網路環境即時顯示（PM-156）/💾儲存快照+PII 遮罩測試（PM-157）/🐍Python·Node CLI 可複製指令（PM-176~179）；保留現有 Console/Network/DOM/截圖/跨頁/輸入；全 `getLang`+`t(zh,en)` 中英 + 語言切換鈕 + no-store；副標改「完整測試所有捕捉能力 — 前端+後端+AI 分析」。線上中英雙語實測 12 區塊 + 新 JS 函式 + Python 指令皆present。`wrangler deploy`（`d058123b`）。

- PM-179：**CLI 錯誤 AI 導航摘要（Terminal 版 generateBugSummary）**（`server/index.ts`）。同 PM-159 精神，規則引擎零成本：`generateTerminalSummary()` 取 parsed_errors 最後一個為根因 → ⚡根因 + 💡白話（**Python 16 種**+**Node 5 種**常見錯誤解釋與修復建議）+ 📍位置（file 第 N 行 → function + 程式碼）+ 🖥環境；多錯誤標註、無錯誤提示查 stderr。`get_terminal_logs` 回傳最前面插入摘要（摘要→結構化錯誤→原始 stderr）。node 實測 KeyError/ImportError(pip install)/Node TypeError(optional chaining)/位置皆正確。至此 Python 9 分升級 PM-176~179 完成。`wrangler deploy`（`ceee9a59`）。

- PM-178：**MCP get_terminal_logs 回傳結構化**（`server/index.ts`）。PM-176/177 讓 CLI 傳 parsed_errors+runtime → 新 `formatTerminalLogs()` 把回傳從原始 JSON 改結構化文字：🖥 環境（language/version/os + 📦 套件前 20）→ 🔍 偵測到 N 個錯誤（每個類型/訊息/堆疊 `file:line in function()` + 程式碼）→ 原始 stderr（logs 陣列轉文字）；全空→「目前沒有終端機錯誤記錄」。`readTerminalLogs` 無需改（原本就 passthrough 整包 R2，含 parsed_errors/runtime）。node 實測輸出格式正確。`wrangler deploy`（`25a48724`）。

- PM-177：**CLI 環境快照（語言/版本/OS/套件）**（`cli/detect-env.ts`(新) + `cli/index.ts`）。AI 診斷需環境背景 → 新 `detectRuntime(command)` 依指令關鍵字判語言（python/node/go），抓 `python --version`+`pip list --format=freeze` / `node --version`+`npm list --json`（`name@version`）、OS=`platform arch`、packages ≤50；跨平台（`2>&1` cmd/sh 皆可、stderr 忽略、5s timeout、失敗靜默）。CLI 啟動抓一次 → payload 加 `runtime`；server 靠既有 full-payload passthrough 自動存 R2（runtime 無敏感欄位）。node 實測 node→v22.22.2+packages、python→3.14.3+pip、unknown→空。`wrangler deploy`（`c2d93214`）+ CLI build。

- PM-176：**CLI stderr 智慧解析——Python traceback / Node Error 結構化**（`cli/parse-traceback.ts`(新) + `cli/index.ts` + `server/index.ts`）。CLI 原把 stderr 當純文字上傳 → 新增 `parsePythonTraceback`/`parseNodeError` 解析成 `{type,message,frames[file,line,function,code],raw,runtime}`；stderr chunk **先 maskStderr 再解析**（結構化資料也遮罩）→ payload 加 `parsed_errors` 陣列（logs 維持既有陣列相容）；server `POST /api/terminal-logs` 整包存 R2 + `maskTerminalPayload` 擴充雙重遮罩 parsed_errors（message/raw/frames.code）。node 實測：Python KeyError/Node TypeError 正確結構化、正常 stderr→null、DB 密碼在 frame.code 已遮罩。`wrangler deploy`（`a7e4781e`）+ CLI build。

- PM-175：**修復 AI 輪盤語言切回中文不重置 bug**（`extension/popup.ts`）。根因：原 `JSON.stringify` 比對預設值因序列化微差異誤判「已自訂」→ 英→中切不回來。改用明確 flag `bugezy:prompts-customized`：未自訂（flag≠true，含舊使用者）→ 切語言重置為新語言預設；已自訂（儲存/編輯切換時設 true）→ 不重置。移除 JSON 比對。`npm run build` ✅（dist 含 flag、舊 JSON 比對已移除）。未 deploy（純 extension，待重上架）。

- PM-174：**官網問題回報頁 /feedback**（`server/index.ts` + `schema.sql`）。使用者遇問題無回報入口 → 新增 `feedbackPage(lang)`（中英表單：Email 選填/類型/描述 5000 字上限+字數計數，inline JS fetch 不跳頁、成功顯示感謝）+ `POST /api/feedback`（**不需登入**，驗證非空/≤5000、存 Supabase `feedback` 表含 `country` IP 偵測、錯誤脫敏）+ 全站 7 處 footer 加「📬 問題回報」+ sitemap 加 /feedback + SEO meta。`feedback` 表加入 schema.sql（RLS，service_role 寫入）。線上實測：GET 中英、POST 空白/過長→400、正常→200 實寫入、sitemap+footer ✅。`wrangler deploy`（`fa0ba8e2`）。

- PM-173：**全站文案「MCP」→「MCP AI 讀取」並列 + 免費額度數字核對**（`server/index.ts` + `extension/i18n.ts`/`popup.html`）。小白不懂「MCP」→ 保留 MCP 並列「AI 讀取」（行家認得出）：①面向使用者的配額/用量文案改「MCP AI 讀取」——首頁定價 `MCP 月 20 次→MCP AI 讀取 月 20 次`、FAQ 免費額度/Token 說明、bumpUsage 403 label、隱私、日票成功頁、extension `usage-desc-mcp`/`intl-free-hint`（中英皆改）；②**技術設定不動**——/install MCP config/端點、「MCP 是什麼？」教育條、meta 品牌詞、工具清單、tool name；③免費額度數字全站核對**本就一致**（10 錄製/5 回溯/20 MCP AI 讀取/截圖無限/7 天）。`wrangler deploy`（`5f8bda9b`）+ extension build。

- PM-172：**付費判斷改 IP 國家偵測（取代 PM-171 語言判斷）**（`server/index.ts` + `extension/popup.ts`）。PM-171 用語言判斷不嚴謹（台灣人選英文看不到付費、香港人選中文付不了）→ 改用 Cloudflare `request.cf.country`（零成本/準確/無法偽造）。①`cfCountry()`/`isPayCountry()`（白名單 `['TW']`）helper；`getUserPlan` 回 `country`；②popup 改 `currentCountry`（來自 plan.country）+ `isTaiwanUser()=country==='TW'`，移除語言判斷（語言只控 UI/語音、不控付費）；③`homePage(lang, request)` 定價 CTA 依國家（非語言）；④`/checkout`+`/api/day-pass/create` 加 `country!=='TW'` 403（防繞 UI 直呼）。線上實測（本環境 IP=TW）：首頁 EN 版顯示付費按鈕（語言≠付費，驗收 #2）。`wrangler deploy`（`bfb538fa`）+ extension build。

- PM-171：**非台灣用戶付費 coming soon（策略 B：全球下載 + payments coming soon）**（`server/index.ts` + `extension/popup.ts`/`popup.html`/`i18n.ts`）。綠界只收台灣卡 → 用**語言判斷**（非 IP）：`zh`=台灣正常付費，`yue`/`en`/其他=coming soon。①popup `isTaiwanUser()`（原始語言判斷）；免費版台灣→日票/月費鈕、非台灣→`#intlNotice`（🌏 國際付款即將開放藍框）；**修正** langSelect zh↔yue 早退不重繪 → 改一律 loadPlan（付費地區會變）；②PM-170 用完 overlay 非台灣隱藏付費鈕改 coming soon；③首頁 EN 定價 CTA/hint 改「Install Free →」+「International payments coming soon」（ZH 不變）；④i18n intl-* 中英。`wrangler deploy`（`6cb37ac5`）+ extension build。

- PM-170：**免費版每月用量重置 + 回溯用量檢查 + 用完升級引導**（`server/index.ts` + `extension/background.ts`/`popup.ts`/`popup.html`/`i18n.ts`）。修三缺口：①用量不重置（一生累加永久鎖）→ `bumpUsage` 加「距上次重置 ≥30 天歸零三個 count」（`usage_reset_at` 欄位 PM-63 已存在）；②回溯無用量檢查 → `background.ts` 抽泛型 `checkUsage(type)` + 新 `checkRewindUsage`，`REWIND_30S` 前檢查達上限不進入；③用完沒引導 → popup 新增 `#upgradeOverlay`（📋 本月額度已用完 + 錄製/回溯 N/N + ⚡日票 + ✨月費 + 💡每月自動重置），錄製/回溯 403 即彈；popup 三卡片顯示「剩 N 次」（≤2 紅色）/付費「✨ 無限次」；`getUserPlan` 回 `usage_reset_at`；i18n 中英 7 鍵。`wrangler deploy`（`a4c29ca8`）+ extension build。

## 2026-07-05

Day 20（PM-153~169）。**Bug 捕捉 10/10 + 安全 9.5/10（Fable5 第三輪全清）**。前半（PM-153~159）Bug 捕捉升級（漏網錯誤 + 效能兜底 + 網路/儲存快照 + MCP 時序麵包屑 + AI 導航摘要）；後半（PM-160~168）Fable5 R3 安全與體驗收尾——Stored XSS 三層防禦 + CSP（script-src 'self'）+ 存取模型文案釐清 + MCP live/terminal 授權補強與必填 session + createReport 額度縱深 + ECPay callback 原子性 + PII 規則擴充 + CLI stderr PII 遮罩 + session rotation + 報告頁 i18n（全站 8 頁完成）；PM-169 extension 改用正式域名 bugezy.dev。

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
