# BugEzy 產品規格書 v0.2

> 發起人：FOX
> 初版：2026-06-16
> 更新：2026-06-16（整合開發討論文件 + 市場白皮書）
> 狀態：延伸專案（隸屬 lottoshare_tools，待正式獨立）
> 定位：亞洲專屬平價 MCP 語音除錯工具

---

## 一、產品定位

**一句話**：開發者用中文語音錄 Bug，自動產出 DOM 軌跡 + 網路錯誤 + Console Log + 中文字幕的完整報告，一鍵分享給隊友或 AI 助手直接修復。

**核心差異（vs Jam）**：

| | Jam | BugEzy |
|---|---|---|
| 語言 | 英文為主，中文語音殘破 | **中日韓越混雜語音原生支援** |
| 價格 | $14/月（NT$450） | **NT$80/月（便宜 82%）** |
| 市場 | 歐美 | **台灣 → 日韓越 → 全亞洲** |
| 錄影技術 | 真影片（佔空間） | **rrweb DOM 軌跡（儲存趨近零）** |
| AI 整合 | MCP（Push 全量） | **MCP Pull 模式（按需查詢，省 token）** |
| 語音辨識 | 雲端 | **本地 Web Speech API 優先 → 雲端降級** |

---

## 二、目標市場

### 市場規模

```
TAM：556 萬人（亞洲 AI 導向開發者）
 └ SAM：250 萬人（前端/全端/QA）
    └ SOM：6.5~14 萬人（1-2 年內中日韓越付費用戶）
```

### 各市場特性

| 市場 | 工程師數 | 特性 | 切入策略 |
|---|---|---|---|
| 大中華區 | 580 萬 | 初期主場，社群擴散最快 | 繁中優先，PTT/FB/IT 邦 |
| 日本 | 120 萬 | 缺工程師，付費意願最高 | 日英混雜語音是殺手功能 |
| 南韓 | 60 萬 | 追求快節奏極致效率 | 韓英混雜 + IDE 整合 |
| 越南 | 55 萬 | 外包重鎮，跨境痛點明確 | 越語錄音 → 日文報告 |

### 目標用戶

1. 獨立開發者 / SOHO（主力）
2. 接案工程師（跟客戶溝通 Bug）
3. QA 測試人員
4. 非技術人員（PM、設計師、客戶）
5. AI 輔助開發者（Claude / ChatGPT / Cursor 用戶）
6. 跨境外包團隊（日本發包 ↔ 越南承接）

---

## 三、定價方案

| 方案 | 月費 | 報告/月 | 錄影長度 | 保存期 | 語音分鐘/月 | MCP |
|---|---|---|---|---|---|---|
| **免費體驗** | $0 | 30 | 30 秒 | 7 天 | 15 | ❌ |
| **個人 Pro** | NT$80（年繳 NT$800） | 50 | 2 分鐘 | 1 年 | 100 | ✅ |
| **重度 Pro** | NT$150（年繳 NT$1,500） | 200 | 5 分鐘 | 3 年 | 500 | ✅ |
| **團隊版** | NT$100/人/月（年繳 8 折） | 無限 | 5 分鐘 | 永久 | 無限 | ✅ |

### 成本結構（個人 Pro）

| 項目 | 月成本 |
|---|---|
| Groq Whisper API | ~NT$7.6 |
| R2 儲存 | ~NT$0.5 |
| LLM Token（標題生成等） | ~NT$1 |
| **合計** | **< NT$9** |
| **毛利率** | **> 88%** |

### 極端重度用戶（1,500 分鐘/月）

| 方案 | 成本 |
|---|---|
| Groq Whisper | NT$98 |
| OpenAI Whisper（對比） | NT$293（會虧本） |
| LLM Token | NT$49 |
| **結論** | **必須用 Groq，不能用 OpenAI** |

---

## 四、技術架構

