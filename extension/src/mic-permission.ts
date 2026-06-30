// mic-permission.ts — PM-88：可見的麥克風授權頁
// Chrome 只在「可見頁面」彈麥克風授權；offscreen 是隱藏頁不會彈。
// 第一次需要時 background 開此分頁觸發授權，成功後通知 background 並自動關閉。

import { MIC_KEY } from './types';

(async () => {
  const status = document.getElementById('status');
  if (!status) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 授權成功，立刻停止音軌（這裡只為取得權限，不錄音）
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = '✅ 已授權！此分頁將自動關閉...';
    status.style.color = '#3fb950';
    await chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_GRANTED' });
    await chrome.storage.local.set({ [MIC_KEY]: true }); // PM-89：授權完直接把 mic toggle 設為 ON
    setTimeout(() => window.close(), 1500);
  } catch {
    status.textContent = '❌ 授權被拒絕。請在瀏覽器設定中允許麥克風後重試。';
    status.style.color = '#f85149';
  }
})();
