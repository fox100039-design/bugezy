// PM-367：瀏覽器錯誤的 PII 遮罩。
//
// 與終端機的 `maskStderr` **共用同一組 regex**（從 vendor/pii-mask.ts import，
// 那份與 `cli/src/pii-mask.ts` 逐字一致並有防漂移測試），差別只在輸出格式：
//   終端機 → `***MASKED***` / `***`
//   瀏覽器 → `<masked:JWT>` / `<masked:EMAIL>` …
//
// **為什麼要留型別標籤**：這些錯誤是給 AI 讀來 debug 的。看到 `<masked:JWT>` 它知道
// 「這裡本來是一個 JWT，可能是過期或格式問題」；看到一坨 `***` 就只剩「有東西被遮掉了」。
// 遮罩不該讓工具失去用處 —— 這是 PM-366 當初沒有直接動手的原因。

import {
  DB_URI,
  ENV_SENSITIVE_KEYS,
  TOKEN_PATTERNS,
  GENERAL_PII,
  type LabeledPattern,
} from './vendor/pii-mask.js';

/**
 * 瀏覽器情境額外的樣式。**刻意不放進 vendor/cli 的共用檔**——那份檔案同時被
 * 已發布的 CLI 使用，往裡面加樣式等於改變既有使用者的上傳行為。
 * 這些是 PM-367 卡片點名要加的（Stripe key、Bearer token 等）。
 */
const BROWSER_EXTRA_PATTERNS: LabeledPattern[] = [
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: 'API_KEY' }, // Stripe secret／restricted
  { re: /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: 'API_KEY' }, // Stripe publishable（卡片點名）
  { re: /\bgh[sur]_[A-Za-z0-9]{36,}\b/g, label: 'TOKEN' }, // GitHub server／user-to-server／refresh
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, label: 'TOKEN' }, // Authorization: Bearer xxx
  { re: /\b[Bb]asic\s+[A-Za-z0-9+/]{16,}=*/g, label: 'TOKEN' }, // Authorization: Basic xxx
];

/** query string 裡值必須遮罩的參數名（比對時轉小寫）。**參數名保留**，只遮值。 */
const SENSITIVE_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'authorization',
  'api_key', 'apikey', 'api-key', 'key', 'secret', 'client_secret',
  'password', 'passwd', 'pwd', 'sig', 'signature', 'session', 'session_token',
]);

/** 值長什麼樣就標什麼標籤——比一律標 API_KEY 更有資訊量。 */
function labelForValue(value: string, paramName: string): string {
  for (const p of [...TOKEN_PATTERNS, ...BROWSER_EXTRA_PATTERNS]) {
    p.re.lastIndex = 0;
    if (p.re.test(value)) return p.label;
  }
  const n = paramName.toLowerCase();
  if (n.includes('password') || n === 'pwd' || n === 'passwd') return 'PASSWORD';
  if (n.includes('secret')) return 'SECRET';
  if (n.includes('key')) return 'API_KEY';
  return 'TOKEN';
}

/**
 * 遮罩 console 錯誤訊息等自由文字。
 *
 * 順序與 `maskStderr` 一致（DB URI → env 賦值 → token → 一般 PII），
 * 因為前面的規則會吃掉後面規則本來會誤判的片段。
 */
/**
 * PM-373：進遮罩前先限長。
 *
 * 共用的 regex（`[\w.-]+@[\w.-]+\.\w{2,}` 這類）在**特製的超長輸入**下會產生大量回溯，
 * 一則 100 KB 的假 email 字串就能讓 bridge 卡住。**刻意不動共用 regex**（那份與 CLI
 * 逐字一致、有防漂移測試），改在呼叫端截斷 —— 效果一樣，風險小得多。
 */
export const MAX_MESSAGE_LEN = 32 * 1024;
export const MAX_URL_LEN = 8 * 1024;
export const TRUNCATED_SUFFIX = ' ...<truncated>';

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + TRUNCATED_SUFFIX;
}

