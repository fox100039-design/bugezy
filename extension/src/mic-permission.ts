// mic-permission.ts — PM-88：可見的麥克風授權頁
// Chrome 只在「可見頁面」彈麥克風授權；offscreen 是隱藏頁不會彈。
// 第一次需要時 background 開此分頁觸發授權，成功後通知 background 並自動關閉。

import { LANG_KEY, MIC_KEY } from './types';
import { getUILang, t } from './i18n';

(async () => {
  // PM-216：授權頁 i18n——跟隨 popup 語言設定（LANG_KEY）
  const langStore = await chrome.storage.local.get(LANG_KEY);
  const uiLang = getUILang((langStore[LANG_KEY] as string) || 'zh');
  const T = (key: string) => t(key, uiLang);
  document.title = T('mperm-title');
  const permH = document.getElementById('permH');
  if (permH) permH.textContent = T('mperm-h');
  const permDesc = document.getElementById('permDesc');
  if (permDesc) permDesc.innerHTML = T('mperm-desc'); // 含 <br />，靜態內容安全

  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = T('mperm-requesting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 授權成功，立刻停止音軌（這裡只為取得權限，不錄音）
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = T('mperm-granted');
    status.style.color = '#3fb950';
    await chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_GRANTED' });
    await chrome.storage.local.set({ [MIC_KEY]: true }); // PM-89：授權完直接把 mic toggle 設為 ON
    setTimeout(() => window.close(), 3000); // PM-90：停留加長至 3 秒，讓使用者看清楚
  } catch {
    status.textContent = T('mperm-denied');
    status.style.color = '#f85149';
  }
})();
