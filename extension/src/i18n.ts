// i18n.ts — PM-138：popup 多語系（中/英/簡中/日/韓/越）。七語全覆蓋。
// 語音語言（PM-137）→ UI 語言對照：繁中/粵語看繁中；zh-CN 看簡體；ja 日文；ko 韓文；vi 越南文；其餘英文。

import { toSimplified } from './t2s';

export type UILang = 'zh' | 'en' | 'zh-CN' | 'ja' | 'ko' | 'vi';

/** Whisper 語音語言 → popup UI 語言。 */
export function getUILang(speechLang: string): UILang {
  if (speechLang === 'zh-CN') return 'zh-CN'; // PM-232：簡體中文獨立 UI
  if (speechLang === 'ja') return 'ja'; // PM-233：日語獨立 UI
  if (speechLang === 'ko') return 'ko'; // PM-234：韓語獨立 UI
  if (speechLang === 'vi') return 'vi'; // PM-235：越南語獨立 UI
  if (speechLang === 'zh' || speechLang === 'yue') return 'zh';
  return 'en';
}

// 註：含 emoji 的值為「emoji + 文字」整段（對應 popup.html 單一 text node 的 span）。
// PM-233/234/235：ja/ko/vi 為手譯（敬體 です/ます、합니다체、越南語；技術術語保留英文 Bug/Console/Network/DOM/MCP/Token/JSON/API）。
const dict: Record<string, { zh: string; en: string; ja: string; ko: string; vi: string }> = {
  // ── 登入 ──
  'login-hint': { zh: '登入後開始使用', en: 'Sign in to get started', ja: 'ログインして始めましょう', ko: '로그인하고 시작하세요', vi: 'Đăng nhập để bắt đầu' },
  'login-google': { zh: '用 Google 登入', en: 'Sign in with Google', ja: 'Google でログイン', ko: 'Google로 로그인', vi: 'Đăng nhập bằng Google' },
  'login-loading': { zh: '登入中...', en: 'Signing in...', ja: 'ログイン中...', ko: '로그인 중...', vi: 'Đang đăng nhập...' },
  'login-failed': { zh: '登入失敗，重試', en: 'Login failed, retry', ja: 'ログイン失敗、再試行', ko: '로그인 실패, 다시 시도', vi: 'Đăng nhập thất bại, thử lại' },

  // ── 頂部 ──
  logout: { zh: '登出', en: 'Logout', ja: 'ログアウト', ko: '로그아웃', vi: 'Đăng xuất' },
  'voice-bug-report': { zh: '語音 Bug 回報', en: 'Voice Bug Report', ja: '音声バグレポート', ko: '음성 버그 리포트', vi: 'Báo lỗi bằng giọng nói' },
  'voice-mode': { zh: '語音模式', en: 'Voice Mode', ja: '音声モード', ko: '음성 모드', vi: 'Chế độ giọng nói' },
  'mode-realtime': { zh: '即時字幕', en: 'Live Caption', ja: 'リアルタイム字幕', ko: '실시간 자막', vi: 'Phụ đề trực tiếp' },
  'mode-whisper': { zh: '精準轉錄', en: 'Precise', ja: '高精度文字起こし', ko: '고정밀 변환', vi: 'Chuyển đổi chính xác' },
  'settings-locked': { zh: '🔒 錄製中，設定已鎖定', en: '🔒 Recording, settings locked', ja: '🔒 録画中、設定はロックされています', ko: '🔒 녹화 중, 설정이 잠겼습니다', vi: '🔒 Đang ghi hình, cài đặt đã khóa' },

  // ── 三大模式卡片 ──
  'mode-record': { zh: '錄製', en: 'Record', ja: '録画', ko: '녹화', vi: 'Ghi hình' },
  'mode-record-desc': { zh: 'DOM + 語音 + Console', en: 'DOM + Voice + Console', ja: 'DOM + 音声 + Console', ko: 'DOM + 음성 + Console', vi: 'DOM + Giọng nói + Console' },
  'mode-rewind': { zh: '回溯 30s', en: 'Rewind 30s', ja: '30秒巻き戻し', ko: '30초 되감기', vi: 'Tua lại 30 giây' },
  'mode-rewind-desc': { zh: '抓剛才的 Bug', en: 'Catch recent Bug', ja: '直前の Bug を取得', ko: '방금 발생한 Bug 캡처', vi: 'Bắt lại Bug vừa xảy ra' },
  'mode-screenshot': { zh: '截圖標注', en: 'Screenshot', ja: 'スクリーンショット', ko: '스크린샷', vi: 'Chụp màn hình' },
  'mode-screenshot-desc': { zh: '快速擷取 + 畫重點', en: 'Capture + Annotate', ja: 'キャプチャ + 注釈', ko: '캡처 + 주석', vi: 'Chụp + Chú thích' },

  // ── 用量（動態）──
  unlimited: { zh: '✨ 無限次', en: '✨ Unlimited', ja: '✨ 無制限', ko: '✨ 무제한', vi: '✨ Không giới hạn' },
  remaining: { zh: '剩 {n} 次', en: '{n} left', ja: '残り {n} 回', ko: '{n}회 남음', vi: 'Còn {n} lần' },
  'used-up': { zh: '已用完（升級解鎖）', en: 'Used up (upgrade)', ja: '使い切りました（アップグレードで解除）', ko: '모두 사용함 (업그레이드로 해제)', vi: 'Đã dùng hết (nâng cấp để mở khóa)' },

  // ── 日票 / 月費 ──
  'upgrade-unlock': { zh: '升級解鎖無限次', en: 'Upgrade for unlimited', ja: 'アップグレードで無制限', ko: '업그레이드하여 무제한', vi: 'Nâng cấp để không giới hạn' },
  'my-reports': { zh: '📋 我的報告', en: '📋 My Reports', ja: '📋 マイレポート', ko: '📋 내 리포트', vi: '📋 Báo cáo của tôi' }, // PM-184
  // PM-185：截圖敏感偵測 + 馬賽克
  'sf-password': { zh: '密碼欄位', en: 'password fields', ja: 'パスワード欄', ko: '비밀번호 필드', vi: 'trường mật khẩu' },
  'sf-token': { zh: 'Token 欄位', en: 'token fields', ja: 'Token 欄', ko: 'Token 필드', vi: 'trường Token' },
  'sf-secret': { zh: 'Secret 欄位', en: 'secret fields', ja: 'Secret 欄', ko: 'Secret 필드', vi: 'trường Secret' },
  'sf-key': { zh: 'API Key 欄位', en: 'API key fields', ja: 'API Key 欄', ko: 'API Key 필드', vi: 'trường API Key' },
  'sf-card': { zh: '信用卡欄位', en: 'credit card fields', ja: 'クレジットカード欄', ko: '신용카드 필드', vi: 'trường thẻ tín dụng' },
  'sf-cvv': { zh: 'CVV 欄位', en: 'CVV fields', ja: 'CVV 欄', ko: 'CVV 필드', vi: 'trường CVV' },
  'sf-marked': { zh: '標記為敏感的元素', en: 'sensitive-marked elements', ja: '機密としてマークされた要素', ko: '민감 항목으로 표시된 요소', vi: 'phần tử được đánh dấu nhạy cảm' },
  'sensitive-sep': { zh: '、', en: ', ', ja: '、', ko: ', ', vi: ', ' },
  'sensitive-title': { zh: '偵測到敏感欄位', en: 'Sensitive fields detected', ja: '機密欄を検出しました', ko: '민감한 필드가 감지되었습니다', vi: 'Đã phát hiện trường nhạy cảm' },
  'sensitive-page-has': { zh: '頁面上有：{fields}', en: 'This page contains: {fields}', ja: 'このページに含まれるもの：{fields}', ko: '이 페이지에 포함됨: {fields}', vi: 'Trang này chứa: {fields}' },
  'sensitive-hint': {
    zh: '截圖後可用 🔒 馬賽克筆刷塗掉敏感區域再上傳',
    en: 'Use the 🔒 mosaic brush to cover sensitive areas before uploading',
    ja: 'スクリーンショット後、🔒 モザイクブラシで機密領域を塗りつぶしてからアップロードできます',
    ko: '스크린샷 후 🔒 모자이크 브러시로 민감 영역을 가린 뒤 업로드할 수 있습니다',
    vi: 'Sau khi chụp, dùng cọ 🔒 mosaic để che vùng nhạy cảm trước khi tải lên',
  },
  'sensitive-continue': { zh: '繼續截圖', en: 'Continue', ja: 'スクリーンショットを続ける', ko: '스크린샷 계속', vi: 'Tiếp tục chụp' },
  'sensitive-cancel': { zh: '取消', en: 'Cancel', ja: 'キャンセル', ko: '취소', vi: 'Hủy' },
  'sensitive-tip': {
    zh: '🔒 偵測到敏感欄位，建議用馬賽克筆刷塗掉再上傳',
    en: '🔒 Sensitive fields detected — use the mosaic brush to cover them before uploading',
    ja: '🔒 機密欄を検出しました。モザイクブラシで塗りつぶしてからアップロードすることをお勧めします',
    ko: '🔒 민감한 필드가 감지되었습니다. 모자이크 브러시로 가린 뒤 업로드하는 것을 권장합니다',
    vi: '🔒 Đã phát hiện trường nhạy cảm, nên dùng cọ mosaic che lại trước khi tải lên',
  },
  'annotate-mosaic': { zh: '🔒 馬賽克', en: '🔒 Mosaic', ja: '🔒 モザイク', ko: '🔒 모자이크', vi: '🔒 Mosaic' },
  // PM-186：自動遮罩
  'auto-masked': { zh: '🔒 已自動遮罩 {n} 個敏感欄位', en: '🔒 Auto-masked {n} sensitive field(s)', ja: '🔒 {n} 個の機密欄を自動でマスクしました', ko: '🔒 민감 필드 {n}개를 자동으로 마스킹했습니다', vi: '🔒 Đã tự động che {n} trường nhạy cảm' },
  'undo-mask': { zh: '撤銷遮罩', en: 'Undo mask', ja: 'マスクを取り消す', ko: '마스킹 취소', vi: 'Hoàn tác che' },
  'day-pass-btn': { zh: '⚡ 日票 NT$20（24hr）', en: '⚡ Day Pass NT$20 (24hr)', ja: '⚡ デイパス NT$20（24時間）', ko: '⚡ 데이 패스 NT$20 (24시간)', vi: '⚡ Vé ngày NT$20 (24 giờ)' },
  'monthly-btn': { zh: '✨ 月費 NT$80/月', en: '✨ Monthly NT$80/mo', ja: '✨ 月額 NT$80/月', ko: '✨ 월정액 NT$80/월', vi: '✨ Hàng tháng NT$80/tháng' },
  // PM-170：用完升級引導 overlay
  'usage-exhausted': { zh: '本月額度已用完', en: 'Monthly quota exhausted', ja: '今月の利用枠を使い切りました', ko: '이번 달 사용량을 모두 소진했습니다', vi: 'Đã hết hạn mức tháng này' },
  'usage-desc-record': { zh: '錄製 {used}/{max} 次已使用', en: 'Recording {used}/{max} used', ja: '録画 {used}/{max} 回 使用済み', ko: '녹화 {used}/{max}회 사용', vi: 'Ghi hình {used}/{max} lần đã dùng' },
  'usage-desc-rewind': { zh: '回溯 {used}/{max} 次已使用', en: 'Rewind {used}/{max} used', ja: '巻き戻し {used}/{max} 回 使用済み', ko: '되감기 {used}/{max}회 사용', vi: 'Tua lại {used}/{max} lần đã dùng' },
  'usage-desc-mcp': { zh: 'MCP AI 讀取 {used}/{max} 次已使用', en: 'MCP AI reads {used}/{max} used', ja: 'MCP AI 読み取り {used}/{max} 回 使用済み', ko: 'MCP AI 읽기 {used}/{max}회 사용', vi: 'MCP AI đọc {used}/{max} lần đã dùng' },
  'usage-reset-hint': { zh: '💡 免費額度每月自動重置', en: '💡 Free quota resets monthly', ja: '💡 無料枠は毎月自動リセット', ko: '💡 무료 사용량은 매월 자동 초기화', vi: '💡 Hạn mức miễn phí tự động đặt lại mỗi tháng' },
  'day-pass-btn-full': { zh: '⚡ 日票 NT$20（24hr 無限）', en: '⚡ Day Pass NT$20 (24hr unlimited)', ja: '⚡ デイパス NT$20（24時間 無制限）', ko: '⚡ 데이 패스 NT$20 (24시간 무제한)', vi: '⚡ Vé ngày NT$20 (24 giờ không giới hạn)' },
  'monthly-btn-full': { zh: '✨ 月費 NT$80/月（最划算）', en: '✨ Monthly NT$80/mo (best value)', ja: '✨ 月額 NT$80/月（最もお得）', ko: '✨ 월정액 NT$80/월 (가장 저렴)', vi: '✨ Hàng tháng NT$80/tháng (đáng giá nhất)' },
  // PM-171：非台灣付費 coming soon
  'intl-coming-soon': { zh: '🌏 國際付款即將開放', en: '🌏 International Payments Coming Soon!', ja: '🌏 海外決済まもなく対応', ko: '🌏 해외 결제 곧 지원', vi: '🌏 Thanh toán quốc tế sắp có' },
  'intl-desc': {
    zh: '我們正在開通國際信用卡付款，敬請期待！',
    en: "We're working on enabling international credit card payments. Stay tuned!",
    ja: '海外クレジットカード決済を準備中です。お楽しみに！',
    ko: '해외 신용카드 결제를 준비 중입니다. 기대해 주세요!',
    vi: 'Chúng tôi đang mở thanh toán thẻ tín dụng quốc tế. Hãy chờ nhé!',
  },
  'intl-free-hint': {
    zh: '💡 免費版現在就能用 — 每月 10 次錄製 + 20 次 MCP AI 讀取',
    en: '💡 Free plan available now — 10 recordings + 20 MCP AI reads per month',
    ja: '💡 無料版は今すぐ利用可能 — 毎月 10 回の録画 + 20 回の MCP AI 読み取り',
    ko: '💡 무료 버전은 지금 바로 사용 가능 — 매월 녹화 10회 + MCP AI 읽기 20회',
    vi: '💡 Bản miễn phí dùng ngay — 10 lần ghi hình + 20 lần MCP AI đọc mỗi tháng',
  },
  'day-pass-badge': { zh: '⚡ 日票', en: '⚡ Day Pass', ja: '⚡ デイパス', ko: '⚡ 데이 패스', vi: '⚡ Vé ngày' },
  'day-pass-remaining': { zh: '剩餘 {h}h {m}m {s}s', en: '{h}h {m}m {s}s left', ja: '残り {h}時間 {m}分 {s}秒', ko: '{h}시간 {m}분 {s}초 남음', vi: 'Còn {h} giờ {m} phút {s} giây' },
  'day-pass-expire-hint': {
    zh: '日票到期後可升級月費',
    en: 'Upgrade to monthly after day pass expires',
    ja: 'デイパス終了後、月額にアップグレードできます',
    ko: '데이 패스 만료 후 월정액으로 업그레이드할 수 있습니다',
    vi: 'Sau khi vé ngày hết hạn có thể nâng cấp hàng tháng',
  },
  'paid-badge': { zh: '✨ 付費版會員', en: '✨ Premium Member', ja: '✨ 有料会員', ko: '✨ 유료 회원', vi: '✨ Thành viên trả phí' },
  'cancel-sub': { zh: '取消訂閱', en: 'Cancel', ja: '解約', ko: '구독 취소', vi: 'Hủy đăng ký' },
  'cancelled-prefix': { zh: '已取消訂閱，可用到', en: 'Cancelled, active until', ja: '解約済み、利用可能期限', ko: '구독 취소됨, 사용 가능 기한', vi: 'Đã hủy đăng ký, dùng được đến' },
  resub: { zh: '重新訂閱', en: 'Resubscribe', ja: '再購読', ko: '재구독', vi: 'Đăng ký lại' },

  // ── 進階設定 ──
  'lang-label': { zh: '🌐 語音語言', en: '🌐 Voice Language', ja: '🌐 音声言語', ko: '🌐 음성 언어', vi: '🌐 Ngôn ngữ giọng nói' },
  'advanced-settings': { zh: '⚙️ 進階設定', en: '⚙️ Advanced Settings', ja: '⚙️ 詳細設定', ko: '⚙️ 고급 설정', vi: '⚙️ Cài đặt nâng cao' },
  'monitor-toggle': { zh: '🔍 即時監控（AI 可查 error）', en: '🔍 Live Monitor (AI reads errors)', ja: '🔍 リアルタイム監視（AI が error を確認可能）', ko: '🔍 실시간 모니터링 (AI가 error 확인 가능)', vi: '🔍 Giám sát trực tiếp (AI đọc được error)' },
  'keyboard-toggle': { zh: '🔇 鍵盤模式（關閉語音）', en: '🔇 Keyboard Mode (no voice)', ja: '🔇 キーボードモード（音声オフ）', ko: '🔇 키보드 모드 (음성 끄기)', vi: '🔇 Chế độ bàn phím (tắt giọng nói)' },
  'hq-toggle': { zh: '📸 高畫質 AI 分析（高 Token）', en: '📸 HQ AI Analysis (high Token)', ja: '📸 高画質 AI 分析（高 Token）', ko: '📸 고화질 AI 분석 (높은 Token)', vi: '📸 Phân tích AI chất lượng cao (Token cao)' },
  'effect-toggle': { zh: '✨ 工具列特效', en: '✨ Toolbar Effects', ja: '✨ ツールバー エフェクト', ko: '✨ 툴바 효과', vi: '✨ Hiệu ứng thanh công cụ' },

  // ── AI 輪盤 ──
  'carousel-title': { zh: '一鍵複製指令貼給 AI', en: 'Copy prompt to AI', ja: 'AI へのコマンドをコピー', ko: 'AI에 명령어 복사', vi: 'Sao chép lệnh cho AI' },
  'copy-btn': { zh: '複製', en: 'Copy', ja: 'コピー', ko: '복사', vi: 'Sao chép' },
  'edit-btn': { zh: '✏️ 編輯', en: '✏️ Edit', ja: '✏️ 編集', ko: '✏️ 편집', vi: '✏️ Chỉnh sửa' },
  'save-btn': { zh: '💾 儲存', en: '💾 Save', ja: '💾 保存', ko: '💾 저장', vi: '💾 Lưu' },
  'cancel-btn': { zh: '取消', en: 'Cancel', ja: 'キャンセル', ko: '취소', vi: 'Hủy' },

  // ── 錄製中 / 完成 ──
  'stop-recording': { zh: '⏹ 停止錄製', en: '⏹ Stop Recording', ja: '⏹ 録画停止', ko: '⏹ 녹화 중지', vi: '⏹ Dừng ghi hình' },
  'done-title': { zh: '✅ 錄製完成！', en: '✅ Recording Done!', ja: '✅ 録画完了！', ko: '✅ 녹화 완료!', vi: '✅ Ghi hình xong!' },
  'sum-dom': { zh: 'DOM 事件', en: 'DOM Events', ja: 'DOM イベント', ko: 'DOM 이벤트', vi: 'Sự kiện DOM' },
  'sum-console': { zh: 'Console', en: 'Console', ja: 'Console', ko: 'Console', vi: 'Console' },
  'sum-network': { zh: 'Network 錯誤', en: 'Network Errors', ja: 'Network エラー', ko: 'Network 오류', vi: 'Lỗi Network' },
  'sum-voice': { zh: '語音片段', en: 'Voice Clips', ja: '音声クリップ', ko: '음성 클립', vi: 'Đoạn giọng nói' },
  'sum-time': { zh: '時間', en: 'Duration', ja: '時間', ko: '시간', vi: 'Thời gian' },
  'duration-sec': { zh: '{n} 秒', en: '{n}s', ja: '{n} 秒', ko: '{n}초', vi: '{n} giây' },
  'copy-json': { zh: '📋 複製 JSON', en: '📋 Copy JSON', ja: '📋 JSON をコピー', ko: '📋 JSON 복사', vi: '📋 Sao chép JSON' },
  'export-json': { zh: '💾 匯出 JSON（給 AI 讀）', en: '💾 Export JSON (for AI)', ja: '💾 JSON をエクスポート（AI 用）', ko: '💾 JSON 내보내기 (AI용)', vi: '💾 Xuất JSON (cho AI đọc)' },
  'clear-restart': { zh: '🗑️ 清除，重新錄製', en: '🗑️ Clear & Restart', ja: '🗑️ クリアして録り直し', ko: '🗑️ 지우고 다시 녹화', vi: '🗑️ Xóa, ghi lại' },
  'copy-link': { zh: '📋 複製連結', en: '📋 Copy Link', ja: '📋 リンクをコピー', ko: '📋 링크 복사', vi: '📋 Sao chép liên kết' },
  // PM-189：JSON 複製/匯出改付費功能 + 敏感資料免責警語
  'json-paid-only': { zh: '此為會員進階功能，請升級後使用', en: 'This is a member feature. Please upgrade to use.', ja: 'これは会員向け機能です。アップグレードしてご利用ください。', ko: '회원 전용 기능입니다. 업그레이드 후 사용하세요.', vi: 'Đây là tính năng thành viên. Vui lòng nâng cấp để dùng.' },
  'json-warning-title': { zh: '⚠️ JSON 資料包含完整除錯紀錄', en: '⚠️ JSON data contains full debug records', ja: '⚠️ JSON データには完全なデバッグ記録が含まれます', ko: '⚠️ JSON 데이터에는 전체 디버그 기록이 포함됩니다', vi: '⚠️ Dữ liệu JSON chứa toàn bộ bản ghi gỡ lỗi' },
  'json-warning-body': {
    zh: '此資料可能包含敏感資訊（API 金鑰、Token、錯誤訊息等），請勿將 JSON 資料分享給不信任的對象。因資料外洩造成的損失，BugEzy 不承擔責任。',
    en: 'This data may contain sensitive information (API keys, tokens, error messages, etc.). Do not share JSON data with untrusted parties. BugEzy is not responsible for any loss caused by data leakage.',
    ja: 'このデータには機密情報（API キー、Token、エラーメッセージなど）が含まれる可能性があります。信頼できない相手に JSON データを共有しないでください。データ漏洩による損害について、BugEzy は責任を負いません。',
    ko: '이 데이터에는 민감한 정보(API 키, Token, 오류 메시지 등)가 포함될 수 있습니다. 신뢰할 수 없는 상대에게 JSON 데이터를 공유하지 마세요. 데이터 유출로 인한 손실에 대해 BugEzy는 책임지지 않습니다.',
    vi: 'Dữ liệu này có thể chứa thông tin nhạy cảm (API key, Token, thông báo lỗi, v.v.). Đừng chia sẻ dữ liệu JSON cho bên không đáng tin cậy. BugEzy không chịu trách nhiệm cho tổn thất do rò rỉ dữ liệu.',
  },
  'json-confirm': { zh: '我了解，繼續', en: 'I understand, continue', ja: '理解しました、続行', ko: '이해했습니다, 계속', vi: 'Tôi hiểu, tiếp tục' },
  'json-cancel': { zh: '取消', en: 'Cancel', ja: 'キャンセル', ko: '취소', vi: 'Hủy' },
  'json-copy-locked': { zh: '🔒 複製 JSON（會員）', en: '🔒 Copy JSON (member)', ja: '🔒 JSON をコピー（会員）', ko: '🔒 JSON 복사 (회원)', vi: '🔒 Sao chép JSON (thành viên)' },
  'json-export-locked': { zh: '🔒 匯出 JSON（會員）', en: '🔒 Export JSON (member)', ja: '🔒 JSON をエクスポート（会員）', ko: '🔒 JSON 내보내기 (회원)', vi: '🔒 Xuất JSON (thành viên)' },
  // PM-191：一鍵複製 MCP 設定
  'copy-mcp': { zh: '📋 複製 MCP 設定', en: '📋 Copy MCP Config', ja: '📋 MCP 設定をコピー', ko: '📋 MCP 설정 복사', vi: '📋 Sao chép cấu hình MCP' },
  'copy-mcp-done': { zh: '✅ 已複製！貼到 Claude/Cursor 設定即可', en: '✅ Copied! Paste into your Claude/Cursor settings', ja: '✅ コピーしました！Claude/Cursor の設定に貼り付けてください', ko: '✅ 복사되었습니다! Claude/Cursor 설정에 붙여넣으세요', vi: '✅ Đã sao chép! Dán vào cài đặt Claude/Cursor của bạn' },
  'copy-mcp-login': { zh: '請先登入 BugEzy 再複製 MCP 設定', en: 'Please sign in to BugEzy before copying the MCP config', ja: 'MCP 設定をコピーする前に BugEzy にログインしてください', ko: 'MCP 설정을 복사하기 전에 BugEzy에 로그인하세요', vi: 'Vui lòng đăng nhập BugEzy trước khi sao chép cấu hình MCP' },
  'mcp-config-hint': { zh: '當 AI 無法讀取你的報告時，按此複製，貼給你的 AI 重新設定', en: 'If AI cannot read your reports, copy this and paste to your AI to reconfigure', ja: 'AI がレポートを読み取れない場合、これをコピーして AI に貼り付け、再設定してください', ko: 'AI가 리포트를 읽지 못할 때 이것을 복사하여 AI에 붙여넣고 다시 설정하세요', vi: 'Khi AI không đọc được báo cáo của bạn, sao chép cái này và dán cho AI để cấu hình lại' },
  // PM-193：精準轉錄麥克風授權引導
  'mic-fallback-tip': {
    zh: '⚠️ 精準轉錄麥克風授權不足，已切換為即時字幕模式。下次請選「允許這個網站使用」。',
    en: '⚠️ Whisper mic permission denied. Switched to realtime mode. Next time select "Always allow".',
    ja: '⚠️ 高精度文字起こしのマイク権限が不足しているため、リアルタイム字幕モードに切り替えました。次回は「このサイトに許可」を選択してください。',
    ko: '⚠️ 고정밀 변환 마이크 권한이 부족하여 실시간 자막 모드로 전환했습니다. 다음에는 "이 사이트에 허용"을 선택하세요.',
    vi: '⚠️ Quyền micro cho chuyển đổi chính xác không đủ, đã chuyển sang chế độ phụ đề trực tiếp. Lần sau hãy chọn "Luôn cho phép trang này".',
  },
  'mic-perm-hint': {
    zh: '💡 精準轉錄需選「永久允許」此網站使用麥克風',
    en: '💡 Whisper requires "Always allow" microphone permission',
    ja: '💡 高精度文字起こしには、このサイトのマイクを「常に許可」する必要があります',
    ko: '💡 고정밀 변환에는 이 사이트의 마이크를 "항상 허용"해야 합니다',
    vi: '💡 Chuyển đổi chính xác cần chọn "Luôn cho phép" micro cho trang này',
  },

  // ── mic OFF 提示 ──
  'mic-prompt-title': { zh: '麥克風目前關閉', en: 'Microphone is off', ja: 'マイクが現在オフです', ko: '마이크가 현재 꺼져 있습니다', vi: 'Micro hiện đang tắt' },
  'mic-prompt-desc': { zh: '要用語音描述 Bug 嗎？', en: 'Use voice to describe the bug?', ja: '音声で Bug を説明しますか？', ko: '음성으로 Bug를 설명하시겠습니까?', vi: 'Muốn mô tả Bug bằng giọng nói?' },
  'mic-prompt-on': { zh: '開啟並錄製', en: 'Turn on & record', ja: 'オンにして録画', ko: '켜고 녹화', vi: 'Bật và ghi hình' },
  'mic-prompt-skip': { zh: '直接錄製（不錄語音）', en: 'Record without voice', ja: '音声なしで録画', ko: '음성 없이 녹화', vi: 'Ghi hình không giọng nói' },

  // ── 版本（動態）──
  'update-available': {
    zh: '🆕 目前 v{cur} → 新版 v{new} 可用',
    en: '🆕 v{cur} → v{new} available',
    ja: '🆕 現在 v{cur} → 新版 v{new} が利用可能',
    ko: '🆕 현재 v{cur} → 새 버전 v{new} 사용 가능',
    vi: '🆕 Hiện tại v{cur} → có bản mới v{new}',
  },

  // ── PM-139：截圖工具列（content.ts）──
  'toolbar-fullpage': { zh: '📷 整頁', en: '📷 Full Page', ja: '📷 全ページ', ko: '📷 전체 페이지', vi: '📷 Toàn trang' },
  'toolbar-region': { zh: '⬜ 區域（兩點）', en: '⬜ Region (2 clicks)', ja: '⬜ 範囲（2クリック）', ko: '⬜ 영역 (2클릭)', vi: '⬜ Vùng (2 lần nhấp)' },
  'toolbar-freeform': { zh: '✂️ 自由形狀', en: '✂️ Freeform', ja: '✂️ フリーフォーム', ko: '✂️ 자유 형태', vi: '✂️ Tự do' },
  'toolbar-cancel': { zh: '✗ 取消', en: '✗ Cancel', ja: '✗ キャンセル', ko: '✗ 취소', vi: '✗ Hủy' },
  'toolbar-select-mode': { zh: '選擇截圖模式', en: 'Select screenshot mode', ja: 'スクリーンショットモードを選択', ko: '스크린샷 모드 선택', vi: 'Chọn chế độ chụp màn hình' },
  'toolbar-region-hint': { zh: '可自由捲動頁面，點第二下標記終點', en: 'Scroll freely, click again to set the end point', ja: 'ページを自由にスクロールし、もう一度クリックで終点を指定', ko: '페이지를 자유롭게 스크롤하고, 다시 클릭하여 끝점을 지정하세요', vi: 'Cuộn trang tự do, nhấp lần nữa để đánh dấu điểm cuối' },
  'transcribing': { zh: '⏳ 語音轉錄中…', en: '⏳ Transcribing…', ja: '⏳ 音声を文字起こし中…', ko: '⏳ 음성 변환 중…', vi: '⏳ Đang chuyển đổi giọng nói…' },

  // ── PM-139：即時監控（inject.ts，經 it()）──
  'monitor-active': { zh: '🟢 BugEzy 監控中', en: '🟢 BugEzy Monitoring', ja: '🟢 BugEzy 監視中', ko: '🟢 BugEzy 모니터링 중', vi: '🟢 BugEzy đang giám sát' },
  'monitor-errors': { zh: '⚠️ 發現 {n} 個錯誤（點我查看）', en: '⚠️ {n} error(s) found (click to view)', ja: '⚠️ {n} 個のエラーを検出（クリックで確認）', ko: '⚠️ 오류 {n}개 발견 (클릭하여 확인)', vi: '⚠️ Phát hiện {n} lỗi (nhấp để xem)' },
  'monitor-errors-title': { zh: 'BugEzy 偵測到 {n} 個錯誤，點我查看', en: 'BugEzy found {n} error(s), click to view', ja: 'BugEzy が {n} 個のエラーを検出、クリックで確認', ko: 'BugEzy가 오류 {n}개를 발견했습니다, 클릭하여 확인', vi: 'BugEzy phát hiện {n} lỗi, nhấp để xem' },
  'monitor-panel-title': { zh: '🐛 即時監控錯誤', en: '🐛 Live Monitor Errors', ja: '🐛 リアルタイム監視エラー', ko: '🐛 실시간 모니터링 오류', vi: '🐛 Lỗi giám sát trực tiếp' },
  'monitor-empty': { zh: '✓ 目前無錯誤', en: '✓ No errors', ja: '✓ 現在エラーなし', ko: '✓ 현재 오류 없음', vi: '✓ Hiện không có lỗi' },
  'monitor-upload': { zh: '📤 上傳報告讓 AI 分析', en: '📤 Upload report for AI analysis', ja: '📤 レポートをアップロードして AI に分析させる', ko: '📤 리포트를 업로드하여 AI 분석', vi: '📤 Tải báo cáo lên để AI phân tích' },
  'monitor-uploading': { zh: '⏳ 上傳中…', en: '⏳ Uploading…', ja: '⏳ アップロード中…', ko: '⏳ 업로드 중…', vi: '⏳ Đang tải lên…' },
  'monitor-uploaded': { zh: '✅ 已上傳！點此查看報告', en: '✅ Uploaded! Click to view report', ja: '✅ アップロード完了！クリックでレポートを表示', ko: '✅ 업로드 완료! 클릭하여 리포트 보기', vi: '✅ Đã tải lên! Nhấp để xem báo cáo' },
  'monitor-upload-fail': { zh: '❌ 上傳失敗，點此重試', en: '❌ Upload failed, click to retry', ja: '❌ アップロード失敗、クリックで再試行', ko: '❌ 업로드 실패, 클릭하여 재시도', vi: '❌ Tải lên thất bại, nhấp để thử lại' },
  'monitor-desc': { zh: '即時監控偵測到 {n} 個錯誤', en: 'Live monitor found {n} error(s)', ja: 'リアルタイム監視が {n} 個のエラーを検出', ko: '실시간 모니터링이 오류 {n}개를 발견했습니다', vi: 'Giám sát trực tiếp phát hiện {n} lỗi' },

  // ── PM-139：錄製字幕 / 麥克風授權（inject.ts，經 it()）──
  'caption-recording': { zh: '🎙 錄製中，可以用中文描述問題…', en: '🎙 Recording — describe the issue by voice…', ja: '🎙 録画中、音声で問題を説明できます…', ko: '🎙 녹화 중, 음성으로 문제를 설명할 수 있습니다…', vi: '🎙 Đang ghi hình, bạn có thể mô tả vấn đề bằng giọng nói…' },
  'caption-voice-log': { zh: '📝 語音記錄', en: '📝 Voice Log', ja: '📝 音声記録', ko: '📝 음성 기록', vi: '📝 Ghi âm' },
  'keyboard-bar': { zh: '🔇 鍵盤模式 — 錄製中（語音已關閉）', en: '🔇 Keyboard mode — recording (voice off)', ja: '🔇 キーボードモード — 録画中（音声オフ）', ko: '🔇 키보드 모드 — 녹화 중 (음성 꺼짐)', vi: '🔇 Chế độ bàn phím — đang ghi hình (giọng nói đã tắt)' },
  'whisper-bar': { zh: '🎙️ 錄音中…（停止後自動轉錄）', en: '🎙️ Recording…（auto-transcribe on stop）', ja: '🎙️ 録音中…（停止後に自動で文字起こし）', ko: '🎙️ 녹음 중…（중지 후 자동 변환）', vi: '🎙️ Đang ghi âm…（tự động chuyển đổi sau khi dừng）' },
  // PM-216：即時字幕浮動條狀態文字（inject.ts setVoiceStatus）
  'caption-listening': { zh: '🟢 聽取中…', en: '🟢 Listening…', ja: '🟢 聞き取り中…', ko: '🟢 듣는 중…', vi: '🟢 Đang nghe…' },
  'caption-restarting': { zh: '🟡 重啟中…', en: '🟡 Restarting…', ja: '🟡 再起動中…', ko: '🟡 재시작 중…', vi: '🟡 Đang khởi động lại…' },
  'caption-stopped': { zh: '🔴 已停止', en: '🔴 Stopped', ja: '🔴 停止しました', ko: '🔴 중지됨', vi: '🔴 Đã dừng' },
  'caption-note-restart': { zh: '按 🔄 重啟', en: 'Press 🔄 to restart', ja: '🔄 で再起動', ko: '🔄 눌러 재시작', vi: 'Nhấn 🔄 để khởi động lại' },
  'caption-note-denied': { zh: '麥克風被拒絕', en: 'Microphone denied', ja: 'マイクが拒否されました', ko: '마이크가 거부되었습니다', vi: 'Micro bị từ chối' },
  'caption-note-nocapture': { zh: '麥克風無法擷取，請檢查裝置', en: "Can't capture mic — check your device", ja: 'マイクを取得できません。デバイスを確認してください', ko: '마이크를 캡처할 수 없습니다. 장치를 확인하세요', vi: 'Không thể thu micro, hãy kiểm tra thiết bị' },
  'caption-note-noaccess': { zh: '麥克風無法存取', en: 'Microphone unavailable', ja: 'マイクにアクセスできません', ko: '마이크에 접근할 수 없습니다', vi: 'Không thể truy cập micro' },
  'caption-note-restart-fail': { zh: '重啟失敗，請重新整理頁面', en: 'Restart failed — please refresh the page', ja: '再起動に失敗しました。ページを再読み込みしてください', ko: '재시작에 실패했습니다. 페이지를 새로고침하세요', vi: 'Khởi động lại thất bại, vui lòng tải lại trang' },
  // PM-216：麥克風授權頁（mic-permission）
  'mperm-title': { zh: 'BugEzy 麥克風授權', en: 'BugEzy Microphone Permission', ja: 'BugEzy マイク許可', ko: 'BugEzy 마이크 권한', vi: 'Quyền micro BugEzy' },
  'mperm-h': { zh: 'BugEzy 需要麥克風權限', en: 'BugEzy needs microphone access', ja: 'BugEzy にはマイクの許可が必要です', ko: 'BugEzy에 마이크 권한이 필요합니다', vi: 'BugEzy cần quyền truy cập micro' },
  'mperm-desc': {
    zh: '允許後即可用語音描述 Bug。<br />此授權只需一次，之後自動啟用。',
    en: 'Allow access to describe bugs by voice.<br />One-time only — enabled automatically afterwards.',
    ja: '許可すると音声で Bug を説明できます。<br />許可は一度だけで、以降は自動で有効になります。',
    ko: '허용하면 음성으로 Bug를 설명할 수 있습니다.<br />권한은 한 번만 필요하며 이후 자동으로 활성화됩니다.',
    vi: 'Cho phép để mô tả Bug bằng giọng nói.<br />Chỉ cần cấp quyền một lần, sau đó tự động kích hoạt.',
  },
  'mperm-requesting': { zh: '正在請求授權...', en: 'Requesting permission…', ja: '許可をリクエスト中...', ko: '권한 요청 중...', vi: 'Đang yêu cầu quyền...' },
  'mperm-granted': {
    zh: '✅ 麥克風已授權成功！此頁面 3 秒後自動關閉...',
    en: '✅ Microphone granted! This page closes in 3 seconds…',
    ja: '✅ マイクが許可されました！このページは 3 秒後に自動で閉じます…',
    ko: '✅ 마이크가 허용되었습니다! 이 페이지는 3초 후 자동으로 닫힙니다…',
    vi: '✅ Đã cấp quyền micro! Trang này tự đóng sau 3 giây…',
  },
  'mperm-denied': {
    zh: '❌ 授權被拒絕。請在瀏覽器設定中允許麥克風後重試。',
    en: '❌ Permission denied. Please allow microphone in browser settings and retry.',
    ja: '❌ 許可が拒否されました。ブラウザの設定でマイクを許可してから再試行してください。',
    ko: '❌ 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용한 후 다시 시도하세요.',
    vi: '❌ Quyền bị từ chối. Vui lòng cho phép micro trong cài đặt trình duyệt rồi thử lại.',
  },
  'mic-perm-title': { zh: 'BugEzy 需要麥克風權限', en: 'BugEzy needs microphone access', ja: 'BugEzy にはマイクの許可が必要です', ko: 'BugEzy에 마이크 권한이 필요합니다', vi: 'BugEzy cần quyền truy cập micro' },
  'mic-perm-desc': { zh: '允許後可用語音描述 Bug · 此網站只需授權一次', en: 'Allow to describe bugs by voice · one-time per site', ja: '許可すると音声で Bug を説明できます · サイトごとに一度だけ', ko: '허용하면 음성으로 Bug를 설명할 수 있습니다 · 사이트당 한 번만', vi: 'Cho phép để mô tả Bug bằng giọng nói · chỉ một lần mỗi trang' },
  'mic-perm-allow': { zh: '允許麥克風', en: 'Allow microphone', ja: 'マイクを許可', ko: '마이크 허용', vi: 'Cho phép micro' },
  'mic-perm-skip': { zh: '跳過（不錄語音）', en: 'Skip (no voice)', ja: 'スキップ（音声なし）', ko: '건너뛰기 (음성 없음)', vi: 'Bỏ qua (không giọng nói)' },

  // ── PM-139：截圖標注頁（annotate）──
  'annotate-pen': { zh: '✏️ 畫筆', en: '✏️ Pen', ja: '✏️ ペン', ko: '✏️ 펜', vi: '✏️ Bút' },
  'annotate-arrow': { zh: '➡️ 箭頭', en: '➡️ Arrow', ja: '➡️ 矢印', ko: '➡️ 화살표', vi: '➡️ Mũi tên' },
  'annotate-rect': { zh: '⬜ 框框', en: '⬜ Box', ja: '⬜ 枠', ko: '⬜ 박스', vi: '⬜ Khung' },
  'annotate-text': { zh: '📝 文字', en: '📝 Text', ja: '📝 テキスト', ko: '📝 텍스트', vi: '📝 Văn bản' },
  'annotate-color': { zh: '顏色', en: 'Color', ja: '色', ko: '색상', vi: 'Màu' },
  'annotate-thickness': { zh: '粗細', en: 'Width', ja: '太さ', ko: '두께', vi: 'Độ dày' },
  'annotate-thin': { zh: '細', en: 'Thin', ja: '細', ko: '얇게', vi: 'Mỏng' },
  'annotate-mid': { zh: '中', en: 'Medium', ja: '中', ko: '중간', vi: 'Vừa' },
  'annotate-thick': { zh: '粗', en: 'Thick', ja: '太', ko: '굵게', vi: 'Dày' },
  'annotate-undo': { zh: '↩️ 復原', en: '↩️ Undo', ja: '↩️ 元に戻す', ko: '↩️ 실행 취소', vi: '↩️ Hoàn tác' },
  'annotate-clear': { zh: '🗑️ 清除全部', en: '🗑️ Clear All', ja: '🗑️ すべてクリア', ko: '🗑️ 모두 지우기', vi: '🗑️ Xóa tất cả' },
  'annotate-cancel': { zh: '✗ 取消', en: '✗ Cancel', ja: '✗ キャンセル', ko: '✗ 취소', vi: '✗ Hủy' },
  'annotate-save': { zh: '✅ 完成儲存', en: '✅ Save', ja: '✅ 保存', ko: '✅ 저장', vi: '✅ Lưu' },
  'annotate-next': { zh: '📤 下一步', en: '📤 Next', ja: '📤 次へ', ko: '📤 다음', vi: '📤 Tiếp theo' }, // PM-204：截圖標注完導到編輯報告頁
  'annotate-desc-label': { zh: '💬 問題描述（選填）', en: '💬 Description (optional)', ja: '💬 問題の説明（任意）', ko: '💬 문제 설명 (선택)', vi: '💬 Mô tả vấn đề (tùy chọn)' },
  'annotate-desc-ph': { zh: '描述你看到的問題，或按右邊麥克風語音輸入...', en: 'Describe the issue, or tap the mic on the right to dictate...', ja: '見つけた問題を説明するか、右のマイクで音声入力...', ko: '발견한 문제를 설명하거나, 오른쪽 마이크로 음성 입력하세요...', vi: 'Mô tả vấn đề bạn thấy, hoặc nhấn micro bên phải để nhập bằng giọng nói...' },
  'annotate-listening': { zh: '🔴 聆聽中，邊畫邊說描述問題...', en: '🔴 Listening — describe while you draw...', ja: '🔴 聞き取り中、描きながら問題を説明してください...', ko: '🔴 듣는 중, 그리면서 문제를 설명하세요...', vi: '🔴 Đang nghe, vừa vẽ vừa mô tả vấn đề...' },
  'annotate-uploading': { zh: '⏳ 上傳中...', en: '⏳ Uploading...', ja: '⏳ アップロード中...', ko: '⏳ 업로드 중...', vi: '⏳ Đang tải lên...' },
  // PM-250：截圖標注頁 Whisper 提示 i18n（zh-CN 由 zh 自動 toSimplified；yue 走 zh UI）
  'an-whisper-recording': {
    zh: '🔴 Whisper 錄音中，講完按 ⏹ 轉錄…',
    en: '🔴 Whisper recording — press ⏹ when done to transcribe…',
    ja: '🔴 Whisper 録音中——話し終えたら ⏹ で文字起こし…',
    ko: '🔴 Whisper 녹음 중——끝나면 ⏹ 눌러 변환…',
    vi: '🔴 Whisper đang ghi âm — nói xong nhấn ⏹ để chuyển đổi…',
  },
  'an-whisper-transcribing': {
    zh: '⏳ Whisper 轉錄中…',
    en: '⏳ Whisper transcribing…',
    ja: '⏳ Whisper 文字起こし中…',
    ko: '⏳ Whisper 변환 중…',
    vi: '⏳ Whisper đang chuyển đổi…',
  },
  'an-whisper-paid-only': {
    zh: 'Whisper 為付費功能，請升級（或改用鍵盤）',
    en: 'Whisper is a premium feature. Please upgrade (or use keyboard).',
    ja: 'Whisper は有料機能です。アップグレードしてください（またはキーボードをご利用ください）。',
    ko: 'Whisper는 유료 기능입니다. 업그레이드하세요 (또는 키보드를 사용하세요).',
    vi: 'Whisper là tính năng trả phí. Vui lòng nâng cấp (hoặc dùng bàn phím).',
  },
  'an-whisper-prompt': {
    zh: '🎙️ 付費版 Whisper：按 🎤 錄音描述，講完按 ⏹ 轉錄',
    en: '🎙️ Premium Whisper: tap 🎤 to record, ⏹ when done to transcribe',
    ja: '🎙️ 有料版 Whisper：🎤 で録音、話し終えたら ⏹ で文字起こし',
    ko: '🎙️ 유료 Whisper: 🎤 눌러 녹음, 끝나면 ⏹ 눌러 변환',
    vi: '🎙️ Whisper trả phí: nhấn 🎤 để ghi âm, ⏹ khi xong để chuyển đổi',
  },

  // ── PM-215：編輯報告頁（edit-report）i18n ──
  'er-tag': { zh: '報告編輯', en: 'Edit Report', ja: 'レポート編集', ko: '리포트 편집', vi: 'Chỉnh sửa báo cáo' },
  'er-summary-h': { zh: '📊 錄製摘要', en: '📊 Recording Summary', ja: '📊 録画サマリー', ko: '📊 녹화 요약', vi: '📊 Tóm tắt ghi hình' },
  'er-marker-h': { zh: '📌 時間軸標記', en: '📌 Timeline Markers', ja: '📌 タイムラインマーカー', ko: '📌 타임라인 마커', vi: '📌 Đánh dấu dòng thời gian' },
  'er-clean': { zh: '🧹 乾淨模式', en: '🧹 Clean View', ja: '🧹 クリーンモード', ko: '🧹 클린 모드', vi: '🧹 Chế độ sạch' },
  'er-mark': { zh: '📌 標記此刻', en: '📌 Mark Now', ja: '📌 このタイミングをマーク', ko: '📌 이 시점 마크', vi: '📌 Đánh dấu thời điểm' },
  'er-voice-h': { zh: '🎤 語音記錄（自動辨識）', en: '🎤 Voice Transcript (auto)', ja: '🎤 音声記録（自動認識）', ko: '🎤 음성 기록 (자동 인식)', vi: '🎤 Ghi âm (nhận dạng tự động)' },
  'er-ai-correct': { zh: '🔧 AI 校正', en: '🔧 AI Fix', ja: '🔧 AI 校正', ko: '🔧 AI 교정', vi: '🔧 AI hiệu chỉnh' },
  'er-ai-summarize': { zh: '🤖 AI 精簡', en: '🤖 AI Summarize', ja: '🤖 AI 要約', ko: '🤖 AI 요약', vi: '🤖 AI tóm tắt' },
  'er-voice-ph': { zh: '（這次錄製沒有語音）', en: '(No voice in this recording)', ja: '（今回の録画に音声はありません）', ko: '(이번 녹화에는 음성이 없습니다)', vi: '(Bản ghi này không có giọng nói)' },
  'er-desc-h': { zh: '💬 補充說明（選填）', en: '💬 Notes (optional)', ja: '💬 補足説明（任意）', ko: '💬 보충 설명 (선택)', vi: '💬 Ghi chú bổ sung (tùy chọn)' },
  'er-desc-ph': { zh: '打字或按右邊麥克風語音補充...', en: 'Type, or use the mic on the right to dictate...', ja: '入力するか、右のマイクで音声補足...', ko: '입력하거나 오른쪽 마이크로 음성 보충...', vi: 'Gõ, hoặc dùng micro bên phải để nhập bằng giọng nói...' },
  'er-token-h': { zh: '📊 Token 估算', en: '📊 Token Estimate', ja: '📊 トークン見積もり', ko: '📊 토큰 추정', vi: '📊 Ước tính Token' },
  'er-discard': { zh: '✗ 捨棄報告', en: '✗ Discard', ja: '✗ レポートを破棄', ko: '✗ 리포트 삭제', vi: '✗ Xóa báo cáo' },
  'er-upload': { zh: '✅ 上傳報告', en: '✅ Upload Report', ja: '✅ レポートをアップロード', ko: '✅ 리포트 업로드', vi: '✅ Tải báo cáo lên' },
  // dynamic
  'er-no-report': { zh: '找不到報告資料', en: 'Report data not found', ja: 'レポートデータが見つかりません', ko: '리포트 데이터를 찾을 수 없습니다', vi: 'Không tìm thấy dữ liệu báo cáo' },
  'er-row-screenshot': { zh: '截圖', en: 'Screenshots', ja: 'スクリーンショット', ko: '스크린샷', vi: 'Ảnh chụp' },
  'er-row-dom': { zh: 'DOM 事件', en: 'DOM events', ja: 'DOM イベント', ko: 'DOM 이벤트', vi: 'Sự kiện DOM' },
  'er-row-voice': { zh: '語音片段', en: 'Voice segments', ja: '音声クリップ', ko: '음성 클립', vi: 'Đoạn giọng nói' },
  'er-row-duration': { zh: '時長', en: 'Duration', ja: '長さ', ko: '길이', vi: 'Thời lượng' },
  'er-row-page': { zh: '頁面', en: 'Page', ja: 'ページ', ko: '페이지', vi: 'Trang' },
  'er-sec': { zh: '秒', en: 's', ja: '秒', ko: '초', vi: 'giây' },
  'er-screenshot-preview': { zh: '📸 截圖預覽', en: '📸 Screenshot Preview', ja: '📸 スクリーンショットプレビュー', ko: '📸 스크린샷 미리보기', vi: '📸 Xem trước ảnh chụp' },
  'er-screenshot-voice': {
    zh: '📸 截圖模式：語音內容已包含在補充說明中',
    en: '📸 Screenshot mode: voice content is included in the description below.',
    ja: '📸 スクリーンショットモード：音声内容は下の補足説明に含まれています',
    ko: '📸 스크린샷 모드: 음성 내용은 아래 보충 설명에 포함되어 있습니다',
    vi: '📸 Chế độ chụp màn hình: nội dung giọng nói đã có trong phần ghi chú bổ sung bên dưới',
  },
  'er-listening': { zh: '🔴 聆聽中...', en: '🔴 Listening...', ja: '🔴 聞き取り中...', ko: '🔴 듣는 중...', vi: '🔴 Đang nghe...' },
  'er-no-sr': { zh: '此瀏覽器不支援語音辨識', en: 'Voice recognition not supported in this browser', ja: 'このブラウザは音声認識に対応していません', ko: '이 브라우저는 음성 인식을 지원하지 않습니다', vi: 'Trình duyệt này không hỗ trợ nhận dạng giọng nói' },
  'er-no-mic': { zh: '❌ 麥克風無法存取', en: '❌ Microphone unavailable', ja: '❌ マイクにアクセスできません', ko: '❌ 마이크에 접근할 수 없습니다', vi: '❌ Không thể truy cập micro' },
  'er-restarted': { zh: '🔴 語音已重啟...', en: '🔴 Voice restarted...', ja: '🔴 音声を再起動しました...', ko: '🔴 음성을 재시작했습니다...', vi: '🔴 Đã khởi động lại giọng nói...' },
  'er-voice-interrupted': { zh: '⚠ 語音中斷，按 🎤 重新啟動', en: '⚠ Voice interrupted — press 🎤 to restart', ja: '⚠ 音声が中断しました。🎤 を押して再起動', ko: '⚠ 음성이 중단되었습니다. 🎤를 눌러 재시작', vi: '⚠ Giọng nói bị gián đoạn, nhấn 🎤 để khởi động lại' },
  'er-voice-error': { zh: '語音錯誤：', en: 'Voice error: ', ja: '音声エラー：', ko: '음성 오류: ', vi: 'Lỗi giọng nói: ' },
  'er-keyboard': { zh: '🔇 鍵盤模式', en: '🔇 Keyboard mode', ja: '🔇 キーボードモード', ko: '🔇 키보드 모드', vi: '🔇 Chế độ bàn phím' },
  'er-uploading': { zh: '⏳ 上傳中...', en: '⏳ Uploading...', ja: '⏳ アップロード中...', ko: '⏳ 업로드 중...', vi: '⏳ Đang tải lên...' },
  'er-uploaded': { zh: '✅ 已上傳！分享連結：', en: '✅ Uploaded! Share link: ', ja: '✅ アップロード完了！共有リンク：', ko: '✅ 업로드 완료! 공유 링크: ', vi: '✅ Đã tải lên! Liên kết chia sẻ: ' },
  'er-copy-link': { zh: '複製連結', en: 'Copy link', ja: 'リンクをコピー', ko: '링크 복사', vi: 'Sao chép liên kết' },
  'er-upload-done': { zh: '✅ 已上傳', en: '✅ Uploaded', ja: '✅ アップロード完了', ko: '✅ 업로드 완료', vi: '✅ Đã tải lên' },
  'er-close': { zh: '關閉', en: 'Close', ja: '閉じる', ko: '닫기', vi: 'Đóng' },
  'er-upload-fail': { zh: '❌ 上傳失敗：', en: '❌ Upload failed: ', ja: '❌ アップロード失敗：', ko: '❌ 업로드 실패: ', vi: '❌ Tải lên thất bại: ' },
  'er-unknown-err': { zh: '未知錯誤，請重試', en: 'Unknown error, please retry', ja: '不明なエラー、再試行してください', ko: '알 수 없는 오류, 다시 시도하세요', vi: 'Lỗi không xác định, vui lòng thử lại' },
  'er-correcting': { zh: '🔧 校正中...', en: '🔧 Fixing...', ja: '🔧 校正中...', ko: '🔧 교정 중...', vi: '🔧 Đang hiệu chỉnh...' },
  'er-corrected': { zh: '✅ 已校正', en: '✅ Fixed', ja: '✅ 校正しました', ko: '✅ 교정 완료', vi: '✅ Đã hiệu chỉnh' },
  'er-correct-fail': { zh: '❌ 校正失敗', en: '❌ Fix failed', ja: '❌ 校正に失敗しました', ko: '❌ 교정 실패', vi: '❌ Hiệu chỉnh thất bại' },
  'er-too-short': { zh: '語音記錄太短，無需精簡', en: 'Transcript too short to summarize', ja: '音声記録が短すぎて要約できません', ko: '음성 기록이 너무 짧아 요약할 수 없습니다', vi: 'Bản ghi quá ngắn, không cần tóm tắt' },
  'er-summarizing': { zh: '🤖 精簡中...', en: '🤖 Summarizing...', ja: '🤖 要約中...', ko: '🤖 요약 중...', vi: '🤖 Đang tóm tắt...' },
  'er-summarized': { zh: '✅ 已精簡（不可重複）', en: '✅ Summarized (once only)', ja: '✅ 要約しました（再実行不可）', ko: '✅ 요약 완료 (재실행 불가)', vi: '✅ Đã tóm tắt (không lặp lại)' },
  'er-fail': { zh: '❌ 失敗', en: '❌ Failed', ja: '❌ 失敗', ko: '❌ 실패', vi: '❌ Thất bại' },
  // Token 估算面板
  'er-tok-voice': { zh: '語音記錄', en: 'Voice transcript', ja: '音声記録', ko: '음성 기록', vi: 'Ghi âm' },
  'er-tok-desc': { zh: '補充說明', en: 'Notes', ja: '補足説明', ko: '보충 설명', vi: 'Ghi chú bổ sung' },
  'er-tok-markers': { zh: '時間軸標記', en: 'Timeline markers', ja: 'タイムラインマーカー', ko: '타임라인 마커', vi: 'Đánh dấu dòng thời gian' },
  'er-tok-dom': { zh: 'DOM 摘要', en: 'DOM summary', ja: 'DOM サマリー', ko: 'DOM 요약', vi: 'Tóm tắt DOM' },
  'er-tok-total': { zh: 'AI 讀取總計', en: 'AI read total', ja: 'AI 読み取り合計', ko: 'AI 읽기 합계', vi: 'Tổng AI đọc' },
  'er-tok-compare': { zh: '💡 同場景 Claude in Chrome：', en: '💡 Same task with Claude in Chrome: ', ja: '💡 同じ場面での Claude in Chrome：', ko: '💡 동일 작업의 Claude in Chrome: ', vi: '💡 Cùng tác vụ với Claude in Chrome: ' },
  'er-tok-saved': { zh: '✅ BugEzy 為你省了', en: '✅ BugEzy saves you', ja: '✅ BugEzy が節約した量', ko: '✅ BugEzy가 절약한 양', vi: '✅ BugEzy giúp bạn tiết kiệm' },

  // ── PM-139：alert / confirm（popup.ts）──
  'confirm-cancel-sub': {
    zh: '確定要取消月費訂閱嗎？\n取消後到期日前仍可使用付費功能，到期後自動降回免費版。',
    en: 'Cancel your monthly subscription?\nYou can still use premium features until the end of your billing period.',
    ja: '月額サブスクリプションを解約しますか？\n解約後も期限までは有料機能を利用でき、期限後は自動で無料版に戻ります。',
    ko: '월 구독을 취소하시겠습니까?\n취소 후에도 만료일까지 유료 기능을 사용할 수 있으며, 만료 후 자동으로 무료 버전으로 전환됩니다.',
    vi: 'Hủy đăng ký hàng tháng?\nSau khi hủy vẫn dùng được tính năng trả phí đến hết kỳ, sau đó tự động về bản miễn phí.',
  },
  'alert-cancelled': {
    zh: '已取消訂閱。到期日前仍可使用付費功能。',
    en: 'Subscription cancelled. Premium features remain active until end of billing period.',
    ja: '解約しました。期限までは有料機能を利用できます。',
    ko: '구독이 취소되었습니다. 만료일까지 유료 기능을 사용할 수 있습니다.',
    vi: 'Đã hủy đăng ký. Vẫn dùng được tính năng trả phí đến hết kỳ thanh toán.',
  },
  'alert-cancel-fail': { zh: '取消失敗，請稍後再試', en: 'Cancellation failed, please try again later', ja: '解約に失敗しました。しばらくしてから再試行してください', ko: '취소에 실패했습니다. 잠시 후 다시 시도하세요', vi: 'Hủy thất bại, vui lòng thử lại sau' },
};

