# bugezy-bridge

讓**任何 MCP 相容的 AI**（Claude Desktop / Claude Code / Cursor / ChatGPT / Gemini…）即時操作你的瀏覽器並讀取當前分頁的錯誤。

全部在你自己的電腦上跑 —— 資料不經過 BugEzy 伺服器。

```
任何 AI  ──MCP(stdio)──►  bugezy-bridge  ──WebSocket(localhost)──►  BugEzy Extension  ──►  目標網頁
```

---

## 安裝

```bash
npm install -g bugezy-bridge
```

需要 **Node.js 18+**，以及已安裝並啟用的 [BugEzy Chrome 擴充功能](https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj)。

## 連接你的 AI

**Claude Desktop** —— 編輯 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "bugezy-bridge": {
      "command": "bugezy-bridge"
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add bugezy-bridge -- bugezy-bridge
```

其他 MCP 用戶端：以 **stdio** 模式執行 `bugezy-bridge` 即可。

> AI 工具會自己啟動 bridge，你不需要手動先跑它。

## 工具

| 工具 | 說明 |
|---|---|
| `ping` | 確認擴充功能是否連上，並量測往返延遲 |
| `get_page_url` | 取得當前分頁的網址與標題 |
| `get_live_errors` | 即時讀取當前分頁的 Console 錯誤與失敗的網路請求（4xx/5xx） |

`get_live_errors` 有一個 `source` 參數：`'browser'`（預設，即時）。
要讀**歷史**報告請改用雲端 MCP（`https://bugezy.dev/mcp`），那裡有完整的 13 個報告工具。

## 疑難排解

**AI 說「Extension 尚未連上 bridge」**
1. 確認 BugEzy 擴充功能已安裝且**已啟用**
2. 確認瀏覽器有開著
3. 到 `chrome://extensions` **重新載入** BugEzy（擴充功能要重新載入才會去連 bridge）

**「當前分頁沒有 BugEzy content script」**
該分頁可能是 `chrome://`、Chrome 線上應用程式商店或 PDF 檢視器 —— 這些頁面依 Chrome 政策不允許擴充功能注入。換一個一般網頁，或重新整理該分頁。

**「port 19850 已被占用」**
已經有一個 bridge 在跑（可能是另一個 AI 工具啟動的）。用 `BUGEZY_BRIDGE_PORT` 換一個 port：

```bash
BUGEZY_BRIDGE_PORT=19860 bugezy-bridge
```
（Extension 端目前固定連 19850，換 port 需同步調整。）

---

## 設計說明

### 為什麼用 localhost WebSocket，而不是 Native Messaging 或 HTTP 輪詢

| 方案 | 判斷 |
|---|---|
| **Native Messaging** | ❌ 需要 `nativeMessaging` 權限 → **會觸發 Chrome Web Store 重新審核**，還得在各作業系統註冊 host manifest（Windows 登錄檔／macOS、Linux 各自路徑）。 |
| **HTTP 輪詢（每 500ms）** | ❌ **撐不過 MV3**：service worker 閒置 30 秒就被回收，`setInterval` 隨之消失，而且沒有任何事件能把它喚醒 → 半分鐘後靜默失效。`chrome.alarms` 最短 30 秒，無法用於 500ms 輪詢。而且長年輪詢會白耗 CPU。 |
| **localhost WebSocket** | ✅ 不受 CORS 限制、連 localhost **不需要任何新權限**；而且 **Chrome 116 起 WebSocket 活動會重置 service worker 的閒置計時器** —— 每 20 秒一次心跳就是官方認可的保活方式。延遲 <50 ms。 |

### 可靠性設計

- **Extension 沒連上時不會卡住**：工具立刻回一則可讀的錯誤，而不是等到逾時。
- **指令逾時 10 秒**：避免 AI 端無限等待。
- **Extension 端指數退避重連**（5s → 60s 上限）：bridge 沒開是常態，不該一直重試。
- **只服務一個 Extension**：重新載入擴充功能時，新連線會取代舊連線。
- **所有訊息走 stderr**：stdio 模式下 stdout 專屬於 MCP 協定，寫 log 到 stdout 會讓 AI 端解析失敗。

### 開發

```bash
npm install
npm run build     # tsc → dist/
npm run dev       # tsc --watch
```

```
src/
├── index.ts          入口：啟動 MCP server + Extension 通訊 server
├── mcp-server.ts     MCP 工具定義
├── extension-link.ts 與 Extension 的通訊層（WebSocket + 指令對應 + 心跳）
└── types.ts          線上協定型別（**與 extension/src/background.ts 的 bridge 區塊必須一致**）
```

## 授權

MIT
