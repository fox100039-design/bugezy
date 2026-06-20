#!/usr/bin/env node
// BugEzy Terminal Agent（PM-53）
// 用法：npx bugezy-watch -- <your command>
// 包住開發指令，透傳全部輸出，但自動把 stderr / throw / crash 攔截後送到 BugEzy API，
// AI 透過 MCP get_terminal_logs 可讀。正常輸出完全不受影響。

import { spawn } from 'node:child_process';

const API_BASE = process.env.BUGEZY_API_URL || 'https://bugezy-api.bugezy-api.workers.dev';
const BUFFER_INTERVAL = 10_000; // 每 10 秒推送一次
const MAX_BUFFER = 50; // 最多暫存 50 筆

// 錯誤關鍵字（命中 = 視為 error）
const ERROR_PATTERNS: RegExp[] = [
  /error/i,
  /Error:/,
  /TypeError/,
  /ReferenceError/,
  /SyntaxError/,
  /RangeError/,
  /URIError/,
  /EvalError/,
  /FATAL/i,
  /ENOENT/,
  /ECONNREFUSED/,
  /EADDRINUSE/,
  /Unhandled/i,
  /uncaught/i,
  /throw/i,
  /panic/i,
  /segfault/i,
  /SIGTERM/,
  /SIGKILL/,
  /SIGSEGV/,
];

// 排除的雜訊（不送）
const EXCLUDE_PATTERNS: RegExp[] = [
  /ExperimentalWarning/,
  /DeprecationWarning.*punycode/,
  /npm warn/i,
  /^$/, // 空行
];

interface TerminalLog {
  level: 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
  source: 'stderr' | 'exit';
}

const buffer: TerminalLog[] = [];
let totalCaptured = 0;

function isErrorLine(line: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(line));
}

function isExcluded(line: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => p.test(line));
}

function addToBuffer(log: TerminalLog): void {
  buffer.push(log);
  totalCaptured++;
  if (buffer.length > MAX_BUFFER) buffer.shift(); // 超過上限移除最舊
}

// ── 解析命令列：npx bugezy-watch -- npm run dev ──
const separatorIndex = process.argv.indexOf('--');
if (separatorIndex === -1 || separatorIndex === process.argv.length - 1) {
  console.log('🐛 BugEzy Terminal Agent');
  console.log('');
  console.log('用法: npx bugezy-watch -- <your command>');
  console.log('範例: npx bugezy-watch -- npm run dev');
  console.log('      npx bugezy-watch -- node server.js');
  console.log('');
  console.log('環境變數:');
  console.log('  BUGEZY_API_URL  API 端點 (預設: https://bugezy-api.bugezy-api.workers.dev)');
  process.exit(0);
}

const userCommand = process.argv.slice(separatorIndex + 1);
const cmd = userCommand[0];
const args = userCommand.slice(1);

console.log('🐛 BugEzy Terminal Agent — 監控中');
console.log(`   指令: ${userCommand.join(' ')}`);
console.log(`   API:  ${API_BASE}`);
console.log('   只攔截 stderr + error（正常輸出不影響）');
console.log('─'.repeat(50));

// ── 定時推送 ──
async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const logs = buffer.splice(0, buffer.length);
  try {
    const res = await fetch(`${API_BASE}/api/terminal-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logs,
        command: userCommand.join(' '),
        cwd: process.cwd(),
        timestamp: Date.now(),
      }),
    });
    if (!res.ok) console.error(`🐛 推送失敗: ${res.status}`);
  } catch {
    // API 不通就靜默（不影響使用者的程式）
  }
}

const flushTimer = setInterval(() => {
  void flushBuffer();
}, BUFFER_INTERVAL);

// ── 啟動子程序 ──
const child = spawn(cmd, args, {
  stdio: ['inherit', 'pipe', 'pipe'], // stdin 繼承；stdout/stderr 用 pipe 以便攔截
  shell: true,
  env: { ...process.env },
});

// stdout：原樣透傳；若內含 error 關鍵字也攔截
child.stdout?.on('data', (data: Buffer) => {
  const text = data.toString();
  process.stdout.write(text);
  for (const line of text.split('\n').filter(Boolean)) {
    if (isErrorLine(line) && !isExcluded(line)) {
      addToBuffer({ level: 'error', message: line.trim(), timestamp: Date.now(), source: 'stderr' });
    }
  }
});

// stderr：透傳 + 攔截
child.stderr?.on('data', (data: Buffer) => {
  const text = data.toString();
  process.stderr.write(text);
  for (const line of text.split('\n').filter(Boolean)) {
    if (!isExcluded(line)) {
      const level: TerminalLog['level'] = isErrorLine(line) ? 'error' : 'warn';
      addToBuffer({ level, message: line.trim(), timestamp: Date.now(), source: 'stderr' });
    }
  }
});

// 子程序結束 → 最後一次推送後退出（沿用子程序的 exit code）
child.on('exit', (code, signal) => {
  clearInterval(flushTimer);
  console.log('─'.repeat(50));
  if (code !== 0 && code !== null) {
    const msg = `程序結束，exit code: ${code}${signal ? ` (signal: ${signal})` : ''}`;
    console.log(`🐛 ${msg}`);
    addToBuffer({ level: 'error', message: msg, timestamp: Date.now(), source: 'exit' });
  }
  void flushBuffer().then(() => {
    console.log(`🐛 BugEzy Agent 結束（共攔截 ${totalCaptured} 筆）`);
    process.exit(code ?? 0);
  });
});

// 中斷轉送給子程序
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
