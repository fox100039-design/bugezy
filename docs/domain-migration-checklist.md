# BugEzy 域名遷移清單（workers.dev → bugezy.dev）

> 產出：PM-81（2026-06-30）｜**純調查，未改任何程式碼**
> 舊域名：`bugezy-api.bugezy-api.workers.dev`
> 新域名：`bugezy.dev`（已購買 + 綁定 Cloudflare Workers，DNS+SSL 已生效 2026-06-30）
>
> ⚠ **執行時機**：Chrome Web Store + 綠界 ECPay **雙審核中**，本清單**先別動**。等兩審核結果出來、確認流程後再依「§7 遷移順序」執行。

---

## 核心結論（先看這段）

1. **Worker 後端程式碼本身與域名無關**：`server/src/index.ts` 全程用 `url.origin`（動態取請求進來的域名）組 share_url / ECPay 回調 URL，**不寫死自家域名**。所以 Worker 端**不需為了換域名改任何邏輯**——只要把 `bugezy.dev` route 綁到同一個 Worker（已完成），後端就同時服務兩個域名。
2. **真正要改的「程式碼」只有 1 個關鍵點**：`extension/src/types.ts` 的 `API_BASE` 常數。擴充所有 API 呼叫、結帳、分享連結基準都從它衍生。
3. **OAuth 不用改**：用 `chrome.identity.getAuthToken`（Chrome 內建擴充 OAuth，綁擴充 ID + client_id，**無 web redirect URI**）。換 API 域名不影響登入。
4. **ECPay 回調不用改程式碼**：回調 URL 由 `url.origin` 動態產生 → 只要使用者從 `bugezy.dev/checkout` 進來，回調自動變 `bugezy.dev/...`（隨 `API_BASE` 改動而連動）。
5. **其餘是「文件 / 顯示字串」**：guide/faq 頁面給使用者看的 MCP 網址、上架文案、CLI 預設值、docs 等——換域名時一起改以保持一致，但不影響功能（舊域名仍可用）。

> 換句話說：**舊網址在 Worker route 沒移除前都還能用**，所以遷移可平滑、無斷線。

---

## §1 擴充功能程式碼（必改）

| # | 檔案 | 行 | 現值 | 改為 | 用途 / 備註 |
|---|---|---|---|---|---|
| 1 | `extension/src/types.ts` | 121 | `export const API_BASE = 'https://bugezy-api.bugezy-api.workers.dev';` | `https://bugezy.dev` | **唯一真正的源頭**。background/annotate/edit-report/popup 全部 `${API_BASE}/...` 衍生（API 呼叫、`/checkout`、`/#pricing`、`/api/*`）。改這一行 → 全擴充跟著走新域名。**改後必須 `npm run build` + 重打包 zip + 重新上 Web Store**（故須等 Web Store 審核結束）。 |

**連帶（不用改，會自動跟著 API_BASE 走，列出供確認）**：
- `extension/src/background.ts`：`${API_BASE}/api/user/usage`、`/api/reports`、`/api/live-errors`
- `extension/src/annotate.ts`：`${API_BASE}/api/reports`
- `extension/src/edit-report.ts`：`${API_BASE}/api/correct`、`/api/summarize`
- `extension/src/popup.ts`：`${API_BASE}/checkout?user_id=…`、`/api/user/plan`、`/api/user/cancel`、`/#pricing`

> 這些都用模板字串引用 `API_BASE`，**不需逐一改**。

---

## §2 OAuth 設定（不需改）

| 項目 | 現況 | 是否需改 | 說明 |
|---|---|---|---|
| 登入方式 | `extension/src/popup.ts:349` `chrome.identity.getAuthToken({interactive:true})` | ❌ 不需改 | Chrome 內建擴充 OAuth 流程，token 在前端取得後送 `POST {API_BASE}/api/auth/google` 驗證。 |
| `manifest.json` `oauth2` | `client_id: 610395663887-…apps.googleusercontent.com`、`scopes: openid/email/profile`（第 7-10 行） | ❌ 不需改 | client_id 綁的是**擴充 ID**（Chrome App OAuth client），非網站域名。 |
| redirect_uri / authorized origins | 全 codebase **無** `redirect_uri`、無 web callback | ❌ 不需改 | 擴充 OAuth 不走 web redirect；Google Console 端**不需**為換域名加授權來源/重導 URI。 |

**結論**：換 API 域名 → OAuth 完全不受影響。唯一前提是 `/api/auth/google` 在新域名可達（隨 §1 `API_BASE` 改動即達成）。

