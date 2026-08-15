# BugEzy v2/v3 產品規格書

> 從 Bug Reporter 進化為 AI Debug Partner
> 建立日期：2026-08-15
> FOX + Claude 共同規劃

> **這份文件的用途**：給未來任何 session 的 AI 接手時，一次看懂 BugEzy 要往哪裡走。
> §1~§10 是產品願景與規劃；**附錄 A 是對照現有程式碼的查證結果**，動工前務必一併讀。
> **v0.3 起，A-1／A-2／A-5 三項已由 FOX 定案**，Phase 1 可以開工。
> 完整版（含 §11 全棧 debug、§12 附錄）請看 `bugezy_v2_v3_product_spec.html`。

---

## §1 產品演進路線

### v1（現在，已上線）
- Chrome Extension：6 種錄製模式
- MCP Server：13 個工具（讀歷史報告）
- 人工錄製 → AI 事後分析
- 定位：**Bug Reporter**

### v2（近期）
- 圖釘標注系統
- bugezy-bridge（Native Messaging 極速模式）
- 雲端模式（WebSocket 備用）
- MCP 新增即時操作工具（`navigate_to` / `click_element` / `read_page` / `analyze_element`）
- MCP 新增即時偵測工具（`get_live_errors(source='browser')` / `get_page_health` / `get_web_vitals`）
- Bug 嚴重度分類（🔴 Critical 立即通知 / 🟡 Minor 稍後處理）
- AI Debug 過程視覺化（藍框巡察 + 圖釘變色 + 即時面板）
- 定位：**AI Debug Partner**

### v3（中期）
- AI 自動化 debug 閉環
  - AI 寫代碼 → 開瀏覽器 → BugEzy 自動偵測 → AI 自動修
  - 用戶只說「做一個購物網站」→ 全自動完成含 debug
- BugEzy 成為 AI 開發流程的自動體檢站
- 定位：**AI Debug 自動駕駛**

---

## §2 商業模式

### 定價分層

| 方案 | 價格 | 可用範圍 |
|---|---|---|
| Free | 免費 | v1 錄製 10 次/月 |
| **票券 / 日票** | 活動兌換 · NT$20（24hr） | **v1 無限錄製（不含 v2 功能）** |
| Pro | NT$80/月 | v1 全功能 + **v2 全功能**（圖釘 / bridge / 即時偵測 / 雲端模式） |
| Max | NT$200/月 | Pro + **AI 自動化 debug（v3）** |
| Agent | NT$500/月 | Max + **全棧自動閉環** |

> ✅ **已定案（2026-08-15）**：v2 功能只給訂閱用戶。票券與日票只解鎖 v1 無限錄製——票券是拉新用的免費額度，v2 是付月費才有的差異化價值。實作影響見附錄 A-5。

### AI 算力成本策略
- BugEzy **不購買 AI API** — AI 算力用戶自己的 Claude/ChatGPT 訂閱額度
- BugEzy 只收工具費（MCP 橋接 + 偵測 + 視覺化）
- 用戶越多，BugEzy 的 AI 成本 = 0

### 戰略夥伴模式
- 區域夥伴負責行銷推廣，不參與開發
- 夥伴獲利佔該區域營收 **65%**，FOX 佔 **35%**
- 核心工作：持續產出當地語言的 debug 教學影片
- 推薦碼追蹤用戶歸屬
- 先在台灣驗證模式，再擴展日本、韓國、越南

---

## §3 技術架構 — bugezy-bridge（極速模式）

### 架構圖

```
任何 AI（Claude / ChatGPT / Cursor / Gemini）
    │
    MCP 標準協議
    │
bugezy-bridge（localhost Node.js）
    │
    Chrome Native Messaging
    │
BugEzy Extension（content.ts）
    │
    目標網頁
```

### 安裝方式

```bash
npm install -g bugezy-bridge
```

### 運作方式
- bugezy-bridge 跑一個 localhost MCP server
- 透過 Chrome Native Messaging 連接 Extension
- AI 呼叫 MCP → bridge 轉發給 Extension → 拿結果回傳
- 延遲 **< 50ms**
- 全部在用戶電腦上跑，BugEzy 伺服器成本 = 0

---

## §4 技術架構 — 雲端模式（WebSocket）

### 架構圖

