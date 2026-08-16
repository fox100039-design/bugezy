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
| 2026-08-16 | **v0.6** | **新增 §14 The Octa-Memory Matrix（八層記憶矩陣）**：L1~L8、7 個 `memory_*` 工具、自動學習循環、Phase A~D；**依 §5 決策 2 去掉原稿的 `bugezy:` 前綴** |
| 2026-08-16 | **v0.7** | **決策 4~6 定案**（記憶混合式儲存／L1 兩層式共享／BugEzy 不碰使用者程式碼）；**新增 §14.12 記憶管理**：CRUD 工具 +6（記憶層共 13、全站 43）、多專案 `.bugezy/` 隔離、容量與智慧淘汰、匯出匯入 |

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

## §14 The Octa-Memory Matrix — 八層記憶矩陣

> 當這八層全部組建完成，BugEzy 的大腦結構會呈現**完美的立體防線**。
> AI 不再是每次從零開始的臨時工，而是一個**有記憶、會成長、懂業務、知分寸**的 AI 開發夥伴。

```
L1 🔴 Debug 經驗庫   ─┐
L2 🟡 專案知識庫     ─┼─ 知道「這個專案是怎麼回事」
L3 🔵 客服知識庫     ─┘
L4 🟢 商業邏輯庫     ─┐
L5 🔵 外部依賴庫     ─┼─ 知道「什麼叫做對、什麼不是我的錯」
L6 🔴 資安合規庫     ─┘
L7 🟠 效能帳本庫     ─┐
L8 🟣 團隊協作庫     ─┴─ 知道「改完之後要負什麼責任」
```

🔴 與 🔵 各出現兩次是**刻意的分組**：紅＝會擋下錯誤修改的關鍵防線（L1 經驗、L6 資安），藍＝描述外部環境的知識（L3 使用環境、L5 依賴環境）。

### §14.1 L1 Debug 經驗庫 🔴（動態）

- **為什麼需要**：10 秒秒殺重複 Bug，**省 95% 推理 Token**。同一個 bug 不該讓 AI 從零推理第二次。
- **記憶內容**：每次 debug 成功後**自動記錄**：症狀 → 根因 → 修法 → 關鍵檔案
- **實戰威力**：

> 「TypeError: Cannot read 'map' of undefined → API 回傳 null 沒有預設值 → 加 `?? []` 防護」

下次遇到類似 error → 自動比對歷史 → **直接給修法**。**越用越聰明。**

### §14.2 L2 專案知識庫 🟡（靜態）

- **為什麼需要**：讓 AI 擁有**整幅地圖**，不用每次重複讀取大文件。
- **記憶內容**：架構文件、引擎清單、API 路由表、**已知的坑**
- **實戰威力**：

> 「這個欄位用 `timestamptz` 不是 `timestamp`」→ **AI 不會再犯**

### §14.3 L3 客服知識庫 🔵（支援）

- **為什麼需要**：**產品內建客服**，自動排查環境與安裝問題。
- **記憶內容**：安裝教學（Extension / MCP / Bridge）、FAQ、操作指南、錯誤排解
- **實戰威力**：

> 用戶問「MCP 連不上」→ AI 查 L3 →「最常見原因是 token 過期，請到設定頁重新複製」

**整合 `SKILL.md`**：靜態手冊 ＋ 動態經驗 ＝ 完整客服。

### §14.4 L4 商業邏輯庫 🟢（業務）

- **為什麼需要**：確保 AI 修 Code 時，**數據與業務規則完全正確**。**這是 AI 最常犯的錯——程式碼寫對了，但商業邏輯改錯了。**
- **記憶內容**：核心業務規則
- **實戰威力（LottoShare）**：

