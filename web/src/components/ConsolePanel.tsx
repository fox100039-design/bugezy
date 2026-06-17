import type { Report } from '../types';

interface Props {
  logs: Report['consoleLogs'];
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function ConsolePanel({ logs }: Props) {
  return (
    <div className="panel">
      <h2>Console（{logs.length}）</h2>
      {logs.length === 0 ? (
        <div className="empty">無 Console 記錄</div>
      ) : (
        <ul>
          {logs.map((log, i) => (
            <li key={i} className="mono">
              <span className={log.level === 'error' ? 'tag tag-error' : 'tag tag-warn'}>
                {log.level}
              </span>
              {log.message}
              <div className="ts">{fmtTime(log.timestamp)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