```
任何 AI
    │
    MCP 標準協議
    │
Cloudflare Workers
    │
    WebSocket（Durable Objects）
    │
BugEzy Extension
    │
    目標網頁
```

### 運作方式
- Extension 啟動時建立 WebSocket 長連線
- AI 呼叫 MCP → Workers 透過 WebSocket 推給 Extension
- 延遲 **~200ms**
- 用戶零安裝成本

---

## §5 MCP 工具擴充（v2 新增）

> ✅ **命名慣例已定案（2026-08-15）**：新工具一律 **snake_case、不加 `bugezy:` 前綴**，與現有 13 個工具一致。MCP 用戶端本來就以 server 名稱做命名空間，再加前綴會變成 `bugezy - bugezy:navigate`。

> 📌 **所有操作類／偵測類／圖釘類／監控類工具都帶可選的 `tab_id?: number`**：省略 → 當前分頁（§13.1 偵察模式）；指定 → 只作用於該分頁（§13.2 出任務模式）。
>
> 適用範圍：**操作類 5 個、偵測類 4 個、圖釘類 3 個、監控類 3 個，共 15 個工具**（2026-08-15 定案，圖釘／監控由 PM-301 補上）。唯一例外是 `get_live_errors(source='cache')`——它讀的是已上傳的歷史報告，與分頁無關。

### 瀏覽器操作類

| 工具 | 說明 |
|---|---|
| `navigate_to(url, tab_id?)` | 開啟網頁。**省略 `tab_id` → 開新分頁**（`active:false`，不搶焦點）並**回傳新分頁的 `tab_id`**；指定則在該分頁內導航 |
| `click_element(selector, tab_id?)` | 點擊元素 |
| `type_text(selector, text, tab_id?)` | 輸入文字 |
| `take_screenshot(tab_id?)` | 截取頁面截圖（背景分頁有實作限制，見 §13.2）|
| `read_page(tab_id?)` | 讀取頁面結構（文字，非截圖，省 95% token）|

### 偵測類（BugEzy 獨有優勢，Claude in Chrome 做不到）

| 工具 | 說明 |
|---|---|
| `get_live_errors(source='browser', tab_id?)` | **沿用既有工具加 `source` 參數**：即時讀瀏覽器 Console **與 Network** 錯誤，含嚴重度分類 |
| `get_live_errors(source='cache')` | **預設值**，維持 v1 行為（讀 R2 快取），向下相容。此模式讀的是已上傳的歷史報告，`tab_id` 不適用 |
| `analyze_element(selector, tab_id?)` | 深度分析：DOM + CSS + event listeners |
| `get_web_vitals(tab_id?)` | 效能指標 |
| `get_page_health(tab_id?)` | 整體健康報告 |

### 圖釘類

| 工具 | 說明 |
|---|---|
| `pin_element(selector, description, tab_id?)` | 釘選元素 + 描述 |
| `pin_analyze(selector, tab_id?)` | 釘選 + 自動深度分析 |
| `get_pin_results(tab_id?)` | 取得圖釘的檢查結果（**省略＝當前分頁的圖釘**）|

### 監控類

| 工具 | 說明 |
|---|---|
| `start_monitor(tab_id?)` | 開始即時監控 |
| `stop_monitor(tab_id?)` | 停止監控 |
| `get_monitor_report(tab_id?)` | 取得監控期間的所有異常 |

> ✅ **已定案（2026-08-15）：圖釘類與監控類也吃 `tab_id`。** 這兩類本質上都綁定某個分頁（圖釘是畫在某頁的 DOM 覆蓋層、監控是收某頁的事件流），不帶 `tab_id` 會留下歧義：出任務模式下 `start_monitor()` 到底監控誰？語意與 §13.3 相同（省略＝當前分頁）。
>
> ⚠ **連帶影響：監控與圖釘都是有狀態的，因此「每個分頁各自一份」。** 同時對多個分頁 `start_monitor()` 要能各自獨立運作；`stop_monitor()` 省略 `tab_id` 時**只停當前分頁，不可一次停光全部**——否則 AI 在偵察模式下隨手停一次，會把出任務模式跑到一半的監控一起殺掉。

### 原有報告類（13 個工具，全保留不動）

以下為 `server/src/index.ts` 目前實際註冊的 13 個工具（已對照原始碼確認）：

