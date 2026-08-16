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
const js = ts.transpileModule(sensitive + '\n' + readPage, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = dom.window;
const run = new Function('window', 'document', 'getComputedStyle', 'Node', 'NodeFilter', 'CSS',
  js + '\nreturn { extractPageContent, uniqueSelector, ownText, isSensitiveField };');
const api = run(g, g.document, g.getComputedStyle.bind(g), g.Node, g.NodeFilter, g.CSS);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
