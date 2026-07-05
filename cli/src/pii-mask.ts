// pii-mask.ts — PM-167：CLI 端 stderr PII 遮罩
// 後端 traceback 常夾帶 DB 連線字串（含密碼）、環境變數（金鑰）、API token。
// 上傳前一律在「使用者本機」遮罩，server 永遠只收到遮罩後的結果（同 PM-157 前端遮罩精神）。
// server 端另有一份相同規則做雙重防護（防舊版 CLI 未更新）。

// 資料庫連線字串（含密碼）：mysql/postgres/mongodb/redis/amqp/mssql://...
const DB_URI = /\b(mysql|postgres|postgresql|mongodb|redis|amqp|mssql):\/\/[^\s"']+/gi;

// 環境變數賦值（KEY=VALUE 或 KEY: "VALUE"）——保留 KEY 名稱、遮罩值
const ENV_SENSITIVE_KEYS =
  /\b(DATABASE_URL|DB_URL|DB_PASSWORD|DB_PASS|REDIS_URL|MONGO_URI|SQLALCHEMY_DATABASE_URI|SECRET_KEY|JWT_SECRET|API_KEY|API_SECRET|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|STRIPE_SECRET|OPENAI_API_KEY|GROQ_API_KEY|SUPABASE_SERVICE_ROLE_KEY|PRIVATE_KEY|CLIENT_SECRET)\s*[=:]\s*["']?[^\s"']+["']?/gi;

// 常見 token / key 格式 → 整個遮罩
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI
  /\bAIza[A-Za-z0-9_-]{30,}\b/g, // Google
  /\bghp_[A-Za-z0-9]{36,}\b/g, // GitHub PAT
  /\bgho_[A-Za-z0-9]{36,}\b/g, // GitHub OAuth
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS Access Key ID
  /\bxox[baprs]-[A-Za-z0-9-]+/g, // Slack token
  /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, // JWT
];

// 一般 PII（複用 PM-157 規則）：email / 信用卡 / 台灣手機 / 台灣身分證
const GENERAL_PII: RegExp[] = [
  /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  /\b09\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g,
  /\b[A-Z][12]\d{8}\b/g,
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
  for (const pattern of TOKEN_PATTERNS) masked = masked.replace(pattern, '***MASKED***');

  // 4. 一般 PII → 局部遮罩
  for (const pattern of GENERAL_PII) masked = masked.replace(pattern, '***');

  return masked;
}
