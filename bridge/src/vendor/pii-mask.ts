// ⚠ 從 `cli/src/pii-mask.ts` **逐字複製**（PM-327），不是另寫一份。
//
// 為什麼是複製而不是 import：`bugezy-bridge` 會單獨 `npm publish`，
// 相對路徑的 `../../cli/src/...` 在發布出去的套件裡並不存在。
//
// 🔴 **改動請改 `cli/src/pii-mask.ts` 再同步過來**——`_verify_vendor.mjs` 會逐字比對，
//    兩邊只要不一致就會測試失敗（避免默默漂移）。
// pii-mask.ts — PM-167：CLI 端 stderr PII 遮罩
// 後端 traceback 常夾帶 DB 連線字串（含密碼）、環境變數（金鑰）、API token。
// 上傳前一律在「使用者本機」遮罩，server 永遠只收到遮罩後的結果（同 PM-157 前端遮罩精神）。
// server 端另有一份相同規則做雙重防護（防舊版 CLI 未更新）。

// PM-367：以下四組 pattern 改為 export，讓 bridge 的瀏覽器錯誤遮罩能沿用**同一組規則**
// （規格要求「與 terminal 的 maskStderr 用同一組 regex pattern」）。
// TOKEN／PII 兩組加上 `label`，供需要標示型別的呼叫端使用（例如 `<masked:JWT>`）；
// **`maskStderr` 自己的輸出完全不變**，仍是 ***MASKED*** / ***。

// 資料庫連線字串（含密碼）：mysql/postgres/mongodb/redis/amqp/mssql://...
export const DB_URI = /\b(mysql|postgres|postgresql|mongodb|redis|amqp|mssql):\/\/[^\s"']+/gi;

// 環境變數賦值（KEY=VALUE 或 KEY: "VALUE"）——保留 KEY 名稱、遮罩值
export const ENV_SENSITIVE_KEYS =
  /\b(DATABASE_URL|DB_URL|DB_PASSWORD|DB_PASS|REDIS_URL|MONGO_URI|SQLALCHEMY_DATABASE_URI|SECRET_KEY|JWT_SECRET|API_KEY|API_SECRET|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|STRIPE_SECRET|OPENAI_API_KEY|GROQ_API_KEY|SUPABASE_SERVICE_ROLE_KEY|PRIVATE_KEY|CLIENT_SECRET)\s*[=:]\s*["']?[^\s"']+["']?/gi;

/** 帶型別標籤的 pattern。`label` 只給需要標示型別的呼叫端用，`maskStderr` 不使用它。 */
export interface LabeledPattern {
  re: RegExp;
  label: string;
}

// 常見 token / key 格式 → 整個遮罩
export const TOKEN_PATTERNS: LabeledPattern[] = [
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: 'API_KEY' }, // OpenAI
  { re: /\bAIza[A-Za-z0-9_-]{30,}\b/g, label: 'API_KEY' }, // Google
  { re: /\bghp_[A-Za-z0-9]{36,}\b/g, label: 'TOKEN' }, // GitHub PAT
  { re: /\bgho_[A-Za-z0-9]{36,}\b/g, label: 'TOKEN' }, // GitHub OAuth
  { re: /\bAKIA[A-Z0-9]{16}\b/g, label: 'API_KEY' }, // AWS Access Key ID
  { re: /\bxox[baprs]-[A-Za-z0-9-]+/g, label: 'TOKEN' }, // Slack token
  { re: /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, label: 'JWT' }, // JWT
];

// 一般 PII（複用 PM-157 規則）：email / 信用卡 / 台灣手機 / 台灣身分證
export const GENERAL_PII: LabeledPattern[] = [
  { re: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, label: 'EMAIL' },
  { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, label: 'CARD' },
  { re: /\b09\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, label: 'PHONE' },
  { re: /\b[A-Z][12]\d{8}\b/g, label: 'ID' },
];

/** 遮罩 stderr/crash log 中的敏感資料。DB URI 保 scheme+host、env 保 KEY 名、token/PII 整遮。 */
export function maskStderr(text: string): string {
  if (!text) return text;
  let masked = text;

  // 1. DB 連線字串 → 保留 scheme + host，遮罩帳號/密碼
  masked = masked.replace(DB_URI, (match) => {
    try {
      const url = new URL(match);
      if (url.password) url.password = '***';
      if (url.username) url.username = '***';
      return url.toString();
    } catch {
      // 不合法 URL → 手動遮罩 user:pass@ 段
      return match.replace(/:\/\/[^@]+@/, '://***:***@');
    }
  });

  // 2. 敏感環境變數 → 保留 KEY 名，遮罩值
  masked = masked.replace(ENV_SENSITIVE_KEYS, (match) => {
    const eqIndex = match.search(/[=:]/);
    return eqIndex > 0 ? match.slice(0, eqIndex + 1) + ' ***MASKED***' : '***MASKED***';
  });

  // 3. token / key 格式 → 整個遮罩
  for (const p of TOKEN_PATTERNS) masked = masked.replace(p.re, '***MASKED***');

  // 4. 一般 PII → 局部遮罩
  for (const p of GENERAL_PII) masked = masked.replace(p.re, '***');

  return masked;
}
