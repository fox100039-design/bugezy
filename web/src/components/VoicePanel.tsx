import type { Report } from '../types';

interface Props {
  transcript: Report['voiceTranscript'];
}

// 相對時間（從第一句起算）格式化為 m:ss
function relTime(ts: number, base: number): string {
  const sec = Math.max(0, Math.round((ts - base) / 1000));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function VoicePanel({ transcript }: Props) {
  const base = transcript.length > 0 ? transcript[0].timestamp : 0;
  return (
    <div className="panel">
      <h2>語音字幕（{transcript.length}）</h2>
      {transcript.length === 0 ? (
        <div className="empty">無語音記錄</div>
      ) : (
        <ul>
          {transcript.map((seg, i) => (
            <li key={i}>
              <span className="ts">{relTime(seg.timestamp, base)}　</span>
              {seg.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
