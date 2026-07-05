// storage.ts — PM-157：儲存空間快照 + PII 遮罩（inject MAIN world + annotate 擴充頁共用）
// 小白常遇「登入狀態突然消失」「資料怎麼不見了」——多半是 localStorage/sessionStorage/cookie 問題。
// ⚠ 儲存空間可能含密碼/token/信用卡號 → 遮罩「在使用者本機」執行，server 永遠只收到遮罩後的結果。

import type { StorageItem, StorageSnapshot } from './types';

// key 名稱敏感 → 整個值遮罩（密碼 / token / 金鑰 / 憑證 / 卡號 / session / jwt / bearer / refresh / access）
// PM-163（Fable5 #8）：補 jwt/bearer/refresh/access（OAuth token 常用命名）
const SENSITIVE_KEYS =
  /password|passwd|pwd|token|secret|key|api.?key|auth|credential|credit.?card|card.?num|cvv|ssn|session|jwt|bearer|refresh|access/i;

// 值裡的敏感模式 → 局部遮罩（email / 卡號 / JWT / 台灣手機 / 身分證 / API key）
// PM-163（Fable5 #8）：補 Amex 15 位 / 台灣手機 / 台灣身分證 / OpenAI sk- / Google AIza key
const SENSITIVE_VALUES: RegExp[] = [
  /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, // email
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // 信用卡號（4-4-4-4）
  /\b\d{15}\b/g, // Amex 15 位卡號
  /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, // JWT token（header.payload.sig）
  /\b09\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, // 台灣手機（09xx-xxx-xxx）
  /\b[A-Z][12]\d{8}\b/g, // 台灣身分證（1 英文 + 1/2 + 8 數字）
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI API key
  /\bAIza[A-Za-z0-9_-]{30,}\b/g, // Google API key
];

/** PII 遮罩：①敏感 key→整值遮罩 ②>500 字元→截斷 ③值含敏感模式→局部遮罩。 */
export function maskPII(key: string, value: string): string {
  // 1. key 名稱敏感 → 整個值遮罩
  if (SENSITIVE_KEYS.test(key)) return '***MASKED***';

  // 2. 值太長（>500 字元）→ 截斷 + 標示原大小
  if (value.length > 500) {
    return value.slice(0, 100) + `... (${value.length} chars, truncated)`;
  }

  // 3. 值裡含敏感模式 → 局部遮罩（email / 卡號 / JWT）
  let masked = value;
  for (const pattern of SENSITIVE_VALUES) masked = masked.replace(pattern, '***');
  return masked;
}

function snapshotStorage(storage: Storage): StorageItem[] {
  const items: StorageItem[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    const rawValue = storage.getItem(key) || '';
    items.push({ key, size: rawValue.length, value: maskPII(key, rawValue) });
  }
  return items;
}

/** 收集 localStorage/sessionStorage（遮罩後）+ cookie 只留名稱（不留值）。 */
export function getStorageSnapshot(): StorageSnapshot {
  // storage 存取在跨源/隱私模式可能 throw（SecurityError）→ 各自兜住，缺一不影響其他
  let localItems: StorageItem[] = [];
  let sessionItems: StorageItem[] = [];
  try {
    localItems = snapshotStorage(window.localStorage);
  } catch {
    /* SecurityError / 停用 → 空 */
  }
  try {
    sessionItems = snapshotStorage(window.sessionStorage);
  } catch {
    /* SecurityError / 停用 → 空 */
  }
  // cookie 只留名稱（值可能含 session token，一律不上傳）；httpOnly cookie 本就讀不到
  const cookieNames = document.cookie
    ? document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean)
    : [];
  return {
    localStorage: localItems,
    sessionStorage: sessionItems,
    cookieCount: cookieNames.length,
    cookieNames,
  };
}