`list_reports`、`get_report_overview`、`get_console_logs`、`get_network_errors`、
`get_voice_transcript`、`get_page_info`、`get_rrweb_summary`、`get_rrweb_events`、
`get_live_errors`、`get_terminal_logs`、`get_usage_stats`、`get_screenshots`、`get_timeline`

---

## §6 Bug 嚴重度分類

### 自動判定規則

| 嚴重度 | 條件 | AI 行為 |
|---|---|---|
| 🔴 Critical | Uncaught Error / TypeError / ReferenceError | 立即中斷，馬上修 |
| 🔴 Critical | Network 500 | 立即中斷 |
| 🔴 Critical | Promise rejection 未處理 | 立即中斷 |
| 🟡 Minor | `console.warn` | 記錄，稍後處理 |
| 🟡 Minor | Network 404 | 記錄，稍後處理 |
| 🟡 Minor | Web Vitals 超標 | 記錄，稍後處理 |
| ⚪ Info | `console.log` / `info` | 忽略 |

### MCP 回傳格式

```json
{
  "critical": [{ "type": "TypeError", "message": "...", "file": "cart.js", "line": 42 }],
  "minor": [{ "type": "warning", "message": "..." }],
  "summary": "🔴 1 critical, 🟡 2 minor"
}
```

### 用戶可自訂規則
- `/api/` 開頭的 404 → 升級為 🔴
- 含 `deprecated` 的 warn → 降級為 ⚪

---

## §7 AI Debug 視覺化

### 藍框巡察動畫
- AI 操作/偵測時，頁面上出現藍色方框
- 方框移動到 AI 正在檢查的元素位置
- CSS transition 平滑移動（300ms）
- 呼吸光暈效果表示「檢查中」

### 圖釘狀態顏色

| 顏色 | 狀態 |
|---|---|
| ⚪ 白色 | 剛放上去，等待檢查 |
| 🔵 藍色 | AI 正在檢查中 |
| ✅ 綠色 | 檢查完畢，沒問題 |
| ⚠ 橘色 | 輕微問題 |
| 🔴 紅色 | 嚴重問題 |

### 圖釘巡察模式
- 用戶放置多個圖釘並指定順序
- AI 按順序巡察：藍框跑到 ① → 檢查 → 變色 → 跑到 ② → …
- 每個圖釘旁浮出小標籤：「正在分析 DOM 結構…」

### 右下角即時面板

```
┌──────────────────────────────┐
│ 🐛 BugEzy AI Debug          │
│ 📍 巡察進度：2/3             │
│ ├ ① 登入按鈕      ✅ 正常    │
│ ├ ② 購物車        ⚠ 問題    │
│ └ ③ 結帳表單      🔵 檢查中  │
│ ⏱ 已用時間：12 秒            │
│ 📊 Token：~1,200             │
└──────────────────────────────┘
```

---

## §8 跨 AI 平台支援

### 為什麼不綁 Claude
- Claude in Chrome 只給 Claude 用，市場受限
- BugEzy MCP 支援所有 MCP 相容的 AI 工具
- ChatGPT / Cursor / Gemini / Copilot / Claude 都能用
- 市場大 10 倍

### 與 Claude in Chrome 的差異

| | Claude in Chrome | BugEzy MCP |
|---|---|---|
| 操作速度 | ~500ms | 極速 <50ms / 雲端 ~200ms |
| 讀 DOM | 截圖（貴） | 文字（省 95%）|
| Console errors | ❌ 看不到 | ✅ 完整攔截 |
| Network errors | ❌ 看不到 | ✅ 完整攔截 |
| 歷史報告 | ❌ | ✅ 13 工具 |
| 跨 AI 平台 | ❌ 只有 Claude | ✅ 全部 |
| Token 消耗 | 🔥 截圖很貴 | 💰 文字省 95% |
| 視覺化 | 滑鼠亂飄 | 藍框巡察 + 圖釘變色 |

> 📌 本表比的是**能力面**。分頁與 session 面向的比較另見 **§13.4**——**那一面向兩者其實高度相似**，別誤把「共享登入狀態」當成差異化賣點。

---

## §9 開發順序

