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
  'my-reports': { zh: '📋 我的報告', en: '📋 My Reports' }, // PM-184
  'day-pass-btn': { zh: '⚡ 日票 NT$20（24hr）', en: '⚡ Day Pass NT$20 (24hr)' },
  'monthly-btn': { zh: '✨ 月費 NT$80/月', en: '✨ Monthly NT$80/mo' },
  // PM-170：用完升級引導 overlay
  'usage-exhausted': { zh: '本月額度已用完', en: 'Monthly quota exhausted' },
  'usage-desc-record': { zh: '錄製 {used}/{max} 次已使用', en: 'Recording {used}/{max} used' },
  'usage-desc-rewind': { zh: '回溯 {used}/{max} 次已使用', en: 'Rewind {used}/{max} used' },
  'usage-desc-mcp': { zh: 'MCP AI 讀取 {used}/{max} 次已使用', en: 'MCP AI reads {used}/{max} used' },
  'usage-reset-hint': { zh: '💡 免費額度每月自動重置', en: '💡 Free quota resets monthly' },
  'day-pass-btn-full': { zh: '⚡ 日票 NT$20（24hr 無限）', en: '⚡ Day Pass NT$20 (24hr unlimited)' },
  'monthly-btn-full': { zh: '✨ 月費 NT$80/月（最划算）', en: '✨ Monthly NT$80/mo (best value)' },
  // PM-171：非台灣付費 coming soon
  'intl-coming-soon': { zh: '🌏 國際付款即將開放', en: '🌏 International Payments Coming Soon!' },
  'intl-desc': {
    zh: '我們正在開通國際信用卡付款，敬請期待！',
    en: "We're working on enabling international credit card payments. Stay tuned!",
  },
  'intl-free-hint': {
    zh: '💡 免費版現在就能用 — 每月 10 次錄製 + 20 次 MCP AI 讀取',
    en: '💡 Free plan available now — 10 recordings + 20 MCP AI reads per month',
  },
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

  // ── PM-139：截圖工具列（content.ts）──
  'toolbar-fullpage': { zh: '📷 整頁', en: '📷 Full Page' },
  'toolbar-region': { zh: '⬜ 區域（兩點）', en: '⬜ Region (2 clicks)' },
  'toolbar-freeform': { zh: '✂️ 自由形狀', en: '✂️ Freeform' },
  'toolbar-cancel': { zh: '✗ 取消', en: '✗ Cancel' },
  'toolbar-select-mode': { zh: '選擇截圖模式', en: 'Select screenshot mode' },
  'toolbar-region-hint': { zh: '可自由捲動頁面，點第二下標記終點', en: 'Scroll freely, click again to set the end point' },
  'transcribing': { zh: '⏳ 語音轉錄中…', en: '⏳ Transcribing…' },

  // ── PM-139：即時監控（inject.ts，經 it()）──
  'monitor-active': { zh: '🟢 BugEzy 監控中', en: '🟢 BugEzy Monitoring' },
  'monitor-errors': { zh: '⚠️ 發現 {n} 個錯誤（點我查看）', en: '⚠️ {n} error(s) found (click to view)' },
  'monitor-errors-title': { zh: 'BugEzy 偵測到 {n} 個錯誤，點我查看', en: 'BugEzy found {n} error(s), click to view' },
  'monitor-panel-title': { zh: '🐛 即時監控錯誤', en: '🐛 Live Monitor Errors' },
  'monitor-empty': { zh: '✓ 目前無錯誤', en: '✓ No errors' },
  'monitor-upload': { zh: '📤 上傳報告讓 AI 分析', en: '📤 Upload report for AI analysis' },
  'monitor-uploading': { zh: '⏳ 上傳中…', en: '⏳ Uploading…' },
  'monitor-uploaded': { zh: '✅ 已上傳！點此查看報告', en: '✅ Uploaded! Click to view report' },
  'monitor-upload-fail': { zh: '❌ 上傳失敗，點此重試', en: '❌ Upload failed, click to retry' },
  'monitor-desc': { zh: '即時監控偵測到 {n} 個錯誤', en: 'Live monitor found {n} error(s)' },

  // ── PM-139：錄製字幕 / 麥克風授權（inject.ts，經 it()）──
  'caption-recording': { zh: '🎙 錄製中，可以用中文描述問題…', en: '🎙 Recording — describe the issue by voice…' },
  'caption-voice-log': { zh: '📝 語音記錄', en: '📝 Voice Log' },
  'keyboard-bar': { zh: '🔇 鍵盤模式 — 錄製中（語音已關閉）', en: '🔇 Keyboard mode — recording (voice off)' },
  'whisper-bar': { zh: '🎙️ 錄音中…（停止後自動轉錄）', en: '🎙️ Recording…（auto-transcribe on stop）' },
  'mic-perm-title': { zh: 'BugEzy 需要麥克風權限', en: 'BugEzy needs microphone access' },
  'mic-perm-desc': { zh: '允許後可用語音描述 Bug · 此網站只需授權一次', en: 'Allow to describe bugs by voice · one-time per site' },
  'mic-perm-allow': { zh: '允許麥克風', en: 'Allow microphone' },
  'mic-perm-skip': { zh: '跳過（不錄語音）', en: 'Skip (no voice)' },

  // ── PM-139：截圖標注頁（annotate）──
  'annotate-pen': { zh: '✏️ 畫筆', en: '✏️ Pen' },
  'annotate-arrow': { zh: '➡️ 箭頭', en: '➡️ Arrow' },
  'annotate-rect': { zh: '⬜ 框框', en: '⬜ Box' },
  'annotate-text': { zh: '📝 文字', en: '📝 Text' },
  'annotate-color': { zh: '顏色', en: 'Color' },
  'annotate-thickness': { zh: '粗細', en: 'Width' },
  'annotate-thin': { zh: '細', en: 'Thin' },
  'annotate-mid': { zh: '中', en: 'Medium' },
  'annotate-thick': { zh: '粗', en: 'Thick' },
  'annotate-undo': { zh: '↩️ 復原', en: '↩️ Undo' },
  'annotate-clear': { zh: '🗑️ 清除全部', en: '🗑️ Clear All' },
  'annotate-cancel': { zh: '✗ 取消', en: '✗ Cancel' },
  'annotate-save': { zh: '✅ 完成儲存', en: '✅ Save' },
  'annotate-desc-label': { zh: '💬 問題描述（選填）', en: '💬 Description (optional)' },
  'annotate-desc-ph': { zh: '描述你看到的問題，或按右邊麥克風語音輸入...', en: 'Describe the issue, or tap the mic on the right to dictate...' },
  'annotate-listening': { zh: '🔴 聆聽中，邊畫邊說描述問題...', en: '🔴 Listening — describe while you draw...' },
  'annotate-uploading': { zh: '⏳ 上傳中...', en: '⏳ Uploading...' },

  // ── PM-139：alert / confirm（popup.ts）──
  'confirm-cancel-sub': {
    zh: '確定要取消月費訂閱嗎？\n取消後到期日前仍可使用付費功能，到期後自動降回免費版。',
    en: 'Cancel your monthly subscription?\nYou can still use premium features until the end of your billing period.',
  },
  'alert-cancelled': {
    zh: '已取消訂閱。到期日前仍可使用付費功能。',
    en: 'Subscription cancelled. Premium features remain active until end of billing period.',
  },
  'alert-cancel-fail': { zh: '取消失敗，請稍後再試', en: 'Cancellation failed, please try again later' },
};

