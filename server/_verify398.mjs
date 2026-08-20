// PM-398/399 驗收：MCP30 票券 + 兌換時驗證 MCP 使用紀錄。
//
// ⚠ server 端沒有既有的驗收腳本慣例（邏輯都在 Workers + Supabase 裡，
//   單元測試要 mock 整個 PostgREST，成本遠高於價值）。所以這支做兩件事：
//   ① **原始碼層面的不變式**——順序、fail-closed、退路，這些寫錯了線上也看不出來
//   ② **線上端點的實際行為**——能在沒有使用者 token 的前提下驗到的部分
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

const src = readFileSync('src/index.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

console.log('\n=== ① PM-398 步驟 2：兌換時的 MCP 驗證 ===');
check('398   有 MCP_VERIFIED_CODES 集合（之後加代碼只要一行）', /MCP_VERIFIED_CODES\s*=\s*new Set\(\['MCP30'\]\)/.test(code));
check('398-4 🔴 BUG10 不在需要驗證的清單裡（既有流程不受影響）',
  /new Set\(\['MCP30'\]\)/.test(code) && !/MCP_VERIFIED_CODES[\s\S]{0,80}BUG10/.test(code));
check('398   查的是 mcp_usage 且以 user_id 過濾', /\.from\('mcp_usage'\)[\s\S]{0,120}\.eq\('user_id', userId\)/.test(code));

// 順序：重複兌換檢查 → MCP 驗證 → 搶名額
const iDup = code.indexOf("你已兌換過此代碼");
const iMcp = code.indexOf('MCP_VERIFIED_CODES.has(code)');
const iCas = code.indexOf('if (p.max_uses !== null) {');
check('398   🔴 MCP 驗證排在「搶名額」之前（資格不符的人不該占掉限量名額）',
  iDup > 0 && iMcp > iDup && iCas > iMcp, `dup=${iDup} mcp=${iMcp} cas=${iCas}`);

console.log('\n=== ② fail closed：查不出來時不發券 ===');
check('398   🔴 查詢失敗回 null，與「確定沒有」分開處理',
  /return null;[\s\S]{0,40}\}[\s\S]{0,80}return \(data\?\.length \?\? 0\) > 0;/.test(code)
  || /console\.error\('mcp_usage 查詢失敗/.test(src));
check('398   🔴 查不出來 → **不發券**（fail closed，不是失敗即放行）',
  /used === null[\s\S]{0,200}無法驗證 MCP 使用紀錄/.test(code), '查詢失敗時可能放行了');
check('398   查不出來與「你還沒接 MCP」是不同訊息（否則使用者會一直重試沒做錯的事）',
  /無法驗證 MCP 使用紀錄/.test(src) && /請先完成 MCP 對接/.test(src));
check('398-2 沒有 MCP 紀錄 → 友善提示且附教學連結',
  /請先完成 MCP 對接[\s\S]{0,80}bugezy\.dev\/guide/.test(src));
check('398   回傳帶 need_mcp 旗標，前端可據此顯示引導', /need_mcp:\s*true/.test(code));

console.log('\n=== ③ PM-398 驗收 5：mcp_usage 要有 user_id 才查得到 ===');
check('398-5 🔴 logMcpUsage 現在會寫 user_id（原本完全沒有使用者維度）',
  /user_id: userId/.test(code) && /logMcpUsage/.test(code));
check('398-5 身分來自 MCP URL 的 ?token=（每請求一份 env 副本）',
  /const token = env\.__mcp_session_token \|\| '';[\s\S]{0,160}verifySessionByToken\(token, env\)/.test(code));
check('398-5 🔴 欄位還沒建時有退路（否則會靜靜停止寫入所有用量紀錄）',
  /const res = await post\(\{ \.\.\.base, user_id: userId \}\);[\s\S]{0,80}if \(!res\.ok\) await post\(base\);/.test(code),
  '沒有看到 fallback');
check('398-5 沒有 token（未帶 ?token=）仍照舊寫入，不會因此漏記',
  /if \(!userId\) \{[\s\S]{0,60}await post\(base\);[\s\S]{0,30}return;/.test(code));

console.log('\n=== ③b PM-401：工具參數的 session_token 也要記到 user_id ===');
check('401   logMcpUsage 接受呼叫端已驗證的 userId', /knownUserId\?: string,/.test(code));
check('401   優先用已驗證的 userId，沒有才退回 URL token',
  /const userId = knownUserId \|\| \(token \? await verifySessionByToken\(token, env\) : null\);/.test(code));
check('401   txtWithTokens 有透傳 knownUserId',
  /await logMcpUsage\(env, toolName, est, reportId, knownUserId\);/.test(code));
for (const tool of ['list_reports', 'get_live_errors', 'get_terminal_logs', 'get_usage_quota']) {
  check(`401-1 ${tool} 把已驗證的 userId 傳給用量記錄`,
    new RegExp(`'${tool}', undefined, `).test(code), '沒看到第四個參數');
}
check('401   🔴 沒有改用「把 token 回填進 env」的做法（那是 PM-190 明確提醒要避開的競態樣式）',
  !/env\.__mcp_session_token\s*=[^=]/.test(code), '出現了對 env.__mcp_session_token 的賦值');
check('401-3 🔴 完全沒有 token 時 userId 為 null，照舊寫入不報錯',
  /if \(!userId\) \{[\s\S]{0,60}await post\(base\);[\s\S]{0,30}return;/.test(code));
check('401   🔴 只有「驗證過 token 屬於該使用者」之後才帶 userId',
  /return txtWithTokens\(\[\], 'list_reports'\);/.test(code),
  'list_reports 在「查無此 email」時不該帶 userId —— 那時根本還沒驗證身分');
check('401-2 🔴 URL 帶 token 的舊路徑沒有被拿掉（向下相容）',
  /const token = env\.__mcp_session_token \|\| '';/.test(code));

console.log('\n=== ④ SQL 腳本（FOX 手動執行的部分）===');
const sql = readFileSync('mcp30-ticket.sql', 'utf8');
check('398-1 有建立 MCP30 的 INSERT（30 天、不限量、啟用）',
  /INSERT INTO promo_codes[\s\S]*'MCP30'[\s\S]*30[\s\S]*NULL[\s\S]*true/.test(sql));
check('398   INSERT 可重複執行不會壞', /ON CONFLICT \(code\) DO NOTHING/.test(sql));
check('398-5 🔴 有 ALTER 補 mcp_usage.user_id（卡片沒寫，但少了它整個功能不會動）',
  /ALTER TABLE mcp_usage ADD COLUMN IF NOT EXISTS user_id/.test(sql));
check('398   有加索引（兌換是 WHERE user_id 的查詢）',
  /CREATE INDEX IF NOT EXISTS[\s\S]*mcp_usage \(user_id\)/.test(sql));
check('398   🔴 明說舊資料沒有歸屬、部署後要再呼叫一次才算數',
  /舊資料一定是 0/.test(sql) && /再呼叫一次任何 MCP 工具/.test(sql));

console.log('\n=== ⑤ 線上端點實際行為（能在沒有使用者 token 下驗到的部分）===');
const BASE = 'https://bugezy-api.bugezy-api.workers.dev';
const post = async (path, body, hdrs = {}) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'bugezy-verify/1.0', ...hdrs },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};
const noAuth = await post('/api/promo/redeem', { code: 'MCP30' });
check('399   未登入兌換 MCP30 → 401（認證閘門在最前面）', noAuth.status === 401, JSON.stringify(noAuth));
const badTok = await post('/api/promo/redeem', { code: 'MCP30' }, { Authorization: 'Bearer fake-token-1234567890' });
check('399   假 token → 401（不會漏進兌換流程）', badTok.status === 401, JSON.stringify(badTok));
check('399   🔴 未登入時不會洩漏「MCP30 這個代碼存不存在」', !/MCP30|無效的活動代碼/.test(noAuth.text), noAuth.text);
const bug10 = await post('/api/promo/redeem', { code: 'BUG10' });
check('398-4 BUG10 走同一條路徑、行為一致（同樣先擋認證）', bug10.status === 401, JSON.stringify(bug10));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) {
  console.log('\n⚠ 已登入後的實際兌換（有／沒有 MCP 紀錄、重複兌換）需要真實 session token，');
  console.log('  且必須先在 Supabase 跑完 server/mcp30-ticket.sql —— 見 DONE-399。');
}
process.exit(fail ? 1 : 0);