### Phase 1：bugezy-bridge + 基礎 MCP 工具
- **PM-A**：bugezy-bridge 骨架（localhost MCP + Native Messaging）
- **PM-B**：Extension 接收 bridge 指令
- **PM-B2**：**方案等級判斷雛形** —— 決策 3 使 v2 工具必須擋住票券／日票用戶，`isActiveUserId` 需回傳等級而非布林值（見 A-5）
- **PM-C**：MCP 第一批（`navigate_to` / `click_element` / `read_page` / `get_live_errors(source='browser')`）✅ 命名已定案
- **PM-D**：MCP 第二批（`analyze_element` / `get_page_health` / `take_screenshot` / `get_web_vitals`）

### Phase 2：圖釘系統
- **PM-E**：圖釘 UI（content script 注入 + 釘選元素 + 描述）
- **PM-F**：`pin_analyze` MCP 工具
- **PM-G**：圖釘巡察模式（多圖釘順序檢查）

### Phase 3：視覺化
- **PM-H**：藍框巡察動畫
- **PM-I**：圖釘狀態顏色
- **PM-J**：右下角即時面板

### Phase 4：雲端模式
- **PM-K**：WebSocket 通道（Durable Objects）
- **PM-L**：Extension WebSocket 連線管理

### Phase 5：Bug 嚴重度 + 自動化
- **PM-M**：嚴重度自動分類
- **PM-N**：AI 自動偵測模式（`start_monitor` / `get_monitor_report`）
- **PM-O**：自訂規則

### Phase 6：Max / Agent 方案上線
- **PM-P**：方案分層完整上線（Max / Agent）—— 閘門雛形因決策 3 已提前到 PM-B2
- **PM-Q**：戰略夥伴推薦碼系統

---

## §10 版本記錄

| 日期 | 版本 | 說明 |
|---|---|---|
| 2026-08-15 | v0.1 | 初版，FOX + Claude 共同規劃 |
| 2026-08-15 | v0.2 | HTML 知識庫版本 `bugezy_v2_v3_product_spec.html`（新增 §11 全棧 debug、§12 附錄） |
| 2026-08-15 | **v0.3** | **三項決策定案**：`get_live_errors` 加 `source` 參數、工具全 snake_case、v2 功能只給訂閱用戶 |
| 2026-08-15 | **v0.4** | **新增 §13 雙模式操作**（偵察模式／出任務模式、`tab_id` 參數設計）；§5 工具加可選 `tab_id`；**修正原稿對 Claude in Chrome 的 4 項錯誤宣稱** |
| 2026-08-15 | **v0.5** | 圖釘類／監控類**也加可選 `tab_id`**（共 15 個工具）；補有狀態工具的分頁隔離與收斂規則 |

---

## §13 雙模式操作 — 偵察模式 + 出任務模式

> 章節編號跳過 §11、§12：那兩節（全棧 debug、附錄）**只存在於 HTML 版**。編號刻意與 HTML 版對齊，避免兩份文件互相引用時對不上。

同一套工具、同一個瀏覽器，靠一個可選的 `tab_id` 分出兩種完全不同的工作方式：**AI 看你的分頁**，或 **AI 開自己的分頁去跑**。

### §13.1 偵察模式（讀用戶的分頁）— 「你操作，AI 幫你看」

- 用戶已經開著網頁在 debug，AI 從旁觀察
- 呼叫工具時**不指定 `tab_id`** → 作用於當前分頁
- **不開新分頁、不搶焦點、不打斷用戶**——用戶完全照自己的節奏操作
- 這是 **v2 的預設模式**，也是目前 `bugezy-bridge`（PM-297~299）已實作的行為

典型對話：「我這頁一直跳錯，你看一下」→ AI 呼叫 `get_live_errors(source='browser')` 直接讀用戶眼前這一頁。

### §13.2 出任務模式（AI 開新分頁）— 「AI 自己去測，你忙你的」

- AI 呼叫 `navigate_to(url)` → 開新分頁，**`active: false` 不搶焦點**
- 該呼叫**回傳 `tab_id`**，後續所有操作都帶著它 → 只在 AI 自己的分頁裡動作
- **用戶原本的分頁完全不受影響**，可以同時繼續做自己的事
- 共享瀏覽器 session（cookie / localStorage）→ **登入狀態自動繼承**，不必再餵一次帳密或 token
- 可同時跑多個分頁（各自一個 `tab_id`）→ 平行測多條流程

典型對話：「幫我把結帳流程從頭跑一次」→ AI 開背景分頁自己走完，回報哪一步爆了。

