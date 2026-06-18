// content.ts — 在 ISOLATED world 執行
// 橋接：background（chrome API）<->  inject.ts（MAIN world，window.postMessage）
// 自己不錄製，只負責轉送指令與打包資料。
//
// PM-04：加診斷 log，確認雙向 postMessage 通訊是否跑通。

import {
  BUGEZY_SOURCE,
  STORAGE_KEY,
  blog,
  type ControlMessage,
  type InjectCommand,
  type InjectMessage,
  type RecordingPayload,
  type RecordingSummary,
  type StateResponse,
} from './types';

blog('content loaded（ISOLATED world）', location.href);

let injectReady = false;

function sendToInject(cmd: 'START' | 'STOP') {
  const msg: InjectCommand = { source: BUGEZY_SOURCE, dir: 'to-inject', cmd };
  blog(`→ 轉送 ${cmd} 給 inject（injectReady=${injectReady}）`);
  window.postMessage(msg, '*');
}

function summarize(payload: RecordingPayload): RecordingSummary {
  return {
    domEvents: payload.rrwebEvents.length,
    consoleLogs: payload.consoleLogs.length,
    networkErrors: payload.networkErrors.length,
    pageInfo: payload.pageInfo,
    durationMs: 0, // 由 background 依 startedAt 回填
    voiceSegments: payload.voiceTranscript.length,
    uploadStatus: 'idle', // 由 background RECORDING_DONE 後接手上傳
    shareUrl: null,
    uploadError: null,
  };
}

// inject.ts 的回報訊息（READY / STARTED / RESULT）
window.addEventListener('message', async (e: MessageEvent) => {
  if (e.source !== window) return;
  const data = e.data as InjectMessage;
  if (!data || data.source !== BUGEZY_SOURCE || data.dir !== 'to-content') return;

  // PM-34：即時 flush 訊息 → 轉發給 background 暫存到 chrome.storage.local
  if (data.kind === 'FLUSH_VOICE') {
    chrome.runtime.sendMessage({ type: 'FLUSH_VOICE', segment: data.segment });
    return;
  }
  if (data.kind === 'FLUSH_CONSOLE') {
    chrome.runtime.sendMessage({ type: 'FLUSH_CONSOLE', log: data.log });
    return;
  }
  if (data.kind === 'FLUSH_NETWORK') {
    chrome.runtime.sendMessage({ type: 'FLUSH_NETWORK', error: data.error });
    return;
  }
  if (data.kind === 'FLUSH_RRWEB') {
    chrome.runtime.sendMessage({ type: 'FLUSH_RRWEB', events: data.events });
    return;
  }

  // PM-36：inject 要歷史語音 → 跟 background 拿 buffer → 回填給 inject（to-inject）
  if (data.kind === 'REQUEST_VOICE_HISTORY') {
    chrome.runtime.sendMessage({ type: 'GET_VOICE_BUFFER' }, (response) => {
      const segments = (response as { segments?: unknown[] } | undefined)?.segments;
      if (segments && segments.length > 0) {
        window.postMessage(
          { source: BUGEZY_SOURCE, dir: 'to-inject', kind: 'VOICE_HISTORY', segments },
          '*',
        );
      }
    });
    return;
  }

  if (data.kind === 'READY') {
    injectReady = true;
    blog('✓ inject 已報到（READY）');
    return;
  }

  if (data.kind === 'STARTED') {
    blog(`✓ inject 已開始錄製（rrwebOk=${data.rrwebOk}）`);
    return;
  }

  if (data.kind === 'RESULT') {
    const payload = data.payload;
    // 不再需要合併語音 — inject 已自帶 voiceTranscript（MAIN world 直接收音）
    blog('✓ 收到 inject 打包資料', {
      dom: payload.rrwebEvents.length,
      console: payload.consoleLogs.length,
      network: payload.networkErrors.length,
      voice: payload.voiceTranscript.length,
    });
    chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
      chrome.runtime.sendMessage({ type: 'RECORDING_DONE', summary: summarize(payload) });
    });
  }
});

// background → content：控制指令
chrome.runtime.onMessage.addListener((msg: ControlMessage, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    sendToInject('START');
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_RECORDING') {
    sendToInject('STOP');
    sendResponse({ ok: true });
  } else if (msg.type === 'START_SCREENSHOT') {
    injectScreenshotOverlay();
    sendResponse({ ok: true });
  }
  return true;
});

// PM-35：頁面載入時自動恢復錄製。
// 使用者跳頁後新頁面是全新的 content + inject，本來不知道仍在錄製中。
// 載入時主動問 background 狀態，若 recording=true 就等 inject READY 後補送 START。
(async () => {
  try {
    const state = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })) as StateResponse | undefined;
    if (!state?.recording) return;
    blog('偵測到正在錄製中，自動恢復 inject 錄製');
    const waitForInject = (retries = 0) => {
      if (injectReady) {
        sendToInject('START'); // inject 全新（recording=false）會正常啟動
        blog('已送 START 給 inject（跳頁恢復）');
      } else if (retries < 40) {
        // PM-36：inject 尚未 READY，縮短為每 50ms 再試（最多 40×50ms = 2 秒），恢復更滑順
        setTimeout(() => waitForInject(retries + 1), 50);
      } else {
        blog('⚠ inject 未就緒，跳頁恢復失敗');
      }
    };
    waitForInject();
  } catch {
    // GET_STATE 失敗（background 未就緒），忽略
  }
})();

