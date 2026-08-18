// PM-327（§11.2 / PM-D2）：終端機即時監控。
//
// bridge 本身就是 Node process，可以直接 spawn 指令並攔 stderr，
// **完全不經過 Extension 或 Chrome** —— 這條路徑跟瀏覽器工具是獨立的。
//
// 與 bugezy-watch CLI 的差別（PM-326 盤點）：
//   · CLI 是**單向推送**（每 10 秒 POST /api/terminal-logs），沒有讀取通道
//   · 這裡是**本機滾動緩存 + 隨叫隨取**，不上傳任何東西
//   解析與遮罩沿用 CLI 的同一份程式碼（見 src/vendor/）。

import { spawn, type ChildProcess } from 'node:child_process';
import { maskStderr } from './vendor/pii-mask.js';
import { checkCommand } from './command-guard.js';

/** PM-373：進 maskStderr 前先限長（理由同 pii-browser：不動共用 regex，改在呼叫端截斷）。 */
const MAX_STDERR_CHUNK = 32 * 1024;
const clampStderr = (t: string) => (t.length <= MAX_STDERR_CHUNK ? t : t.slice(0, MAX_STDERR_CHUNK) + ' ...<truncated>');
import { parseNodeError, parsePythonTraceback, type ParsedError } from './vendor/parse-traceback.js';
import { log } from './extension-link.js';

/** 後端錯誤的保留窗口。比瀏覽器端的 30 秒長——編譯／重啟一輪就可能超過半分鐘。 */
export const TERMINAL_WINDOW_MS = 120_000;
/** 同時監控上限，避免 AI 連續呼叫把機器 spawn 爆。 */
export const MAX_MONITORS = 5;
/** 單一 monitor 的錯誤筆數上限（防某個服務狂噴 log 吃光記憶體）。 */
const MAX_ERRORS_PER_MONITOR = 500;

export interface TerminalError extends ParsedError {
  severity: 'error' | 'warn';
}

interface Monitor {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  pid: number | undefined;
  startedAt: number;
  status: 'running' | 'stopped';
  exitCode: number | null;
  errors: Array<{ at: number; data: TerminalError }>;
  /** 未解析成 traceback 的 stderr 行（仍然遮罩過），保底用 */
  rawLines: Array<{ at: number; line: string }>;
}

const monitors = new Map<string, Monitor>();
let seq = 0;

function prune(m: Monitor): void {
  const cutoff = Date.now() - TERMINAL_WINDOW_MS;
  m.errors = m.errors.filter((e) => e.at > cutoff).slice(-MAX_ERRORS_PER_MONITOR);
  m.rawLines = m.rawLines.filter((e) => e.at > cutoff).slice(-MAX_ERRORS_PER_MONITOR);
}

export function startTerminalMonitor(command: string, cwd?: string): Record<string, unknown> {
  if (!command.trim()) return { error: '缺少 command 參數' };

  // PM-368：白名單 + shell 元字元兩道檢查，**都過才 spawn**。
  //   呼叫這支的是 AI，而 AI 讀得到攻擊者可控的頁面內容 —— 提示注入不需要任何漏洞
  //   就能變成 RCE。錯誤訊息回原文（未遮罩）是刻意的：使用者要看得出自己哪裡寫錯，
  //   而被拒絕的指令從來沒有執行過，也不會被存進緩存。
  const guard = checkCommand(command);
  if (!guard.ok) return { error: guard.error, command_rejected: true };

  const running = [...monitors.values()].filter((m) => m.status === 'running');
  if (running.length >= MAX_MONITORS) {
    return {
      error: `同時監控的指令已達上限 ${MAX_MONITORS} 個。請先用 stop_terminal_monitor 停掉不需要的，或等既有的結束。`,
        running_monitors: running.map((m) => ({ monitor_id: m.id, command: maskStderr(m.command) })),
    };
  }

  const id = `mon${++seq}-${Date.now().toString(36)}`;
  let child: ChildProcess;
  try {
    // shell:true 才能吃 `npm run dev` 這種含空白與 shell 語法的指令
    child = spawn(command, { cwd: cwd || process.cwd(), shell: true });
  } catch (e) {
    return { error: `無法啟動指令：${e instanceof Error ? e.message : String(e)}` };
  }

  const m: Monitor = {
    id,
    command,
    cwd: cwd || process.cwd(),
    child,
    pid: child.pid,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    errors: [],
    rawLines: [],
  };

  let pending = '';
  const onStderr = (chunk: Buffer) => {
    // 🔴 先遮罩再解析——與 CLI 同順序。反過來的話，traceback 的 raw 欄位會存到未遮罩的原文。
    const masked = maskStderr(clampStderr(pending + chunk.toString()));
    pending = '';
    const parsed: ParsedError | null = parsePythonTraceback(masked) ?? parseNodeError(masked);
    const at = Date.now();
    if (parsed) {
      m.errors.push({ at, data: { ...parsed, severity: 'error' } });
    } else {
      for (const line of masked.split('\n')) {
        const t = line.trim();
        if (t) m.rawLines.push({ at, line: t });
      }
    }
    prune(m);
  };
  child.stderr?.on('data', onStderr);
  // stdout 也看：很多工具（Vite / Next）把錯誤印在 stdout
  child.stdout?.on('data', (c: Buffer) => {
    const masked = maskStderr(clampStderr(c.toString()));
    const parsed = parsePythonTraceback(masked) ?? parseNodeError(masked);
    if (parsed) {
      m.errors.push({ at: Date.now(), data: { ...parsed, severity: 'error' } });
      prune(m);
    }
  });

  child.on('exit', (code) => {
    m.status = 'stopped';
    m.exitCode = code;
    // PM-391：**這裡也要遮罩**。PM-327 當時把四處「回傳值」的指令回聲都遮了，
    //   但漏掉這兩行 log —— 而 stderr 會被 MCP client 寫進 log 檔，那份檔案通常沒人在管權限，
    //   `DATABASE_URL=postgres://u:pw@h/db npm run dev` 這種寫法就這樣落地成明文。
    log(`⏹ terminal monitor ${id} 結束（exit ${code}）：${maskStderr(command)}`);
  });
  child.on('error', (e) => {
    m.status = 'stopped';
    m.errors.push({
      at: Date.now(),
      data: {
        type: 'SpawnError',
        message: e.message,
        frames: [],
        raw: e.message,
        timestamp: Date.now(),
        severity: 'error',
      },
    });
  });

  monitors.set(id, m);
  log(`▶ terminal monitor ${id} 已啟動（pid ${child.pid}）：${maskStderr(command)}`); // PM-391：同上，遮罩後才寫 stderr
  return { monitor_id: id, command: maskStderr(command), cwd: m.cwd, pid: child.pid ?? null, status: 'running' };
}

