# BugEzy v2/v3 產品規格書

> 從 Bug Reporter 進化為 AI Debug Partner
> 建立日期：2026-08-15
> FOX + Claude 共同規劃

> **這份文件的用途**：給未來任何 session 的 AI 接手時，一次看懂 BugEzy 要往哪裡走。
> §1~§10 是產品願景與規劃；**附錄 A 是對照現有程式碼的查證結果**，動工前務必一併讀。

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
- MCP 新增即時操作工具（navigate / click / readPage / analyzeElement）
- MCP 新增即時偵測工具（getLiveErrors / getNetworkFails / getPageHealth）
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

| 方案 | 價格 | 功能 |
|---|---|---|
| Free | 免費 | 錄製 10 次/月 |
| Pro | NT$80/月 | 無限錄製 + 雲端模式 |
| Max | NT$200/月 | Pro + 圖釘大招 + 極速模式 |
| Agent | NT$500/月 | Max + AI 自動化偵測 |

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

### 瀏覽器操作類

| 工具 | 說明 |
|---|---|
| `bugezy:navigate(url)` | 開啟網頁 |
| `bugezy:click(selector)` | 點擊元素 |
| `bugezy:type(selector, text)` | 輸入文字 |
| `bugezy:screenshot()` | 截取頁面截圖 |
| `bugezy:readPage()` | 讀取頁面結構（文字，非截圖，省 95% token）|

### 偵測類（BugEzy 獨有優勢，Claude in Chrome 做不到）

| 工具 | 說明 |
|---|---|
| `bugezy:getLiveErrors()` | 即時 Console errors，含嚴重度分類 |
| `bugezy:getNetworkFails()` | 即時 Network 4xx/5xx |
| `bugezy:analyzeElement(selector)` | 深度分析：DOM + CSS + event listeners |
| `bugezy:getWebVitals()` | 效能指標 |
| `bugezy:getPageHealth()` | 整體健康報告 |

### 圖釘類

| 工具 | 說明 |
|---|---|
| `bugezy:pin(selector, description)` | 釘選元素 + 描述 |
| `bugezy:pinAnalyze(selector)` | 釘選 + 自動深度分析 |
| `bugezy:getPinResults()` | 取得所有圖釘的檢查結果 |

### 監控類

| 工具 | 說明 |
|---|---|
| `bugezy:startMonitor()` | 開始即時監控 |
| `bugezy:stopMonitor()` | 停止監控 |
| `bugezy:getMonitorReport()` | 取得監控期間的所有異常 |

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

---

## §9 開發順序

### Phase 1：bugezy-bridge + 基礎 MCP 工具
- **PM-A**：bugezy-bridge 骨架（localhost MCP + Native Messaging）
- **PM-B**：Extension 接收 bridge 指令
- **PM-C**：MCP 第一批（navigate / click / readPage / getLiveErrors）
- **PM-D**：MCP 第二批（analyzeElement / getPageHealth / screenshot）

### Phase 2：圖釘系統
- **PM-E**：圖釘 UI（content script 注入 + 釘選元素 + 描述）
- **PM-F**：pinAnalyze MCP 工具
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
- **PM-N**：AI 自動偵測模式（startMonitor / getMonitorReport）
- **PM-O**：自訂規則

### Phase 6：Max / Agent 方案上線
- **PM-P**：方案分層 + 功能閘門
- **PM-Q**：戰略夥伴推薦碼系統

---

## §10 版本記錄

| 日期 | 版本 | 說明 |
|---|---|---|
| 2026-08-15 | v0.1 | 初版，FOX + Claude 共同規劃 |

---

# 附錄 A：實作註記（對照現有程式碼的查證）

> 以下是撰寫本文件時**實際比對 `server/src/index.ts`、`extension/manifest.json` 與現行方案設定**得到的結果。
> §1~§10 是願景；這裡是動工前必須先知道的現實條件。**開 Phase 1 的卡片前請先讀完這一節。**

## A-1　`get_live_errors` 已經存在，v2 的 `getLiveErrors` 是「另一條路」

現有 MCP 已有 **`get_live_errors`**，但它的資料來源是 **R2 上由 extension 即時監控模式寫入的快取**（需 `user_email` + `session_token` 驗證），屬於「非同步落地後再讀」。

§5 規劃的 `bugezy:getLiveErrors()` 則是**透過 bridge 直接向當前分頁要資料**的同步路徑。兩者行為不同，**不要當成同一個工具**。動工時要先決定：

- **方案 A**：新工具改名（例如 `live_errors_now` / `bridge_get_errors`），與既有工具並存 —— 語意清楚，但工具數量變多。
- **方案 B**：`get_live_errors` 加參數（如 `source: 'cache' | 'live'`），bridge 可用時走即時、否則退回 R2 快取 —— 對使用者較友善，但要處理 bridge 未安裝的降級。

**建議方案 B**，因為「AI 不需要知道 bridge 裝了沒」才是好體驗；但這是產品決策，留給 FOX 拍板。

## A-2　工具命名慣例要先統一

現有 13 個工具都是 **snake_case 無前綴**（`get_report_overview`）；§5 的新工具寫成 **`bugezy:camelCase`**（`bugezy:getLiveErrors`）。

MCP 用戶端通常會**自動以 server 名稱作為命名空間**，工具名裡再加 `bugezy:` 會出現 `bugezy - bugezy:navigate` 這種重複。建議新工具沿用 **snake_case 無前綴**（`navigate`、`read_page`、`analyze_element`），文件裡的 `bugezy:` 只當作說明用的前綴。**這件事要在 PM-C 之前定案**，之後改名等於破壞相容性。

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

## A-5　現行方案還有一個「日票」，§2 表格未列

v1 目前實際在賣的是：**Free**／**NT$80 月費**／**NT$20 日票（24 小時）**，另有 PM-265~267 的**活動票券**（兌換碼換免費天數）。

§2 的新分層若上線，要決定：日票與活動票券**對應到哪一層**（目前兩者都給「等同 Pro」的無限額度）。這會直接影響 PM-P 的功能閘門實作——`isActiveUserId()` 目前只回傳「是否付費」的**布林值**，要做四層分級必須改成回傳**方案等級**（見 ARCHITECTURE §4-8 對兩種付費判定的說明，改動時務必分清 `isActiveUserId` 與 `isEcpayActiveUserId`）。

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