// ════════════════════════════════════════════════════════════
// PM-19：截圖模式 overlay（整頁 / 區域兩點可捲動 / 自由形狀）
// 注入頁面 DOM（ISOLATED world 共用頁面 DOM），擷取交由 background。
// ════════════════════════════════════════════════════════════

const SS_TOOLBAR_ID = 'bugezy-ss-toolbar';
const SS_OVERLAY_ID = 'bugezy-ss-overlay';
const SS_CANVAS_ID = 'bugezy-ss-canvas';
const SS_DOT_ID = 'bugezy-ss-dot';
const Z_TOP = '2147483647';
const Z_LAYER = '2147483646';

let ssKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/** 移除所有截圖 overlay DOM + 鍵盤監聽 */
function ssCleanup() {
  [SS_TOOLBAR_ID, SS_OVERLAY_ID, SS_CANVAS_ID, SS_DOT_ID].forEach((id) =>
    document.getElementById(id)?.remove(),
  );
  if (ssKeyHandler) {
    window.removeEventListener('keydown', ssKeyHandler);
    ssKeyHandler = null;
  }
}

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** 等捲動/移除 overlay 後渲染完成，並避開 captureVisibleTab 速率限制 */
async function settle() {
  await raf();
  await raf();
  await new Promise((r) => setTimeout(r, 350));
}

/** 請 background 擷取目前可見分頁 */
async function captureSegment(): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({ type: 'CAPTURE_SEGMENT' })) as {
    dataUrl?: string;
    error?: string;
  };
  if (!resp?.dataUrl) throw new Error(resp?.error ?? 'capture 失敗');
  return resp.dataUrl;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load 失敗'));
    img.src = dataUrl;
  });
}

function sendReady(dataUrl: string) {
  chrome.runtime.sendMessage({
    type: 'SCREENSHOT_READY',
    dataUrl,
    pageUrl: location.href,
    pageTitle: document.title,
  } satisfies ControlMessage);
}

function setHint(text: string) {
  const hint = document.getElementById('bugezy-ss-hint');
  if (hint) hint.textContent = text;
}

/** 頂部模式選擇列 */
function createToolbar(onMode: (mode: string) => void) {
  const bar = document.createElement('div');
  bar.id = SS_TOOLBAR_ID;
  bar.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:${Z_TOP};display:flex;align-items:center;gap:8px;padding:10px 16px;background:#16213e;border-bottom:1px solid #333;font-family:system-ui,sans-serif;font-size:14px;color:#fff;`;
  const modes: Array<[string, string]> = [
    ['full', '📷 整頁'],
    ['area', '⬜ 區域（兩點）'],
    ['free', '✂️ 自由形狀'],
    ['cancel', '✗ 取消'],
  ];
  for (const [mode, label] of modes) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.mode = mode;
    b.style.cssText = `background:${mode === 'cancel' ? '#dc2626' : '#333'};color:#fff;border:1px solid #555;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:14px;`;
    b.addEventListener('click', () => onMode(mode));
    bar.appendChild(b);
  }
  const hint = document.createElement('span');
  hint.id = 'bugezy-ss-hint';
  hint.textContent = '選擇截圖模式';
  hint.style.cssText = 'margin-left:8px;color:#9aa3b2;';
  bar.appendChild(hint);
  document.body.appendChild(bar);
}

