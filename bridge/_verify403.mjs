// PM-403~406 驗收：popup 兩層架構、AI 監測、記憶矩陣唯讀通道、guide MCP30 章節。
// popup 沒有 DOM 可跑（不是 content script，無法用 jsdom 抽函式），所以用原始碼靜態檢查；
// 唯讀通道的協定兩端都查，guide 則直接打線上頁面。
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

const html = readFileSync('../extension/src/popup.html', 'utf8');
const ptsRaw = readFileSync('../extension/src/popup.ts', 'utf8');
const pts = strip(ptsRaw);
const i18n = readFileSync('../extension/src/i18n.ts', 'utf8');
const bg = strip(readFileSync('../extension/src/background.ts', 'utf8'));

console.log('\n=== ① PM-403：第一層主門面 ===');
check('403-2 🔴 圖釘區塊已經不在第一層（idleView）裡', (() => {
  const idle = html.slice(html.indexOf('id="idleView"'), html.indexOf('id="scoutView"'));
  return !idle.includes('id="pinSection"');
})(), '第一層還看得到 pinSection');
check('403-3 第一層有「偵察模式 →」入口且可點', /id="scoutEnterBtn"/.test(html) && /scout-mode/.test(html));
check('403   入口帶圖釘數 badge（不進第二層也知道有沒有東西在盯）', /id="scoutPinBadge"/.test(html) && /refreshScoutBadge/.test(pts));
check('403-5 第一層既有功能一個都沒動（錄製／截圖／報告／提示詞／兌換）',
  ['startBtn', 'rewindBtn', 'screenshotBtn', 'myReportsBtn', 'promoCode', 'copyMcpBtn'].every((id) => html.includes(`id="${id}"`)));
check('403-4 票券錢包的展開／收合機制仍在', /id="ticketToggle"/.test(html) && /updateTicketFold/.test(pts));

