// i18n.ts — PM-138：popup 多語系（先做中/英，架構可擴充）
// 語音語言（PM-137）→ UI 語言對照：繁中/粵語看中文 UI；日韓英越暫用英文 UI。

export type UILang = 'zh' | 'en';

/** Whisper 語音語言 → popup UI 語言（粵語用繁中；ja/ko/en/vi 暫用英文 UI，未來可擴充字典）。 */
export function getUILang(speechLang: string): UILang {
  if (speechLang === 'zh' || speechLang === 'yue') return 'zh';
  return 'en';
}

// 註：含 emoji 的值為「emoji + 文字」整段（對應 popup.html 單一 text node 的 span），
// 這樣 applyTranslations 直接覆寫 textContent 不會弄丟 emoji。
const dict: Record<string, Record<UILang, string>> = {
  // ── 登入 ──
  'login-hint': { zh: '登入後開始使用', en: 'Sign in to get started' },
  'login-google': { zh: '用 Google 登入', en: 'Sign in with Google' },
  'login-loading': { zh: '登入中...', en: 'Signing in...' },
  'login-failed': { zh: '登入失敗，重試', en: 'Login failed, retry' },

  // ── 頂部 ──
  logout: { zh: '登出', en: 'Logout' },
  'voice-bug-report': { zh: '語音 Bug 回報', en: 'Voice Bug Report' },
  'voice-mode': { zh: '語音模式', en: 'Voice Mode' },
  'mode-realtime': { zh: '即時字幕', en: 'Live Caption' },
  'mode-whisper': { zh: '精準轉錄', en: 'Precise' },
  'settings-locked': { zh: '🔒 錄製中，設定已鎖定', en: '🔒 Recording, settings locked' },

  // ── 三大模式卡片 ──
  'mode-record': { zh: '錄製', en: 'Record' },
  'mode-record-desc': { zh: 'DOM + 語音 + Console', en: 'DOM + Voice + Console' },
  'mode-rewind': { zh: '回溯 30s', en: 'Rewind 30s' },
  'mode-rewind-desc': { zh: '抓剛才的 Bug', en: 'Catch recent Bug' },
  'mode-screenshot': { zh: '截圖標注', en: 'Screenshot' },
  'mode-screenshot-desc': { zh: '快速擷取 + 畫重點', en: 'Capture + Annotate' },

  // ── 用量（動態）──
  unlimited: { zh: '✨ 無限次', en: '✨ Unlimited' },
  remaining: { zh: '剩 {n} 次', en: '{n} left' },
  'used-up': { zh: '已用完（升級解鎖）', en: 'Used up (upgrade)' },

  // ── 日票 / 月費 ──
  'upgrade-unlock': { zh: '升級解鎖無限次', en: 'Upgrade for unlimited' },
  'day-pass-btn': { zh: '⚡ 日票 NT$20（24hr）', en: '⚡ Day Pass NT$20 (24hr)' },
  'monthly-btn': { zh: '✨ 月費 NT$80/月', en: '✨ Monthly NT$80/mo' },
  'day-pass-badge': { zh: '⚡ 日票', en: '⚡ Day Pass' },
  'day-pass-remaining': { zh: '剩餘 {h}h {m}m {s}s', en: '{h}h {m}m {s}s left' },
  'day-pass-expire-hint': {
    zh: '日票到期後可升級月費',
    en: 'Upgrade to monthly after day pass expires',
  },
  'paid-badge': { zh: '✨ 付費版會員', en: '✨ Premium Member' },
  'cancel-sub': { zh: '取消訂閱', en: 'Cancel' },
  'cancelled-prefix': { zh: '已取消訂閱，可用到', en: 'Cancelled, active until' },
  resub: { zh: '重新訂閱', en: 'Resubscribe' },

  // ── 進階設定 ──
  'lang-label': { zh: '🌐 語音語言', en: '🌐 Voice Language' },
  'advanced-settings': { zh: '⚙️ 進階設定', en: '⚙️ Advanced Settings' },
  'monitor-toggle': { zh: '🔍 即時監控（AI 可查 error）', en: '🔍 Live Monitor (AI reads errors)' },
  'keyboard-toggle': { zh: '🔇 鍵盤模式（關閉語音）', en: '🔇 Keyboard Mode (no voice)' },
  'hq-toggle': { zh: '📸 高畫質 AI 分析（高 Token）', en: '📸 HQ AI Analysis (high Token)' },
  'effect-toggle': { zh: '✨ 工具列特效', en: '✨ Toolbar Effects' },

  // ── AI 輪盤 ──
  'carousel-title': { zh: '一鍵複製指令貼給 AI', en: 'Copy prompt to AI' },
  'copy-btn': { zh: '複製', en: 'Copy' },
  'edit-btn': { zh: '✏️ 編輯', en: '✏️ Edit' },
  'save-btn': { zh: '💾 儲存', en: '💾 Save' },
  'cancel-btn': { zh: '取消', en: 'Cancel' },

  // ── 錄製中 / 完成 ──
  'stop-recording': { zh: '⏹ 停止錄製', en: '⏹ Stop Recording' },
  'done-title': { zh: '✅ 錄製完成！', en: '✅ Recording Done!' },
  'sum-dom': { zh: 'DOM 事件', en: 'DOM Events' },
  'sum-console': { zh: 'Console', en: 'Console' },
  'sum-network': { zh: 'Network 錯誤', en: 'Network Errors' },
  'sum-voice': { zh: '語音片段', en: 'Voice Clips' },
  'sum-time': { zh: '時間', en: 'Duration' },
  'duration-sec': { zh: '{n} 秒', en: '{n}s' },
  'copy-json': { zh: '📋 複製 JSON', en: '📋 Copy JSON' },
  'export-json': { zh: '💾 匯出 JSON（給 AI 讀）', en: '💾 Export JSON (for AI)' },
  'clear-restart': { zh: '🗑️ 清除，重新錄製', en: '🗑️ Clear & Restart' },
  'copy-link': { zh: '📋 複製連結', en: '📋 Copy Link' },

  // ── mic OFF 提示 ──
  'mic-prompt-title': { zh: '麥克風目前關閉', en: 'Microphone is off' },
  'mic-prompt-desc': { zh: '要用語音描述 Bug 嗎？', en: 'Use voice to describe the bug?' },
  'mic-prompt-on': { zh: '開啟並錄製', en: 'Turn on & record' },
  'mic-prompt-skip': { zh: '直接錄製（不錄語音）', en: 'Record without voice' },

  // ── 版本（動態）──
  'update-available': {
    zh: '🆕 目前 v{cur} → 新版 v{new} 可用',
    en: '🆕 v{cur} → v{new} available',
  },
};

/** 取翻譯字串。找不到 key 回 key 本身；找不到該語言回中文；支援 {name} 佔位替換。 */
export function t(key: string, lang: UILang, params?: Record<string, string | number>): string {
  const entry = dict[key];
  let text = entry?.[lang] || entry?.['zh'] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