export function getTerminalLiveErrors(monitorId?: string): Record<string, unknown> {
  const all = [...monitors.values()];
  if (all.length === 0) {
    return {
      error: '目前沒有任何終端機監控。請先用 start_terminal_monitor 啟動一個（例如 command: "npm run dev"）。',
    };
  }
  // 省略 → 最近啟動的那個
  const m = monitorId ? monitors.get(monitorId) : all[all.length - 1];
  if (!m) {
    return { error: `找不到 monitor ${monitorId}`, available: all.map((x) => x.id) };
  }
  prune(m);
  return {
    monitor_id: m.id,
    // 🔴 指令本身也要遮罩：`DATABASE_URL=postgres://u:pw@h/db npm run dev` 這種寫法極常見，
    //    而這個欄位每次呼叫都會回傳給 AI ——不遮的話等於把憑證反覆送進 AI 的 context。
    //    （這個洞是 PM-327 的測試抓到的：錯誤內容有遮，但回聲的 command 沒遮。）
    command: maskStderr(m.command),
    cwd: m.cwd,
    pid: m.pid ?? null,
    status: m.status,
    ...(m.status === 'stopped' ? { exit_code: m.exitCode } : {}),
    uptime_seconds: Math.round((Date.now() - m.startedAt) / 1000),
    errors: m.errors.map((e) => e.data),
    unparsed_stderr: m.rawLines.slice(-50).map((r) => r.line),
    total_count: m.errors.length,
    window_seconds: TERMINAL_WINDOW_MS / 1000,
    note:
      `只涵蓋最近 ${TERMINAL_WINDOW_MS / 1000} 秒。` +
      'errors 是解析成功的 traceback（含 type/message/frames）；unparsed_stderr 是解析不出結構的 stderr 原文（已遮罩），' +
      '**空的 errors 不代表沒問題**——可能是該語言的格式尚未支援，請一併看 unparsed_stderr。',
  };
}

export function stopTerminalMonitor(monitorId?: string): Record<string, unknown> {
  const all = [...monitors.values()];
  const m = monitorId ? monitors.get(monitorId) : all[all.length - 1];
  if (!m) return { error: monitorId ? `找不到 monitor ${monitorId}` : '目前沒有任何終端機監控' };
  if (m.status === 'running') killMonitor(m);
  return { monitor_id: m.id, command: maskStderr(m.command), status: 'stopped', exit_code: m.exitCode };
}

function killMonitor(m: Monitor): void {
  try {
    // Windows 上 shell:true 會多一層 cmd.exe，只殺 child 會留下孫程序（PM-310 踩過同樣的坑）
    if (process.platform === 'win32' && m.pid) {
      spawn('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      m.child.kill('SIGKILL');
    }
  } catch {
    /* 已經死了就算了 */
  }
  m.status = 'stopped';
}

/** bridge 結束時呼叫——不收的話被監控的 `npm run dev` 會變成孤兒繼續占著 port。 */
export function stopAllTerminalMonitors(): void {
  for (const m of monitors.values()) if (m.status === 'running') killMonitor(m);
}
