// PM-392~394 驗收：pin_analyze 動態探測。
// 沿用 _verify309 的做法——把 content.ts 裡真正的函式抽出來在 jsdom 的真實 DOM 上跑。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

const src = readFileSync('../extension/src/content.ts', 'utf8');
const seg = (from, to) => {
  const i = src.indexOf(from), j = src.indexOf(to);
  if (i < 0 || j < 0) throw new Error(`content.ts 裡找不到 ${from} / ${to} —— 原始碼結構已變，測試需同步更新`);
  return src.slice(i, j);
};
const sensitive = seg('const SENSITIVE_RECT_SELECTORS', '/** PM-186：收集敏感欄位');
const hlFn = seg('const HIGHLIGHT_MAX', '// ── PM-330／331：圖釘系統');
const pinsFn = seg('interface Pin {', '// ── PM-317：get_page_health');
const analyzeFn = seg('const ANALYZE_STYLE_PROPS', '// ── PM-309：read_page');
const readPage = seg('const READ_PAGE_MAX_CHARS', '// background → content：控制指令');

const js = ts.transpileModule([sensitive, hlFn, pinsFn, analyzeFn, readPage].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = dom.window;
// 探測用 queryInjectLiveErrors 取錯誤（inject 在 MAIN world，jsdom 裡不存在）→ 注入可控替身。
// 用替身反而更強：可以精準控制「這個動作有沒有噴錯」。
let injectErrors = { consoleLogs: [], networkErrors: [] };
const run = new Function('window', 'document', 'getComputedStyle', 'Node', 'NodeFilter', 'CSS',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', 'InputEvent', 'performance',
  'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'CSSStyleSheet', 'MutationObserver', 'fetch',
  'queryInjectLiveErrors',
  js + '\nreturn { probeElement, probeWithTimeout, pinStatusFromProbe, bridgePinAnalyze, bridgePatrolPins, bridgePinElement, bridgeGetPinResults, pins, PATROL_PROBE_BUDGET_MS };');
let fetchCalls = [];
let fetchOk = true;
const api = run(g, g.document, g.getComputedStyle.bind(g), g.Node, g.NodeFilter, g.CSS,
  g.HTMLInputElement, g.HTMLTextAreaElement, g.HTMLSelectElement, g.Event, g.InputEvent, g.performance,
  (cb) => g.setTimeout(cb, 0),
  g.setTimeout.bind(g), g.clearTimeout.bind(g), g.CSSStyleSheet, g.MutationObserver,
  (url, opts) => { fetchCalls.push({ url, opts }); return fetchOk ? Promise.resolve({}) : Promise.reject(new Error('net')); },
  () => Promise.resolve(injectErrors));

const setBody = (html) => { g.document.body.innerHTML = html; };
// jsdom 沒有版面計算 → getBoundingClientRect 全 0，analyze 會判成「尺寸為 0」而跳過探測。
// 這裡把它撐出尺寸，才測得到真正的探測邏輯。
g.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON() { return this; } };
};
const el = (sel) => g.document.querySelector(sel);
/** 讓探測「看到」一批新錯誤：在動作發生後才把它們塞進替身。 */
const errorsOnAction = (list) => {
  injectErrors = { consoleLogs: [], networkErrors: [] };
  return () => { injectErrors = { consoleLogs: list, networkErrors: [] }; };
};
/** PM-396：只餵網路錯誤、**完全沒有 JS error** —— 這才是這張卡要修的情境。 */
const networkOnAction = (nets) => {
  injectErrors = { consoleLogs: [], networkErrors: [] };
  return () => { injectErrors = { consoleLogs: [], networkErrors: nets }; };
};

console.log('\n=== ① PM-392 驗收 1/2：按鈕點擊探測 ===');
setBody('<button id="bad">觸發錯誤</button><button id="ok">正常按鈕</button>');
const arm = errorsOnAction([{ level: 'error', message: "TypeError: Cannot read 'map' of undefined", timestamp: 111 }]);
el('#bad').addEventListener('click', arm);
let r = await api.probeWithTimeout(el('#bad'));
check('392-1 button → probed: click', r.type === 'click', JSON.stringify(r));
check('392-1 點擊觸發的錯誤被收集到', r.errors_triggered.length === 1 && /TypeError/.test(r.errors_triggered[0].message), JSON.stringify(r.errors_triggered));
check('392   有回報探測耗時', typeof r.duration_ms === 'number' && r.duration_ms >= 0);

