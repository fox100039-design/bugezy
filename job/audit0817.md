# BugEzy 安全審察報告 — v2 Bridge + 記憶矩陣 + Zone Grid

- **日期**：2026-08-17
- **審察者**：Claude Opus（PM/審察角色，另一 session）
- **委託**：FOX
- **給誰讀**：另一 session 的 Opus 4.6 PM——請評估「本審察的正確性」與「下方 PM-368~380 卡片是否合理、是否照樣派給 Claude Code」。
- **審察方法**：以 dc-light（唯讀）**實際讀取原始碼**逐檔比對,非憑摘要推論。下方每條發現都附 `檔案:行`。
- **實際讀過的檔**：
  - `bridge/src/`：extension-link.ts、memory-store.ts、memory-ops.ts、terminal-monitor.ts、tier-gate.ts、severity.ts、pii-browser.ts、vendor/pii-mask.ts
  - `extension/src/`：manifest.json、background.ts(部分)、content.ts(部分)、inject.ts(部分)、edit-report.ts(部分)
  - `server/src/index.ts`：auth/session、ECPay callback、Supabase key、MCP list_reports(抽查)
- **未能完整覆蓋(誠實聲明)**：`index.ts` 共 8,873 行,只抽查代表性端點;RLS 是否啟用是 DB 狀態不在程式碼內。詳見文末「無法從程式碼確認」。

---

## 0. 貫穿全局的核心結論(最優先閱讀)

BugEzy 的 bridge 同時具備**代理三要素(lethal trifecta)**:

1. **讀得到不可信內容** — `read_page` / `get_browser_errors` 回傳的頁面內容由攻擊者控制
2. **有高權限本機能力** — `start_terminal_monitor` 執行指令、跨分頁讀 DOM(靠 tab_id)、導航
3. **有外洩管道** — 可導航到攻擊者網址、或把資料經「AI 讀→AI 執行」的注入迴圈餵回去

而這三者中間**沒有任何使用者確認關卡**。

FOX 個別修的洞(P0 Origin、P1 路徑、P2 遮罩)都修得不錯,但它們沒有處理這個系統性問題:**AI 從敵意頁面讀進來的內容,和 AI 執行的指令之間,沒有信任邊界**。這直接影響下方對「start_terminal_monitor 已接受風險」的評估——我認為那條不該照原樣接受。

---

## 1. 主要發現總表

