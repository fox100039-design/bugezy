// day-pass-checkout.ts — PM-111：日票結帳跳板頁（擴充頁）
// 為何需要這頁：/api/day-pass/create 是 POST + 需 Authorization（無法直接開分頁）。
// 這頁讀 session token → POST 建單 → 取回綠界 auto-submit 表單 HTML → 自行 submit。
// （月費結帳同理走 checkout.html，PM-129 後兩者都是 POST + session token。）
// （MV3 擴充頁 CSP 會擋掉綠界表單內嵌的 inline <script>，故不能靠它自動送出，改由本 bundle 手動 submit。）

import { API_BASE } from './types';
import { parseEcpayForm, submitEcpayForm } from './ecpay-form';
import { getAuthHeaders } from './auth';

const statusEl = document.getElementById('status');
/**
 * 寫入畫面上的說明列。
 *
 * PM-425：這支函式的**每一個呼叫點都是失敗路徑**（未登入／建單失敗／回應異常／網路錯誤）——
 * 成功時是直接 submit 綠界表單離開這一頁，不會走到這裡。所以「setStatus 被呼叫過」
 * 等同「這次沒成功」，順手在 body 掛一個 `failed` 讓 CSS 收掉「還在進行中」的那些元素
 * （三個脈衝六角、掃描進度條、"正在建立…" 標題），改秀警示三角。
 *
 * 沒有這一行的話，畫面會一邊跑進度條說「正在建立訂單」、一邊在下面寫「網路錯誤」，
 * 比改版前（整頁只有一句錯誤訊息）更難懂。
 * ⚠ 這只是換一個 class，沒有動到任何控制流程、事件綁定或 ECPay 跳轉邏輯。
 */
function setStatus(msg: string): void {
  document.body.classList.add('failed');
  if (statusEl) statusEl.textContent = msg;
}

void (async () => {
  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    setStatus('請先在 BugEzy 登入後再購買日票。');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/day-pass/create`, {
      method: 'POST',
      headers,
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
