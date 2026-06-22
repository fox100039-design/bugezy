import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Report } from '../types';
import RrwebReplay from '../components/RrwebPlayer';
import ScreenshotPanel from '../components/ScreenshotPanel';
import ConsolePanel from '../components/ConsolePanel';
import NetworkPanel from '../components/NetworkPanel';
import VoicePanel from '../components/VoicePanel';

type Status = 'loading' | 'error' | 'loaded';
type TabKey = 'info' | 'console' | 'network' | 'voice' | 'screenshots';

function fmtSec(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

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
  const [activeTab, setActiveTab] = useState<TabKey>('info');

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

  // PM-58：載入後自動跳到有資料的 tab（console > network > info）
  useEffect(() => {
    if (!report) return;
    if (report.consoleLogs.length > 0) setActiveTab('console');
    else if (report.networkErrors.length > 0) setActiveTab('network');
    else setActiveTab('info');
  }, [report]);

  if (status === 'loading')
    return (
      <div className="state">
        <span className="loading-spinner"></span>
        <div>載入中…</div>
      </div>
    );
  if (status === 'error' || !report) return <div className="state">找不到報告</div>;

  return (
    <>
      <nav className="topbar">
        <span className="topbar-brand">🐛 BugEzy</span>
        <span className="topbar-title">Bug 報告</span>
      </nav>

      <div className="report">
        <header className="report-header">
          <h1>{report.title || '（無標題）'}</h1>
          <div className="meta">
            <div>
              URL：<a href={report.url} target="_blank" rel="noreferrer">{report.url}</a>
            </div>
            <div>
              {report.browser}
              {report.screen_size ? ` ｜ ${report.screen_size}` : ''}
            </div>
            <div>{fmtDate(report.created_at)}</div>
          </div>
        </header>

        {report.rrwebEvents.length > 0 && (
          <div className="player-wrap">
            <RrwebReplay events={report.rrwebEvents} markers={report.markers} />
          </div>
        )}

        {/* Tab Bar（Jam 風格 DevTools 分頁，PM-58） */}
        <div className="tab-bar">
          {(
            [
              { key: 'info', label: 'Info', show: true },
              { key: 'console', label: 'Console', count: report.consoleLogs.length, show: true },
              { key: 'network', label: 'Network', count: report.networkErrors.length, show: true },
              {
                key: 'voice',
                label: 'Voice',
                count: report.voiceTranscript.length,
                show: report.voiceTranscript.length > 0,
              },
              {
                key: 'screenshots',
                label: '📸',
                count: report.screenshots?.length || 0,
                show: (report.screenshots?.length || 0) > 0,
              },
            ] as { key: TabKey; label: string; count?: number; show: boolean }[]
          )
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.key}
                className={`tab-btn ${activeTab === t.key ? 'active' : ''} ${
                  t.count && t.count > 0 && t.key !== 'info' ? 'has-data' : ''
                }`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className={`tab-badge ${t.key === 'console' ? 'badge-error' : ''}`}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
        </div>

        {/* Tab Content */}
        <div className="tab-content">
          {activeTab === 'info' && (
            <div className="tab-panel">
              {report.description && (
                <div className="info-section">
                  <h3>💬 描述</h3>
                  <p>{report.description}</p>
                </div>
              )}
              {report.markers && report.markers.length > 0 && (
                <div className="info-section">
                  <h3>📌 時間軸標記</h3>
                  {report.markers.map((m, i) => (
                    <div key={i} className="marker-item">
                      <span className="marker-time">{fmtSec(m.time_sec)}</span>
                      <span>{m.note || '（無描述）'}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="info-section">
                <h3>📊 摘要</h3>
                <div className="info-grid">
                  <div>DOM 事件：{report.rrwebEvents.length}</div>
                  <div>Console：{report.consoleLogs.length}</div>
                  <div>Network：{report.networkErrors.length}</div>
                  <div>語音：{report.voiceTranscript.length} 段</div>
                  <div>截圖：{report.screenshots?.length || 0}</div>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'console' && <ConsolePanel logs={report.consoleLogs} />}
          {activeTab === 'network' && <NetworkPanel errors={report.networkErrors} />}
          {activeTab === 'voice' && <VoicePanel transcript={report.voiceTranscript} />}
          {activeTab === 'screenshots' && report.screenshots && (
            <ScreenshotPanel screenshots={report.screenshots} />
          )}
        </div>
      </div>
    </>
  );
}
