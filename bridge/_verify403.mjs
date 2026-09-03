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
// PM-418：色碼從 popup.ts 的 SEV_COLOR 對照表搬到 popup.html 的 token（§7.7 左側 3px 色條）。
//   驗的東西不變 —— 「有依嚴重度分級的視覺」+「分級來自 content script 的 emoji」——
//   只是實作從 inline style 換成 CSS class。
check('405-3/4 依嚴重度上色（err／warn／ok 三級）',
  /function sevClass/.test(pts)
  && ['sev-err', 'sev-warn', 'sev-ok'].every((c) => pts.includes(`'${c}'`))
  && ['.pin-res-row.sev-err', '.pin-res-row.sev-warn', '.pin-res-row.sev-ok'].every((c) => html.includes(c)));
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

// PM-418：三顆按鈕現在都要寫 `width: auto`——大黃蜂系統的全域 `button { width: 100% }`
//   會把它們撐滿整列。`auto` 正是這條斷言想要的（不寫死尺寸），所以只擋固定值。
check('408-3 按鈕沒有寫死寬度（文字變長不會被截斷）',
  !/\.scout-act\s*\{[^}]*width\s*:\s*\d/.test(html) && !/\.scout-back\s*\{[^}]*width\s*:\s*\d/.test(html)
  && !/\.pin-mode-btn\s*\{[^}]*width\s*:\s*\d/.test(html));

