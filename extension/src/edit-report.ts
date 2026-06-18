// edit-report.ts — 停止錄製後的報告編輯頁（PM-24）
// 從 storage 讀 payload + summary → 顯示摘要 + 語音記錄 → 使用者補描述（可語音）→ 上傳。

import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import {
  API_BASE,
  STATE_KEY,
  STORAGE_KEY,
  blog,
  type ControlMessage,
  type RecordingPayload,
  type RecordingSummary,
  type TimeMarker,
} from './types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const summaryEl = $('summary');
const voiceText = $<HTMLTextAreaElement>('voiceText');
const descInput = $<HTMLTextAreaElement>('descInput');
const voiceBtn = $<HTMLButtonElement>('voiceBtn');
const voiceStatus = $<HTMLDivElement>('voiceStatus');
const discardBtn = $<HTMLButtonElement>('discardBtn');
const uploadBtn = $<HTMLButtonElement>('uploadBtn');
const summarizeBtn = $<HTMLButtonElement>('summarizeBtn');
const result = $('result');

// ── 載入摘要 + 語音記錄 ───────────────────────────────────
async function init() {
  const store = await chrome.storage.local.get([STORAGE_KEY, STATE_KEY]);
  const payload = store[STORAGE_KEY] as RecordingPayload | undefined;
  const state = store[STATE_KEY] as { summary?: RecordingSummary } | undefined;
  if (!payload) {
    summaryEl.textContent = '找不到報告資料';
    return;
  }

  const dur = state?.summary?.durationMs ?? 0;
  const rows: Array<[string, string | number]> = [
    ['DOM 事件', payload.rrwebEvents.length],
    ['Console', payload.consoleLogs.length],
    ['Network', payload.networkErrors.length],
    ['語音片段', payload.voiceTranscript.length],
    ['時長', `${Math.round(dur / 1000)} 秒`],
    ['頁面', payload.pageInfo.title || payload.pageInfo.url],
  ];
  summaryEl.replaceChildren(
    ...rows.map(([k, v]) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = `${v}`;
      d.append(`${k}：`, b);
      return d;
    }),
  );

  // 語音記錄合成一段
  voiceText.value = payload.voiceTranscript.map((s) => s.text).join('');

  // PM-28：初始化 mini rrweb 播放器 + 時間軸標記
  initMiniPlayer(payload.rrwebEvents);
}
void init();

// ── PM-28：時間軸標記 ─────────────────────────────────────
const markers: TimeMarker[] = [];
let replayer: Replayer | null = null;
let duration = 0; // 總時長（ms）
let playing = false;
// PM-40/41：mini player 放大/縮小切換旗標
let zoomed = false;

