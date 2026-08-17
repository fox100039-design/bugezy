// PM-378：把綠界回應的 auto-submit 表單「重建」成本地 DOM，而不是 innerHTML 塞進頁面。
//
// 原本是 `document.body.innerHTML = serverResponse`。就算 `<script>` 不會被 innerHTML 執行、
// 就算擴充頁面的 CSP 會擋 —— **`<img onerror>` 這類事件處理器不受 CSP script-src 限制**，
// 只要回應內容被竄改（中間人、或 server 端有注入點）就會執行。
// 這裡改為：解析 → **只挑出真正需要的東西**（action、method、hidden 欄位）→ 用 createElement 重建。
// 任何屬性、任何事件處理器、任何多餘的節點都不會被帶進來。

export interface EcpayForm {
  action: string;
  method: string;
  fields: Array<{ name: string; value: string }>;
}

/**
 * 從綠界回應中抽出表單資料。**只讀取，不建立任何節點到頁面上。**
 * 用 `DOMParser` 解析：它產生的是與本頁隔離的 document，
 * 其中的 script 不會執行、img 不會發請求（不在 render tree 裡）。
 */
export function parseEcpayForm(html: string): EcpayForm | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  const form = (doc.getElementById('ecpay') as HTMLFormElement | null) ?? doc.querySelector('form');
  if (!form) return null;

  const action = form.getAttribute('action') ?? '';
  // 只接受 https 的綠界網域 —— 表單是要帶著訂單資料 POST 出去的，
  // 目的地被換掉就等於把使用者的訂單資訊送給別人。
  if (!/^https:\/\/([\w-]+\.)*ecpay\.com\.tw(\/|$)/i.test(action)) return null;

  const fields: Array<{ name: string; value: string }> = [];
  for (const el of Array.from(form.querySelectorAll('input'))) {
    const name = el.getAttribute('name');
    if (!name) continue;
    fields.push({ name, value: el.getAttribute('value') ?? '' });
  }
  if (fields.length === 0) return null;

  return {
    action,
    method: (form.getAttribute('method') || 'post').toLowerCase() === 'get' ? 'get' : 'post',
    fields,
  };
}

/**
 * 用 DOM API 重建表單並送出。
 * 建出來的每一個節點都是這裡自己 `createElement` 的，**沒有任何屬性來自回應內容**
 * （name/value 只以 `value` property 設定，不會變成可執行的屬性）。
 */
export function submitEcpayForm(data: EcpayForm): void {
  const form = document.createElement('form');
  form.action = data.action;
  form.method = data.method;
  for (const f of data.fields) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = f.name;
    input.value = f.value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