/** PM-115：AI 慣用語輪盤的一則（文字 + 顏色標記）。 */
export interface PromptItem {
  text: string;
  color: string;
}

/** PM-139：AI 輪盤多語預設慣用語（語言切換時，若使用者未自訂則重置為對應語言預設）。 */
const DEFAULT_PROMPTS: { zh: PromptItem[]; en: PromptItem[]; ja: PromptItem[]; ko: PromptItem[]; vi: PromptItem[] } = {
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
  ja: [
    { text: 'BugEzy の最新レポートを読み取り、問題を見つけて修正してください', color: '#ef4444' },
    {
      text: 'BugEzy の最新レポートを読み取り、分析してください：\n1. 本当の root cause\n2. 修正方法\n3. どのファイルを変更するか\n4. fix plan を作成\n推測せず、情報が不足している場合は必要な情報を教えてください',
      color: '#3b82f6',
    },
    { text: '最新のスクリーンショットレポートを読み取り、画面のどこに問題があるか確認し、CSS/HTML の修正案をください', color: '#22c55e' },
    { text: 'BugEzy の最新レポートを読み取り、そのまま貼り付けられる修正コードをください', color: '#f59e0b' },
  ],
  ko: [
    { text: '최신 BugEzy 리포트를 읽고 문제를 찾아 수정해 주세요', color: '#ef4444' },
    {
      text: '최신 BugEzy 리포트를 읽고 분석해 주세요:\n1. 진짜 root cause\n2. 수정 방법\n3. 어떤 파일을 변경할지\n4. fix plan 생성\n추측하지 말고, 정보가 부족하면 필요한 정보를 알려주세요',
      color: '#3b82f6',
    },
    { text: '최신 스크린샷 리포트를 읽고 화면의 어디에 문제가 있는지 확인하여 CSS/HTML 수정안을 주세요', color: '#22c55e' },
    { text: '최신 BugEzy 리포트를 읽고 그대로 붙여넣을 수 있는 수정 코드를 주세요', color: '#f59e0b' },
  ],
  vi: [
    { text: 'Đọc báo cáo BugEzy mới nhất của tôi và giúp tôi tìm và sửa lỗi', color: '#ef4444' },
    {
      text: 'Đọc báo cáo BugEzy mới nhất và phân tích:\n1. root cause thực sự\n2. Cách sửa\n3. Cần sửa file nào\n4. Tạo fix plan\nĐừng đoán — nếu thiếu thông tin, hãy cho tôi biết cần cung cấp gì',
      color: '#3b82f6',
    },
    { text: 'Đọc báo cáo ảnh chụp mới nhất, xác định vấn đề UI, và cho tôi cách sửa CSS/HTML', color: '#22c55e' },
    { text: 'Đọc báo cáo BugEzy mới nhất và cho tôi mã sửa lỗi có thể dán trực tiếp', color: '#f59e0b' },
  ],
};

