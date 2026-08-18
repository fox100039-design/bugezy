// PM-383~387 驗收：手動釘選模式。
// 沿用 _verify309 的做法——**把 content.ts 裡真正的函式抽出來在 jsdom 的真實 DOM 上跑**，
// 不自己搭一個假 DOM 測自己的假設。popup 側沒有 DOM 可跑，用原始碼靜態檢查。
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
// 這一段自 PM-383 起同時含圖釘系統與釘選模式
const pinsFn = seg('interface Pin {', '// ── PM-317：get_page_health');
const analyzeFn = seg('const ANALYZE_STYLE_PROPS', '// ── PM-309：read_page');
const readPage = seg('const READ_PAGE_MAX_CHARS', '// background → content：控制指令');

const js = ts.transpileModule(
  [sensitive, hlFn, pinsFn, analyzeFn, readPage].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
).outputText;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = dom.window;
const run = new Function('window', 'document', 'getComputedStyle', 'Node', 'NodeFilter', 'CSS',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'InputEvent', 'performance',
  'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'CSSStyleSheet', 'MutationObserver',
  js + '\nreturn { setPinMode, getPinListForPopup, openPinPrompt, openPinMenu, bridgePinElement, bridgeGetPinResults, bridgeRemovePin, uniqueSelector, pins, repositionPins, isBugezyOwnUi, autoDescription };');
const api = run(g, g.document, g.getComputedStyle.bind(g), g.Node, g.NodeFilter, g.CSS,
  g.HTMLInputElement, g.HTMLTextAreaElement, g.Event, g.InputEvent, g.performance,
  (cb) => g.setTimeout(cb, 0),
  g.setTimeout.bind(g), g.clearTimeout.bind(g), g.CSSStyleSheet, g.MutationObserver);

const setBody = (html) => { g.document.body.innerHTML = html; };
const tick = (ms = 5) => new Promise((r) => g.setTimeout(r, ms));
const ui = () => g.document.querySelector('[data-bugezy-pin-ui]')?.shadowRoot ?? null;
const q = (sel) => ui()?.querySelector(sel) ?? null;
/** 模擬一次真實的滑鼠事件（capture 階段的 handler 收得到）。 */
const fire = (el, type, init = {}) =>
  el.dispatchEvent(new g.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }));

console.log('\n=== ① PM-384：進入／離開釘選模式 ===');
setBody('<a id="lnk" href="https://example.com/">連結</a><button id="btn">按我</button><iframe id="fr"></iframe>');
check('384-1 預設是關閉的', api.getPinListForPopup().pin_mode === false);
api.setPinMode(true);
check('384-1 進入釘選模式 → html 標記 data-bugezy-pin-mode（crosshair 游標）',
  g.document.documentElement.hasAttribute('data-bugezy-pin-mode'));
check('384   UI 容器是 shadow DOM（不會被頁面 CSS 干擾）', !!ui(), 'shadowRoot 不存在');
check('384   模式啟動時頁面上有橫幅（不會不知不覺還開著）',
  /釘選模式/.test(q('.bz-banner')?.textContent || ''), q('.bz-banner')?.textContent);
check('384   重複開啟不會疊出第二條橫幅', (() => {
  api.setPinMode(true);
  return ui().querySelectorAll('.bz-banner').length === 1;
})());

