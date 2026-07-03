// checkout.ts — PM-129：月費升級結帳跳板頁（擴充頁）
// 為何需要這頁：PM-129 把月費結帳從 GET /checkout?user_id 改成 POST /checkout（帶 session token，
// 不把 user_id 暴露在 URL）。POST + auth 無法直接 tabs.create 開分頁，故沿用日票的跳板做法：
// 這頁讀 session → POST 建單 → 取回綠界 auto-submit 表單 HTML → 自行 submit。
// （MV3 擴充頁 CSP 會擋掉綠界表單內嵌的 inline <script>，故不能靠它自動送出，改由本 bundle 手動 submit。）

import { API_BASE } from './types';
import { getAuthHeaders } from './auth';

const statusEl = document.getElementById('status');
function setStatus(msg: string): void {
  if (statusEl) statusEl.textContent = msg;
}

void (async () => {
  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    setStatus('請先在 BugEzy 登入後再升級付費版。');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/checkout`, {
      method: 'POST',
      headers,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = '建立訂閱訂單失敗，請稍後再試。';
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
