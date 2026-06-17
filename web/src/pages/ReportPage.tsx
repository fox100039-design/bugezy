import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Report } from '../types';
import RrwebReplay from '../components/RrwebPlayer';
import ConsolePanel from '../components/ConsolePanel';
import NetworkPanel from '../components/NetworkPanel';
import VoicePanel from '../components/VoicePanel';

type Status = 'loading' | 'error' | 'loaded';

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    fetch(`/api/reports/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error('not ok');
        return r.json();
      })
      .then((data: Report) => {
        setReport(data);
        setStatus('loaded');
      })
      .catch(() => setStatus('error'));
  }, [id]);

  if (status === 'loading') return <div className="state">載入中…</div>;
  if (status === 'error' || !report) return <div className="state">找不到報告</div>;

  return (
    <div className="report">
      <header className="report-header">
        <h1>🐛 {report.title || '（無標題）'}</h1>
        <div className="meta">
          <div>
            URL：<a href={report.url} target="_blank" rel="noreferrer">{report.url}</a>
          </div>
          <div>
            Browser：{report.browser}
            {report.screen_size ? ` ｜ ${report.screen_size}` : ''}
          </div>
          <div>時間：{fmtDate(report.created_at)}</div>
        </div>
      </header>

      <div className="player-wrap">
        <RrwebReplay events={report.rrwebEvents} />
      </div>

      <div className="panels">
        <ConsolePanel logs={report.consoleLogs} />
        <NetworkPanel errors={report.networkErrors} />
        <VoicePanel transcript={report.voiceTranscript} />
      </div>
    </div>
  );
}