> 「冷熱門號碼的權重計算，任何時候分母都不能為 0，且勝率加總必須剛好等於 1（100%）」
>
> ENG-27 回傳的 JSON **格式正確（不噴錯）**，但數據總和 ＝ 1.2（120%）
>
> - ✗ 沒有 L4 → AI 說「沒有 bug」
> - ✓ 有 L4 → AI 說「違反商業規則，權重分配錯誤」→ **主動修正**

### §14.5 L5 外部依賴庫 🔵（環境）

- **為什麼需要**：分辨是**自己的 Bug** 還是**第三方 API 掛掉**。
- **記憶內容**：外部依賴的**脾氣與坑**
- **實戰威力**：

> 「第三方開獎數據 API 每天晚上 8:30~8:35 例行維護，回傳 503 屬正常」
>
> ENG-12 在 8:32 噴網路錯誤
>
> - ✗ 沒有 L5 → AI：「你的程式壞了！」
> - ✓ 有 L5 → AI：「這是 API 維護，不是你的問題。已幫你加上 Retry Circuit Breaker，5 分鐘後自動重試」

### §14.6 L6 資安合規庫 🔴（防禦）

- **為什麼需要**：防止 AI 寫出**有安全性漏洞或密碼外洩**的程式碼。
- **記憶內容**：專案的**資安鐵律**
- **實戰威力**：

> 「嚴禁將 `API_KEY`、`JWT_SECRET`、DB 密碼寫死在代碼中，必須用 `process.env`」
>
> 「使用者的密碼、身分證字號在日誌中必須完全遮蔽」

AI 修完 bug 自動**「自我審查（Audit）」** → 發現自己不小心寫死了一個變數 → **立刻自己改掉** → 確保產出的 PR 100% 符合資安規範。

### §14.7 L7 效能帳本庫 🟠（監控）

- **為什麼需要**：確保修好 Bug 的同時，**網站速度不會變慢**。
- **記憶內容**：各引擎正常運作時的**效能基準（Baseline）**
- **實戰威力**：

> 「正常情況下 ENG-15 大數據機率回歸引擎，單次運算 < 200ms，記憶體 < 128MB」

AI 修完 bug → 重啟引擎 → 自動測試比對帳本 → 發現修完後運算卡了 **2000ms（效能衰退 10 倍）** → **主動撤回修改** → 嘗試更省記憶體的寫法。

### §14.8 L8 團隊協作庫 🟣（流程）

- **為什麼需要**：自動對接 Git 與團隊分工，**PR 寫得比人類更優雅**。
- **記憶內容**：模組負責人（Owner）＋ Git 修改歷史
- **實戰威力**：

> 「Core-Algorithm 模組負責人是 Max，任何修改必須 @Max Review」

AI 修好 code → 自動發 PR → 完美的 commit message → 自動標記 @Max → 附上說明：

> 「本次修改影響 ENG-12，已根據 Max 上週五在 Slack 提到的架構進行優化」

### §14.9 MCP 工具設計

> ✅ **已依 §5 命名慣例調整：去掉 `bugezy:` 前綴。** 原稿寫的是 `bugezy:memory_save(...)`，但 §5 決策 2（2026-08-15 定案）已明訂**工具名一律 snake_case、不加 `bugezy:` 前綴**——MCP 用戶端本來就以 server 名稱做命名空間，再加前綴會出現 `bugezy - bugezy:memory_save`。故本節 7 個工具**全部去掉前綴**，與既有 13 個及 v2 新增的 17 個一致。

| 類別 | 工具 | 說明 |
|---|---|---|
| **記憶寫入** | `memory_save(layer, entry)` | 存入指定層 |
| **記憶寫入** | `memory_learn(debug_session)` | debug 完成後**自動萃取經驗**存入 L1 |
| **記憶讀取** | `memory_search(query, layers?)` | **跨層**搜尋相關記憶 |
| **記憶讀取** | `memory_get(layer, topic)` | 精準提取指定層的特定主題 |
| **自動守衛** | `memory_audit(code_diff)` | **L6** 資安審查 |
| **自動守衛** | `memory_perf_check(metrics)` | **L7** 效能比對 |
| **自動守衛** | `memory_biz_validate(output)` | **L4** 商業邏輯驗證 |

