// annotate.ts — 截圖標注畫布（擴充內頁面）
// 從 storage 讀暫存截圖 → 畫到 canvas → 四種工具標注 → 完成存回 background。
//
// 工具：✏️ 畫筆(freehand) / ➡️ 箭頭 / ⬜ 框框 / 📝 文字
// undo：history stack（每次操作前 snapshot），clear：還原底圖。

import { API_BASE, blog, type ControlMessage } from './types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d context 不可用');

const penTool = $<HTMLButtonElement>('penTool');
const arrowTool = $<HTMLButtonElement>('arrowTool');
const rectTool = $<HTMLButtonElement>('rectTool');
const textTool = $<HTMLButtonElement>('textTool');
const colorPicker = $<HTMLInputElement>('colorPicker');
const lineWidthSel = $<HTMLSelectElement>('lineWidth');
const undoBtn = $<HTMLButtonElement>('undoBtn');
const clearBtn = $<HTMLButtonElement>('clearBtn');
const cancelBtn = $<HTMLButtonElement>('cancelBtn');
const saveBtn = $<HTMLButtonElement>('saveBtn');
const descInput = $<HTMLTextAreaElement>('descInput');
const voiceInputBtn = $<HTMLButtonElement>('voiceInputBtn');
const voiceStatus = $<HTMLDivElement>('voiceStatus');

// PM-26：標注頁的 AI 精簡按鈕已從 annotate.html 移除（截圖補充說明不需要），
// 故移除對應的 summarizeBtn 邏輯，避免 $('summarizeBtn') 在載入時 throw 使整頁失效。

// PM-23：工具列按鈕 mousedown 不搶焦點，否則會打斷 SpeechRecognition。
// 排除 color input / select（它們需要焦點展開選單）。click 仍正常觸發。
const toolbar = document.querySelector('.toolbar');
toolbar?.addEventListener('mousedown', (e) => {
  const tag = (e.target as HTMLElement).tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'select') e.preventDefault();
});

const params = new URLSearchParams(location.search);
const key = params.get('key');

// ── 工具狀態 ──────────────────────────────────────────────
type Tool = 'pen' | 'arrow' | 'rect' | 'text';
let currentTool: Tool = 'pen';
let drawing = false;
let startX = 0;
let startY = 0;
let snapshot: ImageData | null = null; // 拖曳預覽用（形狀工具）
let baseImage: ImageData | null = null; // 原始底圖（清除全部用）
const history: ImageData[] = []; // undo stack

const toolButtons: Record<Tool, HTMLButtonElement> = {
  pen: penTool,
  arrow: arrowTool,
  rect: rectTool,
  text: textTool,
};

function setTool(tool: Tool) {
  currentTool = tool;
  (Object.keys(toolButtons) as Tool[]).forEach((t) => {
    toolButtons[t].classList.toggle('active', t === tool);
  });
}
penTool.addEventListener('click', () => setTool('pen'));
arrowTool.addEventListener('click', () => setTool('arrow'));
rectTool.addEventListener('click', () => setTool('rect'));
textTool.addEventListener('click', () => setTool('text'));

// ── 畫圖工具 ──────────────────────────────────────────────
function applyStyle() {
  ctx!.strokeStyle = colorPicker.value;
  ctx!.fillStyle = colorPicker.value;
  ctx!.lineWidth = Number(lineWidthSel.value);
  ctx!.lineCap = 'round';
  ctx!.lineJoin = 'round';
}

function fontSize(): number {
  return 12 + Number(lineWidthSel.value) * 4; // 細20 / 中28 / 粗44
}

function saveState() {
  history.push(ctx!.getImageData(0, 0, canvas.width, canvas.height));
  if (history.length > 50) history.shift(); // 限制 50 步
}