console.log('\n=== ② PM-384：hover 高亮 + tooltip ===');
const btn = g.document.getElementById('btn');
fire(btn, 'mousemove', { clientX: 40, clientY: 40 });
check('384-2 hover 元素 → 出現 tooltip', !!q('.bz-tip'));
check('384-2 tooltip 顯示 tag#id.class', /button#btn/.test(q('.bz-tip')?.textContent || ''), q('.bz-tip')?.textContent);
fire(g.document.getElementById('fr'), 'mousemove', { clientX: 10, clientY: 10 });
check('384-6 hover iframe → 友善提示而不是假裝可以釘',
  /iframe/.test(q('.bz-tip')?.textContent || '') && q('.bz-tip')?.className.includes('warn'),
  q('.bz-tip')?.textContent);

console.log('\n=== ③ PM-384：點擊攔截（最重要的一條）===');
let navigated = false;
g.document.getElementById('lnk').addEventListener('click', () => { navigated = true; });
const prevented = !fire(g.document.getElementById('lnk'), 'click', { clientX: 20, clientY: 20 });
check('384-4 🔴 點擊被攔截（preventDefault）', prevented);
check('384-4 🔴 頁面原本的 click handler 沒有被觸發（連結不會導航）', navigated === false);
check('384-3 點擊後彈出描述輸入框', !!q('.bz-card'), '沒有出現輸入框');

console.log('\n=== ④ PM-385：描述輸入彈窗 ===');
check('385-1 彈窗有標題、input、兩個按鈕',
  /描述這個問題/.test(q('.bz-card h4')?.textContent || '') && !!q('.bz-card input')
  && ui().querySelectorAll('.bz-card .bz-btn').length === 2);
check('385   input 有 placeholder 範例', /點了沒反應/.test(q('.bz-card input')?.placeholder || ''), q('.bz-card input')?.placeholder);
await tick();
check('385   自動 focus 到輸入框', ui().activeElement === q('.bz-card input'), String(ui().activeElement?.tagName));

// 輸入描述 + 按「釘選」
q('.bz-card input').value = '這個連結點了沒反應';
[...ui().querySelectorAll('.bz-card .bz-btn')].find((b) => b.textContent === '釘選').click();
await tick();
let list = api.getPinListForPopup();
check('385-2 輸入描述 + 釘選 → 圖釘帶描述',
  list.total_count === 1 && list.pins[0].description === '這個連結點了沒反應', JSON.stringify(list.pins));
check('385-4 釘選成功 → toast 通知', /已釘選/.test(q('.bz-toast')?.textContent || ''), q('.bz-toast')?.textContent);
check('385   釘完仍留在釘選模式（可以繼續釘下一個）', api.getPinListForPopup().pin_mode === true);
check('385   彈窗已關閉', !q('.bz-card'));

// 「跳過」→ 自動描述
fire(btn, 'click', { clientX: 50, clientY: 50 });
[...ui().querySelectorAll('.bz-card .bz-btn')].find((b) => b.textContent === '跳過').click();
await tick();
list = api.getPinListForPopup();
const btnPin = list.pins.find((p) => p.selector.includes('btn'));
check('385-3 點跳過 → 用元素的自動描述（不是空的）',
  !!btnPin && /button/.test(btnPin.description) && /按我/.test(btnPin.description), JSON.stringify(btnPin));

// 點外部 → 取消
setBody('<p id="para">文字</p>');
api.setPinMode(false); api.setPinMode(true);
const before = api.getPinListForPopup().total_count;
fire(g.document.getElementById('para'), 'click', { clientX: 30, clientY: 30 });
check('385   點擊後彈窗開啟', !!q('.bz-card'));
await tick();
g.document.dispatchEvent(new g.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
await tick();
check('385-4 點彈窗外 → 取消，不新增圖釘',
  !q('.bz-card') && api.getPinListForPopup().total_count === before, `${before} → ${api.getPinListForPopup().total_count}`);

// Enter = 釘選
fire(g.document.getElementById('para'), 'click', { clientX: 30, clientY: 30 });
await tick();
q('.bz-card input').value = 'Enter 測試';
q('.bz-card input').dispatchEvent(new g.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await tick();
check('385-5 Enter 鍵 = 釘選',
  api.getPinListForPopup().pins.some((p) => p.description === 'Enter 測試'),
  JSON.stringify(api.getPinListForPopup().pins.map((p) => p.description)));

console.log('\n=== ⑤ PM-384：ESC 結束 + 關閉後恢復正常 ===');
g.document.dispatchEvent(new g.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('384-5 ESC 結束釘選模式', api.getPinListForPopup().pin_mode === false);
check('384   結束後移除 crosshair 標記', !g.document.documentElement.hasAttribute('data-bugezy-pin-mode'));
check('384   結束後橫幅與 tooltip 都清掉', !q('.bz-banner') && !q('.bz-tip'));
let clicked2 = false;
g.document.getElementById('para').addEventListener('click', () => { clicked2 = true; });
const notPrevented = fire(g.document.getElementById('para'), 'click', { clientX: 30, clientY: 30 });
check('384   🔴 結束後點擊行為完全恢復（不再攔截）', notPrevented && clicked2);

console.log('\n=== ⑥ PM-384：不能把 BugEzy 自己的 UI 釘起來 ===');
api.setPinMode(true);
const layer = g.document.querySelector('[data-bugezy-pins]');
check('384   圖釘層被辨識為 BugEzy 自己的 UI', layer ? api.isBugezyOwnUi(layer) : true);
check('384   一般元素不會被誤判', api.isBugezyOwnUi(g.document.getElementById('para')) === false);
api.setPinMode(false);

console.log('\n=== ⑦ PM-387：圖釘右鍵選單 ===');
api.pins.clear(); // 圖釘是模組層狀態，跨段落會殘留 → 每段自己清乾淨
setBody('<button id="target">目標</button>');
api.bridgePinElement('#target', '測試描述');
api.repositionPins();
const dot = g.document.querySelector('[data-bugezy-pins] div');
check('387   圖釘圓點已渲染', !!dot);
check('387   圓點的 title 提示可以右鍵', /右鍵/.test(dot?.title || ''), dot?.title);
const ctxPrevented = !dot.dispatchEvent(new g.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 60, clientY: 60 }));
check('387-1 右鍵圖釘 → 出現自訂選單', !!q('.bz-menu'));
check('387-4 圖釘上的右鍵有 preventDefault（不被頁面選單覆蓋）', ctxPrevented);
const items = [...ui().querySelectorAll('.bz-menu button')].map((b) => b.textContent);
check('387-2 四個選項齊全', items.length === 4 && /分析/.test(items[0]) && /修改描述/.test(items[1]) && /已解決/.test(items[2]) && /移除/.test(items[3]), JSON.stringify(items));

// 修改描述 → 舊描述預填
[...ui().querySelectorAll('.bz-menu button')].find((b) => /修改描述/.test(b.textContent)).click();
await tick();
check('387-3 修改描述 → 舊描述預填', q('.bz-card input')?.value === '測試描述', q('.bz-card input')?.value);
q('.bz-card input').value = '改過的描述';
[...ui().querySelectorAll('.bz-card .bz-btn')].find((b) => b.textContent === '釘選').click();
await tick();
check('387-3 更新後描述生效', api.getPinListForPopup().pins.find((p) => p.selector === '#target')?.description === '改過的描述', JSON.stringify(api.getPinListForPopup().pins));

// 標記已解決
api.repositionPins();
g.document.querySelector('[data-bugezy-pins] div').dispatchEvent(new g.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 60, clientY: 60 }));
[...ui().querySelectorAll('.bz-menu button')].find((b) => /標記已解決/.test(b.textContent)).click();
await tick();
const resolvedPin = api.getPinListForPopup().pins.find((p) => p.selector === '#target');
check('387-2 標記已解決 → resolved = true 且 emoji 變 ✅',
  resolvedPin.resolved === true && resolvedPin.emoji === '✅', JSON.stringify(resolvedPin));
