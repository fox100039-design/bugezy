// net.ts — PM-156：網路環境快照（inject MAIN world + annotate 擴充頁共用）
// navigator.connection = Chrome 61+ Network Information API；小白常遇「我電腦好的、客戶那壞」
// 多半是網路環境不同（3G / 高延遲 / 離線）——附給 AI 診斷。

import type { NetworkSnapshot } from './types';

export function getNetworkSnapshot(): NetworkSnapshot {
  const conn = (
    navigator as Navigator & {
      connection?: {
        effectiveType?: string;
        rtt?: number;
        downlink?: number;
        saveData?: boolean;
        type?: string;
      };
    }
  ).connection;
  return {
    online: navigator.onLine,
    effectiveType: conn?.effectiveType || 'unknown',
    rtt: conn?.rtt ?? null,
    downlink: conn?.downlink ?? null,
    saveData: conn?.saveData ?? false,
    type: conn?.type || 'unknown',
  };
}
