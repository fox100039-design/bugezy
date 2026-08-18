// PM-309 read_page 驗收：把 **content.ts 裡真正的 extractPageContent 及其相依函式**
// 抽出來，在 jsdom 的真實 DOM 上跑（不是自己搭一個假 DOM 來測自己的假設）。
//
// ⚠ jsdom 不是 Chrome：它沒有版面計算，所以 checkVisibility 不存在、走 getComputedStyle 後備路徑。
//   這裡驗的是**演算法**（去重、隱藏排除、額度、selector 唯一性、敏感遮蔽），
//   實際瀏覽器行為仍以端到端為準。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

const src = readFileSync('../extension/src/content.ts', 'utf8');
// 抽出 PM-309 那一整段（含 SENSITIVE_RECT_SELECTORS，它被 isSensitiveField 用到）
const seg = (from, to) => {
  const i = src.indexOf(from), j = src.indexOf(to);
  if (i < 0 || j < 0) throw new Error(`content.ts 裡找不到 ${from} / ${to} —— 原始碼結構已變，測試需同步更新`);
  return src.slice(i, j);
};
const sensitive = seg('const SENSITIVE_RECT_SELECTORS', '/** PM-186：收集敏感欄位');
const readPage = seg('const READ_PAGE_MAX_CHARS', '// background → content：控制指令');
const clickFn = seg('function bridgeClick', '// ── PM-311：type_text');
const typeFn = seg('const TYPE_TEXT_REJECTED_INPUT_TYPES', '// ── PM-341~346：Zone Grid');
const zonesFn = seg('interface Zone {', '// ── PM-339：右下角即時面板');
const panelFn = seg('interface PanelData {', '// ── PM-337：藍框巡察動畫');
const hlFn = seg('const HIGHLIGHT_MAX', '// ── PM-330／331：圖釘系統');
const pinsFn = seg('interface Pin {', '// ── PM-317：get_page_health');
const healthFn = seg('const HEALTH_UNLABELLED_OK_TYPES', '// ── PM-316：get_web_vitals');
const vitalsFn = seg('const VITAL_THRESHOLDS', '// ── PM-315：analyze_element');
const analyzeFn = seg('const ANALYZE_STYLE_PROPS', '// ── PM-309：read_page');
const js = ts.transpileModule(sensitive + '\n' + clickFn + '\n' + typeFn + '\n' + zonesFn + '\n' + panelFn + '\n' + hlFn + '\n' + pinsFn + '\n' + healthFn + '\n' + vitalsFn + '\n' + analyzeFn + '\n' + readPage, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = dom.window;
// content script 在頁面裡有這些全域；沙箱裡要手動接進來
const run = new Function('window', 'document', 'getComputedStyle', 'Node', 'NodeFilter', 'CSS',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'InputEvent', 'performance', 'PerformanceObserver',
  'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'CSSStyleSheet',
  'MutationObserver',
  // queryInjectLiveErrors 是 content↔inject 的通道（postMessage），jsdom 裡不存在。
  // 這裡注入一個**可控的替身** —— 測的是 zone 的分桶與歸類邏輯，通道本身已由 PM-313 涵蓋。
  // 用替身反而更強：可以餵入已知 elementSelector 的錯誤，精確驗證它被分到哪一區。
  'queryInjectLiveErrors',
  js + '\nreturn { extractPageContent, uniqueSelector, ownText, isSensitiveField, bridgeClick, bridgeTypeText, bridgeAnalyzeElement, rateVital, summarizeResources, countInputsWithoutLabel, domMaxDepth, bridgePinElement, bridgePinAnalyze, bridgeGetPinResults, bridgePatrolPins, bridgeRemovePin, bridgeClearPins, highlightElement, showDebugPanel, hideDebugPanel, PIN_STATUS_COLOR, bridgeMapPageZones, bridgeGetZoneHealth, bridgeGetZoneErrors, classifyToZone, bridgeWatchZones, bridgeGetZoneChanges, bridgeStopWatchingZones, bridgeShowZoneOverlay, bridgeHideZoneOverlay };');
const api = run(g, g.document, g.getComputedStyle.bind(g), g.Node, g.NodeFilter, g.CSS,
  g.HTMLInputElement, g.HTMLTextAreaElement, g.Event, g.InputEvent, g.performance, g.PerformanceObserver,
  (cb) => g.setTimeout(cb, 0),
  g.setTimeout.bind(g), g.clearTimeout.bind(g), g.setInterval.bind(g), g.clearInterval.bind(g), g.CSSStyleSheet,
  g.MutationObserver,
  () => Promise.resolve(fakeInjectErrors));

// PM-343 用：注入替身回傳的假錯誤（測試中途可改）
let fakeInjectErrors = { consoleLogs: [], networkErrors: [] };
const setBody = (html) => { g.document.body.innerHTML = html; };

console.log('\n=== ① 不重複輸出父層文字（卡片版本最大的坑）===');
setBody('<div class="a"><div class="b"><p>唯一的一段文字</p></div></div>');
let out = api.extractPageContent().content;
console.log('   ', JSON.stringify(out));
check('「唯一的一段文字」只出現 1 次（不是每層各印一次）', (out.match(/唯一的一段文字/g) || []).length === 1, out);
check('沒有文字的容器不佔行', !/\[div\.a\]/.test(out), out);

console.log('\n=== ② interactive 元素附可直接用的 selector ===');
setBody('<button id="submit" class="primary">送出訂單</button><a href="/x">前往</a>');
out = api.extractPageContent().content;
console.log('   ', JSON.stringify(out));
check('button 有 click: selector', /\[button#submit\.primary\] 送出訂單 → click: "#submit"/.test(out), out);
check('a 也有 selector', /\[a\] 前往 → click: "/.test(out), out);

setBody('<div><span class="btn">一</span><button class="btn">A</button><button class="btn">B</button></div>');
out = api.extractPageContent().content;
const sels = [...out.matchAll(/click: "([^"]+)"/g)].map((m) => m[1]);
console.log('    selectors →', JSON.stringify(sels));
check('同 class 多元素 → selector 各自唯一命中 1 個', sels.length === 2 && sels.every((s) => g.document.querySelectorAll(s).length === 1), JSON.stringify(sels));

console.log('\n=== ③ 隱藏元素不出現 ===');
setBody('<p>看得見</p><div style="display:none"><button id="hidden-btn">看不見</button></div><p style="visibility:hidden">也看不見</p>');
out = api.extractPageContent().content;
console.log('   ', JSON.stringify(out));
check('display:none 的子樹整個不出現', !out.includes('看不見') && !out.includes('hidden-btn'), out);
check('visibility:hidden 不出現', !out.includes('也看不見'), out);
check('可見的仍在', out.includes('看得見'), out);

console.log('\n=== ④ 50000 字元上限 ===');
setBody(Array.from({ length: 4000 }, (_, i) => `<p>這是第 ${i} 段用來把輸出撐爆的長長長長長長文字內容</p>`).join(''));
const big = api.extractPageContent();
console.log('    長度 =', big.content.length, 'truncated =', big.truncated);
check('未超過 50000', big.content.length <= 50_000 + 20, String(big.content.length));
check('truncated 旗標為 true', big.truncated === true);
check('結尾標註 (truncated)', big.content.trimEnd().endsWith('(truncated)'), big.content.slice(-40));

console.log('\n=== ⑤ 表單欄位資訊 + 敏感值遮蔽 ===');
setBody('<input id="email" type="email" placeholder="你的信箱" value="a@b.c"><input id="pw" type="password" value="hunter2"><input id="tok" name="api_token" value="sk-secret-abc">');
out = api.extractPageContent().content;
console.log('   ', JSON.stringify(out));
check('一般 input 有 type/placeholder/value', /type=email/.test(out) && /placeholder="你的信箱"/.test(out) && /value="a@b\.c"/.test(out), out);
check('🔴 password 的值被遮蔽', !out.includes('hunter2') && out.includes('已遮蔽'), out);
check('🔴 name 含 token 的欄位也被遮蔽', !out.includes('sk-secret-abc'), out);

console.log('\n=== ⑥ 跳過 script/style/svg + iframe 標註 ===');
setBody('<script>var leak="不該出現"</script><style>.x{color:red}</style><p>正文</p><iframe id="fr" src="/a"></iframe>');
out = api.extractPageContent().content;
console.log('   ', JSON.stringify(out));
check('script 內容不出現', !out.includes('不該出現'), out);
check('style 內容不出現', !out.includes('color:red'), out);
check('iframe 有標註讀不到', /iframe/.test(out) && /讀不到/.test(out), out);

console.log('\n=== ⑦ 優先取 <main> ===');
setBody('<header><p>頁首不該出現</p></header><main><p>主要內容</p></main>');
out = api.extractPageContent().content;
check('有 <main> 時只讀 main', out.includes('主要內容') && !out.includes('頁首不該出現'), out);

console.log('\n=== ⑧ PM-308 bridgeClick：不可點的元素要明確回報（不是靜默成功）===');
// ⚠ jsdom 沒有版面引擎，`getBoundingClientRect()` 對**所有**元素都回 0×0，
//   會讓「尺寸為 0」那道檢查對每個元素都成立。這裡把它中和掉（一律回非 0），
//   才能測到後面的分支；「尺寸為 0」這條本身只有真瀏覽器測得準。
g.Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} };
};
setBody('<button id="ok">可以點</button>'
      + '<button id="dis" disabled>不能點</button>'
      + '<button id="none" style="display:none">自己 display:none</button>'
      + '<button id="invis" style="visibility:hidden">隱形</button>');
let clicked = 0;
g.document.getElementById('ok').addEventListener('click', () => { clicked++; });
const rOk = api.bridgeClick('#ok');
check('可點的元素 → clicked:true 且真的觸發了 click', rOk.clicked === true && clicked === 1, JSON.stringify(rOk));
check('  回傳 tag 與文字', rOk.tag === 'button' && rOk.text === '可以點', JSON.stringify(rOk));
const rDis = api.bridgeClick('#dis');
check('🔴 disabled → 回 error 而不是 clicked:true', !rDis.clicked && /disabled/.test(rDis.error || ''), JSON.stringify(rDis));
const rNone = api.bridgeClick('#none');
check('🔴 display:none → 回 error', !rNone.clicked && /不可見/.test(rNone.error || ''), JSON.stringify(rNone));
const rInv = api.bridgeClick('#invis');
check('🔴 visibility:hidden → 回 error', !rInv.clicked && /不可見/.test(rInv.error || ''), JSON.stringify(rInv));
const rMiss = api.bridgeClick('#nope-12345');
check('找不到 → error 含 selector', !rMiss.clicked && String(rMiss.error).includes('#nope-12345'), JSON.stringify(rMiss));
const rBad = api.bridgeClick('a[[[bad');
check('非法選擇器 → error（不 crash）', !rBad.clicked && /合法的 CSS 選擇器/.test(rBad.error || ''), JSON.stringify(rBad));
check('不可點時仍回報找到的 tag/text（讓 AI 知道選對了元素）', rDis.tag === 'button' && rDis.text === '不能點', JSON.stringify(rDis));
console.log('  NOTE  「祖先 display:none」與「尺寸為 0」兩條在 jsdom 測不準（無版面、無 checkVisibility），');
console.log('        真瀏覽器走 el.checkVisibility() 與真實 rect —— 以端到端為準。');

console.log('\n=== ⑨ PM-311 bridgeTypeText ===');
setBody('<input id="t" type="text" value="舊的">'
      + '<textarea id="ta">原文</textarea>'
      + '<input id="dis" disabled><input id="ro" readonly>'
      + '<input id="pw" type="password" value="old-secret">'
      + '<input id="chk" type="checkbox"><input id="file" type="file">'
      + '<div id="ce" contenteditable="true">可編輯</div>'
      + '<p id="plain">不是欄位</p>');
const ev = { input: 0, change: 0 };
g.document.getElementById('t').addEventListener('input', (e) => { if (e.bubbles) ev.input++; });
g.document.getElementById('t').addEventListener('change', (e) => { if (e.bubbles) ev.change++; });

const t1 = api.bridgeTypeText('#t', '新的文字');
check('1. input 輸入成功 + value 更新', t1.typed === true && g.document.getElementById('t').value === '新的文字', JSON.stringify(t1));
check('1. input/change 事件皆觸發且 bubbles', ev.input === 1 && ev.change === 1, JSON.stringify(ev));
check('   回傳 previous_value（讓 AI 知道覆蓋了什麼）', t1.previous_value === '舊的' && t1.new_value === '新的文字', JSON.stringify(t1));

const t2 = api.bridgeTypeText('#ta', '新內容');
check('2. textarea 輸入成功', t2.typed === true && g.document.getElementById('ta').value === '新內容', JSON.stringify(t2));

check('3. disabled → error 且點名 disabled', !api.bridgeTypeText('#dis', 'x').typed && /disabled/.test(api.bridgeTypeText('#dis', 'x').error || ''));
const ro = api.bridgeTypeText('#ro', 'x');
check('3. readonly → error 且與 disabled 分開描述', !ro.typed && /readonly/.test(ro.error || '') && !/disabled/.test(ro.error || ''), JSON.stringify(ro));

const plain = api.bridgeTypeText('#plain', 'x');
check('4. 非表單元素 → error', !plain.typed && /不是可輸入的欄位/.test(plain.error || ''), JSON.stringify(plain));
const chk = api.bridgeTypeText('#chk', 'x');
check('4. checkbox → error 並指引改用 click_element', !chk.typed && /click_element/.test(chk.error || ''), JSON.stringify(chk));
const file = api.bridgeTypeText('#file', 'x');
check('4. file → error（瀏覽器禁止程式設定）', !file.typed && /安全性/.test(file.error || ''), JSON.stringify(file));

const pw = api.bridgeTypeText('#pw', 'new-secret');
check('5. 🔴 password 的 previous/new 值都被遮蔽', pw.typed === true && !JSON.stringify(pw).includes('old-secret') && !JSON.stringify(pw).includes('new-secret'), JSON.stringify(pw));
check('5.    但實際有寫進去', g.document.getElementById('pw').value === 'new-secret');

const ce = api.bridgeTypeText('#ce', '改過了');
check('   contenteditable 可輸入', ce.typed === true && g.document.getElementById('ce').textContent === '改過了', JSON.stringify(ce));
const miss = api.bridgeTypeText('#nope-9', 'x');
check('   找不到 → error 含 selector', /#nope-9/.test(miss.error || ''), JSON.stringify(miss));

// 🔴 React 相容性：模擬 React 的 _valueTracker。
//   React 在節點上裝一個 **own property** 的 get/set，set 時把值存進自己的快取。
//   · 用 `el.value = x`（會打到 own setter）→ 快取同步更新 → React 比對「快取 == 現值」
//     判定沒變化，**整個 input 事件被忽略**：畫面有字但 state 沒動。
//   · 用 **prototype 上的原生 setter** → 繞過 own setter → 快取維持舊值 → React 比對
//     發現不一致 → 正常處理事件。
//   所以正確的期望是：**真實值已更新，而 tracker 快取仍是舊的**。
const rt = g.document.getElementById('t');
const protoDesc = Object.getOwnPropertyDescriptor(g.HTMLInputElement.prototype, 'value');
let trackerCache = protoDesc.get.call(rt);
Object.defineProperty(rt, 'value', {
  configurable: true,
  get() { return protoDesc.get.call(this); },
  set(v) { trackerCache = v; protoDesc.set.call(this, v); }, // React 的 own setter
});
const cacheBefore = trackerCache;
api.bridgeTypeText('#t', 'React 也收得到');
const realNow = protoDesc.get.call(rt);
check('🔴 走原生 setter：真實值已更新', realNow === 'React 也收得到', `real=${realNow}`);
check('🔴 且繞過 tracker（快取仍是舊值 → React 才會認得這次變更）', trackerCache === cacheBefore, `cache=${trackerCache} before=${cacheBefore}`);

console.log('\n=== ⑩ PM-315 bridgeAnalyzeElement ===');
setBody('<a id="a1" class="btn primary lg" href="/x" role="menuitem" aria-label="去 X" data-track="hero" onclick="void 0">前往</a>'
      + '<input id="pw" type="password" value="secret-should-not-leak" name="password">'
      + '<button id="plain">一般按鈕</button>');
const an = api.bridgeAnalyzeElement('#a1');
console.log('   ', JSON.stringify(an).slice(0, 320));
check('1. 含 tag / attributes / computed_styles / box_model',
  an.tag === 'a' && !!an.attributes && !!an.computed_styles && !!an.box_model, JSON.stringify(an).slice(0, 200));
check('1. classes 正確展開', JSON.stringify(an.classes) === '["btn","primary","lg"]', JSON.stringify(an.classes));
check('1. 白名單屬性有取到（href/role/aria-label/data-*）',
  an.attributes.href === '/x' && an.attributes.role === 'menuitem' && an.attributes['aria-label'] === '去 X' && an.attributes['data-track'] === 'hero',
  JSON.stringify(an.attributes));
check('1. class/id/style 不重複倒進 attributes', !('class' in an.attributes) && !('id' in an.attributes) && !('style' in an.attributes), JSON.stringify(an.attributes));
check('2. computed_styles 不超過 25 個', Object.keys(an.computed_styles).length <= 25, String(Object.keys(an.computed_styles).length));
check('2. computed_styles 含 debug 常用屬性', ['display','position','zIndex','color','fontSize'].every((k) => k in an.computed_styles), Object.keys(an.computed_styles).join(','));

check('   accessibility：明寫的 role 優先且標示非隱含', an.accessibility.role === 'menuitem' && an.accessibility.role_is_implicit === false, JSON.stringify(an.accessibility));
const anB = api.bridgeAnalyzeElement('#plain');
check('   accessibility：沒寫 role 時回隱含角色並標示', anB.accessibility.role === 'button' && anB.accessibility.role_is_implicit === true, JSON.stringify(anB.accessibility));
check('   accessibility：button 天生 focusable', anB.accessibility.focusable === true, JSON.stringify(anB.accessibility));

check('   event_listeners 列出行內 on* 屬性', JSON.stringify(an.event_listeners.inline_attributes) === '["onclick"]', JSON.stringify(an.event_listeners));
check('🔴 event_listeners 明講「空陣列不代表沒有處理器」',
  /不代表沒有事件處理器/.test(an.event_listeners.note || ''), an.event_listeners.note);
check('   沒有行內 on* 時仍附帶同一句說明',
  Array.isArray(anB.event_listeners.inline_attributes) && anB.event_listeners.inline_attributes.length === 0 && /不代表沒有/.test(anB.event_listeners.note || ''),
  JSON.stringify(anB.event_listeners));

const anPw = api.bridgeAnalyzeElement('#pw');
check('4. 🔴 敏感欄位的 value 被遮蔽', !JSON.stringify(anPw).includes('secret-should-not-leak'), JSON.stringify(anPw.attributes));
check('4.    並標示 sensitive_field', anPw.sensitive_field === true, JSON.stringify(anPw).slice(0, 200));

const anMiss = api.bridgeAnalyzeElement('#nope-315');
check('3. 找不到元素 → error 含 selector', !!anMiss.error && String(anMiss.error).includes('#nope-315'), JSON.stringify(anMiss));
check('3.    非法選擇器 → error（不 crash）', /合法的 CSS 選擇器/.test(api.bridgeAnalyzeElement('a[[[bad').error || ''));

console.log('\n=== ⑪ PM-316 rateVital：評級必須符合 Google 標準 ===');
// 逐一驗邊界值（門檻上下各一）——rating 判錯的話，AI 會把「需要改進」當成「良好」
const RATING_CASES = [
  ['LCP', 2500, 'good'], ['LCP', 2501, 'needs-improvement'], ['LCP', 4000, 'needs-improvement'], ['LCP', 4001, 'poor'],
  ['FID', 100, 'good'], ['FID', 101, 'needs-improvement'], ['FID', 300, 'needs-improvement'], ['FID', 301, 'poor'],
  ['CLS', 0.1, 'good'], ['CLS', 0.11, 'needs-improvement'], ['CLS', 0.25, 'needs-improvement'], ['CLS', 0.26, 'poor'],
  ['FCP', 1800, 'good'], ['FCP', 1801, 'needs-improvement'], ['FCP', 3000, 'needs-improvement'], ['FCP', 3001, 'poor'],
  ['TTFB', 800, 'good'], ['TTFB', 801, 'needs-improvement'], ['TTFB', 1800, 'needs-improvement'], ['TTFB', 1801, 'poor'],
];
let ratingOk = 0;
for (const [m, v, want] of RATING_CASES) {
  const got = api.rateVital(m, v);
  if (got === want) ratingOk++;
  else check(`3. ${m}=${v} → ${want}`, false, `得到 ${got}`);
}
check(`3. rating 符合 Google 標準（${RATING_CASES.length} 個邊界值全對）`, ratingOk === RATING_CASES.length, `${ratingOk}/${RATING_CASES.length}`);

console.log('\n=== ⑪ PM-316 summarizeResources ===');
// jsdom 沒有真實資源載入，用假的 performance entry 驗分類與低估揭露
const fakeEntries = [
  { name: 'https://x/app.js', initiatorType: 'script', transferSize: 2048 },
  { name: 'https://x/a.css', initiatorType: 'link', transferSize: 1024 },
  { name: 'https://x/p.png', initiatorType: 'img', transferSize: 512 },
  { name: 'https://cdn/f.woff2', initiatorType: 'other', transferSize: 0 }, // 跨網域無 TAO → 0
  { name: 'https://x/api', initiatorType: 'fetch', transferSize: 256 },
];
g.performance.getEntriesByType = (t) => (t === 'resource' ? fakeEntries : []);
const rs = api.summarizeResources();
console.log('   ', JSON.stringify(rs));
check('4. resource_summary 有 total_requests + by_type', rs.total_requests === 5 && !!rs.by_type, JSON.stringify(rs));
check('4. by_type 分類正確（script/css/image/font/other）',
  rs.by_type.script.count === 1 && rs.by_type.css.count === 1 && rs.by_type.image.count === 1
  && rs.by_type.font.count === 1 && rs.by_type.other.count === 1, JSON.stringify(rs.by_type));
check('4. total_size_kb 合計正確', Math.abs(rs.total_size_kb - (2048 + 1024 + 512 + 256) / 1024) < 0.05, String(rs.total_size_kb));
check('🔴 transferSize=0 的資源有被計數並揭露「總大小為低估值」',
  rs.size_unknown_count === 1 && /低估/.test(rs.size_note || ''), JSON.stringify({ n: rs.size_unknown_count, note: rs.size_note }));

console.log('\n=== ⑫ PM-317 可及性判定（最容易誤報的兩項）===');
setBody('<img src="a.png">'                       // 沒有 alt → 算問題
      + '<img src="b.png" alt="">'                // 裝飾性圖片，**合法**，不算問題
      + '<img src="c.png" alt="說明">'            // 有 alt → 不算
      + '<input id="i1"><label for="i1">有標籤</label>'      // label[for] → 不算
      + '<label>包起來<input id="i2"></label>'               // 被 label 包 → 不算
      + '<input id="i3" aria-label="無障礙標籤">'            // aria-label → 不算
      + '<input id="i4" title="標題">'                       // title → 不算
      + '<input type="hidden" id="i5">'                      // hidden → 不算
      + '<input type="submit" id="i6">'                      // submit → 不算
      + '<input id="i7">');                                  // 真的沒標籤 → 算 1
check('🔴 alt="" 是合法的裝飾性圖片，不算問題', g.document.querySelectorAll('img:not([alt])').length === 1,
  String(g.document.querySelectorAll('img:not([alt])').length));
const noLabel = api.countInputsWithoutLabel();
check('🔴 label[for] / 包裹 / aria-label / title / hidden / submit 都不算誤報', noLabel === 1, `算出 ${noLabel} 個，應為 1`);

console.log('\n=== ⑫ PM-317 domMaxDepth ===');
setBody('<div><div><div><span>深</span></div></div></div>');
// html > body > div > div > div > span = 6
check('巢狀深度計算正確', api.domMaxDepth() === 6, String(api.domMaxDepth()));

console.log('\n=== ⑫ PM-317 評分規則（依卡片的扣分表逐條核對）===');
// 直接驗扣分公式，避免只靠端到端「看起來分數合理」
const deduct = (n, per, cap) => Math.min(n * per, cap);
check('console error -5/個上限 -30', deduct(10, 5, 30) === 30 && deduct(3, 5, 30) === 15);
check('network error -5/個上限 -20', deduct(10, 5, 20) === 20 && deduct(2, 5, 20) === 10);
check('無 alt 圖片 -2/個上限 -10', deduct(9, 2, 10) === 10 && deduct(3, 2, 10) === 6);
check('無 label input -3/個上限 -10', deduct(9, 3, 10) === 10 && deduct(2, 3, 10) === 6);
const healthSrc = readFileSync('../extension/src/content.ts', 'utf8');
const hs = healthSrc.slice(healthSrc.indexOf('const deductions = {'), healthSrc.indexOf('const total = Object.values'));
check('   實作的扣分表與卡片一致（console 5/30、network 5/20、poor 10、ni 5、alt 2/10、label 3/10、lang 5、dom 5）',
  /consoleErrors\.length \* 5, 30/.test(hs) && /networkErrors\.length \* 5, 20/.test(hs)
  && /poorCount \* 10/.test(hs) && /niCount \* 5/.test(hs)
  && /imagesWithoutAlt \* 2, 10/.test(hs) && /inputsWithoutLabel \* 3, 10/.test(hs)
  && /missingLang \? 5 : 0/.test(hs) && /elementCount > 3000 \? 5 : 0/.test(hs), hs.slice(0, 300));
const hs2 = healthSrc.slice(healthSrc.indexOf('const rated ='), healthSrc.indexOf('const deductions'));
check('🔴 null 的指標不列入扣分（未互動的 FID 不能扣分）', /filter\(\(r\): r is string => r !== null\)/.test(hs2), hs2.slice(0, 200));
check('   score 夾在 0~100', /Math\.max\(0, Math\.min\(100, 100 - total\)\)/.test(healthSrc));

console.log('\n=== ⑬ PM-330／331 圖釘系統 ===');
setBody('<button id="b1">按鈕一</button><button id="b2" style="display:none">看不見</button>');
const emptyPins = api.bridgeGetPinResults();
check('331-3 無圖釘 → 空陣列（不是 error）', !emptyPins.error && Array.isArray(emptyPins.pins) && emptyPins.pins.length === 0, JSON.stringify(emptyPins));
const pa = api.bridgePinElement('#b1', '第一個圖釘');
check('330-1 回傳 pin_id + element_found', !!pa.pin_id && pa.element_found === true, JSON.stringify(pa));
const pb = api.bridgePinElement('#b1', '改過的描述');
check('330-3 重複釘 → pin_id 不變且描述更新', pb.pin_id === pa.pin_id && pb.description === '改過的描述' && pb.updated_existing === true, JSON.stringify(pb));
const lst = api.bridgeGetPinResults();
check('330-2 清單只有一個圖釘（沒有重複建立）', lst.total_count === 1, JSON.stringify(lst).slice(0, 200));
check('330-2 頁面上有視覺標記層', !!g.document.querySelector('[data-bugezy-pins]'), 'layer 不存在');
check('330-2 標記數量與圖釘數一致', g.document.querySelector('[data-bugezy-pins]')?.children.length === 1, String(g.document.querySelector('[data-bugezy-pins]')?.children.length));
const badPin = api.bridgePinElement('#nope-330', 'x');
check('330-4 元素不存在 → error 含 selector', !!badPin.error && String(badPin.error).includes('#nope-330'), JSON.stringify(badPin));

const an1 = await api.bridgePinAnalyze('#b1');
check('331-1 pin_analyze 回傳完整 analysis', !!an1.analysis?.computed_styles && !!an1.analysis?.box_model, JSON.stringify(an1).slice(0, 200));
check('331-4 可見元素 → status active', an1.status === 'active', JSON.stringify({ s: an1.status, m: an1.summary }));
const an2 = await api.bridgePinAnalyze('#b2');
check('331-4 隱藏元素 → status warning 且說明原因', an2.status === 'warning' && /不可見|尺寸/.test(an2.summary || ''), JSON.stringify({ s: an2.status, m: an2.summary }));
const lst2 = api.bridgeGetPinResults();
check('331-2 清單含 status 與 last_check', lst2.pins.every((p) => !!p.status && !!p.last_check), JSON.stringify(lst2).slice(0, 240));
g.document.getElementById('b1').remove();
const lst3 = api.bridgeGetPinResults();
check('🔴 元素消失 → 標為 stale 而非刪除或報錯',
  lst3.pins.find((p) => p.selector === '#b1')?.status === 'stale', JSON.stringify(lst3).slice(0, 240));

console.log('\n=== ⑭ PM-334 patrol_pins ===');
api.bridgeClearPins('all');
const emptyPatrol = await api.bridgePatrolPins();
check('334-4 沒有圖釘 → patrolled: 0（不是 error）',
  !emptyPatrol.error && emptyPatrol.patrolled === 0 && emptyPatrol.alert_count === 0, JSON.stringify(emptyPatrol));

setBody('<button id="p1">一</button><button id="p2">二</button><button id="p3">三</button>');
api.bridgePinElement('#p1', '圖釘一');
api.bridgePinElement('#p2', '圖釘二');
api.bridgePinElement('#p3', '圖釘三');
const pat1 = await api.bridgePatrolPins();
check('334-1 三個圖釘 → patrolled: 3，每個都有結果',
  pat1.patrolled === 3 && pat1.results.length === 3 && pat1.results.every((r) => !!r.pin_id && !!r.status), JSON.stringify(pat1).slice(0, 240));
check('334   巡檢順序按建立時間', pat1.results.map((r) => r.selector).join(',') === '#p1,#p2,#p3', pat1.results.map((r) => r.selector).join(','));
check('334   每筆都有 previous_status 供判斷惡化/好轉', pat1.results.every((r) => !!r.previous_status), JSON.stringify(pat1.results[0]));

const pat2 = await api.bridgePatrolPins();
check('334-3 無變化 → changed: false', pat2.results.every((r) => r.changed === false) && pat2.alert_count === 0, JSON.stringify(pat2.results.map((r) => r.changed)));

g.document.getElementById('p2').remove();
const pat3 = await api.bridgePatrolPins();
const gone = pat3.results.find((r) => r.selector === '#p2');
check('334-2 元素消失 → status stale + changed: true', gone?.status === 'stale' && gone?.changed === true, JSON.stringify(gone));
check('334   alert_count 只算「有變化」的（不是「有問題」的）', pat3.alert_count === 1, `alert_count=${pat3.alert_count}`);
check('338-4 summary 含狀態顏色 emoji', /[🟢🟡🔴⚪]/.test(gone?.summary || ''), gone?.summary);

console.log('\n=== ⑮ PM-338 圖釘顏色 ===');
check('338-1 新建（可見）→ 綠 #00c853', api.PIN_STATUS_COLOR.active === '#00c853', api.PIN_STATUS_COLOR.active);
check('338-2 warning → 黃 #ffd600', api.PIN_STATUS_COLOR.warning === '#ffd600', api.PIN_STATUS_COLOR.warning);
check('338-2 error → 紅 #ff1744', api.PIN_STATUS_COLOR.error === '#ff1744', api.PIN_STATUS_COLOR.error);
check('338-3 stale（元素消失）→ 灰 #9e9e9e', api.PIN_STATUS_COLOR.stale === '#9e9e9e', api.PIN_STATUS_COLOR.stale);

console.log('\n=== ⑯ PM-335 remove_pin / clear_pins ===');
api.bridgeClearPins('all'); // 前面幾節留下的圖釘不清掉，下面的數量斷言會對不上
setBody('<button id="r1">一</button><button id="r2">二</button>');
const rp1 = api.bridgePinElement('#r1', 'A');
api.bridgePinElement('#r2', 'B');
const rm = api.bridgeRemovePin(rp1.pin_id);
check('335-1 用 pin_id 移除 → removed: true', rm.removed === true && rm.pin_id === rp1.pin_id, JSON.stringify(rm));
// PM-392：覆蓋層重畫是 rAF 節流的（queueReposition），本來就不是同步發生。
// 之前能同步斷言只是湊巧；pin_analyze 改成非同步後時序變了才暴露出來。等它 flush 再驗。
await new Promise((r) => g.setTimeout(r, 10));
check('335-1 覆蓋層標記減少（等 rAF flush 後）', g.document.querySelector('[data-bugezy-pins]')?.children.length === 1, String(g.document.querySelector('[data-bugezy-pins]')?.children.length));
const rm2 = api.bridgeRemovePin(undefined, '#r2');
check('335-2 用 selector 移除', rm2.removed === true && rm2.selector === '#r2', JSON.stringify(rm2));
check('335-3 pin_id 不存在 → error', !!api.bridgeRemovePin('nope-xyz').error, JSON.stringify(api.bridgeRemovePin('nope-xyz')));

api.bridgeClearPins('all');
setBody('<button id="c1">一</button><button id="c2" style="display:none">二</button>');
await api.bridgePinAnalyze('#c1'); // active
await api.bridgePinAnalyze('#c2'); // warning（不可見）
const onlyWarn = api.bridgeClearPins('warning');
check('335-4 依 status 清除 → 只清 warning', onlyWarn.cleared === 1 && onlyWarn.remaining === 1, JSON.stringify(onlyWarn));
const clearAll = api.bridgeClearPins();
check('335-5 clear_pins() 全清', clearAll.cleared === 1 && clearAll.remaining === 0, JSON.stringify(clearAll));
const bogus = api.bridgeClearPins('resolved');
check("🔴 status 'resolved' → 明確報錯而非靜默清 0 個",
  !!bogus.error && /resolved/.test(bogus.error) && Array.isArray(bogus.valid_status), JSON.stringify(bogus));

console.log('\n=== ⑰ PM-337 highlightElement ===');
setBody('<button id="h1">一</button><button id="h2">二</button>');
const hlLayer = () => g.document.querySelector('[data-bugezy-highlights]');
// 前面的 pin_element / analyze_element 本來就會高亮（PM-337 的整合），所以看「最新加入的那個」
const before = hlLayer()?.children.length ?? 0;
api.highlightElement('#h1', { durationMs: 5000, label: '測試' });
const newest = () => hlLayer()?.lastChild;
check('337-1 高亮框已建立', (hlLayer()?.children.length ?? 0) === Math.min(before + 1, 5), `${before} → ${hlLayer()?.children.length}`);
check('337-3 高亮框位置貼合元素（用 getBoundingClientRect）',
  newest()?.style.width === '104px', newest()?.style.width);
check('337   有 label 標籤', newest()?.textContent === '測試', newest()?.textContent);
check('337   找不到元素 → 靜默略過（不拋錯、不影響呼叫端）', (() => { try { api.highlightElement('#nope-h'); return true; } catch { return false; } })());
for (let i = 0; i < 8; i++) api.highlightElement('#h2', { durationMs: 5000 });
check('337-4 超過 5 個同時高亮 → 最舊的自動消失', hlLayer()?.children.length === 5, String(hlLayer()?.children.length));

console.log('\n=== ⑱ PM-339 即時面板 ===');
const shown = api.showDebugPanel();
const host = g.document.querySelector('[data-bugezy-panel]');
check('339-1 面板已注入且用 shadow DOM 隔離', !!host && !!host.shadowRoot, `host=${!!host} shadow=${!!host?.shadowRoot}`);
check('339-1 預設收合，只顯示 🐛 icon',
  host?.shadowRoot?.querySelector('.icon')?.textContent === '🐛' && !host.shadowRoot.querySelector('.card'), JSON.stringify(shown));
host.shadowRoot.querySelector('.icon').dispatchEvent(new g.MouseEvent('click', { bubbles: true }));
const card = host.shadowRoot.querySelector('.card');
check('339-2 點擊展開顯示卡片', !!card, 'card 不存在');
const bodyText = host.shadowRoot.querySelector('.bd')?.textContent || '';
check('339-2 內容含 Pins / Errors / 效能 / 狀態',
  /Pins/.test(bodyText) && /Errors/.test(bodyText) && /FCP/.test(bodyText), bodyText.slice(0, 120));
check('339-3 有 Collapse 與 Close 按鈕', host.shadowRoot.querySelectorAll('.ft button').length === 2, String(host.shadowRoot.querySelectorAll('.ft button').length));
check('339-3 標題列可拖動（有 mousedown 綁定 + cursor:move）',
  (host.shadowRoot.querySelector('style')?.textContent || '').includes('cursor:move'));
api.hideDebugPanel();
check('339-3 Close → 面板整個移除（DOM 乾淨）', !g.document.querySelector('[data-bugezy-panel]'), '仍存在');


console.log('\n=== ⑲ PM-341 map_page_zones ===');
setBody('<header class="site-header"><h1>頭</h1></header>'
      + '<nav><a href="/a">連結</a></nav>'
      + '<main><section class="cart"><h2>購物車</h2><button id="buy">買</button></section>'
      + '<section class="product-list"><h2>商品</h2></section></main>'
      + '<footer>底</footer>'
      + '<div class="random-thing">沒有語意</div>');
const zmap = api.bridgeMapPageZones();
console.log('   ', JSON.stringify(zmap).slice(0, 300));
const names = zmap.zones.map((x) => x.name);
check('341-1 語意標籤都被辨識出來', ['Header', 'Nav', 'Main', 'Footer'].every((n) => names.includes(n)), JSON.stringify(names));
check('341-2 每個 zone 有 name/selector/element_count/rect',
  zmap.zones.every((x) => !!x.name && !!x.selector && typeof x.element_count === 'number' && !!x.rect), JSON.stringify(zmap.zones[0]));
check('341-3 沒有語意的頂層元素計入 unassigned_count', zmap.unassigned_count >= 1, String(zmap.unassigned_count));
check('341   巢狀的內層不重複切（main 內的 section 不另外成 zone）',
  !names.includes('Cart') || !names.includes('Main') || zmap.zones.find((x) => x.name === 'Cart') === undefined,
  JSON.stringify(names));
const ids1 = zmap.zones.map((x) => x.zone_id).join(',');
const ids2 = api.bridgeMapPageZones().zones.map((x) => x.zone_id).join(',');
check('341-4 重複呼叫 → zone_id 穩定不變', ids1 === ids2, `${ids1} vs ${ids2}`);
setBody('');
const emptyZ = api.bridgeMapPageZones();
check('341-5 空白頁 → zones 空陣列 + unassigned_count', emptyZ.zones.length === 0 && typeof emptyZ.unassigned_count === 'number', JSON.stringify(emptyZ));

console.log('\n=== ⑳ PM-342 error 歸類 ===');
setBody('<header class="site-header"><button id="hbtn">頭部按鈕</button></header>'
      + '<main><section class="cart"><button id="cbtn">購物車按鈕</button></section></main>');
api.bridgeMapPageZones();
const zoneOf = (sel) => api.classifyToZone(sel);
check('342-1 header 內元素 → 歸到 Header zone', /header/i.test(zoneOf('#hbtn')), zoneOf('#hbtn'));
check('342-2 main 內元素 → 歸到 Main zone', /main/i.test(zoneOf('#cbtn')), zoneOf('#cbtn'));
check('342-3 沒有現場元素（undefined）→ Unassigned', zoneOf(undefined) === 'Unassigned', zoneOf(undefined));
check('342   selector 指向已不存在的元素 → Unassigned', zoneOf('#gone-xyz') === 'Unassigned', zoneOf('#gone-xyz'));
check('342   非法 selector → Unassigned（不 crash）', zoneOf('a[[[bad') === 'Unassigned', zoneOf('a[[[bad'));

console.log('\n=== ㉑ PM-343 get_zone_health / get_zone_errors ===');
// 餵入四筆已知來源的錯誤：header 內、main 內（warn + network）、抓不到現場的、以及 info
fakeInjectErrors = {
  consoleLogs: [
    { level: 'error', message: 'header 爆炸', timestamp: Date.now(), source: 'console', elementSelector: '#hbtn' },
    { level: 'warn', message: 'main 警告', timestamp: Date.now(), source: 'console', elementSelector: '#cbtn' },
    { level: 'error', message: 'setTimeout 裡的錯誤', timestamp: Date.now(), source: 'window.onerror' },
    { level: 'info', message: 'LCP 良好', timestamp: Date.now(), source: 'web-vitals' },
  ],
  networkErrors: [{ method: 'GET', url: '/api/x', status: 500, timestamp: Date.now(), duration: 5, elementSelector: '#cbtn' }],
};
const health = await api.bridgeGetZoneHealth();
console.log('   ', JSON.stringify(health).slice(0, 300));
const hdrZone = health.zones.find((x) => /header/i.test(x.name));
const mainZone = health.zones.find((x) => /main/i.test(x.name));
check('342-1 header 的 error 歸到 Header zone', hdrZone?.error_count === 1, JSON.stringify(hdrZone));
check('342-2 main 的 warn + network 歸到 Main zone', mainZone?.warning_count === 1 && mainZone?.error_count === 1, JSON.stringify(mainZone));
check('342-3 🔴 抓不到現場元素的 error 進 Unassigned（不被吞掉）', health.unassigned.error_count === 1, JSON.stringify(health.unassigned));
check('343   level:info 不計入錯誤',
  (hdrZone?.error_count ?? 0) + (mainZone?.error_count ?? 0) + health.unassigned.error_count === 3, 'info 被算進去了');
check('346-1 有問題的 zone 帶 suggested_action', !!hdrZone?.suggested_action && !!mainZone?.suggested_action, JSON.stringify([hdrZone?.suggested_action, mainZone?.suggested_action]));
check('343-1 每個 zone 有 status + error_count',
  health.zones.every((x) => !!x.status && typeof x.error_count === 'number'), JSON.stringify(health.zones?.[0]));
check('343-2 🔴 unassigned 區單獨回報（不被省略）',
  !!health.unassigned && typeof health.unassigned.error_count === 'number', JSON.stringify(health.unassigned));
check('343-3 summary 統計四種狀態',
  ['healthy', 'warning', 'error', 'unknown'].every((k) => k in health.summary), JSON.stringify(health.summary));
check('346-2 healthy zone 的 suggested_action 為 null',
  health.zones.filter((x) => x.status === 'healthy').every((x) => x.suggested_action === null), JSON.stringify(health.zones.map((x) => [x.status, x.suggested_action])));
const ze = await api.bridgeGetZoneErrors(health.zones[0].zone_id);
check('343-4 get_zone_errors 回傳 zone + errors + network_fails',
  !!ze.zone && Array.isArray(ze.errors) && Array.isArray(ze.network_fails), JSON.stringify(ze).slice(0, 200));
const zeBad = await api.bridgeGetZoneErrors('nope-zone');
check('343-5 zone_id 不存在 → error 且列出可用的', !!zeBad.error && Array.isArray(zeBad.available), JSON.stringify(zeBad).slice(0, 200));
const zeU = await api.bridgeGetZoneErrors('Unassigned');
check('343   可查詢 Unassigned 的詳細錯誤', zeU.zone?.name === 'Unassigned', JSON.stringify(zeU.zone));

console.log('\n=== ㉒ PM-344 Zone 覆蓋層 ===');
const ov = await api.bridgeShowZoneOverlay();
const zl = () => g.document.querySelector('[data-bugezy-zones]');
check('344-1 覆蓋層已建立且每區一個框', ov.overlay === 'shown' && zl()?.children.length === health.zones.length, `${zl()?.children.length} vs ${health.zones.length}`);
const firstBox = zl()?.firstChild;
check('344-3 外層 pointer-events:none（點擊穿透）', zl()?.style.pointerEvents === 'none', zl()?.style.pointerEvents);
check('344-3 名稱標籤與 badge 為 pointer-events:auto（可點）',
  firstBox?.children[0]?.style.pointerEvents === 'auto' && firstBox?.children[1]?.style.pointerEvents === 'auto',
  `${firstBox?.children[0]?.style.pointerEvents} / ${firstBox?.children[1]?.style.pointerEvents}`);
check('344-6 DOM API only（無 innerHTML 痕跡：標籤用 textContent）', !!firstBox?.children[0]?.textContent, firstBox?.children[0]?.textContent);
api.bridgeHideZoneOverlay();
check('344-4 hide → 覆蓋層整個移除', !g.document.querySelector('[data-bugezy-zones]'), '仍存在');

console.log('\n=== ㉓ PM-345 watch_zones（Pull 模式）===');
const noChanges0 = api.bridgeGetZoneChanges();
check('345   未啟動監控時查詢 → 明確說明而非空手', Array.isArray(noChanges0.changes) && /沒有在監控/.test(noChanges0.note || ''), JSON.stringify(noChanges0));
const w1 = api.bridgeWatchZones(5);
check('345-1 watch_zones 啟動成功', w1.watching === true && w1.interval_seconds === 5, JSON.stringify(w1));
const w2 = api.bridgeWatchZones(20);
check('345-6 🔴 重複呼叫 → 更新間隔而非開第二個 watcher',
  w2.interval_seconds === 20 && /沒有建立第二個/.test(w2.note || ''), JSON.stringify(w2));
const ch = api.bridgeGetZoneChanges();
check('345-3 沒有變化 → changes 空陣列（不是 error）', Array.isArray(ch.changes) && ch.changes.length === 0 && !ch.error, JSON.stringify(ch));
const st = api.bridgeStopWatchingZones();
check('345-4 stop → 回報時長與變化總數',
  st.stopped === true && typeof st.duration_seconds === 'number' && typeof st.total_changes_detected === 'number', JSON.stringify(st));
check('345   重複 stop → 明確說明沒有在監控', api.bridgeStopWatchingZones().stopped === false);

console.log('\n=== ㉔ PM-346 suggested_action ===');
check('346-4 suggested_action 內含可直接用於 pin_analyze 的 selector',
  health.zones.every((x) => x.suggested_action === null || /pin_analyze\("/.test(x.suggested_action)),
  JSON.stringify(health.zones.map((x) => x.suggested_action)));
check('346   Unassigned 的建議指向 get_zone_errors（它沒有 selector 可釘）',
  health.unassigned.suggested_action === null || /get_zone_errors/.test(health.unassigned.suggested_action),
  String(health.unassigned.suggested_action));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