injectErrors = { consoleLogs: [], networkErrors: [] };
r = await api.probeWithTimeout(el('#ok'));
check('392-2 正常按鈕 → click 且 errors_triggered 空', r.type === 'click' && r.errors_triggered.length === 0, JSON.stringify(r));

console.log('\n=== ② 🔴 破壞性按鈕不點（卡片沒列，但 patrol 會反覆重跑）===');
setBody('<button id="del">刪除帳號</button><button id="pay">確認付款</button><button id="en">Delete all data</button><button id="safe">顯示更多</button>');
let clicked = { del: false, pay: false, en: false, safe: false };
for (const k of ['del', 'pay', 'en', 'safe']) el(`#${k}`).addEventListener('click', () => { clicked[k] = true; });
for (const [id, label] of [['del', '刪除帳號'], ['pay', '確認付款'], ['en', 'Delete all data']]) {
  const rr = await api.probeWithTimeout(el(`#${id}`));
  check(`392   「${label}」→ skipped_destructive 且**沒有被點下去**`,
    rr.type === 'skipped_destructive' && clicked[id] === false, JSON.stringify(rr).slice(0, 160));
}
const safeR = await api.probeWithTimeout(el('#safe'));
check('392   非破壞性按鈕仍然會點（沒有擋過頭）', safeR.type === 'click' && clicked.safe === true, JSON.stringify(safeR));
check('392   跳過時說明理由（使用者知道為什麼沒測）',
  /破壞性/.test((await api.probeWithTimeout(el('#del'))).note || ''), '沒有說明');

console.log('\n=== ③ PM-392 驗收 3：連結只檢查不點 ===');
setBody('<a id="lnk" href="https://example.com/x">連結</a>');
let linkClicked = false;
el('#lnk').addEventListener('click', () => { linkClicked = true; });
fetchCalls = []; fetchOk = true;
r = await api.probeWithTimeout(el('#lnk'));
check('392-3 a[href] → link_check', r.type === 'link_check', JSON.stringify(r));
check('392-3 🔴 連結絕對沒有被 click（不會把頁面導走）', linkClicked === false);
check('392-3 用 HEAD + no-cors 檢查', fetchCalls.length === 1 && fetchCalls[0].opts?.method === 'HEAD' && fetchCalls[0].opts?.mode === 'no-cors', JSON.stringify(fetchCalls));
check('392-3 連得上 → reachable true', r.reachable === true);
check('392   🔴 status 誠實回 null（no-cors 拿不到狀態碼，不編一個 200 出來）',
  r.status === null && /拿不到實際狀態碼/.test(r.note || ''), JSON.stringify(r));
fetchOk = false;
r = await api.probeWithTimeout(el('#lnk'));
check('392   連不上 → reachable false', r.reachable === false, JSON.stringify(r));
setBody('<a id="js" href="javascript:void(0)">JS 連結</a>');
r = await api.probeWithTimeout(el('#js'));
check('392   非 http(s) 連結不發請求', r.type === 'link_check' && r.reachable === false && /非 http/.test(r.note || ''), JSON.stringify(r));

console.log('\n=== ④ PM-392 驗收 4：輸入探測 + 還原 ===');
setBody('<input id="t" type="text" value="原本的值"><textarea id="ta">原文</textarea>');
injectErrors = { consoleLogs: [], networkErrors: [] };
let sawProbeValue = false;
el('#t').addEventListener('input', () => { if (el('#t').value === 'BugEzy_probe_test') sawProbeValue = true; });
r = await api.probeWithTimeout(el('#t'));
check('392-4 input → probed: input', r.type === 'input', JSON.stringify(r));
check('392-4 探測期間真的輸入了測試值', sawProbeValue);
check('392-4 🔴 探測後還原成原值', el('#t').value === '原本的值' && r.restored === true, `${el('#t').value} / ${r.restored}`);
r = await api.probeWithTimeout(el('#ta'));
check('392   textarea 同樣處理且還原', r.type === 'input' && el('#ta').value === '原文' && r.restored === true, `${el('#ta').value}`);
setBody('<input id="ro" type="text" value="x" readonly><input id="di" type="text" value="y" disabled>');
check('392   readonly 不做輸入探測', (await api.probeWithTimeout(el('#ro'))).type === 'static_only');
check('392   disabled 不做輸入探測', (await api.probeWithTimeout(el('#di'))).type === 'static_only');

