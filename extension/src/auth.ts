// auth.ts — 統一 API 認證 header
// 所有對 server 的 API 呼叫都經 getAuthHeaders() 帶 Authorization。
// PM-133：只用 DB 驗證的 session token（SESSION_TOKEN_KEY，POST /api/auth/session 換取）。
// base64 fallback 已完全移除（server 端也不再接受）——舊 token 失效者由 popup 靜默續期或手動重登。

import { SESSION_TOKEN_KEY } from './types';

/** 取原始 session token（未登入回 undefined）。 */
export async function getAuthToken(): Promise<string | undefined> {
  const store = await chrome.storage.local.get(SESSION_TOKEN_KEY);
  return store[SESSION_TOKEN_KEY] as string | undefined;
}

/** 統一的 API 認證 header（含 Content-Type）。未登入則不帶 Authorization。 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 只回 Authorization header（不含 Content-Type）——給 multipart/FormData 用，
 *  否則手動設 Content-Type 會蓋掉瀏覽器自動加的 multipart boundary（PM-135 transcribe）。 */
export async function getAuthHeaderOnly(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** PM-166（Fable5）：敏感操作（如取消訂閱）後 server 會 rotate token 並回 new_session_token。
 *  收到就存入 storage 更新——舊 token 已在 server 端失效，之後 API 一律用新 token。 */
export async function applyRotatedToken(data: unknown): Promise<void> {
  const newToken = (data as { new_session_token?: string } | null)?.new_session_token;
  if (newToken && typeof newToken === 'string') {
    await chrome.storage.local.set({ [SESSION_TOKEN_KEY]: newToken });
  }
}