| 等級 | 位置 | 問題描述 | 建議修法 | 已知項目? |
|---|---|---|---|---|
| **P1** | `bridge/src/terminal-monitor.ts:65` | `spawn(command,{shell:true})` 執行任意指令。經 `read_page` 讀到的敵意頁面內容可提示注入 AI → AI 呼叫 `start_terminal_monitor` 帶惡意指令 → **提示注入 RCE**。tier gate 預設關、無確認關卡。這與 memory_export 提示注入**同一類**,非「同 AI terminal 等價」。 | 指令白名單(僅放行 dev server 樣式)**或**首次執行要使用者確認;或拒絕含 shell 控制字元(`&` `\|` `;` `$()` 反引號)。 | 標為已接受,**我不同意接受** |
| **P1** | `extension/src/content.ts:130`、`154-164` | content↔inject 用 `window.postMessage`,只驗 `e.source===window`+靜態常數 `BUGEZY_SOURCE`。但 inject 在 **MAIN world=頁面 context**,頁面自己的 JS 就能偽造 `to-content` 訊息:(a)灌假 console/network/rrweb 進錄製(汙染報告+注入 AI);(b)送 `REQUEST_VOICE_HISTORY` 觸發後,監聽 `to-inject` 的 wildcard `postMessage('*')` → **任何網站可竊取使用者語音逐字稿**。 | 語音/私密 payload 不經 MAIN world 中轉;buffer 留 ISOLATED content script;inject 只單向往外推、絕不接收 `VOICE_HISTORY`;不用 `'*'`。 | ❌ 新發現 |
| **P2** | `bridge/src/memory-ops.ts:466-473` | export 路徑檢查是**純字面**(`path.resolve` 不解 symlink)。專案目錄內若存在指向外部的 symlink/junction,`path.relative` 判定仍在專案內,但 `writeFileSync` 跟隨連結**寫到專案外**。你要防的 `.ssh/authorized_keys` 情境仍可達成。 | `fs.realpathSync` 正規化(對最深層存在父目錄 realpath 後接檔名),與 `realpathSync(projectRoot)` 比對包含關係。 | 是,**修復不完整** |
| **P2** | `bridge/src/memory-ops.ts:495-515` | `memoryImport` **完全沒有路徑限制**(export 有,import 被漏)。指到任意檔 → 存在性 oracle;依 Node/V8 版本,`JSON.parse` 錯誤訊息會回吐檔案開頭數位元組 → **部分任意讀**。 | import target 套用與 export 相同專案內限制;錯誤訊息不夾帶原始檔案內容。 | 相關,**讀取側被漏掉** |
| **P2** | `bridge/src/extension-link.ts:63-69`、`87-92` | Origin 驗證擋掉網頁來源(P0 主體有效 ✅),但 regex 放行**所有** `chrome-extension://`,不限 BugEzy 自己的 ID。任何**同機共存的惡意擴充**可連上冒充,並靠「新連線取代舊連線」踢掉真 Extension(DoS)。 | pin 精確 origin(prod/dev ID 各列一),而非只驗 scheme。 | 精化已知 P0 |
| **P2** | `bridge/src/vendor/pii-mask.ts:44` | Email regex `[\w.-]+@[\w.-]+\.\w{2,}` 中 `[\w.-]+` 與 `\.` 在 `.` 上重疊 → **多項式回溯 ReDoS**。輸入是攻擊者控制且**未先限長**的 console/URL 字串,跑在 bridge 單執行緒 → 凍結 event loop。 | 遮罩前先截斷輸入長度;domain 段改 `[\w-]+(?:\.[\w-]+)+` 消除重疊。 | 相關(遮罩),ReDoS 面向為新 |
| **P2** | `bridge/src/tier-gate.ts:112-119` | tier 讀 `process.env.BUGEZY_USER_TIER`、開關讀 `ENFORCE_TIER_GATE`,兩者皆本機環境變數且**預設關**。使用者設個 env var 即取得全部付費功能 → 收費閘門零強制力(營收完整性,非使用者受害)。 | 雲端強制:bridge 啟動拿 token 向 Workers 換簽章 tier;純本機功能本質無法完美強制,至少預設開、tier 綁 token。 | 在範圍內,我的評估 |
| **P3** | `bridge/src/severity.ts:66`、`bridge/src/memory-ops.ts:157` | `add_severity_rule` 與 memory L6 `regex:` 規則的使用者樣式,`new RegExp()` 編譯**無複雜度/長度守衛**,只 catch 語法錯誤不擋慢樣式。惡意樣式 × 攻擊者控制錯誤文字 → ReDoS。 | 限長比對;或拒絕巢狀量詞;規則於新增時預編譯。 | ❌ 新發現 |
| **P3** | `bridge/src/pii-browser.ts:121` | `decodeURIComponent(value)` 未包 try/catch。攻擊者控制的 URL 帶壞 `%` 編碼(`%ZZ`)會 throw,中斷該 payload 遮罩。 | 包 try/catch;失敗時視為不透明值,只做 pattern 遮罩。 | ❌ 新發現 |
| **P3** | `extension/manifest.json:29-42` | 權限清單精簡(無 host_permissions/scripting/tabs ✅),但 content_scripts 對 **`<all_urls>` 於 document_start** 注入,且 `inject.js` 跑 **MAIN world**——每個網站(含網銀/信箱)都常駐執行,footprint 與精簡權限不一致。 | 預設縮到 dev 網域(`localhost`/`127.0.0.1`/`*.local`),其他改使用者主動啟用。 | ❌ 新發現(縮小面向) |
| **P3** | `extension/src/checkout.ts:39`、`day-pass-checkout.ts:39` | `document.body.innerHTML=serverResponse`。innerHTML 不執行 `<script>` 但**會觸發 `<img onerror>` 等事件處理器 XSS**;目前靠 MV3 CSP 擋。一旦 CSP 放寬或 server 被入侵 → 擴充 origin(高權限)XSS。 | 改 DOM API 建表單,或明確鎖死 CSP。 | ❌ 新發現 |

