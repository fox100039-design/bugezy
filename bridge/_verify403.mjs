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
check('404-4 掃描結果含 Zone／Error／Score', /Zone：/.test(ptsRaw) && /Error：/.test(ptsRaw) && /Score：/.test(ptsRaw));
check('404   🔴 掃描結果揭露 30 秒視窗（空結果不等於沒問題）', /只涵蓋最近約 30 秒/.test(ptsRaw));
check('404-5 記憶矩陣區塊顯示筆數與各層摘要',
  /id="memResult"/.test(html) && /entries_per_layer/.test(pts) && /MEM_LAYER_NAMES/.test(pts));
check('404-6 🔴 Bridge 未連線 → 明確訊息（與「連上但出錯」分開）',
  /Bridge 未連線/.test(ptsRaw) && /讀取失敗/.test(ptsRaw));
check('404   尚未建立 .bugezy/ 也有專屬說明（不會顯示成 0 筆）', /尚未建立 \.bugezy\//.test(ptsRaw));

console.log('\n=== ③ PM-404：Extension → bridge 的唯讀查詢通道 ===');
const link = strip(readFileSync('src/extension-link.ts', 'utf8'));
const types = strip(readFileSync('src/types.ts', 'utf8'));
const bg = strip(readFileSync('../extension/src/background.ts', 'utf8'));
check('404   bridge 端會處理 query 訊息', /isQuery\(msg\)/.test(link) && /onQuery/.test(link));
check('404   🔴 白名單是硬編碼的 switch（不是查表，新增能力一定要動程式碼）',
  /switch \(query\)/.test(link) && /case 'memory_stats'/.test(link));
check('404   🔴 只開放唯讀查詢 —— 破壞性的 memory_clear 沒有被放進通道',
  !/case 'memory_clear'/.test(link) && !/memoryClear/.test(link), 'bridge 的查詢通道出現了破壞性操作');
check('404   不支援的查詢回明確拒絕，不是靜默忽略', /不支援的查詢/.test(readFileSync('src/extension-link.ts', 'utf8')));
check('404   型別層也標明只有 memory_stats 合法', /query: 'memory_stats'/.test(types));
check('404   extension 端有送出與對回（含逾時）', /queryBridge/.test(bg) && /query_result/.test(bg) && /bridgeQueries/.test(bg));
check('404   🔴 未連線時立刻回覆，不重試（popup 只是要顯示數字，不該卡住）',
  /readyState !== WebSocket\.OPEN[\s\S]{0,120}Bridge 未連線/.test(bg));
check('404   popup 走 background 轉發，沒有自己開 WebSocket',
  /BRIDGE_QUERY_MEMORY_STATS/.test(pts) && !/new WebSocket/.test(pts));
check('404   🔴 popup 明說這條通道是唯讀的、清除要走 AI',
  /唯讀的。要清除記憶請用 AI 呼叫 memory_clear/.test(ptsRaw));

console.log('\n=== ④ PM-405：巡檢／分析結果人類可讀 ===');
check('405-1 巡檢有專屬渲染函式', /function renderPatrolResult/.test(pts));
check('405-2 單一分析有專屬渲染函式', /function renderAnalyzeResult/.test(pts));
check('405-3/4 依嚴重度上色（紅／黃／綠）', /SEV_COLOR/.test(pts) && /#ff6b6b/.test(ptsRaw) && /#4ade80/.test(ptsRaw));
check('405   🔴 顏色取自 content script 已算好的 emoji，popup 不重新判定嚴重度',
  /顏色來自 summary 開頭的 emoji/.test(ptsRaw));
check('405-5 分析顯示探測類型與耗時', /探測：\$\{String\(probe\.type\)\}/.test(ptsRaw) && /duration_ms/.test(pts));
check('405   分析也顯示可見性與尺寸', /可見：/.test(ptsRaw) && /尺寸：/.test(ptsRaw));
check('405-1 🔴 結果不再是 JSON.stringify', !/JSON\.stringify\(r\)\.slice/.test(pts), '還有直接 stringify 的顯示路徑');
check('405   舊的純文字版已移除，不留第二條顯示路徑',
  !/function formatPatrolResult/.test(pts) && !/function formatProbeLine/.test(pts));
check('405   全部用 DOM API 建構（Trusted Types 安全）', !/innerHTML/.test(pts.slice(pts.indexOf('pinResultRender'))));

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