function $opt<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function initMiniPlayer(events: unknown[]) {
  const container = document.getElementById('miniPlayer');
  // rrweb 至少要 2 筆事件（Meta + FullSnapshot）才能回放
  if (!container || events.length < 2) {
    const section = document.getElementById('markerSection');
    if (section) section.style.display = 'none';
    return;
  }

  try {
    replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
      root: container,
      skipInactive: true,
      showWarning: false,
      mouseTail: true, // PM-45：開啟滑鼠軌跡，回放才看得到游標移動
    });
  } catch (err) {
    blog('mini player 建立失敗', err);
    const section = document.getElementById('markerSection');
    if (section) section.style.display = 'none';
    return;
  }

  // PM-38：預載第一幀，避免點播放時卡在開頭的 FullSnapshot 解析
  try {
    replayer.play(0);
    replayer.pause(0);
  } catch {
    /* 忽略 */
  }

  // PM-38：rrweb 以原始解析度渲染（如 1600x900），容器只有 960px → 不縮放會像
  // 放大鏡只看到左上角。等 iframe 渲染後依錄製原始尺寸算縮放比，用 transform 縮到容器寬。
  requestAnimationFrame(() => {
    const iframe = container.querySelector('iframe');
    if (!iframe) return;
    const metaEvent = (
      events as Array<{ type?: number; data?: { width?: number; height?: number } }>
    ).find((e) => e.type === 4); // type 4 = Meta，帶原始頁面寬高
    const pageWidth = metaEvent?.data?.width || 1920;
    const pageHeight = metaEvent?.data?.height || 1080;
    const containerWidth = container.clientWidth;
    const scale = containerWidth / pageWidth;
    iframe.style.width = `${pageWidth}px`;
    iframe.style.height = `${pageHeight}px`;
    iframe.style.transform = `scale(${scale})`;
    iframe.style.transformOrigin = 'top left';
    iframe.style.border = 'none';
    // 容器高度配合縮放後的高度（取代固定 aspect-ratio）
    container.style.height = `${pageHeight * scale}px`;
    container.style.overflow = 'hidden';
  });

  duration = replayer.getMetaData().totalTime || 0;
  const seekBar = $opt<HTMLInputElement>('markerSeek');
  if (seekBar) seekBar.max = String(duration);
  updateTimeDisplay(0);

  // 播放 / 暫停
  $opt('markerPlayBtn')?.addEventListener('click', () => {
    if (!replayer) return;
    const playBtn = $opt('markerPlayBtn');
    if (playing) {
      replayer.pause();
      playing = false;
      if (playBtn) playBtn.textContent = '▶';
    } else {
      const current = replayer.getCurrentTime();
      if (current >= duration - 100) replayer.play(0);
      else replayer.resume(current);
      playing = true;
      if (playBtn) playBtn.textContent = '⏸';
      trackProgress();
    }
  });

  // seek
  seekBar?.addEventListener('input', (e) => {
    if (!replayer) return;
    const time = Number((e.target as HTMLInputElement).value);
    replayer.play(time);
    if (!playing) window.setTimeout(() => replayer?.pause(time), 50);
    updateTimeDisplay(time);
  });

  // 🔍 放大/縮小（PM-41）：容器物理變全寬（非 transform 拉 bar），scale 依新寬度重算 → 內容更清楚
  $opt('zoomBtn')?.addEventListener('click', () => {
    const iframe = container.querySelector('iframe');
    if (!iframe) return;
    zoomed = !zoomed;

    // 原始頁面寬高（initMiniPlayer 已把原始尺寸 inline 寫進 iframe）
    const pageWidth = parseInt(iframe.style.width) || 1920;
    const pageHeight = parseInt(iframe.style.height) || 1080;
    const wrap = document.querySelector('.wrap') as HTMLElement | null;

    if (zoomed) {
      // 2x：連外層 .wrap 一起撐寬，player 才真的變大（不被 720px wrap 卡住）
      if (wrap) wrap.style.maxWidth = '95vw';
      container.style.maxWidth = '100%';
      container.style.width = '100%';
    } else {
      // 1x：回到原始
      if (wrap) wrap.style.maxWidth = '720px';
      container.style.maxWidth = '960px';
      container.style.width = '100%';
    }
    const btn = $opt('zoomBtn');
    if (btn) btn.textContent = zoomed ? '🔍 1x' : '🔍 2x';

    // 容器寬度變了 → 等版面重排後依新寬度重算 scale（overflow:hidden，不用拉 bar）
    requestAnimationFrame(() => {
      const newScale = container.clientWidth / pageWidth;
      iframe.style.transform = `scale(${newScale})`;
      iframe.style.transformOrigin = 'top left';
      container.style.height = `${pageHeight * newScale}px`;
      container.style.overflow = 'hidden';
    });
  });

  // 📌 標記此刻（mousedown preventDefault 避免搶焦點）
  const addBtn = $opt('addMarkerBtn');
  addBtn?.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn?.addEventListener('click', () => {
    if (!replayer) return;
    const sec = Math.floor(replayer.getCurrentTime() / 1000);
    if (playing) {
      replayer.pause();
      playing = false;
      const playBtn = $opt('markerPlayBtn');
      if (playBtn) playBtn.textContent = '▶';
    }
    addMarker(sec);
  });
}