### 架構圖

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Chrome 擴充  │────→│  API Server  │────→│   Storage    │
│  (Manifest V3)│     │ (Cloudflare  │     │ (Cloudflare  │
│  + rrweb      │     │  Workers)    │     │  R2)         │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────┴───────┐
                     │   Database   │
                     │  (Supabase)  │
                     └──────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
       ┌──────┴──┐   ┌─────┴────┐   ┌────┴─────┐
       │ Whisper  │   │  MCP     │   │  Web     │
       │(Groq優先)│   │ Server   │   │  App     │
       │         │   │(Pull模式) │   │(報告頁)  │
       └─────────┘   └──────────┘   └──────────┘
```

### 技術選型

| 元件 | 技術 | 理由 |
|---|---|---|
| Chrome 擴充 | Manifest V3 + TypeScript | Chrome 標準 |
| DOM 軌跡側錄 | **rrweb**（非影片） | 儲存趨近零，可精準重播 |
| 語音辨識（第一層） | **Web Speech API**（瀏覽器內建） | 免費、即時、離線可用 |
| 語音辨識（降級層） | **Groq Whisper API** | 便宜（OpenAI 的 1/3）、中文準 |
| 後端 API | Cloudflare Workers | 免費 10 萬次/天、全球邊緣 |
| 資料庫 | Supabase（PostgreSQL） | 免費版夠、內建 Auth |
| 檔案儲存 | Cloudflare R2 | 免費 10GB、零出口費 |
| LLM（標題/摘要） | DeepSeek-V3 或 Llama-3-8B | 平價、中文好 |
| Web App | React + Vite | 同 LottoShare 技術棧 |
| MCP Server | TypeScript + MCP SDK | Anthropic 標準協議 |

### 關鍵架構原則

1. **rrweb 取代影片**：前端錄 DOM 變化軌跡（JSON），不存高畫質影片，頻寬與儲存成本接近零
2. **智能過濾**：前端自動過濾 200 OK，只擷取 console.error 與 4xx/5xx 錯誤
3. **混合語音辨識**：Web Speech API 免費優先 → 不準或不支援再降級 Groq Whisper
4. **語言 Token 壓縮**：亞洲語言先用小模型轉極簡英文技術術語再餵 AI，降低 80% token 消耗
5. **MCP Pull 模式**：初始只傳 1,000 token 摘要，AI 按需動態查詢細節

---

## 五、資料模型

```sql
-- 用戶（Supabase Auth 處理）

-- 團隊
teams (
  team_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  plan           TEXT DEFAULT 'free',
  created_at     TIMESTAMP
)

-- 月度用量
monthly_usage (
  usage_id       TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  month          TEXT NOT NULL,          -- '2026-06'
  report_count   INTEGER DEFAULT 0,
  voice_seconds  INTEGER DEFAULT 0,
  UNIQUE(user_id, month)
)

-- 報告
reports (
  report_id      TEXT PRIMARY KEY,
  team_id        TEXT,
  author_id      TEXT NOT NULL,
  title          TEXT,                   -- AI 自動產生
  description    TEXT,                   -- 語音轉文字結果
  url            TEXT,                   -- Bug 發生的頁面 URL
  browser        TEXT,
  os             TEXT,
  screen_size    TEXT,
  rrweb_url      TEXT,                   -- R2：DOM 軌跡 JSON
  rrweb_duration INTEGER,                -- 秒
  share_mode     TEXT DEFAULT 'public',
  folder_id      TEXT,
  created_at     TIMESTAMP
)

-- 截圖
screenshots (
  screenshot_id  TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES reports,
  image_url      TEXT,
  annotations    JSONB,
  sort_order     INTEGER,
  created_at     TIMESTAMP
)

-- 網路請求（只存錯誤）
network_requests (
  request_id     TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES reports,
  method         TEXT,
  url            TEXT,
  status_code    INTEGER,
  request_body   TEXT,
  response_body  TEXT,
  duration_ms    INTEGER,
  timestamp_ms   INTEGER,
  created_at     TIMESTAMP
)