/** 螢幕座標 → canvas 像素座標（處理 CSS 縮放） */
function pos(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

/** 線 + 三角箭頭 */
function drawArrow(x1: number, y1: number, x2: number, y2: number) {
  const head = Math.max(10, Number(lineWidthSel.value) * 3);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx!.beginPath();
  ctx!.moveTo(x1, y1);
  ctx!.lineTo(x2, y2);
  ctx!.stroke();
  ctx!.beginPath();
  ctx!.moveTo(x2, y2);
  ctx!.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx!.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx!.closePath();
  ctx!.fill();
}

canvas.addEventListener('mousedown', (e) => {
  const { x, y } = pos(e);

  if (currentTool === 'text') {
    const text = prompt('輸入文字：');
    if (text) {
      saveState();
      applyStyle();
      ctx!.font = `${fontSize()}px system-ui, sans-serif`;
      ctx!.textBaseline = 'top';
      ctx!.fillText(text, x, y);
    }
    return;
  }

  drawing = true;
  startX = x;
  startY = y;
  saveState();
  snapshot = ctx!.getImageData(0, 0, canvas.width, canvas.height);
  if (currentTool === 'pen') {
    applyStyle();
    ctx!.beginPath();
    ctx!.moveTo(x, y);
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const { x, y } = pos(e);
  applyStyle();
  if (currentTool === 'pen') {
    ctx!.lineTo(x, y);
    ctx!.stroke();
  } else if (snapshot) {
    // 形狀工具：每次移動先還原 snapshot 再重畫，達成即時預覽
    ctx!.putImageData(snapshot, 0, 0);
    if (currentTool === 'rect') {
      ctx!.strokeRect(startX, startY, x - startX, y - startY);
    } else if (currentTool === 'arrow') {
      drawArrow(startX, startY, x, y);
    }
  }
});

function endDraw() {
  drawing = false;
  snapshot = null;
}
canvas.addEventListener('mouseup', endDraw);
canvas.addEventListener('mouseleave', endDraw);

// ── undo / clear ──────────────────────────────────────────
undoBtn.addEventListener('click', () => {
  const prev = history.pop();
  if (prev) ctx!.putImageData(prev, 0, 0);
});
clearBtn.addEventListener('click', () => {
  if (!baseImage) return;
  saveState();
  ctx!.putImageData(baseImage, 0, 0);
});

// ── 語音輸入（PM-20，Web Speech API；annotate 是擴充頁，授權歸擴充）──
interface SRAlt {
  readonly transcript: string;
}
interface SRRes {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [i: number]: SRAlt;
}
interface SREvt {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [i: number]: SRRes };
}
interface SRErr {
  readonly error: string;
}
interface SRInst {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SREvt) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SRErr) => void) | null;
  start(): void;
  stop(): void;
}
type SRCtor = new () => SRInst;

const win = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
const SR = win.SpeechRecognition || win.webkitSpeechRecognition;

let recognition: SRInst | null = null;
let listening = false;

const captionText = $('captionText');
const liveCaptions = $('liveCaptions');

// PM-42：套用 inject.ts PM-32/33 穩定模式——工廠建全新實例 + onend 失敗計數。
let autoRestartFails = 0;

function createAnnotateRecognition(): SRInst | null {
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'zh-TW';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e: SREvt) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0].transcript;
      if (res.isFinal) {
        // PM-31 Bug4：append 到末端，但若 cursor 原本不在末端則保留原位（不干擾中間編輯）
        const cursorPos = descInput.selectionStart;
        const isAtEnd = cursorPos === descInput.value.length;
        descInput.value += text; // 確定的文字 → 文字框
        if (!isAtEnd) {
          descInput.selectionStart = cursorPos;
          descInput.selectionEnd = cursorPos;
        }
        captionText.textContent = `✅ ${text}`;
        window.setTimeout(() => {
          if (listening) captionText.textContent = '🔴 聆聽中...';
        }, 1500);
      } else {
        interim = text;
      }
    }
    if (interim) {
      captionText.textContent = `🔴 ${interim}`; // 正在講的 → 即時字幕
      liveCaptions.classList.remove('hidden');
    }
  };
  rec.onend = () => {
    // 靜默自停 → 仍在聽就重啟；連續失敗 3 次改用 getUserMedia 刷新 + 新實例
    if (listening) {
      try {
        rec.start();
        autoRestartFails = 0;
      } catch {
        autoRestartFails++;
        if (autoRestartFails >= 3) {
          // PM-43：getUserMedia 刷新音訊管線 + 建全新實例重啟
          void (async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach((t) => t.stop());
              await new Promise((r) => setTimeout(r, 300));
              if (!listening) return; // 期間使用者已停止
              recognition = createAnnotateRecognition();
              if (recognition) {
                recognition.start();
                autoRestartFails = 0;
                captionText.textContent = '🔴 語音已重啟...';
              }
            } catch {
              captionText.textContent = '⚠ 語音中斷，按 🎤 重新啟動';
              stopListening();
            }
          })();
        }
      }
    }
  };
  rec.onerror = (e: SRErr) => {
    captionText.textContent = `語音錯誤：${e.error}`;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopListening();
  };

  return rec;
}