export function maskBrowserError(message: string): string {
  if (!message) return message;
  let m = clamp(message, MAX_MESSAGE_LEN);

  // 1. DB 連線字串 → 保留 scheme + host，只遮帳密（AI 還看得出連的是哪台）
  m = m.replace(DB_URI, (match) => {
    try {
      const url = new URL(match);
      if (url.password) url.password = '***';
      if (url.username) url.username = '***';
      return url.toString();
    } catch {
      return match.replace(/:\/\/[^@]+@/, '://<masked:DB_URL>@');
    }
  });

  // 2. 敏感環境變數賦值 → 保留 KEY 名
  m = m.replace(ENV_SENSITIVE_KEYS, (match) => {
    const i = match.search(/[=:]/);
    return i > 0 ? match.slice(0, i + 1) + ' <masked:SECRET>' : '<masked:SECRET>';
  });

  // 3. token / key 格式（共用 + 瀏覽器額外）
  for (const p of [...TOKEN_PATTERNS, ...BROWSER_EXTRA_PATTERNS]) {
    m = m.replace(p.re, `<masked:${p.label}>`);
  }

  // 4. 一般 PII
  for (const p of GENERAL_PII) {
    m = m.replace(p.re, `<masked:${p.label}>`);
  }

  return m;
}

/**
 * 遮罩網址：**只動 query string 裡的敏感參數值**。
 *
 * 🔴 **path 一個字元都不能改**——`correlate_errors` 是用 path 去配對前後端錯誤的，
 * 改了 path 等於把那支工具弄壞。zone 歸類與去重也依賴網址的穩定性。
 * 參數名也保留：AI 需要知道「是 api_key 錯了還是 signature 錯了」。
 */
export function maskUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  const url = clamp(rawUrl, MAX_URL_LEN); // PM-373
  const q = url.indexOf('?');
  if (q < 0) return url; // 沒有 query → 完全不動
  const head = url.slice(0, q);
  // hash 不參與遮罩，但要原樣接回去
  const rest = url.slice(q + 1);
  const h = rest.indexOf('#');
  const query = h < 0 ? rest : rest.slice(0, h);
  const hash = h < 0 ? '' : rest.slice(h);

  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!value) return pair;
      if (SENSITIVE_PARAMS.has(name.toLowerCase())) {
        // PM-376：`decodeURIComponent` 對壞編碼（例如 `%ZZ`）會拋 URIError。
        //   遮罩流程不該因為一個編壞的參數就整支炸掉 —— 解不開就當作不透明值，
        //   直接拿原始字串去判型別（判不出來就退回 TOKEN）。
        let decoded = value;
        try {
          decoded = decodeURIComponent(value);
        } catch {
          /* 壞編碼 → 用原始值判型別；無論如何這個參數的值都會被遮掉 */
        }
        return `${name}=<masked:${labelForValue(decoded, name)}>`;
      }
      // 參數名不敏感，但值本身長得像 token／email 也要遮
      const byPattern = maskBrowserError(value);
      return byPattern === value ? pair : `${name}=${byPattern}`;
    })
    .join('&');

  return `${head}?${masked}${hash}`;
}

/** 一筆 console 錯誤：只動 message，其餘欄位（selector／source／level…）原樣保留。 */
export function maskConsoleEntry<T extends { message?: unknown }>(e: T): T {
  if (typeof e?.message !== 'string') return e;
  return { ...e, message: maskBrowserError(e.message) };
}

/** 一筆網路錯誤：只動 url（與可能存在的 message），其餘欄位原樣保留。 */
export function maskNetworkEntry<T extends { url?: unknown; message?: unknown }>(e: T): T {
  const out = { ...e } as Record<string, unknown>;
  if (typeof e?.url === 'string') out.url = maskUrl(e.url);
  if (typeof e?.message === 'string') out.message = maskBrowserError(e.message);
  return out as T;
}

/** 對一包 `{ console_errors, network_errors }` 形狀的資料做遮罩（找不到就原樣回）。 */
export function maskErrorPayload<T extends Record<string, unknown>>(d: T): T {
  const out = { ...d } as Record<string, unknown>;
  if (Array.isArray(d.console_errors)) {
    out.console_errors = (d.console_errors as Array<Record<string, unknown>>).map(maskConsoleEntry);
  }
  if (Array.isArray(d.network_errors)) {
    out.network_errors = (d.network_errors as Array<Record<string, unknown>>).map(maskNetworkEntry);
  }
  if (Array.isArray(d.errors)) {
    // get_zone_errors 用的是單一 errors 陣列，兩種形狀都可能出現
    out.errors = (d.errors as Array<Record<string, unknown>>).map((e) =>
      maskNetworkEntry(maskConsoleEntry(e)),
    );
  }
  return out as T;
}