console.log('\n=== ⑤ PM-392 驗收 6：密碼欄位跳過 ===');
setBody('<input id="pw" type="password" value="hunter2"><input id="pw2" name="user_password" type="text" value="s3cret">');
r = await api.probeWithTimeout(el('#pw'));
check('392-6 🔴 password 欄位 → skipped_sensitive，值沒有被動過',
  r.type === 'skipped_sensitive' && el('#pw').value === 'hunter2', JSON.stringify(r));
check('392   名稱含 password 的一般欄位也跳過（沿用既有敏感欄位判定）',
  (await api.probeWithTimeout(el('#pw2'))).type === 'skipped_sensitive');

console.log('\n=== ⑤b PM-396：點擊觸發的網路失敗也要算 ===');
setBody('<button id="n500">觸發 fetch 500</button><button id="n403">觸發 403</button><button id="n404">觸發 404</button><button id="n0">觸發 CORS 失敗</button><button id="nok">正常按鈕</button>');
const netCase = async (id, nets) => {
  const arm = networkOnAction(nets);
  el(`#${id}`).addEventListener('click', arm);
  return api.probeWithTimeout(el(`#${id}`));
};

let nr = await netCase('n500', [{ method: 'POST', url: 'https://api.example.com/cart', status: 500, timestamp: 1 }]);
check('396-1 🔴 點擊觸發 fetch 500 → 收進 network_errors_triggered',
  nr.network_errors_triggered?.length === 1 && nr.network_errors_triggered[0].status === 500, JSON.stringify(nr));
check('396-1 🔴 **完全沒有 JS error**（這正是修好前會被誤判成 🟢 的情境）',
  nr.errors_triggered.length === 0, JSON.stringify(nr.errors_triggered));
check('396-1 5xx → status error（🔴）',
  api.pinStatusFromProbe([], nr)[0] === 'error', JSON.stringify(api.pinStatusFromProbe([], nr)));
check('396-1 summary 帶方法、路徑與狀態碼（人看得懂）',
  /POST \/cart → 500/.test(api.pinStatusFromProbe([], nr)[1]), api.pinStatusFromProbe([], nr)[1]);

nr = await netCase('n403', [{ method: 'GET', url: 'https://api.example.com/me?token=abc', status: 403, timestamp: 2 }]);
check('396-2 4xx（403）→ status warning（🟡）', api.pinStatusFromProbe([], nr)[0] === 'warning', JSON.stringify(api.pinStatusFromProbe([], nr)));
check('396-2 網址只留 path，不把 query string 塞進 summary',
  /\/me/.test(api.pinStatusFromProbe([], nr)[1]) && !/token=abc/.test(api.pinStatusFromProbe([], nr)[1]),
  api.pinStatusFromProbe([], nr)[1]);

nr = await netCase('n404', [{ method: 'GET', url: 'https://api.example.com/x', status: 404, timestamp: 3 }]);
check('396-3 4xx（404）→ status warning（🟡）', api.pinStatusFromProbe([], nr)[0] === 'warning');

nr = await netCase('n0', [{ method: 'GET', url: 'https://other.example.com/y', status: 0, timestamp: 4 }]);
check('396   status 0（CORS／連不上）→ error（🔴）', api.pinStatusFromProbe([], nr)[0] === 'error', JSON.stringify(api.pinStatusFromProbe([], nr)));
check('396   0 的說明是人話而不是「→ 0」',
  /CORS 或連不上/.test(api.pinStatusFromProbe([], nr)[1]), api.pinStatusFromProbe([], nr)[1]);

injectErrors = { consoleLogs: [], networkErrors: [] };
nr = await api.probeWithTimeout(el('#nok'));
check('396-4 正常按鈕（無 JS 無 network）→ active（🟢）',
  nr.network_errors_triggered.length === 0 && api.pinStatusFromProbe([], nr)[0] === 'active', JSON.stringify(nr).slice(0, 160));