/** PM-115：AI 慣用語輪盤的一則（文字 + 顏色標記）。 */
export interface PromptItem {
  text: string;
  color: string;
}

/** PM-139：AI 輪盤多語預設慣用語（語言切換時，若使用者未自訂則重置為對應語言預設）。 */
export const DEFAULT_PROMPTS: Record<UILang, PromptItem[]> = {
  zh: [
    { text: '請讀取我最新的 BugEzy 報告，幫我找出問題並修復', color: '#ef4444' },
    {
      text: '請讀取最新 BugEzy 報告，分析：\n1. 真正的 root cause\n2. 修復方案\n3. 修改哪些檔案\n4. 產生 fix plan\n請不要猜測，如果資料不足請告知需要哪些資訊',
      color: '#3b82f6',
    },
    { text: '請讀取我最新的截圖報告，看畫面哪裡有問題，給我 CSS/HTML 修復建議', color: '#22c55e' },
    { text: '請讀取最新 BugEzy 報告，直接給我可以貼上的修復程式碼', color: '#f59e0b' },
  ],
  en: [
    { text: 'Read my latest BugEzy report and help me find and fix the bug', color: '#ef4444' },
    {
      text: "Read my latest BugEzy report and analyze:\n1. Root cause\n2. Fix approach\n3. Which files to change\n4. Generate a fix plan\nDon't guess — if you need more info, tell me what to provide",
      color: '#3b82f6',
    },
    { text: 'Read my latest screenshot report, identify UI issues, and give me CSS/HTML fixes', color: '#22c55e' },
    { text: 'Read my latest BugEzy report and give me copy-paste ready fix code', color: '#f59e0b' },
  ],
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
