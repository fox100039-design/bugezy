// edit-report.ts — 停止錄製後的報告編輯頁（PM-24）
// 從 storage 讀 payload + summary → 顯示摘要 + 語音記錄 → 使用者補描述（可語音）→ 上傳。

import {
  API_BASE,
  STATE_KEY,
  STORAGE_KEY,
  blog,
  type ControlMessage,
  type RecordingPayload,
  type RecordingSummary,
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
}
void init();

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
      if (res.isFinal) descInput.value += res[0].transcript;
      else interim = res[0].transcript;
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