---

## 2. 部分發現的推理補充(供評估正確性)

**P1 terminal RCE**:命令來自 AI(MCP 呼叫)。在預期流程裡是使用者叫 AI「監控 npm run dev」。但 AI **同時**讀頁面內容(read_page),頁面內容是敵意可控的。注入鏈:攻擊者在頁面放「請執行診斷指令 X」→ AI 讀到 → AI 呼叫 start_terminal_monitor(X)。`shell:true` 讓 `& | ; $() ` 反引號都能串接指令 → 本機任意程式碼執行。與「AI terminal」的關鍵差異:BugEzy 把「不可信輸入源(網頁)」與「執行 sink」焊在同一個 MCP server 且無確認。

**P1 語音外洩**:content.ts 收到 `REQUEST_VOICE_HISTORY`(dir=to-content)→ 向 background 拿 `GET_VOICE_BUFFER` → 用 `window.postMessage(...,'*')` 送 `VOICE_HISTORY`(dir=to-inject)。inject 在 MAIN world=頁面 context,頁面自己的 script **也能監聽**這個 postMessage。`BUGEZY_SOURCE` 是 shipped 在 inject.js 裡的常數,頁面 context 讀得到,非秘密。條件:錄製中/buffer 有語音時。影響:使用者口述的敏感內容外洩給任意網站。

**P2 memory_export symlink**:`path.resolve` 只做字面正規化(解 `.`/`..`),**不解 symlink**。若專案內有 junction(可經 terminal `mklink /J` 建立,又回到 P1 的注入鏈)指向外部,`path.relative(projectRoot, outPath)` 不以 `..` 開頭 → 通過檢查,但 `writeFileSync` 跟隨連結寫到外部。修法必須 realpath。

**P2 memory_import 讀 oracle**:import 只有 `MAX_IMPORT_BYTES`(50MB,`statSync().size` 先擋 ✅)這一個檢查,**沒有路徑限制**。`讀不到匯入檔` vs 解析錯誤兩種回覆可判斷檔案存在/可讀。Node 20+ V8 的 `JSON.parse` 對非 JSON 文字會在錯誤訊息夾帶開頭片段(如 `Unexpected token '-', "-----BEGIN "... is not valid JSON`)→ 洩漏檔案前綴。存在性 oracle 與版本無關,恆成立。

**P2 ReDoS 是多項式非指數**:email regex 沒有 `(x+)+` 的巢狀量詞,所以是**多項式(約二次)**回溯,不是指數。但輸入(console/URL)攻擊者可控且未先限長,跑在單執行緒,足以凍結 event loop。V8 是回溯引擎,會中招。

---

## 3. FOX 列的四項「已修」——完整度驗證

1. **P0 Origin 驗證** — 主體有效(網頁來源被擋;`Origin: null` 也擋,因 `"null"` 是 truthy 字串走 regex 失敗)。**殘留**:放行任何擴充 origin 而非 BugEzy 專屬 ID(表中 P2)。→ **部分完整**
2. **P1 memory_export 路徑** — **不完整**:純字面檢查,symlink/junction 可繞;且 import 讀取側完全沒限制(兩條 P2)。
3. **P2 大小上限** — 大致到位:`memory_save/update/import` 在 Zod 邊界(`mcp-server.ts:770`)與 50MB 上限都有擋。**小缺口**:`memory_learn` 組出的 content、import 檔內「單筆」條目未個別限長(`memorySave` 本身不檢查,靠各工具 schema)。→ **大致完整**
4. **P2 瀏覽器 PII 遮罩** — 已實作、與 CLI 共用規則、有防漂移測試。**但**:黑名單式(新格式 secret 會漏)、URL **path 段** token 依設計不遮、`decodeURIComponent` 會 throw、email regex 有 ReDoS。→ **已實作但有 caveat**

