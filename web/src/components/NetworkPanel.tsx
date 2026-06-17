import type { Report } from '../types';

interface Props {
  errors: Report['networkErrors'];
}

export default function NetworkPanel({ errors }: Props) {
  return (
    <div className="panel">
      <h2>Network 錯誤（{errors.length}）</h2>
      {errors.length === 0 ? (
        <div className="empty">無 Network 錯誤</div>
      ) : (
        <ul>
          {errors.map((err, i) => (
            <li key={i} className="mono">
              <span className={err.status >= 500 ? 'tag tag-5xx' : 'tag tag-4xx'}>
                {err.status}
              </span>
              {err.method} {err.url}
              {typeof err.duration === 'number' && <span className="ts"> （{err.duration}ms）</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
