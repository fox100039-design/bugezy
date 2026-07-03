// auth.ts — 統一 API 認證 header
// 所有對 server 的 API 呼叫都經 getAuthHeaders() 帶 Authorization。
// PM-133：只用 DB 驗證的 session token（SESSION_TOKEN_KEY，POST /api/auth/session 換取）。
// base64 fallback 已完全移除（server 端也不再接受）——舊 token 失效者由 popup 靜默續期或手動重登。

import { SESSION_TOKEN_KEY } from './types';

/** 統一的 API 認證 header（含 Content-Type）。未登入則不帶 Authorization。 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const store = await chrome.storage.local.get(SESSION_TOKEN_KEY);
  const token = store[SESSION_TOKEN_KEY] as string | undefined;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
