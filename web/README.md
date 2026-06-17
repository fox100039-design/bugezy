# web — React 報告頁

把 share URL 從 raw JSON 變成互動式報告頁：rrweb DOM 回放 + Console / Network / 語音字幕。

## 技術棧

React + Vite + TypeScript ｜ `rrweb-player`（DOM 回放）｜ `react-router-dom`（`/report/:id`）

## 結構

```
web/
├── index.html
├── vite.config.ts        # /api → http://127.0.0.1:8787 proxy
├── tsconfig.json
└── src/
    ├── main.tsx          # 進入點
    ├── App.tsx           # 路由：/report/:id
    ├── types.ts          # Report 型別（對應 API GET 回傳）
    ├── index.css         # 深色主題（與 popup 統一）
    ├── pages/ReportPage.tsx     # fetch + 組裝
    └── components/
        ├── RrwebPlayer.tsx      # rrweb-player 掛載（useRef+useEffect）
        ├── ConsolePanel.tsx     # console（error 紅 / warn 黃）
        ├── NetworkPanel.tsx     # network（5xx 紅 / 4xx 橙）
        └── VoicePanel.tsx       # 語音字幕（相對時間）
```

## 開發

```powershell
# A：API
cd C:\dev\bugezy\server && npx wrangler dev      # localhost:8787
# B：報告頁
cd C:\dev\bugezy\web && npm run dev               # localhost:5173
```

開 `http://localhost:5173/report/<report_id>` 檢視報告。

## Build

```powershell
cd C:\dev\bugezy\web && npm install && npm run build   # tsc && vite build → dist/
```
