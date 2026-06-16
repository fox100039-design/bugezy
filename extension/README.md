# extension — Chrome 擴充（Manifest V3）

第 1 代骨架（PM-02）：按錄製 → 操作網頁 → 停止 → 看到 DOM + Console + Network 完整資料。

## 錄製來源

- **rrweb** — DOM 軌跡側錄（JSON，不錄影片）
- **Console 攔截** — 只抓 `warn` / `error`
- **Network 攔截** — fetch + XMLHttpRequest，只抓 `4xx` / `5xx`
- 語音字幕（Web Speech API）將於後續代次加入

## 架構

| 檔案 | World | 職責 |
|---|---|---|
| `src/inject.ts` | **MAIN** | rrweb + console/fetch/XHR 攔截（唯有 MAIN world 能攔到頁面自身的呼叫） |
| `src/content.ts` | ISOLATED | 橋接 inject ↔ background，存 `chrome.storage.local` |
| `src/background.ts` | SW | 管理錄製狀態（持久化），轉送 popup 指令到 active tab |
| `src/popup.{html,ts}` | — | 錄製按鈕 + 計時 + 結果摘要 + 複製 JSON |
| `src/types.ts` | — | 共用型別與訊息協定 |

資料流：popup →（background）→ content →（postMessage）→ inject 開始/停止錄製；
停止時 inject 打包 `{ rrwebEvents, consoleLogs, networkErrors, pageInfo }` → content 存 storage → background 回填摘要 → popup 顯示。

## 建置

```bash
npm install
npm run build      # → dist/
npm run dev        # watch 模式
```

## 載入測試

1. Chrome → `chrome://extensions` → 開啟「開發人員模式」
2. 「載入未封裝項目」→ 選 `extension/dist/`
3. 開任意網頁 → 點 BugEzy icon → 「開始錄製」
4. 操作頁面（點擊、滾動、觸發 `console.error` 或請求 4xx/5xx）
5. 「停止錄製」→ 看摘要 → 「複製 JSON」貼到編輯器驗證結構化資料

> 注意：`chrome://`、Chrome 線上應用程式商店等頁面禁止注入 content script，請用一般網站測試。