console.log('\n=== ④c PM-409：排版（寬度 + 不斷行）===');
// ⚠ 這裡驗的是**CSS 規則存在**，不是實際渲染寬度——popup 沒有辦法在 CI 裡量。
//   實際視覺仍需人眼確認一次（已寫進 DONE-409）。
// 🔴 PM-413 把寬度改回 320px（DESIGN_SPEC §9）——PM-409 當初加寬到 360 是為了讓中文標籤
//    不斷行，大黃蜂視覺系統改用「標題/按鈕全 nowrap + 說明文字手動斷行 + 次要說明降級為
//    括號小字」三招在 320 站住，所以寬度這條斷言跟著翻面。**下面的 nowrap 與 flex-shrink
//    斷言一個都沒有放寬** —— 它們才是 320 能成立的真正前提。
check('413-1 popup 寬度改回 320px', /body \{[\s\S]{0,700}width: 320px;/.test(html), '仍是 360px');
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
// 🔴 PM-418：這條斷言整個翻面。大黃蜂視覺系統**全站禁用 emoji**（DESIGN_SPEC §1），
//   三個標題的 📌 🤖 🧠 換成 §6 的幾何小六角 `.ico-hex`。驗的意圖沒變 ——
//   「三個 section 的標題都有同一種標記，風格一致」—— 只是標記從 emoji 換成幾何圖形。
check('410-1 三個標題都帶同一種幾何標記（六角，不是 emoji）',
  (scoutHtml.match(/scout-block-title[^>]*>\s*<span class="ico-hex">/g) ?? []).length === 3,
  String((scoutHtml.match(/scout-block-title[^>]*>\s*<span class="ico-hex">/g) ?? []).length));
check('418   🔴 第二層一個 emoji 都不剩（§1 全站禁用）',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(scoutHtml.replace(/<!--[\s\S]*?-->/g, '')));
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

console.log('\n=== ④e PM-411：國際付款「即將開放」不對外顯示 ===');
check('411-1 有單一開關且為 false', /const SHOW_INTL_COMING_SOON = false;/.test(pts));
// 🔴 光有開關不夠——每一個「取消隱藏」的呼叫點都要真的被它擋住，漏一處就會照樣冒出來。
const ptsLines = pts.split(String.fromCharCode(10));
// 守衛可能寫在同一行（`toggle('hidden', … || !FLAG)`）或前一行（`} else if (FLAG) {`），
// 所以看的是「該行 ±2 行的視窗內有沒有這個開關」，而不是只看同一行。
const unhideSites = ptsLines
  .map((l, k) => ({ l, k }))
  .filter(({ l }) => /intlNotice/i.test(l) && /(remove|toggle)\('hidden'/.test(l) && !l.includes("add('hidden')"));
const unguarded = unhideSites.filter(({ k }) =>
  !ptsLines.slice(Math.max(0, k - 2), k + 3).join(String.fromCharCode(10)).includes('SHOW_INTL_COMING_SOON'));
check(`411-1 🔴 ${unhideSites.length} 個顯示點全都被開關擋住`,
  unhideSites.length >= 4 && unguarded.length === 0,
  unguarded.map((x) => x.l.trim()).join(' / ') || `只找到 ${unhideSites.length} 個顯示點`);
check('411-1 兩個 overlay/第一層元素在 HTML 裡預設就是 hidden',
  /id="intlNotice" class="intl-notice hidden"/.test(html) && /id="overlayIntlNotice" class="intl-notice hidden"/.test(html));

check('411   🔴 用開關而不是 CSS 蓋掉（避免「程式說顯示、樣式說不顯示」兩個真相）',
  !/\.intl-notice\s*\{[^}]*display:\s*none/.test(html.replace(/\.intl-notice\.hidden \{ display: none; \}/, '')),
  '出現了直接把 .intl-notice 蓋掉的樣式');
check('411   markup 與翻譯都留著，重新開啟只要改一行',
  /data-i18n="intl-coming-soon"/.test(html) && /'intl-coming-soon'/.test(i18n));
check('411   PM-171/172 的國家判斷沒有被一起拆掉',
  /isTaiwanUser/.test(pts) && /currentCountry/.test(pts));

check('411-2 🔴 台灣使用者的付費按鈕完全不受影響',
  /upgradeHint\.classList\.remove\('hidden'\)/.test(pts)
  && /id="dayPassBtn"/.test(html) && /id="upgradeBtn"/.test(html)
  && /id="overlayDayPassBtn"/.test(html) && /id="overlayMonthlyBtn"/.test(html));
check('411-2 票券錢包／兌換不受影響',
  /id="ticketWallet"/.test(html) && /id="promoCode"/.test(html) && /renderTicketWallet/.test(pts));
check('411   🔴 額度用完的 overlay 不會變成死路（仍有關閉鈕與重置提示）',
  /id="upgradeOverlayClose"/.test(html) && /data-i18n="usage-reset-hint"/.test(html));

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

console.log('\n=== ⑤ PM-413~421：大黃蜂視覺系統（群組 A · popup）===');

// 這一整段是 Day 49 的「規格護欄」——把 DESIGN_SPEC.md 裡最容易被改回去、
// 而且改回去不會有人立刻發現的幾條，釘成可執行的斷言。
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{2600}-\u{26FF}]/u;
const KEEP = new Set(['→', '←', '·', '—', '–', '…']); // 排版用字元，不算 emoji
const stripHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const onlyEmoji = (t) => [...t].filter((c) => EMOJI.test(c) && !KEEP.has(c));

check('413-1 :root 有 DESIGN_SPEC §2.1 的全部十四個色票',
  ['--y:', '--y-deep:', '--y-pale:', '--cream:', '--ink:', '--ink-2:', '--ink-3:',
   '--brown:', '--brown-d:', '--line-dark:', '--line-dark-2:', '--err:', '--err-fg:', '--info:']
    .every((v) => html.includes(v)));
check('413   §2.4 深底次要文字只給兩個色階（--on-dark / --on-dark-2）',
  /--on-dark: #A08B62/.test(html) && /--on-dark-2: #C9A15A/.test(html));
check('413   §3 字體三角色 + §7 圓角 + §7.1 硬投影 + §4 蜂巢紋都有 token',
  ['--font-brand:', '--font-ui:', '--font-mono:', '--r-11:', '--r-pill:', '--sh-3:', '--hive-y:', '--hive-d:', '--hex:']
    .every((v) => html.includes(v)));
check('413   🔴 §4 蜂巢紋 data URI 內沒有未編碼的 `;`（會提早結束 CSS 宣告，整條失效）', (() => {
  for (const m of html.matchAll(/--hive-[yd]: url\("([^"]*)"\)/g)) if (m[1].includes(';')) return false;
  return true;
})());

// 🔴 PM-424 把這條翻面了。PM-421 當時要求「影片 + 靜態備援」，但交付包 README §Assets
//   指定登入頁用 bee.webm，hornet-real.png 是 ≥96px 大尺寸場景（官網 hero）用的；
//   而且那個備援從來沒有正確消失過（見下方 424 的說明）。現在只驗影片本身接對了。
check('414-1 登入頁的蜂是 <bee-video>，且接到 assets/bee.webm、92px、開追蹤',
  /<bee-video src="assets\/bee\.webm" size="92" zoom="\d+" track><\/bee-video>/.test(html));
check('414   🔴 bee-video.js 走 cpSync 而不是 esbuild entryPoints（classic script 才會 customElements.define）', (() => {
  const b = readFileSync('../extension/build.mjs', 'utf8');
  return /cpSync\(resolve\(root, 'src\/bee-video\.js'\)/.test(b) && !/'bee-video': resolve/.test(b);
})());
check('414   §8 land + float 兩段動畫都在', /@keyframes land/.test(html) && /@keyframes float/.test(html));
check('414   🔴 登入鈕只換 label span（textContent 會把 Google logo 一起洗掉）',
  /id="googleLoginLabel"/.test(html) && /googleLoginLabel\.textContent = text/.test(pts));
check('414   刻意不外連 Google Fonts（擴充頁面連外字型 = 每開一次 popup 就送一次請求）',
  !/fonts\.googleapis\.com/.test(html));

check('415-3 🔴 popup 的 markup 一個 emoji 都不剩（DESIGN_SPEC §1 全站禁用）',
  onlyEmoji(stripHtmlComments(html.slice(html.indexOf('<body>')))).length === 0,
  onlyEmoji(stripHtmlComments(html.slice(html.indexOf('<body>')))).join(' '));
check('415-3 🔴 popup 用得到的 i18n 字典值也一個 emoji 都不剩（換 markup 沒用，翻譯會蓋回來）', (() => {
  const bad = [];
  for (const m of i18n.matchAll(/^ {2}'?([A-Za-z0-9_.-]+)'?: *\{/gm)) {
    const k = m.group ?? m[1];
    let d = 1, i = m.index + m[0].length;
    while (d && i < i18n.length) { if (i18n[i] === '{') d++; else if (i18n[i] === '}') d--; i++; }
    const reachable = pts.includes(`'${k}'`) || html.includes(`"${k}"`);
    if (reachable && onlyEmoji(i18n.slice(m.index + m[0].length, i - 1)).length) bad.push(k);
  }
  return bad.length === 0 ? true : bad.join(',');
})() === true);
check('415   幾何圖示是 markup 的兄弟節點，不在 [data-i18n] 元素裡（否則翻譯會把圖示洗掉）',
  /<span class="ico-rec"><\/span>/.test(html) && /class="ico-arrow"/.test(html) && /class="ico-list"/.test(html));
check('415   §7.7 不靠顏色傳達內容：zone 三個數字補了文字標籤',
  /正常 \{ok\}／注意 \{warn\}／異常 \{err\}/.test(i18n));

check('416-1 §9.3 整頁反黑是共用的 body.dark（錄製中 + 偵察模式）',
  /body\.dark \{/.test(html) && /classList\.toggle\('dark'/.test(pts));
check('416   🔴 偵察模式有 scout-open 護欄（否則 show(\'idle\') 會把第二層的黑底關掉）',
  /scout-open/.test(html.concat(pts)) && /!document\.body\.classList\.contains\('scout-open'\)/.test(pts));
check('416-2 計時器用 JetBrains Mono 且是 46px（§3.3 機器產出一律等寬字）',
  /#elapsed \{ font: 700 46px\/1 var\(--font-mono\)/.test(html));
check('416   §8 bar：12 柱波形', (html.match(/class="rec-wave"[\s\S]*?<\/div>/)?.[0].match(/<i /g) ?? []).length === 12);
check('416-3 完成頁是米白摘要卡（§7.2 資料卡 = cream + 2px 黑框）',
  /\.summary-card \{[\s\S]{0,160}background: var\(--cream\); border: 2px solid var\(--ink\)/.test(html));

check('417   語言下拉沒有用 data URI 畫三角（§4 的 `;` 陷阱），改 ::after border',
  /\.lang-select-wrap::after/.test(html) && !/\.lang-select[^{]*\{[^}]*data:image/.test(html));
check('417   🔴 複製 MCP 的回饋卡用 flex（inline display:block 會讓 ::before 的六角失去寬高）',
  /copyMcpFeedback\.style\.display = 'flex'/.test(pts));

check('418-2 §7.7 圖釘與巡檢結果用左側 3px 色條，判定仍來自 content script 的 emoji',
  /function sevClass/.test(pts) && /\.pin-item\.sev-err \{ border-left: 3px solid var\(--err\)/.test(html));

check('419   §7.5 倒數用黑底、額度用黃底（同一個 popup 用底色分辨緊急程度）',
  /\.day-pass-status \{[\s\S]{0,200}background: var\(--ink\)/.test(html)
  && /\.upgrade-overlay-card \{[\s\S]{0,120}background: var\(--y\)/.test(html));
check('419   §7.3 實線=已填、虛線=待填（兌換碼空欄位是虛框，一打字變實心）',
  /\.promo-input input \{[\s\S]{0,220}border: 2px dashed/.test(html)
  && /:not\(:placeholder-shown\)[^}]*border-style: solid/.test(html));
check('419   用量條沒有新增 API，資料就是既有的 freeLimits',
  /function renderOverlayUsage/.test(pts) && /freeLimits\?\.recording/.test(pts));

check('420   JSON 警語是咖啡卡（§2.3 系統訊息），跟黃色的額度卡分開',
  /\.warn-card \{[\s\S]{0,160}background: var\(--brown\)/.test(html) && /class="upgrade-overlay-card warn-card"/.test(html));
check('420   §6 警示三角用 clip-path，且沒有搭配 box-shadow／border（§5：會被裁掉）', (() => {
  const m = html.match(/\.warn-tri \{[^}]*\}/);
  return !!m && /clip-path/.test(m[0]) && !/box-shadow|border:/.test(m[0]);
})());

check('421-1 擴充圖示四個尺寸都在（128 / 48 / 32 / 16）', (() => {
  const mf = JSON.parse(readFileSync('../extension/manifest.json', 'utf8'));
  return ['16', '32', '48', '128'].every((k) => mf.icons[k])
    && ['16', '32', '48'].every((k) => mf.action.default_icon[k]);
})());
check('421   🔴 popup.ts 不用 innerHTML（Trusted Types 相容；更新通知原本是唯一一處）',
  !/innerHTML/.test(pts));
// 🔴 PM-424：登入頁回歸設計原意——只有 <bee-video>，沒有靜態圖疊在上面。
//   PM-414 加的那張備援其實從來沒有正確消失過：bee-video.js 在 <bee-video> 上發的
//   `new CustomEvent('bee-ready')` 預設 bubbles:false，listener 卻掛在父層 .bee-stage，
//   事件永遠傳不到 → 備援圖一直壓在 canvas 上。這條斷言擋的就是「再加一次」。
check('424   🔴 登入頁沒有靜態備援圖疊在動態蜂上面',
  !/beeFallback/.test(html) && !/bee-fallback/.test(html) && !/beeFallback/.test(pts)
  && !/<img[^>]*hornet-real\.png/.test(html));
check('424   §8 land → float 的銜接沒有被動到（float 的 delay 要等於 land 的長度）', (() => {
  const m = html.match(/animation: land ([\d.]+)s[^;]*?,\s*float [\d.]+s [^;]*?([\d.]+)s infinite/s);
  return !!m && m[1] === m[2];
})(), 'land 時長與 float delay 不一致，中間會斷一拍');

const DEAD_TOKENS = ['--bg', '--panel', '--line', '--fg', '--muted', '--accent', '--accent-hover', '--success', '--danger'];
// 只查 var(...) 的**引用**與 :root 的**定義**——--line-dark / --on-dark 這種前綴相同的新 token 不能誤殺
const deadTokenHits = [...new Set([
  ...DEAD_TOKENS.filter((v) => new RegExp(`var\\(\\s*${v}\\s*[,)]`).test(html)),
  ...DEAD_TOKENS.filter((v) => new RegExp(`^\\s*${v}:`, 'm').test(html)),
])];
check('423   🔴 舊的深藍紫 token 一個都不剩（改回去 = 整套配色被拉回舊系統）',
  deadTokenHits.length === 0, deadTokenHits.join(', '));

check('421   §3.1 字標寫成 BugEzy，不是 BUGEZY', !/BUGEZY/.test(stripHtmlComments(html)));

console.log('\n=== ⑥ PM-425：群組 B · 付款中繼頁（畫面 07）===');

// 兩頁共用同一版型，所以逐項對兩份檔案各驗一次——只驗其中一頁的話，
// 另一頁被改壞不會有人知道（它們本來就是複製出來的）。
const CHECKOUT_PAGES = [
  ['checkout.html', readFileSync('../extension/src/checkout.html', 'utf8'), '正在建立訂閱訂單', 'NT$80'],
  ['day-pass-checkout.html', readFileSync('../extension/src/day-pass-checkout.html', 'utf8'), '正在建立日票訂單', 'NT$20'],
];

for (const [name, page, title, price] of CHECKOUT_PAGES) {
  check(`425 ${name} 反黑 + 蜂巢紋`,
    /background: var\(--ink\)/.test(page) && /rgba\(247,190,0,0\.14\)/.test(page));
  check(`425 ${name} 🔴 蜂巢紋 data URI 內沒有未編碼的 ';'`,
    !(page.match(/background-image: url\("([^"]*)"\)/)?.[1] ?? '').includes(';'));
  // 🔴 只數 .checkout-hexes 內部的 <i>。原本數整頁會被進度條與價格膠囊的 <i> 灌水，
  //    把三個六角砍成一個也驗得過（反向測試時抓到的）。
  const hexes = page.match(/class="checkout-hexes"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  check(`425 ${name} 三個脈衝六角 + 掃描進度條`,
    (hexes.match(/<i><\/i>/g) ?? []).length === 3
    && /@keyframes pulse/.test(page) && /@keyframes sweep/.test(page)
    && /class="checkout-bar"/.test(page),
    `六角 ${(hexes.match(/<i><\/i>/g) ?? []).length} 個`);
  // 🔴 只看 <h1> 與價格膠囊的實際文字，不要全文比對——CSS 註解裡就有「正在建立訂閱訂單」
  //    這幾個字，全文比對的話兩頁的標題互換也驗得過（反向測試時抓到的）。
  const h1 = page.match(/<h1 class="checkout-title">([^<]*)<\/h1>/)?.[1] ?? '';
  const note = page.match(/class="checkout-note"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  check(`425 ${name} 標題與價格對得上（兩頁不能複製後忘了換）`,
    h1 === title && note.includes(price), `h1="${h1}"`);
  check(`425 ${name} 🔴 沒有舊紫色系色碼`,
    !/#0f0f1a|#1a1a2e|#7c3aed|#6d28d9|#e0e0e0|#2a2a3e/i.test(page));
  check(`425 ${name} 🔴 零 emoji（§1 全站禁用）`,
    onlyEmoji(stripHtmlComments(page)).length === 0,
    onlyEmoji(stripHtmlComments(page)).join(' '));
  // 去註解再查——這兩頁的註解裡就寫著「設計稿用的 #8A7550 被 §2.4 點名禁止」，
  // 不去掉的話會抓到說明文字本身。
  check(`425 ${name} §2.4 深底次要文字沒有用被點名禁止的 #8A7550`,
    !/#8A7550/i.test(stripHtmlComments(page)));
  check(`425 ${name} #status 還在（.ts 唯一會寫入的元素）`, /id="status"/.test(page));
}

// setStatus 的每個呼叫點都是失敗路徑，所以它掛 body.failed 收掉「進行中」的元素。
// 這條擋的是「有人把 CSS 的 .failed 規則刪掉、或把 classList 那行拿掉」其中一邊。
for (const ts of ['checkout', 'day-pass-checkout']) {
  const src = readFileSync(`../extension/src/${ts}.ts`, 'utf8');
  const html = readFileSync(`../extension/src/${ts}.html`, 'utf8');
  check(`425 ${ts} 失敗時會收掉「正在建立…」與進度條（否則畫面會自相矛盾）`,
    /classList\.add\('failed'\)/.test(src)
    && /body\.failed \.checkout-bar/.test(html)
    && /body\.failed \.checkout-warn \{ display: block/.test(html));
}

console.log('\n=== ⑦ PM-426：群組 B · 麥克風授權頁（畫面 08）===');

const permHtml = readFileSync('../extension/src/mic-permission.html', 'utf8');
const permTs = strip(readFileSync('../extension/src/mic-permission.ts', 'utf8'));
const permBody = stripHtmlComments(permHtml);

check('426   黃底 + 蜂巢紋 10%',
  /background: var\(--y\)/.test(permHtml) && /rgba\(20,17,11,0\.10\)/.test(permHtml));
check('426   🔴 蜂巢紋 data URI 內沒有未編碼的 ";"',
  !(permHtml.match(/background-image: url\("([^"]*)"\)/)?.[1] ?? '').includes(';'));
check('426   §6.1 麥克風四層造型裝在 60px 黑六角裡', (() => {
  const mic = permHtml.match(/class="perm-mic"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  return /width: 60px; height: 69px/.test(permHtml)
    && ['m1', 'm2', 'm3', 'm4'].every((c) => mic.includes(`class="${c}"`));
})());
check('426   狀態膠囊：三態靠形狀分級，不只靠顏色（§7.4）',
  /\.perm-status\.granted \.perm-mark \{[^}]*animation: none/.test(permHtml)
  && /\.perm-status\.denied \.perm-mark \{[\s\S]{0,120}clip-path: polygon\(50% 0, 100% 100%, 0 100%\)/.test(permHtml));
check('426   🔴 狀態標記是 #status 的兄弟節點（放裡面會被 textContent 洗掉）', (() => {
  const box = permHtml.match(/class="perm-status"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  return /<span class="perm-mark"/.test(box) && /<span id="status">/.test(box)
    && !/<span id="status">[\s\S]*perm-mark/.test(box);
})());
check('426   🔴 底部提示的六角也是兄弟節點，不會被覆寫吃掉',
  /<i aria-hidden="true"><\/i><span id="permHint">/.test(permHtml));
check('426   🔴 .ts 不再用 inline style 寫死狀態色（綠 #3fb950 / 紅 #f85149 已清）',
  !/#3fb950|#f85149/i.test(permTs) && /classList\.add\('granted'\)/.test(permTs)
  && /classList\.add\('denied'\)/.test(permTs));
check('426   permH / permDesc / status 三個既有 id 都還在',
  ['permH', 'permDesc', 'status'].every((id) => permHtml.includes(`id="${id}"`)));
check('426   這頁沒有按鈕（自動觸發授權，卡片明講不要加）',
  !/<button/.test(permBody));
check('426   🔴 零 emoji（含字典裡 mperm-granted / mperm-denied 的勾與叉）', (() => {
  const bad = onlyEmoji(permBody);
  for (const k of ['mperm-granted', 'mperm-denied', 'mperm-requesting', 'mperm-hint', 'mperm-h', 'mperm-desc']) {
    const m = i18n.match(new RegExp(`'${k}': *\\{`));
    if (!m) continue;
    let d = 1, i = m.index + m[0].length;
    while (d && i < i18n.length) { if (i18n[i] === '{') d++; else if (i18n[i] === '}') d--; i++; }
    bad.push(...onlyEmoji(i18n.slice(m.index, i)));
  }
  return bad.join(' ');
})() === '');
check('426   🔴 沒有舊紫色系色碼',
  !/#1a1a2e|#9aa3b2|#0f0f1a|#7c3aed/i.test(permHtml));
check('426   §3.2 黃底上的說明文字 ≥600 字重、用 #3A2409（不是 #4A2F12）',
  /#permDesc \{[\s\S]{0,120}font: 600 13px/.test(permHtml)
  && /--on-y: #3A2409/.test(permHtml) && !/#4A2F12/i.test(permBody));

console.log('\n=== ⑧ PM-427：群組 B · 截圖標注頁（畫面 05）===');

const anHtml = readFileSync('../extension/src/annotate.html', 'utf8');
const anTsRaw = readFileSync('../extension/src/annotate.ts', 'utf8');
const anTs = strip(anTsRaw);
const anBody = stripHtmlComments(anHtml);

check('427   §9.4 工作區反轉：黃色工具列 + 近黑畫布 + 黃色描述列',
  /\.toolbar \{[\s\S]{0,200}background: var\(--y\)/.test(anHtml)
  && /\.canvas-wrapper \{[\s\S]{0,200}background: var\(--ink-3\)/.test(anHtml)
  && /\.description-area \{[\s\S]{0,200}background: var\(--y\)/.test(anHtml));
check('427   §2.3 敏感警示條是咖啡底（系統在跟你說話）',
  /\.sensitive-tip \{[\s\S]{0,160}background: var\(--brown\)/.test(anHtml));
check('427   🔴 警示條的六角用 ::before 且是 inline-block', (() => {
  // .ts 會 tip.textContent = … 再 appendChild，六角放進 DOM 會被洗掉 → 只能用 pseudo；
  // 而 .ts 又是 tip.style.display='block'（inline style 蓋掉 flex）→ ::before 必須 inline-block 才有寬高。
  const r = anHtml.match(/\.sensitive-tip::before \{[^}]*\}/)?.[0] ?? '';
  return /display: inline-block/.test(r) && /clip-path: var\(--hex\)/.test(r);
})());
check('427   🔴 蜂巢紋 data URI 內沒有未編碼的 ";"',
  [...anHtml.matchAll(/background-image: url\("([^"]*)"\)/g)].every((m) => !m[1].includes(';')));

check('427   §6 五個工具的圖示都是幾何（筆／箭頭／框／T／馬賽克）',
  ['ic-pen', 'ic-arrow', 'ic-rect', 'ic-text', 'ic-mosaic'].every((c) => anHtml.includes(c)));
check('427   🔴 工具圖示是 [data-i18n] 元素的兄弟節點（翻譯會覆寫 textContent）', (() => {
  // 每顆工具鈕都要長成 <button …><span class="ic …"></span><span data-i18n=…>
  const btns = [...anHtml.matchAll(/<button id="(pen|arrow|rect|text|mosaic)Tool"[^>]*>([\s\S]*?)<\/button>/g)];
  return btns.length === 5 && btns.every(([, , inner]) =>
    /<span class="ic [^"]*"[^>]*>[\s\S]*?<\/span>\s*<span data-i18n=/.test(inner));
})());
check('427   🔴 下一步鈕的文字有獨立 span（.ts 換「處理中」時不會洗掉箭頭）',
  /id="saveBtnLabel"/.test(anHtml) && /getElementById\('saveBtnLabel'\)/.test(anTs)
  && !/saveBtn\.textContent/.test(anTs));
check('427   🔴 錄音鈕改切 .rec 而不是寫 textContent（否則四層麥克風圖示會被洗掉）',
  /voiceInputBtn\.classList\.add\('rec'\)/.test(anTs)
  && !/voiceInputBtn\.textContent/.test(anTs)
  && /\.voice-btn\.rec \.ic-mic \{ display: none/.test(anHtml));
check('427   🔴 鍵盤／語音切換鈕也改切 class（原本 textContent 塞 emoji）',
  !/voiceToggle\.textContent/.test(anTs)
  && /\.voice-toggle-btn\.mic-on \.ic-keyboard \{ display: none/.test(anHtml));

check('427   🔴 原生 #colorPicker / #lineWidth 仍在 DOM（.ts 的 $() 找不到會 throw、且直接讀 .value）',
  /id="colorPicker"/.test(anHtml) && /id="lineWidth"/.test(anHtml)
  && /colorPicker\.value/.test(anTs) && /lineWidthSel\.value/.test(anTs));
check('427   4 個色票 + 3 條粗細橫條，且只把值寫回原生控制項',
  (anHtml.match(/class="swatch[^"]*" data-c=/g) ?? []).length === 4
  && (anHtml.match(/class="width-opt[^"]*" data-w=/g) ?? []).length === 3
  && /colorPicker\.value = b\.dataset\.c/.test(anTs)
  && /lineWidthSel\.value = b\.dataset\.w/.test(anTs));

// 🔴 色票與粗細橫條也是 <button>，會吃到 `.toolbar button`（特異度 0,1,1）的內距與邊框。
//    選擇器必須寫成 `.toolbar button.swatch`（0,2,1）才壓得過去——寫成 `.swatch`（0,1,0）
//    的話畫面上會變成帶內距的大方塊，而且背景被 transparent 蓋掉。
check('427   🔴 色票／粗細橫條的選擇器壓得過 .toolbar button',
  /\.toolbar button\.swatch \{/.test(anHtml) && /\.toolbar button\.width-opt \{/.test(anHtml));

check('427   工具列特效改成大黃蜂色系（橘光 #ff8c00 已清）',
  /@keyframes toolbar-hornet-pulse/.test(anBody) && !/#ff8c00/i.test(anBody));
check('427   🔴 音量條顏色交給 CSS 依位置決定（.ts 不再 inline 寫死綠/紅）',
  !/#3fb950|#ef4444/i.test(anTs)
  && /#volBars \.vol-bar:nth-child\(1\)/.test(anHtml));
check('427   🔴 沒有舊紫色系色碼',
  !/#7c3aed|#6d28d9|#1a1a2e|#16213e|#059669|#dc2626|#9aa3b2/i.test(anBody));
check('427   🔴 annotate 一個 emoji 都不剩（markup + .ts + 它用得到的字典值）', (() => {
  const bad = [...onlyEmoji(anBody), ...onlyEmoji(anTs)];
  for (const m of i18n.matchAll(/^ {2}'?([A-Za-z0-9_.-]+)'?: *\{/gm)) {
    const k = m[1];
    if (!anTs.includes(`'${k}'`) && !anHtml.includes(`"${k}"`)) continue;
    let d = 1, i = m.index + m[0].length;
    while (d && i < i18n.length) { if (i18n[i] === '{') d++; else if (i18n[i] === '}') d--; i++; }
    bad.push(...onlyEmoji(i18n.slice(m.index, i)));
  }
  return [...new Set(bad)].join(' ');
})() === '');
check('427   §9.2 三步流程標記 STEP 2 / 3',
  /class="step-mark"[^>]*>STEP 2 \/ 3</.test(anHtml));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
