// day-pass-checkout.ts — PM-111：日票結帳跳板頁（擴充頁）
// 為何需要這頁：/api/day-pass/create 是 POST + 需 Authorization（不像月費 GET /checkout?user_id
// 能直接開分頁）。這頁讀 session → POST 建單 → 取回綠界 auto-submit 表單 HTML → 自行 submit。
// （MV3 擴充頁 CSP 會擋掉綠界表單內嵌的 inline <script>，故不能靠它自動送出，改由本 bundle 手動 submit。）

import { API_BASE, SESSION_KEY, type Session } from './types';

const statusEl = document.getElementById('status');
function setStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
}

void (async () => {
  const store = await chrome.storage.local.get(SESSION_KEY);
  const session = store[SESSION_KEY] as Session | undefined;
  if (!session?.session_token) {
    setStatus('請先在 BugEzy 登入後再購買日票。');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/day-pass/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.session_token}` },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = '建立日票訂單失敗，請稍後再試。';
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        /* 非 JSON 錯誤，用預設訊息 */
      }
      setStatus(msg);
      return;
    }
    // 回應是綠界 auto-submit 表單 HTML；innerHTML 不會執行內嵌 script（也被 CSP 擋），
    // 故解析出 form 後由本頁手動 submit（跨站 POST 到綠界，允許）。
    document.body.innerHTML = text;
    const form = document.getElementById('ecpay') as HTMLFormElement | null;
    if (form) form.submit();
    else setStatus('付款頁載入異常，請稍後再試。');
  } catch {
    setStatus('網路錯誤，請稍後再試。');
  }
})();
