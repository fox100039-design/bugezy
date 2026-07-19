// annotate.ts — 截圖標注畫布（擴充內頁面）
// 從 storage 讀暫存截圖 → 畫到 canvas → 四種工具標注 → 完成存回 background。
//
// 工具：✏️ 畫筆(freehand) / ➡️ 箭頭 / ⬜ 框框 / 📝 文字
// undo：history stack（每次操作前 snapshot），clear：還原底圖。

import {
  ALLOW_SCREENSHOT_KEY,
  API_BASE,
  KEYBOARD_MODE_KEY,
  LANG_KEY,
  MIC_KEY,
  MIC_MODE_KEY,
  SESSION_KEY,
  SPEECH_LANG_MAP,
  STATE_KEY,
  STORAGE_KEY,
  TOOLBAR_EFFECT_KEY,
  USER_PLAN_KEY,
  blog,
  type Session,
} from './types';
import { getAuthHeaderOnly } from './auth';
import { t, getUILang, type UILang } from './i18n';
import { toSimplified } from './t2s'; // PM-248 修2：zh-CN 語音轉錄繁轉簡
import { getNetworkSnapshot } from './net'; // PM-156：網路環境快照

// PM-139：截圖標注頁 i18n（annotate 是擴充頁，有 chrome.storage，直接讀 LANG_KEY）。
let annotateUILang: UILang = 'zh';
// PM-248 修1：語音辨識語言跟隨 popup（原本寫死 zh-TW）。BCP-47 語碼，同 inject/edit-report。
let annotateSpeechLang = 'zh-TW';
function applyAnnotateTranslations() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key, annotateUILang);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (key) (el as HTMLTextAreaElement | HTMLInputElement).placeholder = t(key, annotateUILang);
  });
}
void chrome.storage.local.get(LANG_KEY, (r) => {
  annotateUILang = getUILang((r[LANG_KEY] as string) || 'zh');
  // PM-248 修1：LANG_KEY → BCP-47 語碼（powered speechToSrLang 同源），createAnnotateRecognition 用。
  annotateSpeechLang = SPEECH_LANG_MAP[(r[LANG_KEY] as string) || 'zh'] || 'zh-TW';
  applyAnnotateTranslations();
});

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
const mosaicTool = $<HTMLButtonElement>('mosaicTool'); // PM-185
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
// PM-101/104：工具列入場橘光脈衝，播完（7 秒）切靜態微光（不持續閃）
toolbar?.addEventListener('animationend', () => {
  (toolbar as HTMLElement).classList.add('glow-settled');
});
// PM-104：依 popup「工具列特效」開關（預設 ON）決定是否播入場脈衝
chrome.storage.local.get(TOOLBAR_EFFECT_KEY, (store) => {
  if (store[TOOLBAR_EFFECT_KEY] !== false) toolbar?.classList.add('fx-on');
});

const params = new URLSearchParams(location.search);
const key = params.get('key');

// PM-186：敏感欄位座標型別 + storage keys（提示/自動遮罩統一在 init 處理，避免雙提示）
interface SensitiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}
const SENSITIVE_DETECTED_KEY = 'bugezy:sensitive-detected';
const SENSITIVE_RECTS_KEY = 'bugezy:sensitive-rects';

/** PM-186：在 (x,y,w,h) 區域畫馬賽克（blockSize 網格取平均色），供自動遮罩敏感欄位。 */
function applyMosaic(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const block = 10;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvas.width, x + w);
  const y1 = Math.min(canvas.height, y + h);
  for (let bx = x0; bx < x1; bx += block) {
    for (let by = y0; by < y1; by += block) {
      const pw = Math.min(block, x1 - bx);
      const ph = Math.min(block, y1 - by);
      if (pw <= 0 || ph <= 0) continue;
      const px = c.getImageData(bx, by, pw, ph).data;
      let r = 0,
        g = 0,
        b = 0;
      const n = px.length / 4;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      c.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
      c.fillRect(bx, by, pw, ph);
    }
  }
}

// ── 工具狀態 ──────────────────────────────────────────────
type Tool = 'pen' | 'arrow' | 'rect' | 'text' | 'mosaic'; // PM-185：+mosaic
let currentTool: Tool = 'pen';
const MOSAIC_SIZE = 16; // PM-185：馬賽克方塊邊長（canvas 像素）
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
  mosaic: mosaicTool,
};