console.log('\n=== ② PM-404：第二層偵察模式 ===');
check('404-1/2 有 scoutView 與返回按鈕', /id="scoutView"/.test(html) && /id="scoutBackBtn"/.test(html));
check('404-1/2 進出第二層由 showScout 控制（用既有的 .hidden，不開新頁）',
  /function showScout\(on: boolean\)/.test(pts) && /classList\.toggle\('hidden'/.test(pts));
check('404   有滑入動畫，且用 animation 而非 transition',
  /slide-in/.test(html) && /@keyframes scoutIn/.test(html));
check('404-3 圖釘清單整段搬進第二層、功能完整', (() => {
  const scout = html.slice(html.indexOf('id="scoutView"'));
  return ['pinSection', 'pinModeBtn', 'pinList', 'pinPatrolBtn', 'pinClearBtn', 'pinResult']
    .every((id) => scout.includes(`id="${id}"`));
})());
check('404-4 AI 監測區塊 + 一鍵全掃', /id="scanAllBtn"/.test(html) && /id="scanResult"/.test(html) && /function runScanAll/.test(pts));
check('404-4 🔴 一鍵全掃是重跑既有工具，不是另寫一套偵測',
  /BRIDGE_MAP_ZONES/.test(pts) && /BRIDGE_ZONE_HEALTH/.test(pts) && /BRIDGE_GET_PAGE_HEALTH/.test(pts) && /BRIDGE_GET_BROWSER_ERRORS/.test(pts));
check('404-4 掃描結果含 Zone／Error／Score（PM-408 後改走 i18n 鍵）',
  /'scout-zone'/.test(pts) && /'scout-error'/.test(pts) && /'scout-score'/.test(pts));
check('404   🔴 掃描結果揭露 30 秒視窗（空結果不等於沒問題）',
  /'scout-window-note'/.test(pts) && /只涵蓋最近約 30 秒/.test(i18n));
check('404-5 記憶矩陣區塊顯示筆數與各層摘要',
  /id="memResult"/.test(html) && /entries_per_layer/.test(pts) && /memLayerName/.test(pts));
check('404-6 🔴 Bridge 未連線 → 明確訊息（與「連上但出錯」分開）',
  /'mem-bridge-off'/.test(pts) && /'mem-read-failed'/.test(pts));
check('408   🔴 未連線的判斷用穩定機器碼，不是比對中文句子',
  /'bridge_offline'/.test(pts) && /'bridge_offline'/.test(bg), 'popup 或 background 還在用中文字串當判斷依據');
check('404   尚未建立 .bugezy/ 也有專屬說明（不會顯示成 0 筆）',
  /'mem-not-init'/.test(pts) && /尚未建立 \.bugezy\//.test(i18n));

console.log('\n=== ③ PM-404：Extension → bridge 的唯讀查詢通道 ===');
const link = strip(readFileSync('src/extension-link.ts', 'utf8'));
const types = strip(readFileSync('src/types.ts', 'utf8'));
check('404   bridge 端會處理 query 訊息', /isQuery\(msg\)/.test(link) && /onQuery/.test(link));
check('404   🔴 白名單是硬編碼的 switch（不是查表，新增能力一定要動程式碼）',
  /switch \(query\)/.test(link) && /case 'memory_stats'/.test(link));
check('404   🔴 只開放唯讀查詢 —— 破壞性的 memory_clear 沒有被放進通道',
  !/case 'memory_clear'/.test(link) && !/memoryClear/.test(link), 'bridge 的查詢通道出現了破壞性操作');
check('404   不支援的查詢回明確拒絕，不是靜默忽略', /不支援的查詢/.test(readFileSync('src/extension-link.ts', 'utf8')));
check('404   型別層也標明只有 memory_stats 合法', /query: 'memory_stats'/.test(types));
check('404   extension 端有送出與對回（含逾時）', /queryBridge/.test(bg) && /query_result/.test(bg) && /bridgeQueries/.test(bg));
check('404   🔴 未連線時立刻回覆，不重試（popup 只是要顯示數字，不該卡住）',
  /readyState !== WebSocket\.OPEN[\s\S]{0,200}bridge_offline/.test(bg));
check('404   popup 走 background 轉發，沒有自己開 WebSocket',
  /BRIDGE_QUERY_MEMORY_STATS/.test(pts) && !/new WebSocket/.test(pts));
check('404   🔴 popup 明說這條通道是唯讀的、清除要走 AI',
  /'mem-readonly-note'/.test(pts) && /要清除記憶請用 AI 呼叫 memory_clear/.test(i18n));

console.log('\n=== ④ PM-405：巡檢／分析結果人類可讀 ===');
check('405-1 巡檢有專屬渲染函式', /function renderPatrolResult/.test(pts));
check('405-2 單一分析有專屬渲染函式', /function renderAnalyzeResult/.test(pts));
check('405-3/4 依嚴重度上色（紅／黃／綠）', /SEV_COLOR/.test(pts) && /#ff6b6b/.test(ptsRaw) && /#4ade80/.test(ptsRaw));
check('405   🔴 顏色取自 content script 已算好的 emoji，popup 不重新判定嚴重度',
  /顏色來自 summary 開頭的 emoji/.test(ptsRaw));
check('405-5 分析顯示探測類型與耗時', /'analyze-probe'/.test(pts) && /duration_ms/.test(pts));
check('405   分析也顯示可見性與尺寸', /'analyze-visible'/.test(pts) && /'analyze-size'/.test(pts));
check('405-1 🔴 結果不再是 JSON.stringify', !/JSON\.stringify\(r\)\.slice/.test(pts), '還有直接 stringify 的顯示路徑');
check('405   舊的純文字版已移除，不留第二條顯示路徑',
  !/function formatPatrolResult/.test(pts) && !/function formatProbeLine/.test(pts));
check('405   全部用 DOM API 建構（Trusted Types 安全）', !/innerHTML/.test(pts.slice(pts.indexOf('pinResultRender'))));

console.log('\n=== ④b PM-408：翻譯完整性 ===');
/** 字典的鍵可能有引號也可能沒有（logout: {…} / 'scout-mode': {…}）。 */
const hasKey = (k) => new RegExp(`(^|\\s|\\{)'?${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'?\\s*:\\s*\\{\\s*zh:`, 'm').test(i18n);

// 🔴 這一條就是 PM-408 的根因守衛：`t()` 找不到鍵時會回傳鍵本身，
//    所以漏一個字典項＝畫面上直接顯示 "scout-mode" 這種原始字串，而且不會有任何錯誤。
const htmlKeys = [...new Set([...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map((m) => m[1]))];
const missingHtml = htmlKeys.filter((k) => !hasKey(k));
check(`408-1 🔴 popup.html 的 ${htmlKeys.length} 個 data-i18n 鍵字典裡全都有`,
  missingHtml.length === 0, `缺：${missingHtml.join(', ')}`);

// popup.ts 裡 t('key', …) 用到的鍵同樣要存在
const tsKeys = [...new Set([...ptsRaw.matchAll(/\bt\(\s*'([a-z0-9_-]+)'\s*,/gi)].map((m) => m[1]))];
const missingTs = tsKeys.filter((k) => !hasKey(k));
check(`408-1 🔴 popup.ts 裡 t() 用到的 ${tsKeys.length} 個鍵字典裡全都有`,
  missingTs.length === 0, `缺：${missingTs.join(', ')}`);

// 卡片點名的六個鍵，逐一確認繁中與英文都真的有值
for (const [key, zh, en] of [
  ['scout-mode', '偵察模式', 'Scout Mode'],
  ['back', '返回', 'Back'],
  ['ai-monitor', 'AI 監測', 'AI Monitor'],
  ['scan-all', '一鍵全掃', 'Scan all'],
  ['memory-matrix', '記憶矩陣', 'Memory Matrix'],
  ['refresh', '重新整理', 'Refresh'],
]) {
  const line = i18n.split('\n').find((l) => new RegExp(`(^|\\s|\\{)'?${key}'?\\s*:\\s*\\{\\s*zh:`).test(l)) ?? '';
  check(`408-1/2 ${key} → 繁中「${zh}」／英文「${en}」`,
    line.includes(`'${zh}'`) && line.includes(`'${en}'`), line.slice(0, 120) || '(找不到)');
}

// 五種語言都要有值（型別要求，但空字串照樣通過型別檢查）
const scoutLines = i18n.split('\n').filter((l) => /'(scout|mem|patrol|analyze|pin)-[a-z0-9-]+'?\s*:\s*\{\s*zh:/.test(l));
check(`408-2 第二層的 ${scoutLines.length} 條字串五種語言都有非空值`,
  scoutLines.length > 20 && scoutLines.every((l) =>
    ['zh', 'en', 'ja', 'ko', 'vi'].every((lg) => new RegExp(`${lg}: '[^']+'`).test(l))),
  scoutLines.find((l) => !['zh', 'en', 'ja', 'ko', 'vi'].every((lg) => new RegExp(`${lg}: '[^']+'`).test(l)))?.slice(0, 120) ?? '');

// 🔴 動態文字也必須走 t()：只補 data-i18n 的話，英文模式下第二層仍是滿滿中文
const scoutCode = strip(ptsRaw.slice(ptsRaw.indexOf('兩層架構')));
const cjkLiterals = [...scoutCode.matchAll(/'([^'\n]{2,90})'/g)]
  .map((m) => m[1])
  .filter((x) => /[一-鿿]/.test(x));
check('408-2 🔴 第二層的動態文字沒有殘留硬編碼中文（英文模式才會真的是英文）',
  cjkLiterals.length === 0, `殘留 ${cjkLiterals.length} 條：${cjkLiterals.slice(0, 3).join(' / ')}`);

check('408   語言切換時第二層會重繪（否則會停在切換前的語言）',
  /applyTranslations[\s\S]{0,600}refreshPinList\(\)[\s\S]{0,200}refreshMemoryStats\(\)/.test(ptsRaw),
  'applyTranslations 沒有重繪第二層');

check('408-3 按鈕沒有寫死寬度（文字變長不會被截斷）',
  !/\.scout-act\s*\{[^}]*width\s*:/.test(html) && !/\.scout-back\s*\{[^}]*width\s*:/.test(html)
  && !/\.pin-mode-btn\s*\{[^}]*width\s*:/.test(html));

console.log('\n=== ④c PM-409：排版（寬度 + 不斷行）===');
// ⚠ 這裡驗的是**CSS 規則存在**，不是實際渲染寬度——popup 沒有辦法在 CI 裡量。
//   實際視覺仍需人眼確認一次（已寫進 DONE-409）。
check('409-1 popup 加寬到 360px', /body \{[\s\S]{0,240}width: 360px;/.test(html), '仍是舊寬度');
for (const sel of ['.scout-title', '.scout-block-title', '.pin-title']) {
  check(`409-1 ${sel} 不斷行`, new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*white-space: nowrap|white-space: nowrap[\\s\\S]{0,400}`).test(html)
    && /white-space: nowrap;/.test(html.slice(html.indexOf('.scout-title'), html.indexOf('.scout-title') + 900)));
}
check('409-1 三個標題都在同一條 nowrap 規則裡（不會漏掉其中一個）', (() => {
  const i = html.indexOf('PM-409：第二層的標題與按鈕一律不斷行');
  const rule = html.slice(i, html.indexOf('}', i));
  return ['.scout-title', '.scout-block-title', '.pin-title', '.scout-back', '.scout-act', '.pin-mode-btn']
    .every((sel) => rule.includes(sel));
})(), '有標題或按鈕沒被納入 nowrap');
check('409-2 🔴 按鈕不讓步（flex-shrink: 0）—— 否則會被壓成兩行或截斷', (() => {
  const i = html.indexOf('按鈕不讓步');
  const rule = html.slice(i, html.indexOf('}', i));
  return ['.scout-back', '.scout-act', '.pin-mode-btn', '.scout-enter-right'].every((sel) => rule.includes(sel));
})());
// 🔴 PM-410 撤掉了 PM-409 給標題加的 min-width:0 + overflow:hidden ——
//    那組合會讓 flex item 被壓到 0 寬而整個消失（正是 PM-410 回報的症狀）。
check('410   🔴 標題不再有 min-width:0 + overflow:hidden（那會讓它被壓到 0 寬而消失）',
  !/\.scout-block-title,\s*\n\s*\.pin-title \{\s*\n\s*min-width: 0;/.test(html), '標題仍可能被壓縮到消失');
check('410   🔴 標題與按鈕兩側都不讓步（flex: 0 0 auto ／ flex-shrink: 0）',
  /\.pin-title \{[\s\S]{0,60}flex: 0 0 auto;/.test(html));
check('410   真的擠不下時由容器裁切，而不是讓子元素憑空不見',
  /\.scout-head,\s*\n\s*\.scout-block-head,\s*\n\s*\.pin-head \{\s*\n\s*overflow: hidden;/.test(html));
check('409-4/5 三個 head 都是 flex row 且左右對齊',
  /\.scout-head \{[\s\S]{0,200}justify-content: space-between/.test(html)
  && /\.scout-block-head \{[^}]*justify-content: space-between/.test(html)
  && /\.pin-head \{[^}]*justify-content: space-between/.test(html));
check('409-3 🔴 第一層不受寬度影響（欄位用 1fr，沒有寫死像素寬）',
  /\.action-grid \{[^}]*grid-template-columns: repeat\(3, 1fr\)/.test(html)
  && !/\.action-grid \{[^}]*width: \d+px/.test(html));
check('409-3 第一層既有元素一個都沒少',
  ['startBtn', 'rewindBtn', 'screenshotBtn', 'myReportsBtn', 'scoutEnterBtn', 'promoCode'].every((id) => html.includes(`id="${id}"`)));

console.log('\n=== ④d PM-410：三個 section 的標題與分隔線 ===');
const scoutHtml = html.slice(html.indexOf('id="scoutView"'), html.indexOf('<section id="recordingView"'));
for (const [label, key] of [['圖釘', 'pin-section-title'], ['AI 監測', 'ai-monitor'], ['記憶矩陣', 'memory-matrix']]) {
  check(`410-1 ${label} section 有標題元素`, scoutHtml.includes(`data-i18n="${key}"`), `找不到 data-i18n="${key}"`);
}
check('410-1 三個標題都帶 emoji（與第一層風格一致）',
  (scoutHtml.match(/scout-block-title">(📌|🤖|🧠)/g) ?? []).length === 3,
  String((scoutHtml.match(/scout-block-title">(📌|🤖|🧠)/g) ?? []).length));
check('410-2 🔴 三個 section 的標題列用同一組 class（結構一致，不是三種寫法）',
  (scoutHtml.match(/class="[^"]*scout-block-head[^"]*"/g) ?? []).length === 3,
  String((scoutHtml.match(/class="[^"]*scout-block-head[^"]*"/g) ?? []).length));
check('410-2 標題左、按鈕右、同一行',
  /\.scout-block-head \{[^}]*display: flex[^}]*justify-content: space-between/.test(html));
check('410-3 🔴 三個 section 都有分隔線（圖釘那段原本沒有）',
  (scoutHtml.match(/class="[^"]*scout-block[^"]*"/g) ?? []).filter((c) => !c.includes('scout-block-head') && !c.includes('scout-block-title')).length === 3,
  String((scoutHtml.match(/class="[^"]*scout-block[^"]*"/g) ?? []).filter((c) => !c.includes('scout-block-head') && !c.includes('scout-block-title')).length));
check('410-3 第一個區塊不畫上分隔線（否則與 scout-head 的線變雙線）',
  /#scoutView > \.scout-block:first-of-type \{ border-top: none;/.test(html));
check('410-4 標題不斷行', /\.pin-title,?[\s\S]{0,120}white-space: nowrap;/.test(html) || /white-space: nowrap;/.test(html.slice(html.indexOf('.scout-title'), html.indexOf('.scout-title') + 400)));
check('410-5 🔴 既有功能一個都沒少（id 全部保留，只是多加 class）',
  ['pinSection', 'pinCount', 'pinModeBtn', 'pinList', 'pinBulk', 'pinPatrolBtn', 'pinClearBtn', 'pinResult', 'scanAllBtn', 'memRefreshBtn']
    .every((id) => scoutHtml.includes(`id="${id}"`)));
check('410   新的標題鍵也在字典裡（五語）', (() => {
  const line = i18n.split('\n').find((l) => /'pin-section-title'\s*:/.test(l)) ?? '';
  return ['zh', 'en', 'ja', 'ko', 'vi'].every((lg) => new RegExp(`${lg}: '[^']+'`).test(line));
})(), '缺 pin-section-title 或語言不全');

console.log('\n=== ⑤ PM-406：guide 的 MCP30 章節（線上實測）===');
const BASE = 'https://bugezy-api.bugezy-api.workers.dev';
for (const [lang, url] of [['繁中', `${BASE}/guide`], ['English', `${BASE}/guide?lang=en`]]) {
  const res = await fetch(url, { headers: { 'User-Agent': 'bugezy-verify/1.0' } });
  const body = await res.text();
  check(`406-1 ${lang} /guide 可存取`, res.status === 200 && body.length > 5000, `status=${res.status} len=${body.length}`);
  check(`406-3 ${lang} 有 MCP30 領取說明`, /MCP30/.test(body));
  check(`406-4 ${lang} 有常見問題（含「請先完成 MCP 對接」怎麼辦）`,
    /請先完成 MCP 對接|please connect MCP first/i.test(body));
  check(`406   ${lang} 🔴 有 ?token= 卡關警告（PM-400 查出的真正阻塞點）`,
    /warn-box/.test(body) && /\?token=/.test(body));
  check(`406-2 ${lang} 含 Claude／ChatGPT／Gemini 說明`,
    /Claude/.test(body) && /ChatGPT/.test(body) && /Gemini/.test(body));
}
const zh = await (await fetch(`${BASE}/guide`, { headers: { 'User-Agent': 'bugezy-verify/1.0' } })).text();
check('406   既有內容沒有被覆蓋掉（六種錄製模式、MCP 設定、快速開始都還在）',
  /30 秒快速開始/.test(zh) && /mcp-tool/.test(zh) && /Cursor/.test(zh));
check('406-5 有 viewport meta（手機版排版的前提）', /name="viewport"/.test(zh));
check('406   登入後自動補 token 的腳本仍在（PM-280）', /bugezy_session_token/.test(zh));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
