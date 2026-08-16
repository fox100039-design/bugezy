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
const typeFn = seg('const TYPE_TEXT_REJECTED_INPUT_TYPES', '// ── PM-316：get_web_vitals');
const vitalsFn = seg('const VITAL_THRESHOLDS', '// ── PM-315：analyze_element');
const analyzeFn = seg('const ANALYZE_STYLE_PROPS', '// ── PM-309：read_page');
const js = ts.transpileModule(sensitive + '\n' + clickFn + '\n' + typeFn + '\n' + vitalsFn + '\n' + analyzeFn + '\n' + readPage, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = dom.window;
// content script 在頁面裡有這些全域；沙箱裡要手動接進來
const run = new Function('window', 'document', 'getComputedStyle', 'Node', 'NodeFilter', 'CSS',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'InputEvent', 'performance', 'PerformanceObserver',
  js + '\nreturn { extractPageContent, uniqueSelector, ownText, isSensitiveField, bridgeClick, bridgeTypeText, bridgeAnalyzeElement, rateVital, summarizeResources };');
const api = run(g, g.document, g.getComputedStyle.bind(g), g.Node, g.NodeFilter, g.CSS,
  g.HTMLInputElement, g.HTMLTextAreaElement, g.Event, g.InputEvent, g.performance, g.PerformanceObserver);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