/** PM-232~235：取對應語言的預設慣用語；zh-CN 由繁體即時轉簡體；ja/ko/vi 用手譯。 */
export function getDefaultPrompts(lang: UILang): PromptItem[] {
  if (lang === 'zh-CN') return DEFAULT_PROMPTS.zh.map((p) => ({ ...p, text: toSimplified(p.text) }));
  if (lang === 'ja') return DEFAULT_PROMPTS.ja;
  if (lang === 'ko') return DEFAULT_PROMPTS.ko;
  if (lang === 'vi') return DEFAULT_PROMPTS.vi;
  return DEFAULT_PROMPTS[lang === 'en' ? 'en' : 'zh'];
}

/** 取翻譯字串。找不到 key 回 key 本身；找不到該語言回中文；支援 {name} 佔位替換。 */
export function t(key: string, lang: UILang, params?: Record<string, string | number>): string {
  const entry = dict[key];
  // PM-232：zh-CN 由繁體字串即時轉簡體（toSimplified）；PM-233~235：ja/ko/vi 為手譯，直接取值
  let text: string;
  if (!entry) text = key;
  else if (lang === 'zh-CN') text = toSimplified(entry.zh);
  else if (lang === 'ja') text = entry.ja;
  else if (lang === 'ko') text = entry.ko;
  else if (lang === 'vi') text = entry.vi;
  else if (lang === 'en') text = entry.en;
  else text = entry.zh;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