---

## 4. FOX 列的兩項「已接受風險」——評估

- **「本機程式可連 bridge」** — 短期可接受,但要知道 Origin 驗證同時也放行「任何共存擴充」,略超過「本機程式」;token 交握能一次解決兩者。→ **可暫緩,但建議提前**
- **「start_terminal_monitor 執行任意指令,同 AI terminal 等價」** — **不建議照原樣接受**。與 read_page(不可信輸入)+無確認組合後是提示注入 RCE,風險高於單純 AI terminal(見第 0 節)。至少加白名單或確認。→ **不同意,列 P1**

---

## 5. 已驗證為安全(這幾項不用擔心)

- **ECPay callback**(`index.ts:7606`):`timingSafeEqualStr` 常數時間比對、金額比對(`!==80` 拒授權)、`MerchantTradeNo` 冪等、`RtnCode==='1'` 才升級、payments→users 順序防孤兒(PM-163)、孤兒自癒(PM-219)。**紮實**。
- **session token → user_id**(`index.ts:160/184`):DB `sessions` 表查詢、`expires_at` 檢查、過期即刪、base64 fallback 已移除(P0-3)、Google token 驗 `aud`(P1-4)。**MCP `list_reports`(`8322`)驗證 token↔user_id 相符**——知道別人 email 也列不到報告(PM-142)。**user_id spoofing 確實補好**。
- **navigate_to**(`background.ts:863` `parseNavigableUrl`):只放行 http/https,擋掉 `javascript:`/`file:`/`data:`——無法用 URL 注入腳本。**好**。
- **報告估算 innerHTML**(`edit-report.ts:199`):只組靜態標籤+數字,`est.text` 僅用於算長度未插入 HTML。error panel 用 textContent 建 DOM(PM-69)。**安全**。

---

## 6. 無法從程式碼確認、需 FOX/PM 自行檢查

- **RLS 是否真的在每張表開 deny-all**:Worker 用 `SUPABASE_SERVICE_ROLE_KEY`(`index.ts:143`)會**繞過 RLS**,RLS 只是備援(擋 anon key 外流/直連)。它有沒有實際啟用在 `sessions/users/reports/payments` 每張表,是 DB 狀態,不在 index.ts——請到 Supabase dashboard 確認,並確保 anon key 沒被嵌進任何 client 端。
- **全端點覆蓋率**:service_role 繞過 RLS,每個碰 per-user 資料的端點都得自己 `.eq('user_id', tokenUserId)`。抽查(list_reports、`8493` R2 key)都對,但 8,873 行未逐一看。建議 grep 全部 `.from('reports'/'payments'/'sessions')` 確認都依 token 使用者過濾。

---

# PM 卡片（PM-368 起，依優先序）

> 說明給評估的 PM：目前最高卡號為 PM-367(瀏覽器 PII 遮罩),故本批從 PM-368 起。
> 每張卡標註 **【可直接派 Claude Code】** 或 **【需 FOX 先決策/鎖定邏輯】**——後者依 FOX「先鎖邏輯再寫 code」哲學,不該直接派工。
> 依賴:pii-mask.ts 是**從 `cli/src/pii-mask.ts` 逐字複製**且 `_verify_vendor.mjs` 會逐字比對——動到共用 regex 必須先改 cli 再同步 vendor(見 PM-373 註)。

---

