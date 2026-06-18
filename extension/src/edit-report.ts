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
    });
  } catch (err) {
    blog('mini player 建立失敗', err);
    const section = document.getElementById('markerSection');
    if (section) section.style.display = 'none';
    return;
  }

  // PM-31 Bug3：讓 Replayer 的 iframe 填滿放大後的容器（960px / 16:9）
  const iframe = container.querySelector('iframe');
  if (iframe) {
    iframe.style.width = '100%';
    iframe.style.height = '100%';
  }

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

voiceBtn.addEventListener('click', () => {
  if (!SR) {
    voiceStatus.textContent = '此瀏覽器不支援語音辨識';
    return;
  }
  if (listening) {
    stopVoice();
    return;
  }
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
      } catch {
        /* 忽略 */
      }
    }
  };
  rec.onerror = (e: SRErr) => {
    voiceStatus.textContent = `語音錯誤：${e.error}`;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopVoice();
  };
  recognition = rec;
  rec.start();
  listening = true;
  voiceBtn.classList.add('listening');
  voiceBtn.textContent = '⏹';
  voiceStatus.textContent = '🔴 聆聽中...';
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