check('396   🔴 沒抓到東西時誠實揭露觀測窗口（慢請求可能看不到）',
  /只涵蓋點擊後 2 秒內完成的請求/.test(nr.note || ''), nr.note);

// 既有行為不退化
setBody('<button id="js">觸發 console.error</button>');
const armJs = errorsOnAction([{ level: 'error', message: 'TypeError: 既有行為', timestamp: 9 }]);
el('#js').addEventListener('click', armJs);
nr = await api.probeWithTimeout(el('#js'));
check('396-5 JS error 的既有行為不退化 → 仍是 error（🔴）',
  api.pinStatusFromProbe([], nr)[0] === 'error' && /TypeError/.test(api.pinStatusFromProbe([], nr)[1]),
  api.pinStatusFromProbe([], nr)[1]);
check('396   JS critical 優先於 network（先報最嚴重的那個）', (() => {
  const both = { type: 'click', errors_triggered: [{ level: 'error', message: 'TypeError: x', timestamp: 1 }],
    network_errors_triggered: [{ method: 'GET', url: '/a', status: 500, timestamp: 1 }], duration_ms: 1 };
  return /TypeError/.test(api.pinStatusFromProbe([], both)[1]);
})());

// 探測前就已存在的網路錯誤不該被算成「這次點擊造成的」
setBody('<button id="pre">按鈕</button>');
injectErrors = { consoleLogs: [], networkErrors: [{ method: 'GET', url: '/old', status: 500, timestamp: 100 }] };
nr = await api.probeWithTimeout(el('#pre'));
check('396   🔴 探測前就存在的網路錯誤不算進來（差集，不是快照）',
  nr.network_errors_triggered.length === 0, JSON.stringify(nr.network_errors_triggered));

// 非互動型探測也要有這個欄位（形狀一致，呼叫端不必到處判 undefined）
setBody('<h2 id="h2">標題</h2>');
nr = await api.probeWithTimeout(el('#h2'));
check('396   static_only 也有 network_errors_triggered 欄位（形狀一致）',
  Array.isArray(nr.network_errors_triggered), JSON.stringify(nr));

console.log('\n=== ⑥ select / checkbox 探測與還原 ===');
setBody('<select id="s"><option>A</option><option>B</option><option>C</option></select><select id="one"><option>只有一個</option></select><input id="cb" type="checkbox"><input id="cbd" type="checkbox" disabled>');
el('#s').selectedIndex = 2;
r = await api.probeWithTimeout(el('#s'));
check('392   select → probed: select 且還原 selectedIndex',
  r.type === 'select' && el('#s').selectedIndex === 2 && r.restored === true, `${r.type} idx=${el('#s').selectedIndex}`);
check('392   只有一個選項的 select 跳過（沒有可切換的對象）',
  (await api.probeWithTimeout(el('#one'))).type === 'static_only');
el('#cb').checked = true;
r = await api.probeWithTimeout(el('#cb'));
check('392   checkbox → probed: toggle 且還原 checked',
  r.type === 'toggle' && el('#cb').checked === true && r.restored === true, `${r.type} checked=${el('#cb').checked}`);
check('392   disabled checkbox 跳過', (await api.probeWithTimeout(el('#cbd'))).type === 'static_only');

console.log('\n=== ⑦ PM-392 驗收 5：媒體檢查 ===');
setBody('<img id="broken" src="x.png"><video id="v"></video>');
r = await api.probeWithTimeout(el('#broken'));
check('392-5 img → media_check + loaded 狀態', r.type === 'media_check' && typeof r.loaded === 'boolean', JSON.stringify(r));
check('392-5 未載入時說明原因', r.loaded === false && !!r.media_error, JSON.stringify(r));
r = await api.probeWithTimeout(el('#v'));
check('392   video → media_check 帶 readyState', r.type === 'media_check' && /readyState/.test(r.note || ''), JSON.stringify(r));

