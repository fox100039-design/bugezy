// PM-438：部署後的線上驗收。抓 bugezy.dev 每一頁，檢查大黃蜂標記在、舊色碼不在、頁面沒被截斷。
//
// 為什麼需要這支：PM-438 上線時首頁是壞的 —— CSS 註解裡的反引號提前結束了 template literal，
// 頁面在中途斷掉。`tsc` 不報錯（後面成了 dead code）、`wrangler --dry-run` 也過、
// 280 條靜態斷言全綠，因為它們讀的都是「原始碼字串」，沒有人看過「這一頁真的長怎樣」。
// 靜態護欄補在 _verify403 的 ⑰，但**收在 </html> 這件事只有真的抓一次頁面才作得了數**。
//
//   用法：node server/_verify-live.mjs [base]   （預設 https://bugezy.dev）
const BASE = process.argv[2] || 'https://bugezy.dev';

const EMOJI = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{2600}-\u{26FF}]/u;
const KEEP = new Set(['→', '←', '·', '—', '–', '…']);
const onlyEmoji = (t) => [...t].filter((c) => EMOJI.test(c) && !KEEP.has(c));
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const DEAD = ['#0f0f1a', '#1a1a2e', '#2a2a3e', '#7c3aed', '#a78bfa', '#c4b5fd', '#8b8fa3',
  '#15152a', '#12121f', '#7ee0c5', '#238636', '#3fb950', '#f59e0b', '#161b22', '#21262d'];

// [路徑, 這頁一定要有的標記…]；'HEX_BULLET' 是共用內容樣式的指紋
const PAGES = [
  ['/', 'hz-nav', 'id="pricing"', '/hornet-real.png', 'sec-steps', 'sec-show', 'sec-langs', 'sec-end', 'hz-foot'],
  ['/features', 'hz-nav', 'hz-foot', 'HEX_BULLET'],
  ['/guide', 'hz-nav', 'quick-start'],
  ['/faq', 'hz-nav', 'faq-q'],
  ['/privacy', 'hz-nav', 'privacy-sec', 'hz-mark'],
  ['/skill', 'hz-nav', 'class="md"'],
  ['/changelog', 'hz-nav', 'cl-ver', 'cl-latest'],
  ['/blog', 'hz-nav', 'post-item', 'post-more'],
  ['/testimonials', 'hz-nav', 't-ava'],
  ['/feedback', 'hz-nav', 'form-row'],
  ['/day-pass-success', 'hexes', '24 小時無限使用'],
];

// 已知缺口：/reports 的外框（reportsShell）PM-432 換過了，但列表內容是 reportsPage() 畫的，
// 至今沒有任何一張卡碰過它 —— h1、刪除鈕、五顆狀態徽章還是 emoji。列出來但不算失敗，
// 要修是獨立一張卡（徽章要換成幾何圖示或文字標籤）。
const KNOWN_GAPS = [['/reports', 'reportsPage() 的列表內容還沒改版（h1／刪除鈕／五顆徽章仍是 emoji）']];

let bad = 0;
const rows = [];
for (const [path, ...marks] of PAGES) {
  const r = await fetch(BASE + path, { headers: { 'Accept-Language': 'zh-TW' } });
  const h = await r.text();
  const missing = marks.filter((m) => m !== 'HEX_BULLET' && !h.includes(m));
  if (marks.includes('HEX_BULLET') && !h.includes('clip-path:var(--hex)')) missing.push('六角樣式');
  // 🔴 這一條就是這支腳本存在的理由
  if (!h.trimEnd().endsWith('</html>')) missing.push('沒有收在</html>');
  const dead = DEAD.filter((c) => h.includes(c));
  const emoji = [...new Set(onlyEmoji(stripComments(h)))];
  rows.push([path, r.status, missing, dead, emoji, h.length]);
}

console.log(BASE);
console.log('-'.repeat(78));
for (const [path, status, missing, dead, emoji, len] of rows) {
  const ok = status === 200 && !missing.length && !dead.length && !emoji.length;
  if (!ok) bad++;
  console.log(
    (ok ? '  OK  ' : ' FAIL ') + path.padEnd(20) + status + '  ' +
    (missing.length ? '缺:' + missing.join(',') + ' ' : '') +
    (dead.length ? '舊色:' + dead.join(',') + ' ' : '') +
    (emoji.length ? 'emoji:' + emoji.join('') + ' ' : '') +
    (ok ? `(${len}b)` : ''));
}

for (const [path, why] of KNOWN_GAPS) {
  const r = await fetch(BASE + path, { headers: { 'Accept-Language': 'zh-TW' } });
  const h = await r.text();
  const emoji = [...new Set(onlyEmoji(stripComments(h)))];
  console.log(' GAP  ' + path.padEnd(20) + r.status + '  ' + why + (emoji.length ? '  ' + emoji.join('') : ''));
}

// 報告頁：殼是 server render，付費牆／找不到報告是 client 端畫的 → 查外部 JS
const rp = await fetch(BASE + '/report/aaaaaaaaaaaaaaaaaaaa');
const rpHtml = await rp.text();
const rpOk = rp.status === 200 && rpHtml.includes('topbar-hex') && rpHtml.trimEnd().endsWith('</html>')
  && !DEAD.some((c) => rpHtml.includes(c));
if (!rpOk) bad++;
console.log((rpOk ? '  OK  ' : ' FAIL ') + '/report/:id 殼'.padEnd(20) + rp.status +
  '  六角=' + rpHtml.includes('topbar-hex') + ' 收在</html>=' + rpHtml.trimEnd().endsWith('</html>'));

const jsUrl = (rpHtml.match(/\/report-page\.js\?v=\d+/) || ['/report-page.js'])[0];
const js = await fetch(BASE + jsUrl);
const jsSrc = await js.text();
const jsOk = js.status === 200 && ['renderNotFound', 'lock-shackle', 'nf-cell', 'shareSlot.appendChild']
  .every((m) => jsSrc.includes(m));
if (!jsOk) bad++;
console.log((jsOk ? '  OK  ' : ' FAIL ') + jsUrl.padEnd(20) + js.status +
  '  付費牆鎖頭=' + jsSrc.includes('lock-shackle') + ' 找不到報告=' + jsSrc.includes('nf-cell') +
  ' 分享卡搬家=' + jsSrc.includes('shareSlot.appendChild'));

const png = await fetch(BASE + '/hornet-real.png');
const pngLen = (await png.arrayBuffer()).byteLength;
const pngOk = png.status === 200 && png.headers.get('content-type') === 'image/png' && pngLen > 60000;
if (!pngOk) bad++;
console.log((pngOk ? '  OK  ' : ' FAIL ') + '/hornet-real.png'.padEnd(20) + png.status +
  '  ' + png.headers.get('content-type') + ' ' + pngLen + 'b');

console.log('-'.repeat(78));
console.log(bad === 0 ? '線上驗收：全部通過' : `線上驗收：${bad} 項未過`);
process.exit(bad === 0 ? 0 : 1);
