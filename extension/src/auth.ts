// auth.ts — PM-129：統一 API 認證 header
// 所有對 server 的 API 呼叫都經 getAuthHeaders() 帶 Authorization。
// 優先用 DB 驗證的 session token（SESSION_TOKEN_KEY，POST /api/auth/session 換取）；
// 過渡期若尚未換取（舊登入 session），退回舊的 base64 session_token（server 端 PM-128 仍支援 fallback）。

import { SESSION_KEY, SESSION_TOKEN_KEY, type Session } from './types';

/** 統一的 API 認證 header（含 Content-Type）。未登入則不帶 Authorization。 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const store = await chrome.storage.local.get([SESSION_TOKEN_KEY, SESSION_KEY]);
  const token =
    (store[SESSION_TOKEN_KEY] as string | undefined) ||
    (store[SESSION_KEY] as Session | undefined)?.session_token; // 過渡：退回舊 base64
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