> ⚠ **出任務模式的實作限制（Chrome 平台層面，非設計選擇）**
>
> - **`take_screenshot` 截不到背景分頁**：`chrome.tabs.captureVisibleTab()` 顧名思義只截「該視窗當前可見的分頁」。要對背景分頁截圖只有三條路：① 暫時切過去（**會搶焦點，違背本模式的前提**）② 改用 `chrome.debugger` 的 `Page.captureScreenshot`（**需 `debugger` 權限，會觸發 Web Store 重新審核，且畫面上方會常駐「BugEzy 正在偵錯這個分頁」黃色橫幅**）③ **改開獨立視窗**（`chrome.windows.create({focused:false})`）——AI 的分頁在那個視窗裡是「可見分頁」，`captureVisibleTab` 就能用，且不搶用戶焦點。③ 看起來最划算，Phase 1 動工前需實測確認。
> - **背景分頁會被節流**：Chrome 對非可見分頁大幅降低計時器頻率，閒置久了甚至凍結整個分頁。以「跑完一段流程」為目標的自動化，等待與逾時的判斷不能沿用前景分頁的直覺。獨立視窗方案同樣能緩解這點。
> - **共享 session 是雙面刃**：登入狀態自動繼承很方便，但也代表 **AI 是以用戶的真實身分在操作真實帳號**。破壞性動作（送出訂單、刪除資料、寄信）必須有防線——留待 v3 安全設計處理，此處先標記。

### §13.3 `tab_id` 參數設計

| 呼叫方式 | 作用對象 | 模式 |
|---|---|---|
| 不指定 `tab_id` | 當前分頁 | §13.1 偵察模式 |
| 指定 `tab_id` | 該特定分頁 | §13.2 出任務模式 |
| `navigate_to(url)` | 開新分頁，**回傳 `tab_id`** 供後續帶入 | §13.2 的入口 |

**為什麼是「可選參數」而不是兩套工具**：與 §5 決策 1（`get_live_errors` 加 `source` 而非另開新工具）同一個邏輯——工具數量翻倍會稀釋 AI 的選擇準確度，也讓既有呼叫全部失效。可選參數則**天然向下相容**。

> 🔴 **需要定義的邊界情況（動工前補齊）**
>
> - **`tab_id` 已關閉／不存在**：應回明確錯誤（「分頁 12345 已關閉」），**不可默默退回當前分頁**——那會讓 AI 在用戶的分頁上執行原本要在自己分頁跑的破壞性操作。
> - **當前分頁沒有 content script**（`chrome://`、Web Store、PDF）：沿用 bridge 既有的錯誤訊息。
> - **「當前分頁」的定義**：多視窗時是「最後聚焦視窗的作用中分頁」（`chrome.tabs.query({active:true, lastFocusedWindow:true})`），需寫死避免各工具解讀不一。
> - **有狀態工具的收斂**（監控類、圖釘類）：分頁關閉時必須自動 `stop_monitor` 並釋放該分頁的圖釘狀態，否則出任務模式跑完關掉分頁就會留下永遠不會結束的監控。

### §13.4 與 Claude in Chrome 的差異（分頁與 session 面向）

> 🔴 **原稿此表 5 項有 4 項與事實不符，已重寫 — 動工前務必看這段**
>
> PM-300 卡片原本要寫的比較表，把 **Claude in Chrome 瀏覽器擴充**與 **Anthropic 另一個「隔離雲端沙箱」產品（Claude Cowork 雲端 session／Claude Code 內建瀏覽器）** 混為一談了。實際查證後：
>
> | 原稿的宣稱 | 查證結果 |
> |---|---|
> | 讀用戶當前分頁 ❌（只有自己的分頁）| **錯** |
> | 共享登入狀態 ❌（獨立 session）| **錯** |
> | 同時操作多分頁 ❌ | **錯** |
> | 不打擾用戶 ❌（會搶焦點）| 無法證實（分歧）|
> | 開新分頁 ✅ | 正確 |
>
> **為什麼這很要緊**：這四項若當真，等於認定「共享登入狀態」與「讀當前分頁」是 BugEzy 的獨門優勢——那會把 Phase 1 的行銷主張與開發優先順序全押在一個對手其實早就有的能力上。