function addMarker(sec: number) {
  // PM-29：按 📌 立刻彈原生對話框問描述，使用者一定看得到
  const note = window.prompt(`📌 ${formatSec(sec)} — 描述這個時間點的問題：`) ?? '';
  markers.push({ time_sec: sec, note: note.trim() }); // 按取消 → 空描述，只留時間點
  renderMarkers();
}

function renderMarkers() {
  const list = document.getElementById('markerList');
  if (!list) return;
  list.replaceChildren();
  markers.sort((a, b) => a.time_sec - b.time_sec);
  markers.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'marker-item';

    const timeBtn = document.createElement('span');
    timeBtn.className = 'marker-time';
    timeBtn.textContent = formatSec(m.time_sec);
    timeBtn.title = '點擊跳到此時間';
    timeBtn.addEventListener('click', () => {
      if (!replayer) return;
      replayer.play(m.time_sec * 1000);
      window.setTimeout(() => replayer?.pause(m.time_sec * 1000), 50);
      updateTimeDisplay(m.time_sec * 1000);
    });

    const noteInput = document.createElement('input');
    noteInput.className = 'marker-note';
    noteInput.type = 'text';
    noteInput.placeholder = '描述這個時間點的問題...';
    noteInput.value = m.note;
    noteInput.addEventListener('input', () => {
      m.note = noteInput.value;
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'marker-delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      markers.splice(i, 1);
      renderMarkers();
    });

    item.append(timeBtn, noteInput, delBtn);
    list.appendChild(item);
  });
}

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimeDisplay(ms: number) {
  const el = document.getElementById('markerTime');
  if (el)
    el.textContent = `${formatSec(Math.floor(ms / 1000))} / ${formatSec(Math.floor(duration / 1000))}`;
  const seekBar = $opt<HTMLInputElement>('markerSeek');
  if (seekBar) seekBar.value = String(ms);
}

function trackProgress() {
  if (!playing || !replayer) return;
  const current = replayer.getCurrentTime();
  updateTimeDisplay(current);
  if (current < duration) {
    requestAnimationFrame(trackProgress);
  } else {
    playing = false;
    const playBtn = $opt('markerPlayBtn');
    if (playBtn) playBtn.textContent = '▶';
  }
}

// ── 語音輸入（補充說明用）────────────────────────────────
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

function stopVoice() {
  listening = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* 忽略 */
    }
    recognition = null;
  }
  voiceBtn.classList.remove('listening');
  voiceBtn.textContent = '🎤';
  voiceStatus.textContent = '';
}

// PM-42：套用 inject.ts PM-32/33 的穩定模式——工廠建全新實例 + onend 失敗計數。
let autoRestartFails = 0;

function createEditRecognition(): SRInst | null {
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'zh-TW';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e: SREvt) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        // PM-31 Bug4：append 到末端，但若 cursor 原本不在末端則保留原位（不干擾中間編輯）
        const cursorPos = descInput.selectionStart;
        const isAtEnd = cursorPos === descInput.value.length;
        descInput.value += res[0].transcript;
        if (!isAtEnd) {
          descInput.selectionStart = cursorPos;
          descInput.selectionEnd = cursorPos;
        }
      } else {
        interim = res[0].transcript;
      }
    }
    voiceStatus.textContent = interim ? `🔴 ${interim}` : '🔴 聆聽中...';
  };

  rec.onend = () => {
    if (listening) {
      try {
        rec.start();
        autoRestartFails = 0; // 成功歸零
      } catch {
        autoRestartFails++;
        if (autoRestartFails >= 3) {
          // PM-43：連續失敗 3 次 → getUserMedia 刷新音訊管線 + 建全新實例重啟
          void (async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach((t) => t.stop());
              await new Promise((r) => setTimeout(r, 300));
              if (!listening) return; // 期間使用者已停止
              recognition = createEditRecognition();
              if (recognition) {
                recognition.start();
                autoRestartFails = 0;
                voiceStatus.textContent = '🔴 語音已重啟...';
              }
            } catch {
              voiceStatus.textContent = '⚠ 語音中斷，按 🎤 重新啟動';
              stopVoice();
            }
          })();
        }
      }
    }
  };

  rec.onerror = (e: SRErr) => {
    voiceStatus.textContent = `語音錯誤：${e.error}`;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopVoice();
  };

  return rec;
}

