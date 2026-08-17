// checkout.ts — PM-129：月費升級結帳跳板頁（擴充頁）
// 為何需要這頁：PM-129 把月費結帳從 GET /checkout?user_id 改成 POST /checkout（帶 session token，
// 不把 user_id 暴露在 URL）。POST + auth 無法直接 tabs.create 開分頁，故沿用日票的跳板做法：
// 這頁讀 session → POST 建單 → 取回綠界 auto-submit 表單 HTML → 自行 submit。
// （MV3 擴充頁 CSP 會擋掉綠界表單內嵌的 inline <script>，故不能靠它自動送出，改由本 bundle 手動 submit。）

import { API_BASE } from './types';
import { parseEcpayForm, submitEcpayForm } from './ecpay-form';
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
    // PM-378：回應是綠界 auto-submit 表單 HTML。**不再用 innerHTML** ——
    //   innerHTML 雖然不執行 <script>，但 `<img onerror>` 這類事件處理器不受 CSP script-src 限制，
    //   回應一旦被竄改就會執行。改為解析出 action／hidden 欄位後，用 createElement 重建表單。
    const ecpay = parseEcpayForm(text);
    if (ecpay) submitEcpayForm(ecpay);
    else setStatus('付款頁載入異常，請稍後再試。');
  } catch {
    setStatus('網路錯誤，請稍後再試。');
  }
})();