check('387   🔴 status 仍是原本四種之一（resolved 沒有污染狀態列舉）',
  ['active', 'warning', 'error', 'stale'].includes(resolvedPin.status), resolvedPin.status);
check('387   get_pin_results 也看得到 resolved（AI 知道人已處理過）',
  api.bridgeGetPinResults().pins.find((p) => p.selector === '#target')?.resolved === true, JSON.stringify(api.bridgeGetPinResults().pins));
api.repositionPins();
check('387   已解決的圓點變淡綠', g.document.querySelector('[data-bugezy-pins] div')?.style.background === 'rgb(165, 214, 167)',
  g.document.querySelector('[data-bugezy-pins] div')?.style.background);

// 選單關閉
g.document.querySelector('[data-bugezy-pins] div').dispatchEvent(new g.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 60, clientY: 60 }));
await tick();
g.document.dispatchEvent(new g.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('387-5 ESC → 選單消失', !q('.bz-menu'));
g.document.querySelector('[data-bugezy-pins] div').dispatchEvent(new g.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 60, clientY: 60 }));
await tick();
g.document.dispatchEvent(new g.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
check('387-5 點外部 → 選單消失', !q('.bz-menu'));

// 移除
g.document.querySelector('[data-bugezy-pins] div').dispatchEvent(new g.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 60, clientY: 60 }));
[...ui().querySelectorAll('.bz-menu button')].find((b) => /移除/.test(b.textContent)).click();
check('387-2 移除 → 圖釘從清單消失', api.getPinListForPopup().total_count === 0);