/** 半透明遮罩 + 預覽 canvas（區域/自由形狀模式） */
function createSelectionLayer(): {
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const overlay = document.createElement('div');
  overlay.id = SS_OVERLAY_ID;
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:${Z_LAYER};cursor:crosshair;`;
  document.body.appendChild(overlay);

  const canvas = document.createElement('canvas');
  canvas.id = SS_CANVAS_ID;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText = `position:fixed;inset:0;z-index:${Z_LAYER};pointer-events:none;`;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  return { overlay, canvas, ctx };
}

function injectScreenshotOverlay() {
  ssCleanup();
  createToolbar((mode) => {
    if (mode === 'cancel') {
      ssCleanup();
    } else if (mode === 'full') {
      void startFullCapture();
    } else if (mode === 'area') {
      startAreaCapture();
    } else if (mode === 'free') {
      startFreeCapture();
    }
  });
}

// ── 模式 A：整頁（可見範圍）──────────────────────────────
async function startFullCapture() {
  ssCleanup(); // 擷取前移除工具列，避免入鏡
  await settle();
  try {
    sendReady(await captureSegment());
  } catch (err) {
    blog('整頁截圖失敗', err);
  }
}

// ── 模式 B：區域（兩點式，可捲動拼接）────────────────────
function startAreaCapture() {
  setHint('點第一下標記起點');
  const { overlay, canvas, ctx } = createSelectionLayer();
  let start: { x: number; y: number } | null = null; // document 絕對座標

  const toDoc = (e: MouseEvent) => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });

  overlay.addEventListener('mousemove', (e) => {
    if (!start) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = start.x - window.scrollX;
    const sy = start.y - window.scrollY;
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(sx, e.clientX), Math.min(sy, e.clientY), Math.abs(e.clientX - sx), Math.abs(e.clientY - sy));
  });

  overlay.addEventListener('click', (e) => {
    if (!start) {
      start = toDoc(e);
      setHint('可自由捲動頁面，點第二下標記終點');
      const dot = document.createElement('div');
      dot.id = SS_DOT_ID;
      dot.style.cssText = `position:absolute;left:${start.x - 5}px;top:${start.y - 5}px;width:10px;height:10px;border-radius:50%;background:#ef4444;z-index:${Z_TOP};pointer-events:none;`;
      document.body.appendChild(dot);
      return;
    }
    const end = toDoc(e);
    const s = start;
    ssCleanup();
    void stitchArea(s, end);
  });
}

/** 跨 viewport 捲動 + 逐段擷取 + 拼接 + 裁切 */
async function stitchArea(start: { x: number; y: number }, end: { x: number; y: number }) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const rectW = Math.max(1, Math.abs(end.x - start.x));
  const rectH = Math.max(1, Math.abs(end.y - start.y));
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const orig = { x: window.scrollX, y: window.scrollY };

  try {
    const big = document.createElement('canvas');
    big.width = Math.round(vw * dpr);
    big.height = Math.round(rectH * dpr);
    const bctx = big.getContext('2d');
    if (!bctx) throw new Error('canvas 2d 不可用');

    let target = top;
    let guard = 0;
    while (target < top + rectH && guard < 40) {
      guard++;
      window.scrollTo(0, target);
      await settle();
      const actualY = window.scrollY;
      const img = await loadImage(await captureSegment());
      bctx.drawImage(img, 0, Math.round((actualY - top) * dpr), Math.round(vw * dpr), Math.round(vh * dpr));
      if (actualY + vh >= top + rectH) break; // 已涵蓋底部
      target = actualY + vh;
    }
    window.scrollTo(orig.x, orig.y);

    const out = document.createElement('canvas');
    out.width = Math.round(rectW * dpr);
    out.height = Math.round(rectH * dpr);
    const octx = out.getContext('2d');
    if (!octx) throw new Error('canvas 2d 不可用');
    octx.drawImage(big, Math.round(left * dpr), 0, out.width, out.height, 0, 0, out.width, out.height);
    sendReady(out.toDataURL('image/png'));
  } catch (err) {
    blog('區域截圖拼接失敗', err);
    window.scrollTo(orig.x, orig.y);
  }
}

// ── 模式 C：自由形狀（多邊形 clip，限可見範圍）────────────
function startFreeCapture() {
  setHint('連續點擊畫多邊形，雙擊或按 Enter 封閉');
  const { overlay, canvas, ctx } = createSelectionLayer();
  const points: Array<{ x: number; y: number }> = []; // viewport 座標

  function redraw(cursor?: { x: number; y: number }) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (points.length === 0) return;
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (cursor) {
      ctx.setLineDash([6, 4]);
      ctx.lineTo(cursor.x, cursor.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ef4444';
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  overlay.addEventListener('mousemove', (e) => redraw({ x: e.clientX, y: e.clientY }));
  overlay.addEventListener('click', (e) => {
    points.push({ x: e.clientX, y: e.clientY });
    redraw();
  });
  overlay.addEventListener('dblclick', () => void closeFree());
  ssKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void closeFree();
    else if (e.key === 'Escape') ssCleanup();
  };
  window.addEventListener('keydown', ssKeyHandler);

  async function closeFree() {
    if (points.length < 3) {
      setHint('至少需要 3 個點');
      return;
    }
    const pts = points.slice();
    const dpr = window.devicePixelRatio || 1;
    ssCleanup();
    await settle();
    try {
      const img = await loadImage(await captureSegment());
      const out = document.createElement('canvas');
      out.width = Math.round(window.innerWidth * dpr);
      out.height = Math.round(window.innerHeight * dpr);
      const octx = out.getContext('2d');
      if (!octx) throw new Error('canvas 2d 不可用');
      octx.beginPath();
      octx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
      for (let i = 1; i < pts.length; i++) octx.lineTo(pts[i].x * dpr, pts[i].y * dpr);
      octx.closePath();
      octx.clip();
      octx.drawImage(img, 0, 0, out.width, out.height);
      sendReady(out.toDataURL('image/png'));
    } catch (err) {
      blog('自由形狀截圖失敗', err);
    }
  }
}