| | Claude in Chrome（擴充）| BugEzy |
|---|---|---|
| 開新分頁 | ✅ | ✅ |
| 讀用戶當前分頁 | ✅ 側邊欄直接讀當前分頁 | ✅ |
| 共享登入狀態 | ✅ 跑在你真實的 Chrome 設定檔 | ✅ 同上，兩者皆為瀏覽器擴充 |
| 同時操作多分頁 | ✅ 需把分頁拖進 Claude 的分頁群組 | ✅ 用 `tab_id` 區分，**不需用戶手動編組** |
| 不搶焦點 | 分歧：側邊欄可背景跑；但 MCP 驅動路徑有大量「每次呼叫都把視窗拉到最前」的回報，且無 headless 模式 | ✅ 設計上即 `active:false`（受 §13.2 截圖限制約束）|

**✅ 真正的差異在別處 — 見 §8**：分頁／session 這一面向，兩者其實高度相似（都是跑在使用者真實 Chrome 裡的擴充功能，共享登入狀態是**必然結果**而非設計優勢）。BugEzy 站得住腳的差異化在 §8：**Console／Network 錯誤完整攔截**（對方看不到）、**文字讀 DOM 而非截圖**（省 95% token）、**13 個歷史報告工具**、**跨 AI 平台**（不綁 Claude）。這幾項才是應該寫進行銷主張的。

另一項本表列出的實質差異：**多分頁不需用戶手動把分頁拖進群組**——AI 自己開的分頁天生就帶著 `tab_id`，零操作成本。

📌 查證日期 **2026-08-15**，依據 Anthropic 官方產品頁／支援文件／Claude Code 文件與 GitHub issue。**對手能力變動快，引用前請重新查證。**另註：Anthropic 於 2026-08-12 起讓 Chrome 側邊欄以 Cowork session 形式運作，此表描述的是該變更後的狀態。

---

# 附錄 A：實作註記（對照現有程式碼的查證）

> 以下是撰寫本文件時**實際比對 `server/src/index.ts`、`extension/manifest.json` 與現行方案設定**得到的結果。
> §1~§13 是願景；這裡是動工前必須先知道的現實條件。**開 Phase 1 的卡片前請先讀完這一節。**

## A-1　`get_live_errors` 的兩種模式　✅ **已定案（2026-08-15）**

**定案**：加 `source` 參數，一個工具兩種模式。

```
get_live_errors(source='cache')    → 現有行為，讀 R2 快取（歷史）；預設值，向下相容
get_live_errors(source='browser')  → v2 新增，即時讀瀏覽器 Console／Network
```

**背景**：v1 已有 `get_live_errors`，資料來源是 R2 上由 extension 即時監控寫入的快取（需 `user_email` + `session_token`），屬「非同步落地後再讀」；v2 要的是透過 bridge 直接向當前分頁要資料的同步路徑。兩者行為不同但語意相同，故合併。

**實作要點**：bridge 未安裝或連不上時，`source='browser'` 應**自動退回 cache 並在回應中註明**，而不是報錯——這正是選這個方案的理由（AI 不需要知道 bridge 裝了沒）。

**連帶決定**：原規劃的 `getNetworkFails()` **併入本工具，不另開新工具**——既有 `get_live_errors` 的描述本來就是「即時 **Console/Network** 錯誤」，涵蓋兩者，另開一支會功能重疊。此點為依決策 1 推得，若要拆成獨立 `get_network_fails()` 需另行指示。

## A-2　工具命名慣例　✅ **已定案（2026-08-15）**

**定案**：全用 snake_case，不加前綴，與現有 13 個工具一致。

`navigate_to` · `click_element` · `type_text` · `read_page` · `take_screenshot` · `analyze_element` · `get_page_health` · `get_web_vitals` · `pin_element` · `pin_analyze` · `get_pin_results` · `start_monitor` · `stop_monitor` · `get_monitor_report` · `start_terminal_monitor` · `get_terminal_live_errors` · `correlate_errors`

**理由**：MCP 用戶端通常已用 server 名稱作命名空間，工具名再加 `bugezy:` 會出現 `bugezy - bugezy:navigate` 這種重複。

v2 完成後 MCP 共 **13 + 17 = 30 個工具**（`get_live_errors` 不重複計）。

## A-3　`npm install -g bugezy-bridge` **不足以**接通 Native Messaging

Chrome Native Messaging 除了裝 CLI，還必須：

