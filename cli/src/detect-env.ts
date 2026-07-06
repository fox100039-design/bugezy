// detect-env.ts — PM-177：bugezy-watch 啟動時抓一次執行環境（語言/版本/OS/套件），
// 讓 AI 診斷時知道「Python 3.11 + Django 4.2 + Windows」等背景。只讀不改，失敗靜默。

import { execSync } from 'node:child_process';

export interface RuntimeEnv {
  language: string; // 'python' | 'node' | 'go' | 'unknown'
  version: string; // 'Python 3.11.5' / 'v20.11.0'
  os: string; // 'win32 x64' / 'darwin arm64' / 'linux x64'
  packages: string[]; // ['django==4.2', 'requests==2.31', …] 最多 50 個
}

// 執行一個偵測指令，捕捉 stdout（stderr 忽略）；失敗/逾時回 null，絕不拋出（不影響使用者程式）。
function run(cmd: string): string | null {
  try {
    return execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

export function detectRuntime(command: string): RuntimeEnv {
  const env: RuntimeEnv = {
    language: 'unknown',
    version: '',
    os: `${process.platform} ${process.arch}`,
    packages: [],
  };

  if (/python|django|flask|gunicorn|uvicorn|celery|fastapi|pytest|manage\.py/i.test(command)) {
    env.language = 'python';
    // 現代 Python 印到 stdout，舊版印 stderr → `2>&1`（cmd 與 sh 皆支援）合併捕捉
    env.version = run('python --version 2>&1') || run('python3 --version 2>&1') || '';
    const pip = run('pip list --format=freeze') || run('pip3 list --format=freeze');
    if (pip) {
      env.packages = pip
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 50);
    }
  } else if (/\bnode\b|npm|npx|ts-node|next|nest|express|vite/i.test(command)) {
    env.language = 'node';
    env.version = run('node --version 2>&1') || '';
    const json = run('npm list --depth=0 --json');
    if (json) {
      try {
        const deps = (JSON.parse(json).dependencies || {}) as Record<string, { version?: string }>;
        env.packages = Object.entries(deps)
          .slice(0, 50)
          .map(([k, v]) => `${k}@${v?.version || '?'}`);
      } catch {
        /* npm list JSON 解析失敗 → 略過 packages */
      }
    }
  } else if (/go\s+run|go\s+build/i.test(command)) {
    env.language = 'go';
    env.version = run('go version 2>&1') || '';
  }

  return env;
}