📌 §14.12.1 再加 6 個管理工具（update／delete／list／clear／export／import）→ 記憶層共 **13 個**，全站合計 **43 個**（`get_live_errors` 不重複計）。

### §14.10 自動學習循環

```
        debug 成功
            │
            ▼
  ┌──────────────────────┐
  │ L1  自動存入經驗      │
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ L7  記錄修前修後效能   │
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ L6  審查修改是否合規   │
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ L4  驗證商業邏輯正確   │
  └──────────┬───────────┘
             ▼
        全部通過？
             │
             ▼
       ✅ 經驗確認 ───────┐
                          │
    下次遇到同類 bug ◄─────┘
             │
             ▼
       直接提取 → 越來越快
```

### §14.11 開發順序

| 階段 | 層 | 理由 |
|---|---|---|
| **Phase A** | L1 Debug 經驗庫 ＋ L3 客服知識庫 | **先做，最有即戰力** |
| **Phase B** | L2 專案知識庫 ＋ L4 商業邏輯庫 | 專案深度整合 |
| **Phase C** | L5 外部依賴庫 ＋ L6 資安合規庫 | 防禦層 |
| **Phase D** | L7 效能帳本庫 ＋ L8 團隊協作庫 | 進階 |

> ✅ **Phase A 的三個前提已定案（2026-08-16）· 決策 4~6**

**決策 4：記憶存哪裡？→ 混合式**

| 位置 | 層 | 理由 |
|---|---|---|
| **雲端（Supabase）** | **L1 匿名模式** ＋ **L3 客服手冊** | L1 匿名經驗要跨專案／跨使用者累積才有威力；L3 是全平台共用的產品手冊 |
| **本機（`.bugezy/`）** | **L2 L4 L5 L6 L7 L8**（含敏感專案資訊）＋ **L1 原始細節** | 業務規則、資安鐵律、架構細節都是使用者的機密資產，不上雲 |

**決策 5：L1 跨用戶共享？→ 兩層式**

- **匿名化模式共享**：去掉檔名／變數名，**只留 bug 模式**
- **原始細節私有**：存在本機 `.bugezy/`，**不上傳**

> ⚠ **匿名化不能只清欄位，要連 symptom 字串一起清。** L1 的「症狀」欄位本身就常內嵌識別資訊——`Cannot read 'map' of undefined at CheckoutPage.tsx:42`、堆疊追蹤裡的內部網域、錯誤訊息帶出的客戶 ID。**只把「檔名／變數名」當成獨立欄位清掉，敏感內容仍會從錯誤訊息整段漏出去。** 上傳前必須對全文做遮蔽（CLI 上傳前遮蔽機密字串的既有做法可沿用）。
>
> 另外：把匿名 L1 存上雲端**是一項新的資料蒐集行為**，依 `ARCHITECTURE.md §4-15`，`/privacy` 必須在功能上線**之前**同步更新（PM-291 被 Chrome Web Store 退件就是這一條）。

**決策 6：L6／L7 能改檔案嗎？→ 只建議，絕不動手**

```
BugEzy  = 偵測 + 分析 + 建議   （眼睛和大腦）
AI 工具 = 決定是否動手修改     （手）

BugEzy 永遠不碰用戶程式碼
```

這條同時解掉一個連帶問題：**§14.6「立刻自己改掉」與 §14.7「主動撤回修改」的措辭要照此理解**——BugEzy 提出的是**建議**，實際落筆的是 AI 工具。這也讓 v2 維持「沒有任何一支工具會寫使用者的檔案」的界線不被打破。

### §14.12 記憶管理

#### §14.12.1 AI 與用戶的 CRUD 權限