-- Console Logs（只存 warn + error）
console_logs (
  log_id         TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES reports,
  level          TEXT,                   -- warn / error
  message        TEXT,
  timestamp_ms   INTEGER,
  created_at     TIMESTAMP
)

-- 用戶事件
user_events (
  event_id       TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES reports,
  event_type     TEXT,                   -- click / input / scroll / navigate
  target         TEXT,                   -- CSS selector
  value          TEXT,
  timestamp_ms   INTEGER,
  created_at     TIMESTAMP
)

-- 語音字幕
transcripts (
  transcript_id  TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES reports,
  language       TEXT DEFAULT 'zh-TW',
  segments       JSONB,                  -- [{start, end, text}]
  full_text      TEXT,
  compressed_en  TEXT,                   -- 壓縮後的英文技術術語版
  created_at     TIMESTAMP
)

-- 留言
comments (
  comment_id     TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES reports,
  author_id      TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMP
)

-- 資料夾
folders (
  folder_id      TEXT PRIMARY KEY,
  team_id        TEXT REFERENCES teams,
  name           TEXT NOT NULL,
  created_at     TIMESTAMP
)
```

---

## 六、MCP Server 設計（Pull 模式）

### Tool Schema

```typescript
// Tool 1：取得報告摘要（初始只傳 ~1,000 token）
get_report_summary(report_id: string) → {
  title, description, url, browser, os,
  error_count, network_error_count,
  transcript_compressed_en,              // 壓縮版英文摘要
  created_at
}

// Tool 2：取得網路錯誤（AI 按需查詢）
get_network_errors(report_id: string) → [{
  method, url, status_code, request_body, response_body
}]

// Tool 3：取得 Console 錯誤
get_console_errors(report_id: string) → [{
  level, message, timestamp_ms
}]

// Tool 4：取得用戶事件時間軸
get_user_events(report_id: string) → [{
  event_type, target, value, timestamp_ms
}]

// Tool 5：取得語音全文
get_transcript(report_id: string) → {
  language, full_text, segments
}

// Tool 6：取得截圖（URL，AI 用 vision 看）
get_screenshots(report_id: string) → [{
  image_url, annotations
}]

// Tool 7：搜尋報告
search_reports(query: string) → [{ report_id, title, created_at }]