voiceBtn.addEventListener('click', async () => {
  if (!SR) {
    voiceStatus.textContent = '此瀏覽器不支援語音辨識';
    return;
  }
  if (listening) {
    stopVoice();
    return;
  }

  // PM-42：先用 getUserMedia 刷新音訊管線（edit-report 是 extension page，非 user-gesture 問題）
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    voiceStatus.textContent = '❌ 麥克風無法存取';
    return;
  }

  autoRestartFails = 0;
  recognition = createEditRecognition();
  if (recognition) {
    recognition.start();
    listening = true;
    voiceBtn.classList.add('listening');
    voiceBtn.textContent = '⏹';
    voiceStatus.textContent = '🔴 聆聽中...';
  }
});

// ── AI 精簡：把語音記錄精簡成重點，替換語音記錄欄（成功後永久 disable）──
summarizeBtn.addEventListener('click', async () => {
  const text = voiceText.value.trim();
  if (!text || text.length < 10) {
    voiceStatus.textContent = '語音記錄太短，無需精簡';
    return;
  }
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = '🤖 精簡中...';
  try {
    const res = await fetch(`${API_BASE}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = (await res.json()) as { summary?: string };
    if (data.summary) {
      voiceText.value = data.summary;
      summarizeBtn.textContent = '✅ 已精簡（不可重複）';
      summarizeBtn.classList.add('done');
      summarizeBtn.disabled = true; // 永久 disable，不可再按
      blog('AI 精簡完成 → 替換語音記錄');
      return; // 跳過 finally 的重新啟用
    } else {
      summarizeBtn.textContent = '❌ 失敗';
    }
  } catch (err) {
    blog('AI 精簡失敗', err);
    summarizeBtn.textContent = '❌ 失敗';
  }
  // 只有失敗才重新啟用（成功已 return）
  setTimeout(() => {
    summarizeBtn.textContent = '🤖 AI 精簡';
    summarizeBtn.classList.remove('done');
    summarizeBtn.disabled = false;
  }, 3000);
});

// ── 上傳 / 捨棄 ───────────────────────────────────────────
uploadBtn.addEventListener('click', async () => {
  stopVoice();
  uploadBtn.disabled = true;
  uploadBtn.textContent = '⏳ 上傳中...';
  const resp = (await chrome.runtime.sendMessage({
    type: 'UPLOAD_REPORT',
    description: descInput.value.trim(),
    markers, // PM-29：保留所有標記（含無文字的，時間點本身就有價值）
  } satisfies ControlMessage)) as { ok: boolean; shareUrl?: string; error?: string };

  if (resp.ok && resp.shareUrl) {
    blog('報告上傳完成', resp.shareUrl);
    result.classList.remove('hidden');
    result.replaceChildren('✅ 已上傳！分享連結：');
    const a = document.createElement('a');
    a.href = resp.shareUrl;
    a.target = '_blank';
    a.textContent = resp.shareUrl;
    result.appendChild(a);
    uploadBtn.textContent = '✅ 已上傳';
    discardBtn.textContent = '關閉';
    await chrome.storage.local.remove(STORAGE_KEY); // 上傳後清本機 payload
  } else {
    result.classList.remove('hidden');
    result.textContent = `❌ 上傳失敗：${resp.error ?? '未知錯誤'}`;
    uploadBtn.disabled = false;
    uploadBtn.textContent = '✅ 上傳報告';
  }
});

discardBtn.addEventListener('click', async () => {
  stopVoice();
  await chrome.storage.local.remove([STORAGE_KEY, STATE_KEY]);
  window.close();
});
