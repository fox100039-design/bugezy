# BUGEZY.md — AI 自動 Debug 指引

> 把這份檔案放在你的專案根目錄，Claude Code 之類的 AI 助手讀到之後就會照著做。
> 需要先安裝 BugEzy 擴充功能並接上 `bugezy-bridge` MCP server。

---

## 規則

### 1. 每次修改前端相關檔案後 → 呼叫 `get_zone_changes()`

- 有 🔴 zone → 呼叫 `get_zone_errors(zone_id)` 查明原因
- 有 critical error → 呼叫 `pin_analyze(selector)` 深入分析
- 修好之後**再呼叫一次** `get_zone_changes()` 確認回到 🟢

> `get_zone_changes` 需要先 `watch_zones()` 才會累積變化；沒監控時它會直說「目前沒有在監控」而不是回空陣列。
> 另外它是 **PULL 模式**（讀取即清空）——MCP 沒有 server 主動推播給模型的通道，你不查就不會知道。

### 2. 每次啟動 dev server 後 → 呼叫 `start_auto_detect({ depth: 'quick' })`

- 用 `get_detect_report()` 看 `score`
- `score < 80` → 優先處理 `critical_errors` 清單
- 需要逐區深入時才用 `depth: 'full'`（會對每個非健康區域再跑一次分析，比較慢）

### 3. 每次修改後端相關檔案後 → 呼叫 `get_terminal_live_errors()`

- 前提是後端用 `start_terminal_monitor('npm run dev')` 跑起來的
- 有 critical → 呼叫 `correlate_errors()` 看前後端是不是同一件事

### 4. Debug 完成後 → 呼叫 `memory_learn({ symptom, fix })`

把「症狀 → 根因 → 修法」記進 L1，下次遇到同樣的 bug 直接給解法，不用重新推理一遍。

---

## 不要做的事

- **不要在沒有確認 `get_zone_changes()` 回 🟢 的情況下說「修好了」。**
- **不要跳過 Unassigned 的錯誤。** 那些是抓不到現場元素的錯誤，往往正是 `setTimeout`／Promise 深處最難查的那幾筆。全綠不代表沒問題。
- **不要把空結果讀成「沒問題」。** 瀏覽器錯誤只涵蓋最近 30 秒、終端機 120 秒；空的意思是「這段時間內沒出事」。
- **不要忽略終端機裡的 `⚠ [BugEzy] 🔴` 警告**（如果你看得到的話——見下方說明）。

---

## 關於 `⚠ [BugEzy] 🔴` stderr 警告

bridge 偵測到 critical 錯誤時，會往 **stderr** 寫一行：

```
⚠ [BugEzy] 🔴 Browser | TypeError: Cannot read 'map' of undefined（section.cart） | 建議：呼叫 pin_analyze("section.cart")
⚠ [BugEzy] 🔴 Terminal | OperationalError: could not connect to server | 建議：呼叫 correlate_errors() 看前端是否有對應的失敗請求
⚠ [BugEzy] 🔴 Zone | Cart Zone 從 healthy → error（新增 2 筆錯誤） | 建議：呼叫 get_zone_errors("zone-cart")
⚠ [BugEzy] 🔴 Pin | button#submit 狀態 active → stale | 建議：呼叫 read_page() 確認頁面結構是不是換了
```

> ⚠ **這不是推播通道，請不要指望它會自己送到 AI 面前。**
>
> MCP **沒有 server → 模型的通道**。stdio 模式下 MCP client 會收走 server 的 stderr，
> 但多數 client 是寫進自己的 log／debug 輸出，**不會自動出現在對話脈絡裡**。
>
> 也就是說：
> - ✅ 你自己在終端機看得到，`claude --debug` 之類的模式也看得到，格式固定一行可以 grep
> - ❌ **AI 不會因為 stderr 出現警告就自動醒過來**——它仍然得照上面的規則主動呼叫工具
>
> 所以第 1~3 條的「每次改完就呼叫」才是真正有效的機制，stderr 是給人看的輔助。

同一則警告 **30 秒內不重複輸出**，而且只有 critical 會叫（minor／info 不會）。輸出前一律做 PII 遮罩。

---

## 用得到的工具速查

| 情境 | 工具 |
|---|---|
| 這頁現在有什麼錯 | `get_browser_errors()` / `get_error_summary()` |
| 錯在頁面的哪一區 | `map_page_zones()` → `get_zone_health()` → `get_zone_errors(zone_id)` |
| 盯著某個元素 | `pin_element(selector, description)` → `patrol_pins()` |
| 一次跑完整輪掃描 | `start_auto_detect()` → `get_detect_report()` |
| 後端錯誤 | `start_terminal_monitor(cmd)` → `get_terminal_live_errors()` |
| 前後端是不是同一件事 | `correlate_errors()` |
| 記住這次的修法 | `memory_learn({ symptom, fix })` |
| 之後想起來 | `memory_search(query)` |

---

## 常見狀況

**工具回「需要 Pro 方案」** — bridge 的方案閘門預設開啟。請在 MCP 設定的 `env` 加上
`BUGEZY_SESSION_TOKEN`（BugEzy 擴充功能的進階設定可以複製）與 `BUGEZY_USER_EMAIL`。

**工具回「Extension 尚未連上 bridge」** — 確認擴充功能已啟用、瀏覽器有開著；剛更新過的話要重新載入擴充功能。

**`start_terminal_monitor` 說指令不被允許** — 它只接受單一個 dev server 指令，
不接受串接（`&&`）、管線（`|`）、重導向（`>`）與命令替換。要組合指令請自己在終端機跑，
再用它監控其中一個。