// Tool 8：列出最近報告
list_recent_reports(limit: number) → [{ report_id, title, created_at }]
```

### AI 工作流範例

```
用戶：「幫我看最新的 Bug」
AI → list_recent_reports(1) → 拿到 report_id
AI → get_report_summary(report_id) → 讀摘要（1,000 token）
AI：「看起來是 /api/orders/pay 回 500，我查一下細節」
AI → get_network_errors(report_id) → 拿到 request/response body
AI → get_console_errors(report_id) → 拿到前端錯誤
AI：「找到了，是 walletBalance undefined，建議修改 xxx」
```

**總 token 消耗 < 3,000**（vs Push 模式可能 30,000+）

---

## 七、功能開發優先序

### MVP（第一週）

| 天 | 任務 |
|---|---|
| Day 1 | Chrome 擴充骨架 + Manifest V3 + 截圖（含標註） |
| Day 2 | rrweb 整合（DOM 軌跡側錄 + 重播） |
| Day 3 | 網路請求攔截（只抓錯誤）+ Console Log 捕捉 + 環境資訊 |
| Day 4 | 後端 API（Supabase + R2 上傳）+ 報告建立 + 用量限制 |
| Day 5 | 語音辨識（Web Speech API 優先 → Groq 降級）+ 中文字幕 |
| Day 6 | MCP Server（Pull 模式 8 個 Tool） |
| Day 7 | Web 報告頁 + 分享連結 + 測試 + Chrome Web Store 準備 |

### Phase 2（延伸功能）

| 優先級 | 功能 | 工時 |
|---|---|---|
| Level 1 | AI 自動產生報告標題（Whisper + GPT） | 半天 |
| Level 1 | 相似 Bug 推薦（比對 error message） | 半天 |
| Level 1 | 一鍵複製 Markdown（GitHub/Notion 格式） | 半天 |
| Level 1 | Slack / Discord Webhook 通知 | 半天 |
| Level 2 | 隱私自動遮罩（密碼/信用卡/Email） | 1 天 |
| Level 2 | 時間軸書籤（錄影時按快捷鍵標記） | 1 天 |
| Level 2 | 離線錄製（IndexedDB 暫存，有網路上傳） | 1 天 |

### Phase 3（長期護城河）

- AI 自動修復建議（生成 diff patch）
- 視覺回歸比對（Pixel diff）
- 劇本轉 E2E 測試（Playwright / Cypress）
- 手機 App（iOS / Android）
- 跨境功能：越語錄音 → 自動轉日文技術報告
- 企業自託管版本
- 語料護城河：收集混雜語音數據微調開源 Whisper

---

## 八、營收預估

### 保守估計

| 時間點 | 付費用戶 | 月收 | 月成本 | 月淨利 | 淨利率 |
|---|---|---|---|---|---|
| 3 個月 | 50 | NT$4,000 | NT$450 | NT$3,550 | 89% |
| 6 個月 | 200 | NT$16,000 | NT$1,800 | NT$14,200 | 89% |
| 1 年 | 500 | NT$40,000 | NT$4,500 | NT$35,500 | 89% |
| 2 年 | 2,000 | NT$160,000 | NT$18,000 | NT$142,000 | 89% |

### 獲客管道

1. Chrome Web Store 自然流量（關鍵字：Bug 回報、中文、開發工具、MCP）
2. 台灣開發者社群（PTT、Facebook、IT 邦幫忙）
3. YouTube 教學影片「用 BugEzy + Claude 三分鐘修 Bug」
4. GitHub 開源 MCP Server（吸引 AI 開發者）
5. 日本：Qiita / Zenn 技術文章
6. 越南：Viblo 社群

---

## 九、競爭護城河

| 護城河 | 說明 |
|---|---|
| **語料壁壘** | 收集真實除錯場景的混雜語音數據，微調 Whisper，辨識率 99% |
| **價格壁壘** | Serverless 架構死守 NT$80，歐美大廠受限矽谷成本無法跟進 |
| **生態壁壘** | 跨境除錯鏈（日本發包 ↔ 越南承接），高度綁定本工具 |
| **技術壁壘** | rrweb + Pull 模式 MCP + Token 壓縮，成本結構碾壓競品 |

---

## 十、開放問題（待討論）

| # | 問題 | 選項 |
|---|---|---|
| 1 | Whisper 替代方案 | Groq 優先（已確認）→ 量大後自架 faster-whisper？ |
| 2 | MCP 是否需支援讀截圖 | 回傳 URL 讓 AI 用 vision 看（已確認） |
| 3 | 隱私遮罩技術 | Chrome 端 Canvas 模糊 vs 後端 OpenCV |
| 4 | 付費串接 | Stripe vs Paddle（台灣開發者友善度） |
| 5 | MVP 是否先支援分享連結帶 token | 建議是，為團隊版鋪路 |
| 6 | 免費版語音功能 | 白皮書建議免費版不給語音，spec 給 15 分鐘 → 待釘定 |

---

## 十一、未來路線圖

```
Phase 1（MVP）：Chrome 擴充 + rrweb + 中文語音 + MCP Pull + Web 報告頁
Phase 2：Level 1 延伸（AI 標題 + Markdown + Webhook）
Phase 3：付費上線（Stripe）+ 團隊功能
Phase 4：Firefox / Edge 擴充
Phase 5：日文 / 韓文 / 越文語音
Phase 6：跨境除錯鏈（越→日自動翻譯）
Phase 7：桌面版（Electron）
Phase 8：企業自託管 + 語料護城河
```