console.log('\n=== ⑧ PM-386：popup 清單資料 ===');
api.pins.clear();
setBody('<button id="a">A</button><section id="b">B</section>');
api.bridgePinElement('#a', '按鈕壞了');
api.bridgePinElement('#b', '區塊怪怪的');
const pl = api.getPinListForPopup();
check('386-1 回傳圖釘清單 + 總數', pl.total_count === 2 && pl.pins.length === 2, JSON.stringify(pl).slice(0, 200));
check('386-2 每筆有顏色符號 + 描述',
  pl.pins.every((p) => ['🟢', '🟡', '🔴', '⚪', '✅'].includes(p.emoji) && typeof p.description === 'string'),
  JSON.stringify(pl.pins));
check('386   同時回報釘選模式狀態（popup 才能畫對按鈕）', typeof pl.pin_mode === 'boolean');
// stale：元素消失
g.document.getElementById('a').remove();
const pl2 = api.getPinListForPopup();
check('386-7 元素消失 → status 轉 stale（popup 據此禁用「分析」）',
  pl2.pins.find((p) => p.selector.includes('a'))?.status === 'stale', JSON.stringify(pl2.pins));

console.log('\n=== ⑨ PM-383 / 386：popup 側原始碼檢查 ===');
const html = readFileSync('../extension/src/popup.html', 'utf8');
const ptsRaw = readFileSync('../extension/src/popup.ts', 'utf8');
const pts = ptsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
check('383-1 popup 有 📌 釘選模式按鈕', /id="pinModeBtn"/.test(html) && /📌 釘選模式/.test(html));
check('383-2 有「啟動中」的視覺樣式（BugEzy 藍 #00bfff）', /\.pin-mode-btn\.on\s*{[^}]*#00bfff/.test(html), '找不到 .pin-mode-btn.on 的藍色樣式');
check('383-2 按鈕文字會切換為「釘選中... 點擊結束」', /釘選中\.\.\. 點擊結束/.test(pts));
check('383-4 用 chrome.storage.session 記住狀態', /chrome\.storage\.session/.test(pts));
check('383   切換時真的送 PIN_MODE_ON / PIN_MODE_OFF', /PIN_MODE_ON/.test(pts) && /PIN_MODE_OFF/.test(pts));
check('383   開啟前先查真實狀態（不靠快取猜）', /PIN_MODE_STATUS/.test(pts));
check('386-1 popup 有圖釘清單容器', /id="pinList"/.test(html) && /GET_PIN_LIST/.test(pts));
check('386-3/4 每筆有分析與移除', /BRIDGE_PIN_ANALYZE/.test(pts) && /BRIDGE_REMOVE_PIN/.test(pts));
check('386-5 有巡檢全部', /BRIDGE_PATROL_PINS/.test(pts) && /id="pinPatrolBtn"/.test(html));
check('386   清除全部有確認對話框（防誤清）', /BRIDGE_CLEAR_PINS/.test(pts) && /confirm\(/.test(pts));
check('386-6 沒有圖釘 → 顯示引導文案', /尚無圖釘，啟動釘選模式開始偵察/.test(pts));
check('386-7 stale 圖釘的「分析」按鈕禁用', /analyze\.disabled\s*=\s*pin\.status === 'stale'/.test(pts), '沒看到 stale 禁用');
check('386   不支援的分頁（chrome://）有明確說明，不會顯示成「沒有圖釘」', /不支援釘選/.test(pts));
check('383/386 全部用 DOM API 建構，沒有 innerHTML（Trusted Types 安全）',
  !/innerHTML/.test(pts.slice(pts.indexOf('PM-383~386'))), 'popup 的釘選區塊出現 innerHTML');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
