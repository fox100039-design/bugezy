import type { Report } from '../types';

interface Props {
  screenshots: Report['screenshots'];
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 截圖縮圖列；點縮圖開新分頁看大圖
export default function ScreenshotPanel({ screenshots }: Props) {
  if (screenshots.length === 0) {
    return (
      <div className="panel">
        <h2>截圖（0）</h2>
        <div className="empty">無截圖</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>截圖（{screenshots.length}）</h2>
      <div className="shots">
        {screenshots.map((s, i) => (
          <figure className="shot" key={i}>
            <a href={s.dataUrl} target="_blank" rel="noreferrer" title="點擊看大圖">
              <img src={s.dataUrl} alt={`screenshot ${i + 1}`} />
            </a>
            <figcaption className="ts">{fmtTime(s.timestamp)}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