function setTool(tool: Tool) {
  currentTool = tool;
  (Object.keys(toolButtons) as Tool[]).forEach((t) => {
    toolButtons[t].classList.toggle('active', t === tool);
  });
  canvas.style.cursor = tool === 'mosaic' ? 'crosshair' : 'crosshair';
}
penTool.addEventListener('click', () => setTool('pen'));
arrowTool.addEventListener('click', () => setTool('arrow'));
rectTool.addEventListener('click', () => setTool('rect'));
textTool.addEventListener('click', () => setTool('text'));
mosaicTool.addEventListener('click', () => setTool('mosaic'));

/** PM-185：在 (x,y) 所屬的網格方塊填該區平均色，模擬馬賽克。 */
function paintMosaic(x: number, y: number) {
  const bx = Math.floor(x / MOSAIC_SIZE) * MOSAIC_SIZE;
  const by = Math.floor(y / MOSAIC_SIZE) * MOSAIC_SIZE;
  const w = Math.min(MOSAIC_SIZE, canvas.width - bx);
  const h = Math.min(MOSAIC_SIZE, canvas.height - by);
  if (w <= 0 || h <= 0) return;
  const img = ctx!.getImageData(bx, by, w, h);
  const px = img.data;
  let r = 0,
    g = 0,
    b = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
  }
  ctx!.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  ctx!.fillRect(bx, by, w, h);
}

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
  } else if (currentTool === 'mosaic') {
    paintMosaic(x, y); // PM-185：單擊也塗一格
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const { x, y } = pos(e);
  if (currentTool === 'mosaic') {
    paintMosaic(x, y); // PM-185：拖曳塗抹馬賽克（不用 snapshot 預覽，直接累積）
    return;
  }
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
  onstart: (() => void) | null; // PM-248 修4
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

// PM-100：問題描述左邊「語音／鍵盤」臨時快速切換鈕。
// icon ⌨️ = 目前語音模式（點我切鍵盤）；icon 🎙️ = 目前鍵盤模式（點我切語音）。
// 只影響這次標注，下次截圖重新載入頁面就恢復預設語音。
const voiceToggle = $<HTMLButtonElement>('voice-toggle');
let voiceOn = true;
function setVoiceToggleUI(on: boolean): void {
  voiceOn = on;
  voiceToggle.textContent = on ? '⌨️' : '🎙️';
  voiceToggle.title = on ? '切換到鍵盤輸入' : '切換到語音輸入';
  voiceToggle.classList.toggle('mic-on', !on); // 鍵盤模式時亮綠框
}
voiceToggle.addEventListener('click', () => {
  if (voiceOn) {
    setVoiceToggleUI(false);
    stopListening(); // 臨時關麥，改鍵盤打字
  } else {
    setVoiceToggleUI(true);
    void startListening(); // 復用頁面載入時同一條語音啟動邏輯
  }
});

// PM-42：套用 inject.ts PM-32/33 穩定模式——工廠建全新實例 + onend 失敗計數。
let autoRestartFails = 0;
// PM-248 修3：interim 節流（韓語組字風暴防護，同 PM-240）。
let lastAnnotateInterimUpdate = 0;
const ANNOTATE_INTERIM_THROTTLE = 150;
// PM-248 修4：記 session 啟動時間，onend 判斷 >1s 才歸零失敗計數（防韓語短命 session 無限循環，同 PM-240）。
let lastAnnotateRecStart = 0;
// PM-248 修5：只有粵語/越南語需要 stale interim 自動升級（同 PM-247）。
const ANNOTATE_NEEDS_PROMOTE = new Set(['yue-Hant-HK', 'vi']);
let annotateInterimTimer: ReturnType<typeof setTimeout> | null = null;
let annotateLastInterim = '';
// PM-248 修6：記最近升級文字供 final 去重（同 PM-246）。
let annotatePromotedText = '';
let annotatePromotedTime = 0;
/** PM-248 修6：取消待升級 timer（僅動 timer + lastInterim；保留 promoted 供 final 去重）。 */
function cancelAnnotateInterimTimer() {
  if (annotateInterimTimer) {
    clearTimeout(annotateInterimTimer);
    annotateInterimTimer = null;
  }
  annotateLastInterim = '';
}
/** PM-248 修6：停錄完整清除（timer + lastInterim + promoted 追蹤）。 */
function clearAnnotatePromote() {
  cancelAnnotateInterimTimer();
  annotatePromotedText = '';
  annotatePromotedTime = 0;
}

function createAnnotateRecognition(): SRInst | null {
  if (!SR) return null;
  const rec = new SR();
  rec.lang = annotateSpeechLang; // PM-248 修1：跟隨 popup 語言（原寫死 zh-TW）
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e: SREvt) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        // PM-248 修6：真 final → 取消待升級 timer（保留 promoted 供去重）。
        cancelAnnotateInterimTimer();
        // PM-248 修2：Chrome zh-CN 辨識回傳仍繁體，final 繁轉簡（其他語言零影響）。
        let text = res[0].transcript;
        if (annotateSpeechLang === 'zh-CN') text = toSimplified(text);
        // PM-248 修6：去重——若這段 final 在 5 秒內已被 stale interim 升級寫入過（相同或互為子集），跳過。
        const dup =
          annotatePromotedText !== '' &&
          Date.now() - annotatePromotedTime < 5000 &&
          (text === annotatePromotedText ||
            annotatePromotedText.includes(text) ||
            text.includes(annotatePromotedText));
        annotatePromotedText = '';
        annotatePromotedTime = 0;
        if (dup) continue;
        // PM-31 Bug4：append 到末端，但若 cursor 原本不在末端則保留原位（不干擾中間編輯）
        const cursorPos = descInput.selectionStart;
        const isAtEnd = cursorPos === descInput.value.length;
        descInput.value += text; // 確定的文字 → 文字框（PM-208：語音直接進補充說明）
        if (!isAtEnd) {
          descInput.selectionStart = cursorPos;
          descInput.selectionEnd = cursorPos;
        }
        captionText.textContent = `✅ ${text}`;
        window.setTimeout(() => {
          if (listening) captionText.textContent = t('er-listening', annotateUILang); // PM-248 修7
        }, 1500);
      } else {
        // PM-248 修2：zh-CN interim 也繁轉簡
        let seg = res[0].transcript;
        if (annotateSpeechLang === 'zh-CN') seg = toSimplified(seg);
        interim = seg;

        // PM-248 修5：粵語/越南語 stale interim 3 秒未變 → 自動寫入文字框（帶語言守門）。
        if (ANNOTATE_NEEDS_PROMOTE.has(annotateSpeechLang) && seg !== annotateLastInterim) {
          annotateLastInterim = seg;
          if (annotateInterimTimer) clearTimeout(annotateInterimTimer);
          annotateInterimTimer = setTimeout(() => {
            annotateInterimTimer = null;
            if (annotateLastInterim && listening) {
              const promoted = annotateLastInterim;
              const cursorPos = descInput.selectionStart;
              const isAtEnd = cursorPos === descInput.value.length;
              descInput.value += promoted;
              if (!isAtEnd) {
                descInput.selectionStart = cursorPos;
                descInput.selectionEnd = cursorPos;
              }
              captionText.textContent = t('er-listening', annotateUILang);
              annotateLastInterim = '';
              // PM-248 修6：記錄升級文字 + 時間供隨後補發的 isFinal 去重。
              annotatePromotedText = promoted;
              annotatePromotedTime = Date.now();
            }
          }, 3000);
        }
      }
    }
    if (interim) {
      // PM-248 修3：interim 字幕節流 150ms（防韓語組字風暴淹沒 DOM；final 不受限）。
      const now = Date.now();
      if (now - lastAnnotateInterimUpdate >= ANNOTATE_INTERIM_THROTTLE) {
        captionText.textContent = `🔴 ${interim}`; // 正在講的 → 即時字幕
        lastAnnotateInterimUpdate = now;
      }
      liveCaptions.classList.remove('hidden');
    }
  };
  // PM-248 修4：記啟動時間，不在此歸零失敗計數（改 onend 判 session 夠長才歸零，防韓語短命循環）。
  rec.onstart = () => {
    lastAnnotateRecStart = Date.now();
  };
  rec.onend = () => {
    // 靜默自停 → 仍在聽就重啟；連續失敗 3 次改用 getUserMedia 刷新 + 新實例
    if (listening) {
      // PM-248 修4：只有持續 >1s 的正常 session 才歸零；短命 session（韓語瞬間 onstart→onend）不歸零。
      if (Date.now() - lastAnnotateRecStart > 1000) autoRestartFails = 0;
      try {
        rec.start();
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
                captionText.textContent = t('er-restarted', annotateUILang); // PM-248 修7
              }
            } catch {
              captionText.textContent = t('er-voice-interrupted', annotateUILang); // PM-248 修7
              stopListening();
            }
          })();
        }
      }
    }
  };
  rec.onerror = (e: SRErr) => {
    captionText.textContent = `語音錯誤：${e.error}`;
    // PM-100：語音授權/服務失敗 → 自動退回鍵盤並更新切換鈕（不含 no-speech：
    // no-speech 只是靜默，onend 會自動重啟，若在此切鍵盤會讓每次停頓都殺掉麥克風）。
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setVoiceToggleUI(false);
      stopListening();
    }
  };

  return rec;
}