### 🟡 PM-368：terminal_monitor 提示注入 RCE 收斂 【需 FOX 先決策】
- **等級**：P1
- **位置**：`bridge/src/terminal-monitor.ts:65`
- **問題**：`spawn(command,{shell:true})` 可被 read_page 注入鏈驅動成本機 RCE,且無確認關卡、tier gate 預設關。
- **需 FOX 決策的選項**（三選一或組合）：
  1. **指令白名單**:只放行 dev server 樣式(`npm|yarn|pnpm run …`、`vite`、`next`、`python -m …` 等),其餘拒絕。覆蓋 95% 真實用途、擋掉 `curl|sh`。
  2. **首次確認**:啟動前經 Extension 彈使用者確認一次(session 內記住)。
  3. **拒絕 shell 元字元**:command 含 `& | ; $() ` 反引號等一律拒絕(仍保留 `npm run dev` 這種純指令)。
- **建議預設**:選項 1+3 疊加,阻力最小、破壞性最低。
- **驗收標準**:惡意指令(含 `& curl … | sh`)被拒並回可讀原因;`npm run dev` / `python -m flask run` 正常;既有 `_verify` 全綠。
- **注意**:這是本審察最高影響項,請 FOX 優先拍板方向再派工。

---

### 🟡 PM-369：語音逐字稿外洩 + content↔inject 訊息偽造 【需 FOX 先鎖架構，核心修法已明確】
- **等級**：P1
- **位置**：`extension/src/content.ts:130`、`154-164`；`inject.ts` 對應 to-inject 監聽
- **問題**：頁面自身 JS 可偽造 `to-content` 訊息(灌假錯誤),並經 `REQUEST_VOICE_HISTORY`+wildcard `postMessage('*')` 竊取使用者語音逐字稿。
- **修法（核心明確）**：
  1. **移除**「語音歷史經 MAIN world 中轉」這條路徑;voice buffer 保留在 ISOLATED content script,不送進 inject(MAIN)。
  2. inject(MAIN)對 content 的通道改為**單向往外推**觀測資料;inject **不再接收** `VOICE_HISTORY` 或任何私密 payload。
  3. 所有 `postMessage` 移除 `'*'` targetOrigin。
- **需鎖定的架構問題**：確認 inject(MAIN world)目前有哪些「需要從 content 收資料」的功能(除語音外),逐一評估是否可改單向;`FLUSH_*` 若被頁面偽造只汙染自家錄製,可接受但建議加 session nonce 提高門檻。
- **驗收標準**:惡意頁面 script 無法取得語音逐字稿(手動驗:頁面監聽 to-inject 收不到 VOICE_HISTORY);錄製功能不退化;跨頁回放正常。

---

### 🟡 PM-370：memory_export 路徑改用 realpath 正規化 【可直接派 Claude Code】
- **等級**：P2
- **位置**：`bridge/src/memory-ops.ts:466-473`
- **問題**：純字面 `path.resolve` 檢查,專案內 symlink/junction 可讓 writeFileSync 逃出專案目錄。
- **修法**：對 `outPath` 最深層存在的父目錄做 `fs.realpathSync`,再接上不存在的尾段;取 `fs.realpathSync(projectRoot)`;用 realpath 後的路徑重做 `path.relative` 包含檢查。既有 `.bugezy-backup-*.json` 不覆蓋規則保留。
- **驗收標準**:指向專案外 junction 的 target 被拒;正常專案內匯出照舊;既有 memory `_verify` 全綠。

---

### 🟡 PM-371：memory_import 補路徑限制 + 錯誤訊息脫敏 【可直接派 Claude Code】
- **等級**：P2
- **位置**：`bridge/src/memory-ops.ts:495-515`
- **問題**：import 無任何路徑限制 → 任意檔存在性 oracle + JSON 解析錯誤回吐檔案前綴。
- **修法**：
  1. import target 套用與 export 相同的「realpath 後須在專案目錄內」限制。
  2. 解析失敗的錯誤訊息**不夾帶** `(e as Error).message` 的原始內容;改回固定訊息(如「檔案不是合法 BugEzy 備份 JSON」)。
- **驗收標準**:指向專案外檔案被拒且不回吐內容;正常備份匯入照舊。

---