在 §14.9 的 7 個工具之上**再加 6 個**，讓記憶可以被更新、刪除、盤點與搬移——記憶若只能寫不能改，三個月後就會塞滿過時的解法。

**MCP 工具擴充**

| 工具 | 說明 | |
|---|---|---|
| `memory_save(layer, entry)` | 寫入 | §14.9 已有 |
| `memory_update(layer, id, entry)` | **更新**（修法進化時覆蓋舊經驗）| **新增** |
| `memory_delete(layer, id)` | 刪除 | **新增** |
| `memory_search(query, layers?)` | 搜尋 | §14.9 已有 |
| `memory_list(layer)` | 列出某層所有記憶 | **新增** |
| `memory_clear(layer)` | 清空某層 | **新增** |
| `memory_export()` | 匯出整個 `.bugezy/` | **新增** |
| `memory_import(path)` | 匯入 | **新增** |

📌 **工具總數連動**：既有 13 ＋ v2 新增 17 ＋ 記憶 **7 ＋ 6 ＝ 13** ＝ **43 個**（`get_live_errors` 不重複計）。§14.9 的另外 5 個（`memory_learn` / `memory_get` / `memory_audit` / `memory_perf_check` / `memory_biz_validate`）不變。

> ✅ **`memory_import` 會寫檔，但不牴觸決策 6。** 決策 6 的界線是**「不碰使用者的程式碼」**，不是「完全不寫檔」。`memory_import` 只寫進 `.bugezy/`——那是 BugEzy 自己的目錄，且是使用者主動下指令要求的。**專案原始碼一個位元組都不會動。**

**用戶 CLI 管理**

```
bugezy memory init               → 在當前專案建立 .bugezy/
bugezy memory list L1            → 列出 Debug 經驗
bugezy memory delete L1 --id=5   → 刪除某條
bugezy memory export             → 匯出備份
bugezy memory import backup.json → 匯入
bugezy memory clear L1           → 清空某層
bugezy memory stats              → 各層容量統計
```

📌 `memory init` 是 §14.12.3 步驟 3 提示使用者執行的指令，一併列進來。**記憶是使用者的資產，任何一層都必須能被使用者自己看見、修改、刪除、帶走**——這也是 `/privacy`「使用者權利」章節能對得上的前提。

**AI 自動更新場景**

```
第一次修 bug        → memory_save(L1, { symptom, fix: '加 ?? []' })
三個月後更好的修法  → memory_update(L1, id, { fix: '改用 Zod schema' })

= 記憶會進化，不會停在最初級的解法
```

#### §14.12.2 多專案隔離

`.bugezy/` 跟著**專案根目錄**走（跟 `.git/` 同層）：

```
C:\projects\
  ├── client-A-ecommerce\
  │   └── .bugezy\         ← A 的記憶
  ├── client-B-hospital\
  │   └── .bugezy\         ← B 的記憶
  └── my-side-project\
      └── .bugezy\         ← 自己的記憶
```

**結構**

```
.bugezy/
  config.json              ← 容量上限、淘汰規則
  memory/
    L1-debug.json
    L2-project.json
    L4-business.json
    L5-dependencies.json
    L6-security.json
    L7-performance.json
    L8-team.json
  .gitignore               ← 預設不進 git（含敏感資訊）
```

> **兩個容易做錯的細節**
>
> **① 沒有 `L3-support.json` 不是漏寫。** L3 客服知識庫依**決策 4** 放雲端——它是 BugEzy 自己的產品手冊，每個使用者拿到的內容都一樣，沒有存在專案目錄裡的理由。本機是 **L1（原始細節）＋ L2、L4、L5、L6、L7、L8 共 7 個檔**。
>
> **② `.bugezy/.gitignore` 的內容必須是自我忽略樣式**，否則「預設不進 git」不會成立：
>
> ```
> *
> !.gitignore
> ```
>
> 放一個空的、或只寫 `.bugezy/` 的 `.gitignore` 都**沒有效果**——目錄內的 `.gitignore` 只能忽略同目錄與子目錄的內容，且必須自己排除自己才不會連規則檔一起被忽略掉。