// PM-21：載入即自動聽。final → 寫入文字框，interim → 即時字幕（浮在畫布上）
// PM-147：免費版/未開 Whisper 走這條（Web Speech API，即時字幕、零成本）。
async function startWebSpeech() {
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
  captionText.textContent = t('annotate-listening', annotateUILang); // PM-248 修7
  liveCaptions.classList.remove('hidden');
}

function stopWebSpeech() {
  if (!listening) return;
  listening = false;
  clearAnnotatePromote(); // PM-248 修6：停錄清除待升級 timer + promoted 追蹤
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

// ── PM-147：付費版 Whisper 語音（MediaRecorder 錄音 → /api/transcribe）──────────
// 條件：付費（paid/cancelled/day_pass）+ popup Whisper toggle（MIC_MODE_KEY==='whisper'）。
// 免費版或 toggle OFF 走 Web Speech（上方）。server /api/transcribe 另有付費檢查（PM-135），
// 故非付費即使誤走 Whisper 也會被 403 擋，這裡以 UI 提示引導。
let useWhisper = false;
let whisperRecorder: MediaRecorder | null = null;
let whisperChunks: Blob[] = [];
let whisperStream: MediaStream | null = null;
// PM-208：截圖語音本來就即時 append 進 descInput（補充說明），存檔時 description 保留完整內容、
// voiceTranscript 留空——不再獨立拆存語音（移除 PM-206/207 的 voiceAccumulated / isManuallyEdited）。
// 編輯報告頁的「語音記錄」區改標示「截圖模式：語音已在補充說明」。

// ── PM-205：Whisper 錄音音量條（AnalyserNode + rAF，5 條綠色跳動，與 popup/inject 視覺一致）──
let volAudioCtx: AudioContext | null = null;
let volAnalyser: AnalyserNode | null = null;
let volRaf = 0;

function updateVolBars(level: number) {
  document.querySelectorAll<HTMLElement>('#volBars .vol-bar').forEach((b, i) => {
    const threshold = (i + 1) / 5;
    const h = level >= threshold ? 4 + 16 * level + Math.random() * 4 : 4;
    b.style.height = `${Math.min(h, 20)}px`;
    b.style.background = level > 0.3 ? '#3fb950' : '#ef4444'; // 講話綠、安靜紅
  });
}

async function startVolumeMeter(stream: MediaStream) {
  try {
    volAudioCtx = new AudioContext();
    // 麥克風擷取型 context 允許無 gesture resume（PM-192 offscreen 同理），確保 analyser 運轉
    if (volAudioCtx.state === 'suspended') await volAudioCtx.resume().catch(() => {});
    const source = volAudioCtx.createMediaStreamSource(stream);
    volAnalyser = volAudioCtx.createAnalyser();
    volAnalyser.fftSize = 256;
    source.connect(volAnalyser);
    const data = new Uint8Array(volAnalyser.frequencyBinCount);
    document.getElementById('volBars')?.classList.remove('hidden');
    const tick = () => {
      if (!volAnalyser) return; // stopVolumeMeter 已清空 → 停迴圈
      volAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      updateVolBars(Math.min(avg / 128, 1));
      volRaf = requestAnimationFrame(tick);
    };
    volRaf = requestAnimationFrame(tick);
  } catch (err) {
    blog('音量條啟動失敗', err);
  }
}

function stopVolumeMeter() {
  if (volRaf) cancelAnimationFrame(volRaf);
  volRaf = 0;
  volAnalyser = null;
  if (volAudioCtx) {
    void volAudioCtx.close();
    volAudioCtx = null;
  }
  const bars = document.getElementById('volBars');
  if (bars) {
    bars.classList.add('hidden');
    bars.querySelectorAll<HTMLElement>('.vol-bar').forEach((b) => {
      b.style.height = '4px';
      b.style.background = '#ef4444';
    });
  }
}

function releaseWhisperStream() {
  whisperStream?.getTracks().forEach((tk) => tk.stop());
  whisperStream = null;
}

async function startWhisper() {
  if (listening) return;
  try {
    whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    voiceStatus.textContent = '❌ 麥克風無法存取';
    return;
  }
  whisperChunks = [];
  whisperRecorder = new MediaRecorder(whisperStream, { mimeType: 'audio/webm' });
  whisperRecorder.ondataavailable = (e) => {
    if (e.data.size) whisperChunks.push(e.data);
  };
  whisperRecorder.start();
  listening = true;
  voiceInputBtn.classList.add('listening');
  voiceInputBtn.textContent = '⏹';
  voiceStatus.textContent = '';
  captionText.textContent = t('an-whisper-recording', annotateUILang); // PM-250
  liveCaptions.classList.remove('hidden');
  void startVolumeMeter(whisperStream); // PM-205：綠色音量條跳動
}

async function stopWhisper() {
  if (!listening) return;
  listening = false;
  voiceInputBtn.classList.remove('listening');
  voiceInputBtn.textContent = '🎤';
  stopVolumeMeter(); // PM-205：停止音量條（停止錄音當下即隱藏）
  const rec = whisperRecorder;
  whisperRecorder = null;
  if (!rec || rec.state === 'inactive') {
    releaseWhisperStream();
    liveCaptions.classList.add('hidden');
    return;
  }
  // 等 recorder 真的停止 + chunks 收齊
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    try {
      rec.stop();
    } catch {
      resolve();
    }
  });
  releaseWhisperStream();
  const blob = new Blob(whisperChunks, { type: 'audio/webm' });
  whisperChunks = [];
  if (blob.size < 1000) {
    voiceStatus.textContent = '語音太短';
    liveCaptions.classList.add('hidden');
    return;
  }
  voiceStatus.textContent = t('an-whisper-transcribing', annotateUILang); // PM-250
  captionText.textContent = '⏳ 轉錄中…';
  try {
    const form = new FormData();
    form.append('audio', blob, 'annotate-voice.webm'); // server handleTranscribe 讀 'audio' 欄
    const langStore = await chrome.storage.local.get(LANG_KEY);
    form.append('language', (langStore[LANG_KEY] as string) || 'zh'); // PM-147：帶語言設定
    const res = await fetch(`${API_BASE}/api/transcribe`, {
      method: 'POST',
      headers: await getAuthHeaderOnly(), // multipart：只帶 Authorization，不設 Content-Type
      body: form,
    });
    const data = (await res.json()) as { text?: string; error?: string };
    if (res.ok && data.text) {
      descInput.value += (descInput.value ? ' ' : '') + data.text;
      voiceStatus.textContent = '✅ 已轉錄';
    } else if (res.status === 403) {
      voiceStatus.textContent = t('an-whisper-paid-only', annotateUILang); // PM-250
    } else {
      voiceStatus.textContent = '轉錄失敗，可改用鍵盤輸入';
    }
  } catch {
    voiceStatus.textContent = '轉錄失敗，可改用鍵盤輸入';
  } finally {
    liveCaptions.classList.add('hidden');
  }
}