### 🟡 PM-372：bridge Origin 綁定 BugEzy 專屬 extension ID 【可直接派 Claude Code，需先確認 ID】
- **等級**：P2
- **位置**：`bridge/src/extension-link.ts:63-69`
- **問題**：`verifyClient` 放行所有 `chrome-extension://`,共存的惡意擴充可冒充/踢掉真 Extension。
- **修法**：把 regex 換成精確 origin 允許清單:prod ID `chrome-extension://hfnkjlbbpehkflgfbjenfmnmjkdjadcj` +(dev 未封裝載入時的 ID,請 FOX 提供)。無 origin(本機 CLI)維持放行不變。
- **驗收標準**:非 BugEzy 的擴充 origin 被拒;真 Extension 連線正常;dev/prod 皆可連。
- **註**:dev 載入的 unpacked ID 會不同,需列進允許清單或改由 env 帶入。

---

### 🟡 PM-373：PII 遮罩 ReDoS — 輸入限長（+ 選配 regex 去重疊）【可直接派 Claude Code】
- **等級**：P2
- **位置**：呼叫端 `bridge/src/pii-browser.ts`、`terminal-monitor.ts`;regex 於 `bridge/src/vendor/pii-mask.ts:44`
- **問題**：email regex 的 `.` 字元重疊 → 多項式回溯;輸入未限長,攻擊者可控大字串凍結 event loop。
- **修法（分兩段，先做 a）**：
  - **(a) 呼叫端限長**：進 `maskBrowserError`/`maskUrl`/`maskStderr` 前先截斷輸入(建議 32KB),超過就截並標註。**此段不動共用 regex,無 vendor 漂移問題,高價值低風險,優先做。**
  - **(b) 選配 regex 去重疊**：domain 段改 `[\w-]+(?:\.[\w-]+)+`。⚠ **此段必須先改 `cli/src/pii-mask.ts` 再同步 `bridge/src/vendor/pii-mask.ts`**,否則 `_verify_vendor.mjs` 逐字比對會失敗;且要確認新 regex 對既有遮罩案例行為一致。
- **驗收標準**:大字串(如 100KB 惡意 email 樣式)遮罩在毫秒級完成;既有遮罩案例輸出不變;`_verify_vendor.mjs` 綠。

---

### 🟡 PM-374：tier gate 改雲端強制 【需 FOX 先決策】
- **等級**：P2（營收完整性，非使用者受害）
- **位置**：`bridge/src/tier-gate.ts:112-119`
- **問題**：tier/開關皆本機 env var 且預設關,設個環境變數即解鎖全部付費功能。
- **需 FOX 決策**：純本機功能(瀏覽器操作、記憶)本質上無法完美強制。可行方向:
  1. bridge 啟動時以 session token 向 Workers 換一個「簽章 tier 斷言」,無效則拒絕運作。
  2. 接受本機不可完美強制,至少讓閘門**預設開**、`currentTier()` 綁**驗證過的 token** 而非自由字串,擋掉隨手繞過。
- **建議**:先做方向 2(低成本擋 casual bypass),方向 1 待 Workers 端 tier 查詢就緒。
- **驗收標準**:未付費使用者無法靠設 env var 取得 Pro 工具;付費使用者正常。

---

### 🟡 PM-375：使用者自訂 regex 加複雜度守衛 【可直接派 Claude Code】
- **等級**：P3
- **位置**：`bridge/src/severity.ts:66`；`bridge/src/memory-ops.ts:157`(L6/L4 `regex:` 規則)
- **問題**：`add_severity_rule` 與 memory 規則的使用者 regex `new RegExp()` 編譯無守衛,惡意樣式 × 攻擊者錯誤文字 → ReDoS。
- **修法**：比對輸入先限長;規則於**新增時預編譯**(而非每次分類重編);可選:拒絕明顯巢狀量詞樣式。
- **驗收標準**:惡意樣式規則不會凍結分類;既有 severity `_verify` 全綠。

---