---

## §3 API Base URL 設定彙整

| # | 檔案 | 行 | 現值 | 改為 | 備註 |
|---|---|---|---|---|---|
| 1 | `extension/src/types.ts` | 121 | `https://bugezy-api.bugezy-api.workers.dev` | `https://bugezy.dev` | 見 §1（擴充唯一源頭）。 |
| 2 | `cli/src/index.ts` | 9 | `process.env.BUGEZY_API_URL \|\| 'https://bugezy-api.bugezy-api.workers.dev'` | 預設改 `https://bugezy.dev` | CLI（`npx bugezy-watch`）API 端點預設值；可被 `BUGEZY_API_URL` 環境變數覆蓋。改後須 `cli` 重新發佈才生效（npm publish）。 |
| 3 | `cli/src/index.ts` | 79 | help 文字 `(預設: https://bugezy-api.bugezy-api.workers.dev)` | 同步改 | 純說明字串。 |
| 4 | `web/vite.config.ts` | 10 | `'/api': 'https://bugezy-api.bugezy-api.workers.dev'` | `https://bugezy.dev` | **僅 dev proxy**；web React app 目前未部署（報告頁由 Worker 直接 serve `/report/:id`）。低優先，改了無害。 |
| 5 | `.mcp.json` | 18 | `BUGEZY_API_URL: http://127.0.0.1:8787` | 維持或改正式 | **本機開發用**（指 localhost），非正式域名；視個人開發習慣，通常不需動。 |

> 結論：**寫死在程式碼**（types.ts / cli），**非統一 config 檔**。env 覆蓋僅 CLI 支援（`BUGEZY_API_URL`）；擴充端無 env，必須改原始碼重 build。

---

## §4 MCP 端點

| 項目 | 現況 | 建議 |
|---|---|---|
| Worker 路由 | `server/src/index.ts` `/mcp`（path-based，`createMcpHandler(..., { route: '/mcp' })`） | ❌ 不需改：路由與域名無關，`bugezy.dev/mcp` 綁同 Worker 後自動可用。 |
| 給使用者的 MCP 網址（guide 頁） | `server/src/index.ts:673`（`<code>…/mcp</code>`）、`:680`（Claude Desktop JSON `"url"`）、`:686`（`claude mcp add … …/mcp`） | ✅ 換域名時一起改成 `https://bugezy.dev/mcp`（顯示字串，影響使用者體感一致）。 |
| FAQ 頁 MCP 網址 | `server/src/index.ts:770` | ✅ 同步改 `https://bugezy.dev/mcp`。 |
| 本機 MCP 設定範例 | `.mcp.json`（localhost） | 個人開發用，視需要。 |

**評估**：建議 MCP 也走 `bugezy.dev/mcp`（短、好記、品牌一致）。Worker 路由免改，只改 guide/faq 顯示字串 + 上架/文件。舊 `…workers.dev/mcp` 在 route 未移除前仍可連，已設定的用戶不會斷。

---

## §5 ECPay 回調 URL

| 項目 | 現況 | 換 key 時是否一起處理 |
|---|---|---|
| `ReturnURL`（首期通知） | `server/src/index.ts:1923` `${url.origin}/api/ecpay/callback` | ❌ 程式不用改：`url.origin` 動態。使用者從 `bugezy.dev/checkout` 進 → 回調自動 `bugezy.dev/...`。 |
| `OrderResultURL`（付款後導回） | `:1924` `${url.origin}/checkout/result` | ❌ 同上，動態。 |
| `PeriodReturnURL`（定期定額第 2 期起） | `:1933` `${url.origin}/api/ecpay/period-callback` | ❌ 同上，動態。 |
| 取消訂閱端點 | `ecpayCancel` 用 `new URL(env.ECPAY_PAYMENT_URL).origin + '/Cashier/CreditCardPeriodAction'` | 這是**綠界端**域名（payment-stage / 正式），非自家域名；換正式 key 時改 `ECPAY_PAYMENT_URL`（wrangler.toml / secret）即連動。 |
| share_url（報告連結） | `createReport` 用 `url.origin`（`:1504`） | ❌ 動態：從哪個域名上傳，分享連結就是哪個域名。 |

**關鍵連動**：ECPay 回調走哪個域名，**取決於 popup 開 `/checkout` 用的 `API_BASE`**（§1）。所以**只要改 §1 的 `API_BASE`，回調 + 分享連結自動全部走 `bugezy.dev`**，無需另外改 server。