// PM-147：語音輸入分派——依 useWhisper 走 Whisper 或 Web Speech。
async function startListening() {
  return useWhisper ? startWhisper() : startWebSpeech();
}
async function stopListening() {
  return useWhisper ? stopWhisper() : stopWebSpeech();
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
// PM-49：鍵盤模式則不自動啟動語音。PM-147：付費 + Whisper toggle → 走 Whisper（不自動錄，按 🎤 才錄）。
// PM-210：語音是否啟用與錄製流程一致——除鍵盤模式外，也要 MIC_KEY 開啟才自動錄語音
//   （截圖麥克風提示選「直接錄製（不錄語音）」→ MIC_KEY 維持 off → 此處不自動啟動語音）。
chrome.storage.local.get([KEYBOARD_MODE_KEY, USER_PLAN_KEY, MIC_MODE_KEY, MIC_KEY], (r) => {
  // PM-147：判斷語音引擎——付費（paid/cancelled/day_pass）+ popup Whisper toggle 才走 Whisper
  const plan = (r[USER_PLAN_KEY] as string) || 'free';
  const isPaid = plan === 'paid' || plan === 'cancelled' || plan === 'day_pass';
  const micMode = (r[MIC_MODE_KEY] as string) || 'whisper'; // 付費預設 whisper（與錄製流程 computeStartFlags 一致）
  useWhisper = isPaid && micMode === 'whisper';
  const micOn = r[MIC_KEY] === true;

  if (r[KEYBOARD_MODE_KEY] === true) {
    voiceStatus.textContent = '🔇 鍵盤模式（語音已關閉）';
    setVoiceToggleUI(false); // PM-100：頁面本就鍵盤模式 → 切換鈕同步顯示 🎙️
  } else if (!micOn) {
    // PM-210：麥克風關閉（截圖「直接錄製不錄語音」）→ 不自動錄語音；仍可手動按 🎤 開啟
    voiceStatus.textContent = '🔇 語音已關閉（可按 🎤 開啟）';
    setVoiceToggleUI(false);
  } else if (useWhisper) {
    // Whisper 模式不自動錄音（避免整段長錄音爆量/超 25MB）——引導使用者手動按 🎤
    voiceStatus.textContent = t('an-whisper-prompt', annotateUILang); // PM-250
  } else {
    window.setTimeout(() => void startListening(), 800);
  }
});

// ── 儲存（PM-18：截圖獨立上傳為一份報告）/ 取消 ──────────
saveBtn.addEventListener('click', async () => {
  const annotatedDataUrl = canvas.toDataURL('image/png');
  await stopListening(); // PM-147：存檔前停止語音；Whisper 模式會等轉錄完成才續（描述才進得去）
  // PM-83：讀 popup「高畫質 AI 分析」開關，截圖上傳時帶入報告設定（預設 false 省 token）
  // PM-98：同時讀登入 session，把 user_id 綁進報告（與 background 錄製上傳一致）——
  // 否則截圖報告沒有 owner，MCP list_reports（依 user_id 過濾）永遠查不到。
  const ssStore = await chrome.storage.local.get([ALLOW_SCREENSHOT_KEY, SESSION_KEY]);
  const allowScreenshotImages = ssStore[ALLOW_SCREENSHOT_KEY] === true;
  const session = ssStore[SESSION_KEY] as Session | undefined;
  // PM-181：向 background 取截圖當下收集的 console/network（截圖流程於 SCREENSHOT_READY 快取）——
  // 讓截圖報告也有錯誤上下文（AI 精準定位），不再只有畫面+語音。
  const collected = (await chrome.runtime
    .sendMessage({ type: 'GET_COLLECTED_ERRORS' })
    .catch(() => null)) as { consoleLogs?: unknown[]; networkErrors?: unknown[] } | null;
  const payload = {
    rrwebEvents: [],
    consoleLogs: collected?.consoleLogs ?? [],
    networkErrors: collected?.networkErrors ?? [],
    // PM-208：截圖報告不獨立存語音——語音已即時併入 description（補充說明）。voiceTranscript 留空，
    // 編輯報告頁的「語音記錄」區改顯示「截圖模式：語音已在補充說明」提示。
    voiceTranscript: [],
    screenshots: [{ dataUrl: annotatedDataUrl, timestamp: Date.now() }],
    description: descInput.value.trim(), // 含語音 + 手動編輯的完整內容
    allow_screenshot_images: allowScreenshotImages,
    ...(session?.user_id ? { user_id: session.user_id } : {}),
    // PM-156：截圖標注也帶網路快照（annotate 是擴充頁，可直接用 navigator API）
    networkSnapshot: { atStart: getNetworkSnapshot() },
    pageInfo: {
      url: params.get('pageUrl') ?? '',
      title: params.get('pageTitle') ?? '',
      browser: navigator.userAgent,
      screenSize: `${screen.width}x${screen.height}`,
      timestamp: new Date().toISOString(),
    },
  };

  // PM-204：截圖標注完不直接上傳——存進 STORAGE_KEY（與錄製報告同一入口）後導到編輯報告頁，
  // 讓使用者檢視截圖預覽 + 補語音/描述 + 看 Token 估算 + AI 校正後再確認上傳（流程與錄製一致）。
  saveBtn.textContent = '⏳ 處理中...';
  saveBtn.disabled = true;
  try {
    // 清掉上一場錄製的 STATE_KEY 摘要，避免編輯頁顯示到殘留的時長/計數
    await chrome.storage.local.set({ [STORAGE_KEY]: payload });
    await chrome.storage.local.remove(STATE_KEY);
    if (key) await chrome.storage.local.remove(key); // 清截圖暫存底圖
    blog('截圖標注完成 → 導向編輯報告頁');
    chrome.tabs.create({ url: chrome.runtime.getURL('edit-report.html') });
  } catch (err) {
    blog('截圖存暫存失敗', err);
  }
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
  baseImage = ctx!.getImageData(0, 0, canvas.width, canvas.height); // 原始（未遮罩），供撤銷/清除還原
  blog('標注頁載入截圖', `${canvas.width}x${canvas.height}`);

  // PM-186：自動遮罩敏感欄位（預設安全）+ 提示；沒有座標則回退 PM-185 偵測提示
  const s = await chrome.storage.local.get([SENSITIVE_RECTS_KEY, SENSITIVE_DETECTED_KEY]);
  void chrome.storage.local.remove([SENSITIVE_RECTS_KEY, SENSITIVE_DETECTED_KEY]);
  const payload = s[SENSITIVE_RECTS_KEY] as
    | { rects?: SensitiveRect[]; viewportWidth?: number; viewportHeight?: number }
    | undefined;
  const tip = document.getElementById('sensitiveTip');
  let autoMasked = 0;
  if (payload?.rects?.length && (payload.viewportWidth ?? 0) > 0 && (payload.viewportHeight ?? 0) > 0) {
    const scaleX = canvas.width / payload.viewportWidth!;
    const scaleY = canvas.height / payload.viewportHeight!;
    // 只在「整頁截圖」（canvas 與 viewport 比例一致）自動遮罩——區域/自由截圖是裁切，座標會錯位，
    // 強行遮罩反而蓋錯地方造成假安全，故略過（改靠手動筆刷 + PM-185 警告）。
    if (Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) < 0.05) {
      for (const r of payload.rects) {
        applyMosaic(ctx!, Math.round(r.x * scaleX), Math.round(r.y * scaleY), Math.round(r.width * scaleX), Math.round(r.height * scaleY));
      }
      autoMasked = payload.rects.length;
    }
  }
  if (tip) {
    if (autoMasked > 0) {
      // PM-186：已自動遮罩 N 個 + 撤銷遮罩（還原原始截圖）
      tip.textContent = t('auto-masked', annotateUILang, { n: autoMasked }) + '  ';
      const undoBtn = document.createElement('button');
      undoBtn.textContent = t('undo-mask', annotateUILang);
      undoBtn.style.cssText =
        'margin-left:8px;background:#fff;color:#000;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px;font-weight:600;';
      undoBtn.onclick = () => {
        if (baseImage) ctx!.putImageData(baseImage, 0, 0); // 還原未遮罩原圖
        tip.style.display = 'none';
      };
      tip.appendChild(undoBtn);
      tip.style.display = 'block';
    } else if (s[SENSITIVE_DETECTED_KEY]) {
      // PM-185：偵測到但未自動遮罩（如區域截圖）→ 提示手動塗
      tip.textContent = t('sensitive-tip', annotateUILang);
      tip.style.display = 'block';
    }
  }
}
void init();