1. 產生 **native messaging host manifest**（JSON），內含 host 名稱、執行檔路徑、`"type": "stdio"`；
2. 在 `allowed_origins` 填入 **擴充功能 ID**——本專案已用 manifest `key` 固定為 `chrome-extension://hfnkjlbbpehkflgfbjenfmnmjkdjadcj/`（PM-187 起）；
3. 把該 manifest **註冊到作業系統指定位置**：
   - **Windows**：寫登錄檔 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host名>`（值＝manifest 絕對路徑）
   - **macOS**：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<host名>.json`
   - **Linux**：`~/.config/google-chrome/NativeMessagingHosts/<host名>.json`
4. Extension 的 `manifest.json` 要加 **`nativeMessaging` 權限**。

**這會影響上架**：新增 `nativeMessaging` 權限必然觸發 Chrome Web Store 重新審核，且需在 Dashboard 與 `/privacy` 補上該權限說明（見 ARCHITECTURE §4-12、§4-15；v1.1.5 已經因權限問題被退件過一次）。

→ **PM-A 的範圍必須包含「安裝後自動註冊 host manifest」與「解除安裝時清除」**，而不只是發一個 npm 套件。

## A-4　Durable Objects 需要 Workers 付費方案

§4 的雲端模式以 Durable Objects 承載 WebSocket。DO **不在 Cloudflare Workers 免費方案內**（需 Workers Paid，約 $5 USD/月起，另計請求與時長）。

這與 §2「BugEzy 伺服器成本 = 0」的敘述有出入——**極速模式（bridge）確實接近零成本，但雲端模式不是**。定價時要把這筆固定成本算進 Pro 方案（雲端模式列在 Pro）。

## A-5　日票與活動票券的層級　✅ **已定案（2026-08-15）**

**定案**：v2 功能只給訂閱用戶。

| 身分 | 可用範圍 |
|---|---|
| Free | v1 錄製 10 次/月 |
| 票券 / 日票 | v1 無限錄製（**不含 v2 功能**）|
| Pro NT$80 | v1 全功能 + v2 全功能（圖釘 / bridge / 即時偵測）|
| Max NT$200 | Pro + AI 自動化 debug（v3）|
| Agent NT$500 | Max + 全棧自動閉環 |

> ⚠ **這個決策讓分層閘門變成 Phase 1 的前置，而不是收尾。**
> `isActiveUserId()` 目前只回傳「是否付費」的**布林值**，無法區分「票券用戶」與「Pro 訂閱者」。既然 v2 功能要擋住票券用戶，**每一個 v2 的 MCP 工具都需要方案等級判斷** → 已在 §9 Phase 1 增列 **PM-B2**。
> 改動時務必分清 `isActiveUserId`（含票券）與 `isEcpayActiveUserId`（僅 ECPay）—— 見 ARCHITECTURE §4-8，**誤用會導致收錢不開通**。

## A-6　§5 有幾個工具在 v1 已有部分基礎

| v2 規劃 | v1 現況 | 銜接方式 |
|---|---|---|
| `getWebVitals()` | `inject.ts` 已收集 LCP/CLS/FID 並寫入 console 收集器（PM-153~159）| 可直接讀既有收集結果，不必重寫量測 |
| `getNetworkFails()` | `inject.ts` 已攔截 4xx/5xx | 同上 |
| `screenshot()` | `chrome.tabs.captureVisibleTab`（需 `activeTab`）| 已有權限，但**只能截可見區域**；整頁截圖 v1 是另外拼接的 |
| Bug 嚴重度分類（§6） | `generateBugSummary()` 規則引擎已存在（PM-153~159）| §6 的分級可**擴充**這支既有引擎，不必另起爐灶 |

## A-7　小校正

- §5「原有報告類」原稿寫的 `get_network_requests` **不存在**，實際工具名為 **`get_network_errors`**（本文件已更正，並補齊 13 個完整名稱）。
- §8 表格「歷史報告 ✅ 13 工具」與實際相符。

---

## 附錄 B：與現有架構文件的關係

- **`ARCHITECTURE.md`** 記錄的是**已實作**的架構與 16 條必守設計原則（含各種踩過的坑）。動工前必讀，尤其：§4-8（付費判定的兩種來源）、§4-12（上架前權限檢查）、§4-15（隱私政策要對得上程式碼）、§4-16（破壞性排程的安全設計）。
- **本文件**記錄的是**尚未實作**的 v2/v3 願景。
- 兩者衝突時，以 `ARCHITECTURE.md` 描述的現況為準；本文件的規劃需據以調整。
