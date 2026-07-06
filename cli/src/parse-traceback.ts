// parse-traceback.ts — PM-176：把 stderr 的 Python traceback / Node.js Error stack 解析成結構化 JSON，
// 讓 AI 一秒定位（type / message / frames[file,line,function,code]）。解析在「已遮罩」的文字上做。

export interface StackFrame {
  file: string;
  line: number;
  function: string;
  code: string;
}

export interface ParsedError {
  type: string; // 'KeyError' / 'TypeError' / 'Error' …
  message: string; // "'key'"
  frames: StackFrame[]; // 堆疊（Python：最外→最內；Node：由上到下）
  raw: string; // 原始（已遮罩）文字，備用
  timestamp: number;
  runtime?: 'python' | 'node'; // 來源語言
}

/**
 * 解析 Python traceback：
 *   Traceback (most recent call last):
 *     File "app.py", line 42, in main
 *       result = process_data(data)
 *   KeyError: 'key'
 */
export function parsePythonTraceback(text: string): ParsedError | null {
  const TB_START = /Traceback \(most recent call last\):/;
  const FRAME_RE = /^\s+File "(.+?)", line (\d+), in (.+)/;
  const CODE_RE = /^\s{4,}(.+)/;
  const ERROR_RE = /^(\w+(?:\.\w+)*):\s*(.*)$/;

  const match = text.match(TB_START);
  if (match?.index == null) return null;

  const lines = text.slice(match.index).split('\n');
  const frames: StackFrame[] = [];
  let errorType = '';
  let errorMessage = '';
  let currentFrame: Partial<StackFrame> | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    const frameMatch = line.match(FRAME_RE);
    if (frameMatch) {
      if (currentFrame?.file) frames.push(currentFrame as StackFrame);
      currentFrame = {
        file: frameMatch[1],
        line: parseInt(frameMatch[2], 10),
        function: frameMatch[3],
        code: '',
      };
      continue;
    }

    const codeMatch = line.match(CODE_RE);
    if (codeMatch && currentFrame) {
      currentFrame.code = codeMatch[1].trim();
      continue;
    }

    const errorMatch = line.match(ERROR_RE);
    if (errorMatch) {
      if (currentFrame?.file) frames.push(currentFrame as StackFrame);
      errorType = errorMatch[1];
      errorMessage = errorMatch[2];
      break;
    }
  }

  if (!errorType) return null;

  return { type: errorType, message: errorMessage, frames, raw: text, timestamp: Date.now(), runtime: 'python' };
}

/**
 * 解析 Node.js 的 Error stack：
 *   TypeError: Cannot read properties of undefined
 *       at Object.<anonymous> (/app/server.js:42:10)
 *       at Module._compile (node:internal/modules/cjs/loader:1105:14)
 */
export function parseNodeError(text: string): ParsedError | null {
  const ERROR_START = /^(\w*Error):\s*(.*)/m;
  const FRAME_RE = /^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?$/;

  const errorMatch = text.match(ERROR_START);
  if (!errorMatch) return null;

  const lines = text.split('\n');
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const frameMatch = line.match(FRAME_RE);
    if (frameMatch) {
      frames.push({
        file: frameMatch[2],
        line: parseInt(frameMatch[3], 10),
        function: frameMatch[1] || '<anonymous>',
        code: '',
      });
    }
  }

  return { type: errorMatch[1], message: errorMatch[2], frames, raw: text, timestamp: Date.now(), runtime: 'node' };
}