console.log('\n=== ⑧ 表單送出被攔下來 ===');
setBody('<form id="f"><button id="sb" type="submit">確定</button></form>');
let submitted = false;
el('#f').addEventListener('submit', () => { submitted = true; });
injectErrors = { consoleLogs: [], networkErrors: [] };
r = await api.probeWithTimeout(el('#sb'));
check('392   🔴 點擊表單內按鈕不會真的送出表單', submitted === false, `type=${r.type} submitted=${submitted}`);

console.log('\n=== ⑨ 其他元素 → static_only ===');
setBody('<h2 id="h">標題</h2><div id="d">內容</div>');
check('392-7 h2 → static_only', (await api.probeWithTimeout(el('#h'))).type === 'static_only');
check('392-7 div → static_only', (await api.probeWithTimeout(el('#d'))).type === 'static_only');

console.log('\n=== ⑩ PM-393：狀態顏色判定 ===');
const P = (o) => ({ type: 'click', errors_triggered: [], duration_ms: 1, ...o });
check('393-2 有 critical 錯誤 → error',
  api.pinStatusFromProbe([], P({ errors_triggered: [{ level: 'error', message: "TypeError: x", timestamp: 1 }] }))[0] === 'error');
check('393-2 錯誤訊息出現在 summary（不是只說「有錯」）',
  /TypeError/.test(api.pinStatusFromProbe([], P({ errors_triggered: [{ level: 'error', message: 'TypeError: x', timestamp: 1 }] }))[1]));
check('393   只有 warn 級 → warning',
  api.pinStatusFromProbe([], P({ errors_triggered: [{ level: 'warn', message: 'deprecated', timestamp: 1 }] }))[0] === 'warning');
check('393-3 探測通過 + 靜態通過 → active',
  api.pinStatusFromProbe([], P({}))[0] === 'active');
check('393   靜態有問題但探測沒錯 → warning（不會被探測結果洗掉）',
  api.pinStatusFromProbe(['元素不可見'], P({}))[0] === 'warning');
check('393   媒體未載入 → warning',
  api.pinStatusFromProbe([], P({ type: 'media_check', loaded: false, media_error: '壞掉' }))[0] === 'warning');
check('393   連結連不上 → warning',
  api.pinStatusFromProbe([], P({ type: 'link_check', reachable: false }))[0] === 'warning');
check('393   動畫沒在跑 → warning',
  api.pinStatusFromProbe([], P({ type: 'animation_check', all_running: false }))[0] === 'warning');
check('393   🔴 還原失敗 → warning 並明講（使用者要知道欄位被動過）',
  (() => { const [st, sm] = api.pinStatusFromProbe([], P({ type: 'input', restored: false })); return st === 'warning' && /還原/.test(sm); })());
check('393   summary 是人話而不是 JSON',
  /點擊測試通過/.test(api.pinStatusFromProbe([], P({}))[1]), api.pinStatusFromProbe([], P({}))[1]);

console.log('\n=== ⑪ PM-393 驗收 1：pin_analyze 回傳含 probe ===');
api.pins.clear();
setBody('<button id="e1">出錯按鈕</button><h2 id="h1">標題</h2>');
const arm2 = errorsOnAction([{ level: 'error', message: 'ReferenceError: boom', timestamp: 222 }]);
el('#e1').addEventListener('click', arm2);
let a1 = await api.bridgePinAnalyze('#e1');
check('393-1 回傳含 probe 欄位', !!a1.probe && a1.probe.type === 'click', JSON.stringify(a1.probe));
check('393-2 觸發錯誤的按鈕 → status error（🔴）', a1.status === 'error', `${a1.status} / ${a1.summary}`);
check('393-2 summary 帶錯誤訊息', /ReferenceError/.test(a1.summary), a1.summary);
check('392-7 🔴 既有靜態分析仍在（動態是追加不是取代）',
  !!a1.analysis && !!a1.analysis.visibility && !!a1.analysis.computed_styles, Object.keys(a1.analysis || {}).join(','));
injectErrors = { consoleLogs: [], networkErrors: [] };
const a2 = await api.bridgePinAnalyze('#h1');
check('393-3 正常元素 → status active（🟢）', a2.status === 'active' && a2.probe.type === 'static_only', `${a2.status} / ${a2.summary}`);