**換正式 key 時要一起做**（與域名無關但同批處理）：`wrangler.toml` 的 `ECPAY_MERCHANT_ID/HASH_KEY/HASH_IV/PAYMENT_URL` 換成正式值（HASH_KEY/IV 建議 `wrangler secret put`）；綠界後台「廠商管理 → 系統介接設定」的回調網址若有手動填，需填 `bugezy.dev` 對應路徑。

---

## §6 文件 / 首頁 / 上架文案 URL 引用（顯示字串，換域名時同步）

| # | 檔案 | 行 | 內容 | 面向使用者？ |
|---|---|---|---|---|
| 1 | `docs/chrome-web-store.md` | 42-44 | 官網 / 使用指南 / 常見問題 URL（中文文案） | ✅ 上架表單會填入，**送審用** |
| 2 | `docs/chrome-web-store.md` | 75-77 | Website / Guide / FAQ（英文文案） | ✅ 同上 |
| 3 | `docs/chrome-web-store.md` | 86 | 隱私政策 URL | ✅ Web Store + 綠界審核欄位 |
| 4 | `docs/chrome-web-store.md` | 89 | 首頁 URL | ✅ 同上 |
| 5 | `docs/SKILL.md` | 56 | 「已部署 bugezy-api.bugezy-api.workers.dev」描述 | ❌ 內部文件 |
| 6 | `server/src/index.ts`（guide/faq HTML） | 673 / 680 / 686 / 770 | 使用者看到的 MCP 設定網址 | ✅ 見 §4 |

> `job/job-*.md` 內大量舊域名引用屬**歷史任務記錄**，不需回頭改（保留當時事實）。

---

## §7 遷移順序建議（待雙審核結束後執行）

> 原則：**舊域名 route 先別移除**，全程可雙域名並行，零斷線。

1. **前置（現在可做、不改 code）**：確認 `bugezy.dev` 已綁同一個 Worker 且 `GET https://bugezy.dev/` 正常回首頁、`https://bugezy.dev/mcp` 可連、`https://bugezy.dev/api/reports` 正常（純驗證，不改 code）。
2. **等 Chrome Web Store 審核結果**：
   - 若**通過後**：再改 `extension/src/types.ts` `API_BASE` → `https://bugezy.dev` → `npm run build` → 重打包 zip → 上傳**新版**走 Web Store 更新流程（會再經一次審核）。**審核期間不要改**，避免影響當前送審版本。
3. **等綠界 ECPay 審核結果 + 換正式 key**：
   - 把 `wrangler.toml` ECPAY 4 值換正式（HASH_KEY/IV 用 `wrangler secret`）→ `wrangler deploy`。
   - 因回調走 `url.origin`，配合步驟 2 的 `API_BASE=bugezy.dev`，回調自動走 `bugezy.dev`；若綠界後台有手填回調網址，改成 `bugezy.dev`。
4. **server 顯示字串 + 文件**（可與步驟 3 同批 deploy）：
   - `server/src/index.ts` guide/faq 的 MCP 網址（673/680/686/770）→ `bugezy.dev/mcp`，`wrangler deploy`。
   - `docs/chrome-web-store.md`（上架文案 4 處）→ 換新域名（供之後更新上架資訊）。
   - `cli/src/index.ts`（預設 + help）→ 新域名，視需要 npm 重發。
   - `web/vite.config.ts`、`docs/SKILL.md`：低優先，順手改。
5. **觀察期過後**（確認新域名穩定、舊用戶都更新後，數週～數月）：才考慮移除舊 `workers.dev` route（**非必要可永久保留**，避免已設定 MCP 的老用戶斷線）。

### 風險 / 注意
- ⚠ 擴充改 `API_BASE` **一定要重新上架**（zip 重打包）；Web Store 審核期間（現在）**禁改**。
- ⚠ 已安裝舊版擴充的用戶，在更新前仍打舊域名 → 舊 route 不可過早移除。
- ⚠ 已在 AI 工具設好舊 `…workers.dev/mcp` 的用戶，舊 route 移除即斷 → 移除前公告或長期保留。
- ✅ 後端 `url.origin` 設計讓 ECPay 回調 / 分享連結零改動自動跟隨——這是本次遷移最省力的關鍵。

---

*本清單由 PM-81 唯讀稽核產出，未變更任何 `.ts/.tsx/.js/.json/.html`、未 build、未 deploy。*