// PM-21：載入即自動聽。final → 寫入文字框，interim → 即時字幕（浮在畫布上）
async function startListening() {
  if (!SR || listening) return;
  // PM-42：先用 getUserMedia 刷新音訊管線
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    voiceStatus.textContent = '❌ 麥克風無法存取';
    return;
  }
  autoRestartFails = 0;
  recognition = createAnnotateRecognition();
  if (!recognition) return;
  recognition.start();
  listening = true;
  voiceInputBtn.classList.add('listening');
  voiceInputBtn.textContent = '⏹';
  voiceStatus.textContent = '';
  captionText.textContent = '🔴 聆聽中，邊畫邊說描述問題...';
  liveCaptions.classList.remove('hidden');
}

function stopListening() {
  if (!listening) return;
  listening = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* 忽略 */
    }
    recognition = null;
  }
  voiceInputBtn.classList.remove('listening');
  voiceInputBtn.textContent = '🎤';
  voiceStatus.textContent = '語音已停止';
  liveCaptions.classList.add('hidden');
}

voiceInputBtn.addEventListener('click', () => {
  if (!SR) {
    voiceStatus.textContent = '此瀏覽器不支援語音辨識';
    return;
  }
  if (listening) stopListening();
  else startListening();
});

// 載入後自動開始聽（延遲等 canvas 渲染 + 麥克風授權）
window.setTimeout(() => startListening(), 800);

// ── 儲存（PM-18：截圖獨立上傳為一份報告）/ 取消 ──────────
saveBtn.addEventListener('click', async () => {
  const annotatedDataUrl = canvas.toDataURL('image/png');
  stopListening(); // 存檔前停止語音辨識
  const payload = {
    rrwebEvents: [],
    consoleLogs: [],
    networkErrors: [],
    voiceTranscript: [],
    screenshots: [{ dataUrl: annotatedDataUrl, timestamp: Date.now() }],
    description: descInput.value.trim(),
    pageInfo: {
      url: params.get('pageUrl') ?? '',
      title: params.get('pageTitle') ?? '',
      browser: navigator.userAgent,
      screenSize: `${screen.width}x${screen.height}`,
      timestamp: new Date().toISOString(),
    },
  };

  saveBtn.textContent = '⏳ 上傳中...';
  saveBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { report_id?: string; share_url?: string };
    if (data.share_url && data.report_id) {
      await chrome.runtime.sendMessage({
        type: 'SCREENSHOT_UPLOADED',
        shareUrl: data.share_url,
        reportId: data.report_id,
      } satisfies ControlMessage);
      blog('截圖獨立上傳完成', data.share_url);
    }
  } catch (err) {
    blog('截圖上傳失敗', err);
  }

  if (key) await chrome.storage.local.remove(key);
  window.close();
});
cancelBtn.addEventListener('click', async () => {
  stopListening();
  if (key) await chrome.storage.local.remove(key); // 取消：刪暫存
  window.close();
});

// ── 初始化：載入暫存截圖當底圖 ────────────────────────────
async function init() {
  if (!key) {
    document.body.textContent = '缺少截圖 key';
    return;
  }
  const store = await chrome.storage.local.get(key);
  const dataUrl = store[key] as string | undefined;
  if (!dataUrl) {
    document.body.textContent = '找不到暫存截圖';
    return;
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx!.drawImage(img, 0, 0);
  baseImage = ctx!.getImageData(0, 0, canvas.width, canvas.height);
  blog('標注頁載入截圖', `${canvas.width}x${canvas.height}`);
}
void init();