### 🟡 PM-376：maskUrl 的 decodeURIComponent 包 try/catch 【可直接派 Claude Code】
- **等級**：P3
- **位置**：`bridge/src/pii-browser.ts:121`
- **問題**：壞的 `%` 編碼(`%ZZ`)會讓 `decodeURIComponent` throw,中斷該 payload 遮罩。
- **修法**：try/catch 包住;失敗時視為不透明值,只走 pattern 遮罩(`labelForValue` 傳原始 value)。
- **驗收標準**:含壞編碼的 URL 不再拋錯、仍完成遮罩。

---

### 🟡 PM-377：content_scripts 注入範圍縮小 【需 FOX 先決策】
- **等級**：P3
- **位置**：`extension/manifest.json:29-42`
- **問題**：`<all_urls>` + MAIN world 於 document_start,每個網站常駐執行,footprint 過大且與精簡權限不符。
- **需 FOX 決策**：預設縮到 dev 網域(`http://localhost/*`、`http://127.0.0.1/*`、`http://*.local/*` 等),其他網域改使用者主動啟用。**取捨**:會改變 UX,且改 manifest **會觸發 Chrome Web Store 重新審核**(與「本階段不加新權限/少動 manifest」硬條件衝突)。
- **建議**:此項可延後至下一次必須送審時一併處理。
- **驗收標準**:預設只在 dev 網域注入;非 dev 網域需使用者啟用;送審通過。

---

### 🟡 PM-378：checkout innerHTML 改 DOM 建構 【可直接派 Claude Code】
- **等級**：P3
- **位置**：`extension/src/checkout.ts:39`、`day-pass-checkout.ts:39`
- **問題**：`document.body.innerHTML=serverResponse` 靠 MV3 CSP 擋事件處理器 XSS,CSP 放寬或 server 被入侵即成擴充 origin XSS。
- **修法**：綠界回應改用 DOMParser/DOM API 建表單並提交,不走字串 innerHTML;或明確保證並鎖死該頁 CSP。
- **驗收標準**:綠界導向流程照舊可付款;不再對網路回應做 innerHTML。

---

### 🟡 PM-379：確認 Supabase RLS deny-all 已啟用 【FOX/PM 查核任務，非 Claude Code】
- **等級**：查核(潛在 P1，取決於現況)
- **位置**：DB 設定 + `index.ts:143`
- **問題**：Worker 用 service_role 繞過 RLS,RLS 僅備援。需確認每張表真的開了 deny-all,且 anon key 未被嵌進 client 端。
- **動作**:FOX 到 Supabase dashboard 逐表確認 RLS 啟用(至少 `sessions/users/reports/payments/promo_codes/tickets`);確認 extension/前端沒有暴露 anon key 給無 RLS 的表。
- **驗收標準**:所有 public 表 RLS = on;anon key 直連任一表回空/被拒。

---

### 🟡 PM-380：per-user 端點授權覆蓋率稽核 【可派 Claude Code 做「唯讀稽核+回報」，先不改】
- **等級**：稽核(潛在 IDOR)
- **位置**：`server/src/index.ts` 全域
- **問題**：service_role 繞過 RLS,每個碰 per-user 資料的端點都得自己依 token 使用者過濾;8,873 行未逐一驗。
- **動作**:grep 全部 `.from('reports')`/`.from('payments')`/`.from('sessions')`/`.from('users')` 的**寫入與查詢**,逐一確認 `.eq('user_id', <來自 getAuthUserId/verifySessionByToken 的 id>)`,列出任何用 client 傳入 email/user_id 未經 token 校驗的端點。
- **驗收標準**:產出一份「端點 × 是否依 token 使用者過濾」清單;標紅項另開修復卡。

---

## 附註：建議修復順序

1. **先兩個 P1**：PM-368(terminal,需 FOX 拍板)、PM-369(語音外洩)
2. **再 P2 直派**：PM-370、PM-371(memory 路徑)→ PM-372(Origin ID)→ PM-373a(遮罩限長)
3. **P2 需決策**：PM-374(tier gate)
4. **查核先行**：PM-379(RLS,FOX 手動)、PM-380(端點稽核,可派 Claude Code 唯讀)
5. **其餘 P3**：PM-375、PM-376、PM-378;PM-377 延後至下次送審