📌 **團隊要共享時走匯出／匯入，不要改成進 git。** L2／L4／L8 確實是團隊會想共用的內容，但 L6（資安鐵律，可能含內部政策）與 L1（含真實檔名與修法）同在一個目錄下，整包進 git 等於把敏感層一併推上遠端。§14.12.5 的匯出檔才是核准的交接路徑。

#### §14.12.3 自動切換

**bridge 啟動時**

```
1. 從 CWD 往上找 .bugezy/（跟 git 找 .git/ 一樣）
2. 找到   → 載入該專案記憶
3. 找不到 → 空白記憶 + 提示 bugezy memory init
4. cd 換專案 → 重啟 bridge → 自動切換
```

📌 步驟 4 在實務上是**自動發生**的：bridge 由 AI 工具以 stdio 啟動，CWD 就是 AI 工具當下的專案目錄。換專案＝開新的 AI session＝新的 bridge process，不需要使用者手動重啟。

**L1 跨專案共享的部分**

```
A 專案修過 Stripe webhook bug → 匿名化存雲端
B 專案也接 Stripe             → 搜尋時從雲端撈到

= 做過的專案越多，新專案上手越快
```

#### §14.12.4 容量限制與智慧淘汰

**本機容量（極寬裕）**

| 項目 | 估算 |
|---|---|
| L1 單條 | ≈ **500 bytes** |
| L1 1000 條 | ≈ **500 KB** |
| 整個 `.bugezy/` | 通常 **< 10 MB** |

**自動淘汰規則**

| 層 | 觸發條件 | 動作 |
|---|---|---|
| **L1** | 超過 `max_entries`（預設 **2000**）| 淘汰**最久沒匹配**的 |
| **L7** | 超過 `retention_days`（預設 **90 天**）| 只保留近期基準 |

📌 L1 淘汰看的是**「最久沒被匹配」而非「最久以前寫的」**——一條三年前寫、但每個月都命中的經驗，價值遠高於上週寫完再也沒用過的那條。實作時要記 `last_hit_at`，不能只靠 `created_at`。

**合併機制**

```
同一個 bug 修過 5 次 → 自動合併成一條最佳實踐

「最初 ?? → 後來 Zod → 最終 middleware 統一處理」

= 記憶濃縮，不只堆積
```

**用戶可設上限**

```json
// .bugezy/config.json
{
  "L1_max_entries": 2000,
  "L7_retention_days": 90,
  "auto_merge": true,
  "auto_evict": true
}
```

#### §14.12.5 匯出 / 匯入 / 備份

```
匯出：bugezy memory export                       → .bugezy-backup-20260816.json
匯入：bugezy memory import .bugezy-backup-20260816.json

用途：換電腦、新同事加入、專案交接
```

> ⚠ **匯出檔含敏感內容，交接時要當作機密處理**
>
> **匯出不含雲端 L1 匿名經驗**（那些本來就在雲端，換電腦後自動撈得到）。但匯出檔**會包含 L1 的原始細節**（真實檔名、函式名、修法）**以及 L6 的資安鐵律**——正是決策 4／5 特意留在本機、不上雲的那些。
>
> 因此 `.bugezy-backup-*.json` 應比照憑證檔對待：**不要寄到公開頻道、不要 commit 進 git**。CLI 匯出時應直接印出這行警告。

---

# 附錄 A：實作註記（對照現有程式碼的查證）

> 以下是撰寫本文件時**實際比對 `server/src/index.ts`、`extension/manifest.json` 與現行方案設定**得到的結果。
> §1~§14 是願景；這裡是動工前必須先知道的現實條件。**開 Phase 1 的卡片前請先讀完這一節。**

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