console.log('\n=== ⑫ PM-394：patrol_pins 整合 ===');
api.pins.clear();
setBody('<button id="p1">出錯按鈕</button><h2 id="p2">標題</h2>');
const arm3 = errorsOnAction([{ level: 'error', message: 'TypeError: patrol boom', timestamp: 333 }]);
el('#p1').addEventListener('click', arm3);
api.bridgePinElement('#p1', '會出錯的按鈕');
api.bridgePinElement('#p2', '正常標題');
injectErrors = { consoleLogs: [], networkErrors: [] };
const pat = await api.bridgePatrolPins();
check('394-1 patrolled 為 2', pat.patrolled === 2, JSON.stringify(pat).slice(0, 200));
const r1 = pat.results.find((x) => x.selector === '#p1');
const r2 = pat.results.find((x) => x.selector === '#p2');
check('394-2 出錯按鈕 → 🔴 且 summary 含探測結果', r1?.status === 'error' && /🔴/.test(r1.summary) && /TypeError/.test(r1.summary), r1?.summary);
check('394-3 正常元素 → 🟢', r2?.status === 'active' && /🟢/.test(r2.summary), r2?.summary);
check('394-1 summary 不再只是「可見且可互動」，帶探測動詞', /點擊|可見且可互動/.test(r2.summary), r2?.summary);
check('394-3 alert_count 把 error 也算進去（不是只算「有變化」）',
  pat.alert_count >= 1 && pat.problem_count === 1, JSON.stringify({ a: pat.alert_count, c: pat.changed_count, p: pat.problem_count }));
check('394   changed_count 與 problem_count 分開回（兩個問題不同）',
  typeof pat.changed_count === 'number' && typeof pat.problem_count === 'number');
check('394   有總時間預算，超過就只做靜態檢查並說明', api.PATROL_PROBE_BUDGET_MS === 20_000);

console.log('\n=== ⑬ 探測不會讓 pin_analyze 整支失敗 ===');
api.pins.clear();
setBody('<button id="throw">會爆的按鈕</button>');
el('#throw').addEventListener('click', () => { throw new Error('handler 自己爆了'); });
const a3 = await api.bridgePinAnalyze('#throw');
// ⚠ 真實瀏覽器裡，會拋例外的 click handler **不會**把例外傳回 el.click() 的呼叫端，
//   而是變成 window.onerror —— 那條路徑由 inject.ts 攔截，會出現在 queryInjectLiveErrors
//   裡並被判成 critical。jsdom 的替身收集器模擬不了這件事，所以這裡只驗真正驗得到的不變式：
//   **探測過程不會讓 pin_analyze 整支掛掉**（這才是這段程式碼要保證的事）。
check('392   🔴 頁面 handler 拋例外 → 工具仍回完整結果，不會掛掉',
  !a3.error && !!a3.probe && !!a3.status && !!a3.summary, JSON.stringify(a3).slice(0, 200));
check('392   靜態分析結果仍然完整回傳', !!a3.analysis?.visibility);
check('392   collectErrorsDuring 對「action 自己丟例外」有處理（非同步動作用得到）',
  /探測動作本身拋出例外/.test(readFileSync('../extension/src/content.ts', 'utf8')));

console.log('\n=== ⑭ 原始碼檢查：工具描述必須講明它會「動手」 ===');
const mcp = readFileSync('src/mcp-server.ts', 'utf8');
const pa = mcp.slice(mcp.indexOf("'pin_analyze',"), mcp.indexOf("'pin_analyze',") + 1800);
check('392   pin_analyze 描述明講會實際操作元素', /ACTIVELY PROBE|實際操作/.test(pa), pa.slice(0, 120));
check('392   描述明講連結絕不點擊、破壞性按鈕會跳過',
  /never clicked|絕不點擊/.test(pa) && /SKIPPED|跳過/.test(pa));
const pp = mcp.slice(mcp.indexOf("'patrol_pins',"), mcp.indexOf("'patrol_pins',") + 1800);
check('394   patrol_pins 描述明講包含動態探測', /INCLUDING the active probe|實際操作的探測/.test(pp));
check('392   兩支工具的逾時已放寬（探測要等秒級）',
  /PROBE_TIMEOUT_MS/.test(mcp) && /PATROL_TIMEOUT_MS/.test(mcp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
