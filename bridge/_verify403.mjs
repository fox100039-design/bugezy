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
const EMOJI = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{2600}-\u{26FF}]/u;
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

console.log('\n=== ⑨ PM-428：群組 B · 報告編輯頁（畫面 06）===');

const erHtml = readFileSync('../extension/src/edit-report.html', 'utf8');
const erTs = strip(readFileSync('../extension/src/edit-report.ts', 'utf8'));
const erBody = stripHtmlComments(erHtml);

check('428   黃底 + 蜂巢紋 + 黑 header + STEP 3 / 3',
  /body \{[\s\S]{0,300}background: var\(--y\)/.test(erHtml)
  && /\.brand \{[\s\S]{0,120}background: var\(--ink\)/.test(erHtml)
  && /class="step-mark"[^>]*>STEP 3 \/ 3</.test(erHtml));
check('428   🔴 蜂巢紋 data URI 內沒有未編碼的 ";"',
  [...erHtml.matchAll(/background-image: url\("([^"]*)"\)/g)].every((m) => !m[1].includes(';')));
check('428   §5.B header 用嵌套六角（clip-path 會裁掉 border，不能用外框做外環）',
  /\.brand-icon \{[\s\S]{0,160}clip-path: var\(--hex\)/.test(erHtml)
  && /\.brand-icon::after \{[\s\S]{0,160}repeating-linear-gradient/.test(erHtml));
check('428   3×2 摘要格：米白格 + 2px 黑格線 + 等寬大數字',
  /\.summary-grid \{[\s\S]{0,200}grid-template-columns: repeat\(3, 1fr\)[\s\S]{0,120}background: var\(--ink\)/.test(erHtml)
  && /\.summary-grid \.sum-cell \{[\s\S]{0,120}background: var\(--cream\)/.test(erHtml)
  && /\.summary-grid b \{[\s\S]{0,80}font: 700 20px\/1\.1 var\(--font-mono\)/.test(erHtml));
check('428   摘要格是「值在上、標籤在下」，Network 那格標 .err',
  /d\.className = 'sum-cell'/.test(erTs) && /classList\.add\('err'\)/.test(erTs)
  && /d\.append\(b, label\)/.test(erTs));

check('428   🔴 播放鈕改切 .playing（textContent 會洗掉幾何三角）',
  !/playBtn\.textContent/.test(erTs)
  && /playBtn\.classList\.add\('playing'\)/.test(erTs)
  && /#markerPlayBtn\.playing \.ic-play \{ display: none/.test(erHtml));
check('428   🔴 語音鈕改切 .rec（同上）',
  !/voiceBtn\.textContent/.test(erTs)
  && /voiceBtn\.classList\.add\('rec'\)/.test(erTs)
  && /\.voice-btn\.rec \.ic-mic \{ display: none/.test(erHtml));
check('428   🔴 標記刪除鈕的交叉線由 CSS 畫（§6），.ts 只清空 textContent',
  /\.marker-delete::before, \.marker-delete::after/.test(erHtml)
  && /rotate\(45deg\)/.test(erHtml) && /delBtn\.textContent = ''/.test(erTs));
check('428   🔴 乾淨／原始模式標籤走字典（原本硬寫中文 + emoji）',
  /T\('er-clean'\) : T\('er-raw'\)/.test(erTs) && /'er-raw'/.test(i18n));
check('428   🔴 複製連結鈕的色碼從 .ts 搬到 CSS，狀態改切 .copied',
  /copyBtn\.className = 'copy-link-btn'/.test(erTs)
  && /copyBtn\.classList\.add\('copied'\)/.test(erTs)
  && /\.copy-link-btn\.copied \{/.test(erHtml)
  && !/copyBtn\.style\.cssText/.test(erTs));

check('428   §2.3 Token 面板是咖啡底 + 黃底節省膠囊',
  /\.token-panel \{[\s\S]{0,120}background: var\(--brown\)/.test(erHtml)
  && /\.token-save \{[\s\S]{0,140}background: var\(--y\)/.test(erHtml));
check('428   §7.3 空的補充說明是虛線待填狀態',
  /#descInput:placeholder-shown \{[^}]*border-style: dashed/.test(erHtml));
check('428   底部按鈕 1 : 2（捨棄描邊、上傳黑底黃字 + 硬投影）',
  /\.discard \{ flex: 1;/.test(erHtml)
  && /\.upload \{ flex: 2;[\s\S]{0,140}box-shadow: 3px 3px 0 var\(--brown-d\)/.test(erHtml));
check('428   🔴 乾淨模式 checkbox 的 accent 不能是黑色（控制列本身就是 #14110B，會看不見）',
  /\.toggle-label input\[type='checkbox'\] \{ accent-color: var\(--y\)/.test(erHtml));

check('428   🔴 舊 token 與舊紫色系全清',
  !/--bg:|--panel:|--accent:|--muted:|--success:|--danger:/.test(erBody)
  && !/#7c3aed|#6d28d9|#1a1a2e|#0f0f1a|#a78bfa|#10b981|rgba\(124, 58, 237/i.test(erBody)
  && !/#7c3aed|#6d28d9|#10b981/i.test(erTs));
check('428   🔴 edit-report 一個 emoji 都不剩（markup + .ts + 它用得到的字典值）', (() => {
  const bad = [...onlyEmoji(erBody), ...onlyEmoji(erTs)];
  for (const m of i18n.matchAll(/^ {2}'?([A-Za-z0-9_.-]+)'?: *\{/gm)) {
    const k = m[1];
    if (!erTs.includes(`'${k}'`) && !erHtml.includes(`"${k}"`)) continue;
    let d = 1, i = m.index + m[0].length;
    while (d && i < i18n.length) { if (i18n[i] === '{') d++; else if (i18n[i] === '}') d--; i++; }
    bad.push(...onlyEmoji(i18n.slice(m.index, i)));
  }
  return [...new Set(bad)].join(' ');
})() === '');

console.log('\n=== ⑩ PM-429：群組 C · content.ts 頁內注入 UI（畫面 23/24）===');

const cnRaw = readFileSync('../extension/src/content.ts', 'utf8');
const cn = strip(cnRaw);

check('429   色票集中成 HZ 常數（cssText 是字串，沒有 CSS 變數可用）',
  /const HZ = \{/.test(cn) && /y: '#F7BE00'/.test(cn) && /onDark: '#A08B62'/.test(cn));
check('429   🔴 §7.8 元素高亮改黃色雙環（#00bfff 與品牌無關）',
  !/#00bfff/i.test(cn)
  && /HIGHLIGHT_COLOR = HZ\.y/.test(cn)
  && /boxShadow: `0 0 0 3px \$\{opts\.color \|\| HIGHLIGHT_COLOR\}, 0 0 0 6px rgba\(247,190,0,\.28\)`/.test(cn));
check('429   §2.2 截圖工具列是唯一用黃底的注入元件',
  /background:\$\{HZ\.y\};border-bottom:2px solid \$\{HZ\.ink\}/.test(cn));
check('429   §2.2 其餘注入 UI 是黑殼 + 黃強調（banner / tip / card / toast / menu）',
  ['.bz-banner', '.bz-tip', '.bz-card', '.bz-toast', '.bz-menu'].every((c) => cn.includes(c))
  && /\.bz-card \{[\s\S]{0,320}background: \$\{HZ\.ink\}[\s\S]{0,220}border: 2px solid \$\{HZ\.y\}/.test(cn));
check('429   §2.1 iframe 提示用磚紅（--err）',
  /\.bz-tip\.warn \{ background: \$\{HZ\.err\}/.test(cn));

check('429   🔴 PIN_STATUS_EMOJI 與判定字串的 emoji **留著**（那是給 popup 的跨界協定）',
  /const PIN_STATUS_EMOJI/.test(cn) && /emoji: p\.resolved \? '✅' : PIN_STATUS_EMOJI\[p\.status\]/.test(cn));
check('429   🔴 但畫進頁面時要剝掉：stripSev() 存在且用在 toast 上',
  /function stripSev/.test(cn)
  && (cn.match(/stripSev\(/g) ?? []).length >= 3);
check('429   🔴 toast 改用 §7.7 左側色條表示嚴重度（不再把圓點印進文字）',
  /function pinModeToast\(text: string, sev\?: Pin\['status'\]\)/.test(cn)
  && /\.bz-toast\.sev-error \{ border-left: 3px solid \$\{HZ\.err\}/.test(cn));

check('429   🔴 六角是文字的兄弟節點（banner / 描述卡 / 降級提示條都會被 textContent 洗掉）',
  /pinModeBanner\.append\(bnHex, bnTxt\)/.test(cn)
  && /title\.append\(tHex, tTxt, tOpt\)/.test(cn)
  && /tip\.append\(tipHex, tipTxt\)/.test(cn));
check('429   §6 截圖工具列四個模式都有幾何圖示', (() => {
  // 只看 createToolbar 的函式本體 —— 釘選選單那邊也有 `b.textContent = label`，
  // 但那些項目本來就沒有圖示，不該被這條擋住。
  const i = cn.indexOf('function createToolbar');
  const body = i < 0 ? '' : cn.slice(i, cn.indexOf('\n}', i));
  return /function ssModeIcon/.test(cn) && /b\.append\(ic, tx\)/.test(body) && !/b\.textContent = label/.test(body);
})());
check('429   工具列特效改大黃蜂色系（橘光 #ff8c00 已清）',
  /@keyframes bugezy-hornet-pulse/.test(cn) && !/#ff8c00|#ffaa00/i.test(cn));
check('429   §7.7 zone badge 補了文字標籤（不只靠顏色）',
  /`ERR ×\$\{ec\}`/.test(cn) && /`WRN ×\$\{wc\}`/.test(cn));
check('429   §2.3 敏感資料警示是咖啡卡 + 黃色警示三角',
  /background:\$\{HZ\.brown\};border:2px solid \$\{HZ\.y\}/.test(cn)
  && /clip-path:polygon\(50% 0,100% 100%,0 100%\)/.test(cn));

check('429   🔴 沒有舊色碼', (() => {
  const dead = ['#00bfff', '#7c3aed', '#6d28d9', '#ff8c00', '#3fb950', '#dc2626', '#4a4a5e',
    '#1a1a2e', '#16213e', '#0f0f1a', '#ef4444', '#f59e0b', '#9aa3b2', '#e5e7eb', '#111827', '#12121f'];
  return dead.filter((c) => new RegExp(c, 'i').test(cn)).join(', ');
})() === '');
check('429   🔴 注入 UI 零 emoji（協定用的 PIN_STATUS_EMOJI／判定前綴與 console log 除外）', (() => {
  // `cn` 已經去過註解。再把三種「不是畫面」的東西整塊挖掉：
  //   ① PIN_STATUS_EMOJI 的物件字面值（它的每一行長得像 `active: '🟢',`，逐行比對抓不到）
  //   ② probeSummary 回傳的判定字串（popup 的 sevClass 靠開頭那顆 emoji 分色）
  //   ③ blog() 的 console log（不是 UI）
  let body = cn.replace(/const PIN_STATUS_EMOJI[\s\S]*?\n\};/, '');
  body = body.replace(/return \['(?:error|warning|active)',[^\n]*\n?/g, '');
  body = body.replace(/emoji: p\.resolved[^\n]*\n?/g, '');
  body = body.replace(/\bblog\([^\n]*\n?/g, '');
  const bad = [...new Set(onlyEmoji(body))];
  return bad.join(' ');
})() === '');
check('429   content.ts 用得到的字典值零 emoji', (() => {
  const bad = [];
  for (const m of i18n.matchAll(/^ {2}'?([A-Za-z0-9_.-]+)'?: *\{/gm)) {
    const k = m[1];
    if (!cn.includes(`'${k}'`)) continue;
    let d = 1, i = m.index + m[0].length;
    while (d && i < i18n.length) { if (i18n[i] === '{') d++; else if (i18n[i] === '}') d--; i++; }
    bad.push(...onlyEmoji(i18n.slice(m.index, i)));
  }
  return [...new Set(bad)].join(' ');
})() === '');

console.log('\n=== ⑪ PM-430：群組 C · inject.ts 頁內注入 UI（畫面 23/25/26/27）===');

const ijRaw = readFileSync('../extension/src/inject.ts', 'utf8');
const ij = strip(ijRaw);

check('430   色票集中成 HZ 常數（inject 是獨立 bundle，不能共用 content.ts 那份）',
  /const HZ = \{/.test(ij) && /onDark2: '#C9A15A'/.test(ij));
check('430   🔴 §3.4 三種字幕條的字級：即時 17px / Whisper 16px / 鍵盤 16px', (() => {
  const live = /font:500 17px\/1\.4 \$\{HZ\.fontUi\}/.test(ij);
  const sixteens = (ij.match(/font:500 16px\/1\.4 \$\{HZ\.fontUi\}/g) ?? []).length;
  return live && sixteens === 2;
})(), '字級不符 §3.4');
check('430   三種字幕條的邊框強調程度不同（Whisper 黃 > 即時咖啡 > 鍵盤最低調）',
  /border:1\.5px solid \$\{HZ\.y\}/.test(ij)
  && /border:1\.5px solid \$\{HZ\.brown\}/.test(ij)
  && /border:1\.5px solid \$\{HZ\.line2\}/.test(ij));
check('430   §7.6 監控徽章：無錯誤咖啡底、有錯誤黃底黑字 + glow',
  /background:\$\{HZ\.brown\};color:\$\{HZ\.yPale\}/.test(ij)
  && /monitorBadge\.style\.background = HZ\.y/.test(ij)
  && /bugezy-hz-glow 1\.6s/.test(ij));
check('430   🔴 徽章的六角是文字的兄弟節點（updateMonitorBadge 會覆寫文字）',
  /badge\.append\(badgeHex, badgeTxt\)/.test(ij)
  && /bugezy-monitor-badge-text/.test(ij)
  && !/monitorBadge\.textContent = it\(/.test(ij));
check('430   §7.7 監控面板每列左側 3px 色條，標籤是文字不是 emoji',
  /border-left:3px solid \$\{markColor\}/.test(ij)
  && /let mark = 'WRN'/.test(ij) && /mark = 'ERR'/.test(ij) && /mark = 'RES'/.test(ij));
check('430   §7.7 5xx 算 ERR（磚紅）、4xx 金黃',
  /err\.status >= 500 \? HZ\.err : HZ\.yDeep/.test(ij));
check('430   語音面板：三線拖曳把手 + 六角標題 + 收合三角（原本是 ▼ / ▶ 字元）',
  /width:13px;height:2px/.test(ij)
  && /clip-path:polygon\(0 0,100% 0,50% 100%\)/.test(ij)
  && !/toggleBtn\.textContent/.test(ij));
check('430   🔴 重啟鈕改幾何三角（原本是 🔄），30×30',
  /width:30px;height:30px/.test(ij) && !/restartBtn\.textContent/.test(ij));
check('430   §6.1 頁內麥克風授權：52×60 黃六角殼 + 反色四層麥克風',
  /width:52px;height:60px[\s\S]{0,60}background:\$\{HZ\.y\};clip-path:\$\{HZ\.hex\}/.test(ij)
  && /const micParts = \[/.test(ij)
  && !/icon\.textContent = '🎙️'/.test(ijRaw));
check('430   麥克風 overlay 遮罩用 rgba(14,12,8,.62)、卡片 308px',
  /background:rgba\(14,12,8,\.62\)/.test(ij) && /width:308px/.test(ij));
check('430   🔴 Whisper 音量柱的顏色由位置決定，.ts 不再 inline 覆寫',
  /const BAR_COLORS = \[HZ\.brown, HZ\.yDeep, HZ\.y, HZ\.yDeep, HZ\.brown\]/.test(ij)
  && !/style\.background = level > 0\.3/.test(ij));
check('430   🔴 沒有舊色碼', (() => {
  const dead = ['#7c3aed', '#6d28d9', '#a78bfa', '#1a1a2e', '#2a2a3e', '#ef4444', '#3fb950',
    '#f59e0b', '#3b82f6', '#238636', '#f85149'];
  return dead.filter((c) => new RegExp(c, 'i').test(ij)).join(', ');
})() === '');
check('430   🔴 注入 UI 零 emoji（console log 的 blog() 除外）', (() => {
  const body = ij.replace(/\bblog\([^\n]*\n?/g, '');
  return [...new Set(onlyEmoji(body))].join(' ');
})() === '');
check('430   inject.ts 用得到的字典值零 emoji', (() => {
  const bad = [];
  for (const m of i18n.matchAll(/^ {2}'?([A-Za-z0-9_.-]+)'?: *\{/gm)) {
    const k = m[1];
    if (!ij.includes(`'${k}'`)) continue;
    let d = 1, i = m.index + m[0].length;
    while (d && i < i18n.length) { if (i18n[i] === '{') d++; else if (i18n[i] === '}') d--; i++; }
    bad.push(...onlyEmoji(i18n.slice(m.index, i)));
  }
  return [...new Set(bad)].join(' ');
})() === '');

console.log('\n=== ⑫ PM-432：群組 D · 分享報告頁（畫面 14/15）===');

const srvRaw = readFileSync('../server/src/index.ts', 'utf8');
// 只看報告頁那一段（reportPageHtml + REPORT_PAGE_JS）——這個檔案 9000 行，官網部分還沒改。
const rpStart = srvRaw.indexOf('function reportPageHtml');
const rpEnd = srvRaw.indexOf('\n`;', srvRaw.indexOf('const REPORT_PAGE_JS'));
const rpRaw = srvRaw.slice(rpStart, rpEnd);
// strip() 會把 // 之後整行當註解砍掉，網址裡的 https:// 會一起消失 → 查外連要用 rpRaw。
const rp = strip(rpRaw);

check('432   黃底 + 蜂巢紋 + 黑 header',
  /body \{\s+background:var\(--y\);\s+background-image:url\("data:image\/svg\+xml,/.test(rpRaw)
  && /rgba\(20,17,11,0\.10\)/.test(rpRaw)
  && /\.topbar \{[^}]*background:var\(--ink\)/.test(rp));
check('432   🔴 蜂巢紋 data URI 內沒有未編碼的 ";"',
 (() => {
  const uris = [...rpRaw.matchAll(/background-image:url\("([^"]*)"\)/g)];
  return uris.length > 0 && uris.every((m) => !m[1].includes(';'));
})());
check('432   §5.B header 是三層嵌套六角（clip-path 會裁掉 border，不能用外框做外環）',
  /\.topbar-hex \{[^}]*clip-path:var\(--hex\)/.test(rp)
  && /\.topbar-hex > i > i \{[^}]*repeating-linear-gradient/.test(rp));
check('432   server 端頁面**可以**外連 Google Fonts（擴充功能不行是 CWS 隱私審查）',
  /fonts\.googleapis\.com\/css2\?family=Archivo/.test(rpRaw));

check('432   🔴 分享連結卡移到標題右側（節點不動，render 後搬進 #share-slot）',
  /id="share-slot"/.test(rp)
  && /shareSlot\.appendChild\(shareBox\)/.test(rp)
  && /\.share-box \{[^}]*background:var\(--brown\)/.test(rp));
check('432   §7.6 分頁徽章：Console 有錯磚紅、其餘低對比；有錯自動成預設分頁',
  /\n\s*\.tab-badge\.error \{ background:var\(--err\)/.test(rp)
  && /\.tab-btn\.active \.tab-badge\.error \{ background:var\(--err\)/.test(rp)
  && /\.tab-badge \{[^}]*rgba\(20,17,11,\.16\)/.test(rp)
  && /if \(consoleCount > 0\) defaultTab = 'console'/.test(rp));
check('432   §6 Console log 圖示：error 圓形 + 橫槓、warn 三角（形狀在 CSS，不是字元）',
  /\.log-item\.error \.log-icon \{[^}]*border-radius:50%[^}]*background:var\(--err\)/.test(rp)
  && /\.log-item\.warn \.log-icon \{[^}]*clip-path:polygon\(50% 0,100% 100%,0 100%\)/.test(rp)
  && /<span class="log-icon"><i><\/i><\/span>/.test(rp));
check('432   §7.7 Network：5xx 磚紅、4xx 較淺的褐（米白底，不是深底）',
  /\.net-status\.s5xx \{ color:var\(--err\)/.test(rp)
  && /\.net-status\.s4xx \{ color:#8A5A24/.test(rp));
check('432   §2.3 Token 面板是咖啡卡 + 黃底節省膠囊，標題色碼不再寫在 inline style',
  /\.token-panel \{[^}]*background:var\(--brown\)/.test(rp)
  && /\.token-save \{[^}]*background:var\(--y\)/.test(rp)
  && /class="token-title"/.test(rp)
  && !/color:#a78bfa/.test(rp));
check('432   Info 分頁兩欄（左內容、右 398px 側欄）',
  /\.info-col-side \{ width:398px/.test(rp) && /class="info-cols"/.test(rp));
check('432   §7.7 網路狀態改文字（原本是 🟢 在線 / 🔴 離線）',
  /fmtOnline = function \(x\) \{ return x && x\.online \? t\('在線'/.test(rp));

check('432   🔴 報告頁沒有舊色碼', (() => {
  const dead = ['#0f0f1a', '#1a1a2e', '#2a2a3e', '#7c3aed', '#a78bfa', '#238636', '#2ea043',
    '#ef4444', '#f59e0b', '#3b82f6', '#c4b5fd', '#8b949e', '#c9d1d9', '#30363d', '#0d1117',
    '#161b22', '#f0f6fc', '#21262d', '#6e7681', '#10b981', '#d29922'];
  return dead.filter((c) => new RegExp(c, 'i').test(rp)).join(', ');
})() === '');
check('432   🔴 報告頁零 emoji', [...new Set(onlyEmoji(rp))].join(' ') === '');

// /reports 我的報告列表（同一次改的，卡片說「只改 CSS 色碼」）
const rsStart = srvRaw.indexOf('function reportsShell');
const rs = strip(srvRaw.slice(rsStart, srvRaw.indexOf('async function reportsPage')));
check('432   /reports 列表頁也換成黃底 + 米白資料卡，且零 emoji、零舊色碼',
  /background:var\(--y\)/.test(rs)
  && /\.reports-table td \{[^}]*background:var\(--cream\)/.test(rs)
  && !/#0f0f1a|#1a1a2e|#7c3aed|#a78bfa|#c4b5fd|#8b8fa3|#da3633/i.test(rs)
  && onlyEmoji(rs).length === 0);

console.log('\n=== ⑬ PM-433：群組 D · 付費牆／找不到報告（畫面 16/17）===');

check('433   §6 鎖頭是四層幾何（六角殼 66×76 + 鎖扣 + 鎖身 + 鑰匙孔），形狀全在 CSS',
  /\.paywall-icon \{[^}]*width:66px; height:76px[^}]*clip-path:var\(--hex\)/.test(rp)
  && /\.paywall-icon \.lock-shackle \{[^}]*border:2\.5px solid var\(--y\); border-bottom:none; border-radius:10px 10px 0 0/.test(rp)
  && /\.paywall-icon \.lock-body \{[^}]*background:var\(--y\)/.test(rp)
  && /\.paywall-icon \.lock-body > i \{[^}]*background:var\(--ink\)/.test(rp)
  && /<i class="lock-body"><i><\/i><\/i>/.test(rp));
check('433   🔴 clip-path 會裁掉 border → 鎖扣／鎖身必須是六角殼的子元素，不能靠外框',
  /class="paywall-icon"><i class="lock-shackle"><\/i><i class="lock-body">/.test(rp)
  && !/\.paywall-icon \{[^}]*border:/.test(rp));
check('433   付費牆 560px、直接站在黃底蜂巢紋上（設計稿這頁沒有米白卡）',
  /\.paywall \{ max-width:560px/.test(rp)
  && !/\.paywall \{[^}]*background:/.test(rp));
check('433   §7.1 主按鈕硬投影 3px、次要描邊；hover 位移後投影縮成 2px',
  /\.state-btn\.primary \{ background:var\(--ink\); color:var\(--y\); box-shadow:3px 3px 0 var\(--brown-d\)/.test(rp)
  && /\.state-btn\.primary:hover \{ transform:translate\(1px,1px\); box-shadow:2px 2px 0 var\(--brown-d\)/.test(rp)
  && /\.state-btn\.secondary \{ background:transparent[^}]*border-color:rgba\(20,17,11,\.4\)/.test(rp));

check('433   §4 找不到報告用三格蜂巢：滿／空／滿（空的那格自己會說話，不靠顏色）',
  /<span class="nf-cell"><i><\/i><\/span><span class="nf-cell empty"><i><\/i><\/span><span class="nf-cell"><i><\/i><\/span>/.test(rp)
  && /\.nf-cell \{ width:26px; height:30px; background:rgba\(20,17,11,\.45\)[^}]*clip-path:var\(--hex\)/.test(rp)
  && /\.nf-cell > i \{[^}]*background:var\(--y\)/.test(rp)
  && /\.nf-cell\.empty > i \{ background:rgba\(20,17,11,\.28\)/.test(rp));
check('433   找不到報告 520px + 回首頁主按鈕',
  /\.notfound \{ max-width:520px/.test(rp)
  && /<a class="state-btn primary" href="' \+ API \+ '\/">/.test(rp));

// 這條是跨檔一致性：文案上的保留天數不能跟清理排程各說各話。
check('433   🔴 保留期限文案（7 天／90 天）跟 RETENTION_FREE_DAYS／RETENTION_PAID_DAYS 對得上', (() => {
  const free = /RETENTION_FREE_DAYS = (\d+)/.exec(srvRaw);
  const paid = /RETENTION_PAID_DAYS = (\d+)/.exec(srvRaw);
  if (!free || !paid) return false;
  const zh = /免費版保留 (\d+) 天，付費版 (\d+) 天/.exec(rp);
  const en = /(\d+) days on the free plan, (\d+) days on paid/.exec(rp);
  if (!zh || !en) return false;
  return zh[1] === free[1] && zh[2] === paid[1] && en[1] === free[1] && en[2] === paid[1];
})());

check('433   舊的單行紅字 .error-msg 已整個換掉，沒留沒人用的 class（不留死 CSS）',
  !/error-msg/.test(rp) && !/paywall-btn/.test(rp) && /renderNotFound\(\);/.test(rp));
check('433   report-page.js 快取碼跟著改（不然舊 JS 會配新 CSS）',
  /\/report-page\.js\?v=433/.test(rp));

console.log('\n=== ⑭ PM-434：群組 E · 官網共用外殼 + 首頁（畫面 28）===');

const chrome = strip(srvRaw.slice(srvRaw.indexOf('const SITE_FONTS'),
  srvRaw.indexOf('\n}\n', srvRaw.indexOf('function siteFooter')) + 3));
const home = strip(srvRaw.slice(srvRaw.indexOf('function homePage('), srvRaw.indexOf('function privacyPage(')));
const homeRaw = srvRaw.slice(srvRaw.indexOf('function homePage('), srvRaw.indexOf('function privacyPage('));

check('434   §5.B 官網 nav 是黑底 + 兩層六角（報告頁那個是三層，別抄錯）',
  /nav\.hz-nav \{[^}]*background:var\(--ink\)/.test(chrome)
  && /nav\.hz-nav \.hz-hex \{[^}]*background:var\(--y\); clip-path:var\(--hex\)/.test(chrome)
  && /nav\.hz-nav \.hz-hex > i \{[^}]*repeating-linear-gradient/.test(chrome)
  && !/\.hz-hex > i > i/.test(chrome));
check('434   🔴 nav／footer 選擇器一律「元素 + class」，否則壓不過各頁既有的 header{} footer{}',
  /nav\.hz-nav \{/.test(chrome) && /footer\.hz-foot \{/.test(chrome)
  && /footer\.hz-foot \.hz-foot-links a \{/.test(chrome)
  && !/^\s*\.hz-nav \{/m.test(chrome) && !/^\s*\.hz-foot \{/m.test(chrome));
check('434   深黑 footer #0E0C08；§2.4 沒用設計稿那個 #6B5A3D（黑底上 2.1:1）',
  /--ink-2:#0E0C08/.test(chrome)
  && /footer\.hz-foot \{[^}]*background:var\(--ink-2\)/.test(chrome)
  && !/#6B5A3D/.test(chrome));

check('434   🔴 11 個官網頁全部套用共用 nav + footer', (() => {
  const navs = (srvRaw.match(/\$\{siteNav\(lang, LANGS_/g) || []).length;
  const foots = (srvRaw.match(/\$\{siteFooter\(lang\)\}/g) || []).length;
  return navs === 11 && foots === 11;
})());
check('434   🔴 nav 的語言切換必須跟該頁 hreflang 宣告一致（PM-289 canonical 鐵則）', (() => {
  const fns = ['homePage', 'privacyPage', 'skillPage', 'guidePage', 'faqPage', 'featuresPage',
    'blogListPage', 'blogPostPage', 'testimonialsPage', 'changelogPage', 'feedbackPage'];
  return fns.every((fn) => {
    const a = srvRaw.indexOf('function ' + fn + '(');
    if (a < 0) return false;
    const seg = srvRaw.slice(a, a + 40000);
    const nav = /\$\{siteNav\(lang, (LANGS_\w+)/.exec(seg);
    const href = /\$\{hreflangTags\([^,]+, (LANGS_\w+)\)\}/.exec(seg);
    return !!nav && !!href && nav[1] === href[1];
  });
})());
check('434   舊的 🐛 header／.lang-switch／langSwitchBar 全清（不留死碼）',
  !/\u{1F41B} BugEzy<\/a><\/header>/u.test(srvRaw)
  && !/langSwitchBar/.test(srvRaw)
  && !/^\s*\.lang-switch/m.test(srvRaw.slice(srvRaw.indexOf('function homePage('), srvRaw.indexOf('function reportsShell'))));

check('434   🔴 首頁交替分節：hero(黃)→三步驟(米白)→展示(黑)→賣點(米白)→語言(咖啡)→定價(黃)→CTA(黑)',
  (home.match(/class="(?:hero|sec sec-steps|sec sec-show|sec sec-points|sec sec-langs|sec sec-price|sec-end)"/g) || []).join('|')
  === 'class="hero"|class="sec sec-steps"|class="sec sec-show"|class="sec sec-points"|class="sec sec-langs"|class="sec sec-price"|class="sec-end"');
check('434   §2.2 黃色只給三個決策點（hero／定價／—— 結尾 CTA 用黑底黃字），中間段不是黃底',
  /\.hero \{[^}]*background:var\(--y\)/.test(home)
  && /\.sec-price \{ background:var\(--y\)/.test(home)
  && /\.sec-steps \{ background:var\(--cream\)/.test(home)
  && /\.sec-show \{ background:var\(--ink\)/.test(home)
  && /\.sec-points \{ background:var\(--cream\)/.test(home)
  && /\.sec-langs \{ background:var\(--brown\)/.test(home)
  && /\.sec-end \{ background:var\(--ink\)/.test(home));
check('434   hero 用 56×98 的大蜂巢格（一般頁面是 28×49），且 data URI 內沒有未編碼的 ";"', (() => {
  const uris = [...homeRaw.matchAll(/background-image:url\("([^"]*)"\)/g)];
  return uris.length === 2 && uris.every((m) => m[1].includes("width='56' height='98'") && !m[1].includes(';'));
})());

check('434   定價區補上了 #pricing 錨點（付費牆的「了解會員方案」本來指向不存在的錨點）',
  /id="pricing"/.test(home) && /\/#pricing/.test(chrome));
check('434   §2.2 月費卡反黑 + 最划算標籤；§2.4 用 --on-dark 不是設計稿的 #8A7550',
  /\.plan\.best \{[^}]*background:var\(--ink\); box-shadow:5px 5px 0 var\(--brown\)/.test(home)
  && /\.plan \.flag \{ position:absolute; top:-13px/.test(home)
  && /\.plan\.best \.price em \{ color:var\(--on-dark\)/.test(home)
  && !/#8A7550/.test(home));
check('434   三個方案的價格跟站內其他地方一致（NT$0／NT$80／NT$20）',
  /<b>NT\$0<\/b>/.test(home) && /<b>NT\$80<\/b>/.test(home) && /<b>NT\$20<\/b>/.test(home));

check('434   §6 三步驟用六角編號 44×51、賣點用六角項目符號 11×13（原本是 emoji）',
  /\.step \.n \{ width:44px; height:51px[^}]*clip-path:var\(--hex\)/.test(home)
  && /\.point i \{ width:11px; height:13px[^}]*clip-path:var\(--hex\)/.test(home)
  && /<span class="n">1<\/span>/.test(home));
check('434   hero 實拍蜂：base64 模組 + 路由 + 340px img（Worker 沒有靜態目錄，沿用 icon-128.png 那套）',
  /import \{ HORNET_REAL_B64 \} from '\.\/hornet-png'/.test(srvRaw)
  && /path === '\/hornet-real\.png'\) return hornetPng\(\)/.test(srvRaw)
  && /<img src="\/hornet-real\.png"[^>]*width="340" height="340">/.test(home));

check('434   🔴 首頁零 emoji（含七國旗）、零舊色碼', (() => {
  const dead = ['#0f0f1a', '#1a1a2e', '#2a2a3e', '#7c3aed', '#a78bfa', '#c4b5fd', '#8b8fa3',
    '#161b22', '#21262d', '#6d28d9', '#e0e0e0', '#c9c9d6', '#9aa3b2', '#b8b8c8', '#dcdce6'];
  return onlyEmoji(home).length === 0 && !dead.some((c) => new RegExp(c, 'i').test(home));
})());
check('434   共用外殼零 emoji、零舊色碼', onlyEmoji(chrome).length === 0
  && !/#0f0f1a|#1a1a2e|#2a2a3e|#7c3aed|#a78bfa|#c4b5fd|#8b8fa3/i.test(chrome));

console.log('\n=== ⑮ PM-435：群組 E · 內容頁（畫面 29 區塊庫 A）===');

const CONTENT_PAGES = [
  ['privacy', 'function privacyPage(', 'function renderMarkdown('],
  ['skill', 'function skillPage(', 'function guidePage('],
  ['guide', 'function guidePage(', 'function faqPage('],
  ['faq', 'function faqPage(', 'function featuresPage('],
  ['features', 'function featuresPage(', 'const BLOG_CSS'],
  ['changelog', 'function changelogPage(', 'function feedbackPage('],
];
const pageSeg = (a, b) => strip(srvRaw.slice(srvRaw.indexOf(a), srvRaw.indexOf(b, srvRaw.indexOf(a))));
const contentCss = strip(srvRaw.slice(srvRaw.indexOf('const SITE_CONTENT_CSS'), srvRaw.indexOf('/** PM-434')));

check('435   🔴 六頁全部吃共用內容樣式，底色統一米白',
  CONTENT_PAGES.every(([, a, b]) => /<style>\$\{SITE_CHROME_CSS\}\$\{SITE_CONTENT_CSS\}/.test(pageSeg(a, b)))
  && /body \{[^}]*background:var\(--cream\)/.test(contentCss));
check('435   §6 條列用六角，不是 disc／✓／emoji',
  /li::before \{ content:''[^}]*clip-path:var\(--hex\)/.test(contentCss)
  && /ul \{ list-style:none/.test(contentCss)
  && !/content:"✓"/.test(srvRaw));
check('435   §7.2 白卡 + 黃色螢光筆 + §2.3 咖啡補充框都在共用樣式裡',
  /\.hz-card \{[^}]*background:#fff; border:2px solid var\(--ink\)/.test(contentCss)
  && /\.hz-mark \{ font-weight:700; background:var\(--y\)/.test(contentCss)
  && /\.hz-note \{[^}]*background:var\(--brown\)/.test(contentCss));

check('435   🔴 FAQ 三角是 CSS 邊框畫的，不是 ▼ 字元；收合白卡／展開黃底 header', (() => {
  const faq = pageSeg('function faqPage(', 'function featuresPage(');
  return /\.faq-q \{[^}]*background:#fff; border:2px solid rgba\(20,17,11,\.35\)/.test(faq)
    && /\.faq-q\.open \{[^}]*background:var\(--y\)/.test(faq)
    && /\.faq-q::after \{ content:''[^}]*border-left:6px solid var\(--ink\)/.test(faq)
    && /\.faq-q\.open::after \{[^}]*border-top:6px solid var\(--ink\)/.test(faq)
    && !/▼/.test(faq);
})());
check('435   FAQ 標題與內容是兄弟節點 → 展開態必須用 .faq-q.open + .faq-a 接（不是包在一起）',
  /\.faq-q\.open \+ \.faq-a \{/.test(pageSeg('function faqPage(', 'function featuresPage(')));

check('435   🔴 §7.3 更新日誌：最新＝實線白卡 + 黑膠囊 + 最新標籤；舊版＝虛線 + 咖啡膠囊', (() => {
  const cl = pageSeg('function changelogPage(', 'function feedbackPage(');
  return /\.changelog-entry \{[^}]*border:2px dashed rgba\(20,17,11,\.35\)/.test(cl)
    && /\.changelog-entry\.latest \{[^}]*border:2px solid var\(--ink\)/.test(cl)
    && /\.cl-ver \{[^}]*background:var\(--brown\); color:var\(--y-pale\)/.test(cl)
    && /\.changelog-entry\.latest \.cl-ver \{ background:var\(--ink\); color:var\(--y\)/.test(cl)
    && (cl.match(/<section class="changelog-entry latest">/g) || []).length === 1
    && (cl.match(/<span class="cl-ver">/g) || []).length === 5;
})());

check('435   🔴 隱私長文包成白卡 + 保留天數用黃色螢光筆 + Limited Use 是咖啡框', (() => {
  const pv = pageSeg('function privacyPage(', 'function renderMarkdown(');
  return (pv.match(/<section class="privacy-sec">/g) || []).length === 22
    && (pv.match(/<span class="hz-mark">/g) || []).length === 4
    && /\.limited-use \{[^}]*background:var\(--brown\)/.test(pv);
})());
check('435   🔴 螢光筆標的天數跟 RETENTION_FREE_DAYS／RETENTION_PAID_DAYS 對得上', (() => {
  const free = /RETENTION_FREE_DAYS = (\d+)/.exec(srvRaw);
  const paid = /RETENTION_PAID_DAYS = (\d+)/.exec(srvRaw);
  const pv = pageSeg('function privacyPage(', 'function renderMarkdown(');
  return !!free && !!paid
    && pv.includes('<span class="hz-mark">' + free[1] + ' 天</span>')
    && pv.includes('<span class="hz-mark">' + paid[1] + ' 天</span>')
    && pv.includes('<span class="hz-mark">' + free[1] + ' days</span>')
    && pv.includes('<span class="hz-mark">' + paid[1] + ' days</span>');
})());

check('435   功能頁：模式卡改六角圖示、語言膠囊沒有國旗、付費方案反黑', (() => {
  const ft = pageSeg('function featuresPage(', 'const BLOG_CSS');
  return /\.mode-card \.mi \{[^}]*clip-path:var\(--hex\)/.test(ft)
    && (ft.match(/<span class="mi"><\/span>/g) || []).length === 6
    && /\.plan3 \.pc\.hl \{ background:var\(--ink\)/.test(ft);
})());
check('435   §2.3 指南的警告／求助框是咖啡底（系統在說話），快速開始是黃底', (() => {
  const gd = pageSeg('function guidePage(', 'function faqPage(');
  return /\.warn-box \{[^}]*background:var\(--brown\)/.test(gd)
    && /\.ai-help-box \{[^}]*background:var\(--brown\)/.test(gd)
    && /\.quick-start \{[^}]*background:var\(--y\)/.test(gd);
})());

check('435   🔴 六頁零 emoji、零舊色碼', (() => {
  const dead = ['#0f0f1a', '#1a1a2e', '#2a2a3e', '#7c3aed', '#a78bfa', '#c4b5fd', '#8b8fa3',
    '#15152a', '#12121f', '#7ee0c5', '#238636', '#3fb950', '#f59e0b', '#7ee787', '#e8e8f0',
    '#6d28d9', '#fcd34d', '#d0d0d8'];
  return CONTENT_PAGES.every(([, a, b]) => {
    const seg = pageSeg(a, b);
    return onlyEmoji(seg).length === 0 && !dead.some((c) => seg.includes(c));
  });
})());
check('435   🔴 清 emoji 時 JA/KO 字典的 key 有跟著改名（makeT 以繁體原文當 key，漏改會整句掉回英文）', (() => {
  // ⚠ makeT 定義在字典「前面」，不能拿它當結尾切片（會切出空字串，斷言就永遠是綠的）。
  const mapStart = srvRaw.indexOf('const JA_MAP');
  const viStart = srvRaw.indexOf('const VI_MAP');
  const maps = srvRaw.slice(mapStart, srvRaw.indexOf('\n};', viStart) + 3);
  const keys = new Set([...maps.matchAll(/^  '((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]));
  const stale = [];
  for (const [, a, b] of CONTENT_PAGES) {
    const seg = srvRaw.slice(srvRaw.indexOf(a), srvRaw.indexOf(b, srvRaw.indexOf(a)));
    for (const m of seg.matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) {
      const zh = m[1];
      // 字典裡若還留著「emoji + 同一句」的舊 key，就是漏改
      for (const k of keys) {
        if (k === zh || !k.endsWith(zh)) continue;
        const prefix = k.slice(0, k.length - zh.length);
        // 前綴要「整段都是 emoji 或空白」才算同一句（不然 'Terminal CLI' 會誤中長句 key）
        if (prefix.trim() && onlyEmoji(prefix).length === [...prefix.trim()].length) stale.push(k);
      }
    }
  }
  return stale.length === 0;
})());

check('435   🔴 JA/KO/VI 字典的「值」也清了 emoji（日／韓／越看到的是值，不是 key）', (() => {
  const s0 = srvRaw.indexOf('const JA_MAP');
  const vi = srvRaw.indexOf('const VI_MAP');
  const maps2 = srvRaw.slice(s0, srvRaw.indexOf('\n};', vi) + 3);
  const entries = [...maps2.matchAll(/^  '(?:[^'\\]|\\.)*': '((?:[^'\\]|\\.)*)',$/gm)];
  return entries.length > 500 && entries.every((m) => onlyEmoji(m[1]).length === 0);
})());

console.log('\n=== ⑯ PM-436：群組 E · 部落格／心得／問題回報／日票（畫面 30 區塊庫 B）===');

const blogCss = strip(srvRaw.slice(srvRaw.indexOf('const BLOG_CSS'), srvRaw.indexOf('function blogListPage')));
const tCss = strip(srvRaw.slice(srvRaw.indexOf('const TESTIMONIALS_CSS'), srvRaw.indexOf('function testimonialsPage')));
const blogList = strip(srvRaw.slice(srvRaw.indexOf('function blogListPage('), srvRaw.indexOf('function blogPostPage(')));
const tPage = strip(srvRaw.slice(srvRaw.indexOf('function testimonialsPage('), srvRaw.indexOf('function changelogPage(')));
const fb = strip(srvRaw.slice(srvRaw.indexOf('function feedbackPage('), srvRaw.indexOf('function reportsShell')));
const dp = strip(srvRaw.slice(srvRaw.indexOf('function dayPassSuccessPage('), srvRaw.indexOf('// POST /api/ecpay/period-callback')));

check('436   部落格列表卡＝白卡 + 黃色硬投影，日期在標題上方、底下有「閱讀全文」',
  /\.post-item \{[^}]*background:#fff; border:2px solid var\(--ink\);\s*border-radius:14px; box-shadow:4px 4px 0 var\(--y\)/.test(blogCss)
  && /\.post-date \{ font:600 11\.5px\/1 var\(--font-mono\)/.test(blogCss)
  && /class="post-more"/.test(blogList)
  // ⚠ indexOf 找不到會回 -1，-1 永遠小於任何位置 → 兩邊都要先確認存在
  && blogList.includes('class="post-date"') && blogList.includes('<h2>')
  && blogList.indexOf('class="post-date"') < blogList.indexOf('<h2>'));
check('436   🔴 列表卡是 <li>，共用樣式的六角項目符號要關掉（不然每張卡前面多一顆）',
  /\.post-item::before \{ content:none; \}/.test(blogCss)
  && /\.t-item::before \{ content:none; \}/.test(tCss));
check('436   部落格內文：h2 靠黃色直線帶層級，**粗體** 走黃色螢光筆',
  /article h2 \{[^}]*border-left:5px solid var\(--y\)/.test(blogCss)
  && /article p \{ margin:14px 0; font:400 14\.5px\/2 var\(--font-ui\)/.test(blogCss)
  && /article strong \{ font-weight:700; background:var\(--y\)/.test(blogCss));

check('436   🔴 §2.2 心得引言卡反黑 + 六角頭像取名字首字',
  /\.t-item \{[^}]*background:var\(--ink\)/.test(tCss)
  && /\.t-ava \{ width:32px; height:37px[^}]*background:var\(--y\); clip-path:var\(--hex\)/.test(tCss)
  && /\.t-quote \{[^}]*color:var\(--y-pale\)/.test(tCss)
  && /const initial = escHtml\(\[\.\.\.item\.name\]\[0\] \|\| 'B'\)/.test(tPage)
  && !/content:"\\201C"/.test(tCss));

check('436   問題回報：Email 與類型並排、描述用虛線框、送出鈕黑底黃字 + 硬投影',
  /\.form-row \{ display:flex; gap:9px/.test(fb)
  && /\.form-row \.f-cat \{ width:150px/.test(fb)
  && /textarea \{[^}]*border:2px dashed rgba\(20,17,11,\.4\);\s*background:rgba\(255,244,214,\.55\)/.test(fb)
  && /button \{[^}]*background:var\(--ink\); color:var\(--y\)[^}]*box-shadow:3px 3px 0 var\(--brown\)/.test(fb)
  && /<div class="form-row">/.test(fb));
check('436   §7.7 送出結果不只靠顏色：成功黃底黑字、失敗磚紅底',
  /\.msg\.ok \{ background:var\(--y\); border:2px solid var\(--ink\); color:var\(--ink\)/.test(fb)
  && /\.msg\.err \{ background:var\(--err\); border:2px solid var\(--err\); color:var\(--y-pale\)/.test(fb)
  && /--err:#8A2A0F/.test(strip(srvRaw.slice(srvRaw.indexOf('const SITE_CHROME_CSS'), srvRaw.indexOf('/** PM-434')))));

check('436   🔴 日票成功頁：黃底卡 + 三顆黑六角 + 脈衝膠囊，且尊重 prefers-reduced-motion',
  /\.card\{max-width:420px;padding:28px 24px;background:var\(--y\);border:2px solid var\(--ink\)/.test(dp)
  && (dp.match(/<i><\/i><i><\/i><i><\/i>/g) || []).length === 1
  && /\.hexes i\{width:20px;height:23px;background:var\(--ink\);clip-path:var\(--hex\);\}/.test(dp)
  && /animation:hz-pulse 1\.4s infinite/.test(dp)
  && /prefers-reduced-motion:reduce\)\{\.pill i\{animation:none/.test(dp));
check('436   🔴 日票膠囊不做假倒數（這頁沒有使用者身分，查不到 day_pass_expires_at）',
  /<span>24 小時無限使用<\/span>/.test(dp)
  && !/setInterval|toLocaleTimeString|剩餘/.test(dp));

check('436   🔴 四頁零 emoji、零舊色碼', (() => {
  const dead = ['#0f0f1a', '#1a1a2e', '#2a2a3e', '#7c3aed', '#a78bfa', '#c4b5fd', '#8b8fa3',
    '#b8b8c8', '#d0d0d8', '#6b7280', '#7ee787', '#22c55e', '#ef4444', '#e0e0e0', '#e8e8f0', '#6d28d9'];
  return [blogCss, tCss, blogList, tPage, fb, dp].every(
    (seg) => onlyEmoji(seg).length === 0 && !dead.some((c) => seg.includes(c)));
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
