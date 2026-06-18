import { useRef, useEffect, useState, type ChangeEvent } from 'react';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import type { TimeMarker } from '../types';

interface Props {
  events: unknown[];
  markers?: TimeMarker[];
}

// 用底層 Replayer class（非 Svelte 的 rrweb-player）+ 自製控制列，100% 可控
export default function RrwebReplay({ events, markers }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const target = containerRef.current;
    if (!target || events.length < 2) return;

    // 清空舊的
    target.innerHTML = '';

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replayer = new Replayer(events as any, {
        root: target,
        skipInactive: true,
        showWarning: false,
        liveMode: false,
      });

      replayerRef.current = replayer;

      // 取得總時長
      const meta = replayer.getMetaData();
      setDuration(meta.totalTime || 0);

      // Replayer 內部 iframe 設定固定尺寸
      const iframe = target.querySelector('iframe');
      if (iframe) {
        iframe.style.width = '800px';
        iframe.style.height = '450px';
        iframe.style.border = '1px solid #333';
        iframe.style.borderRadius = '4px';
        iframe.style.transform = 'scale(1)';
        iframe.style.transformOrigin = 'top left';
      }

      return () => {
        cancelAnimationFrame(rafRef.current);
        replayer.pause();
        replayerRef.current = null;
        target.innerHTML = '';
      };
    } catch (err) {
      console.error('[BugEzy] Replayer 建立失敗:', err);
      target.innerHTML = '<div class="empty">DOM 回放載入失敗</div>';
      return;
    }
  }, [events]);

  if (events.length < 2) {
    return <div className="empty">DOM 軌跡不足，無法回放（{events.length} 筆）</div>;
  }

  const handlePlay = () => {
    const r = replayerRef.current;
    if (!r) return;
    if (playing) {
      r.pause();
      cancelAnimationFrame(rafRef.current);
      setPlaying(false);
    } else {
      // 如果已播完，從頭開始
      if (progress >= duration - 100) {
        r.play(0);
      } else {
        r.resume(progress);
      }
      setPlaying(true);
      // 開始追蹤進度
      const update = () => {
        if (replayerRef.current) {
          const current = replayerRef.current.getCurrentTime();
          setProgress(current);
          if (current < duration) {
            rafRef.current = requestAnimationFrame(update);
          } else {
            setPlaying(false);
          }
        }
      };
      rafRef.current = requestAnimationFrame(update);
    }
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    const r = replayerRef.current;
    if (!r) return;
    r.play(time);
    if (!playing) {
      // 跳到位置後暫停
      setTimeout(() => r.pause(time), 50);
    }
    setProgress(time);
  };

  const fmtTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  // 點擊標記時間戳 → 跳到對應播放位置（PM-28）
  const seekTo = (ms: number) => {
    const r = replayerRef.current;
    if (!r) return;
    r.play(ms);
    setTimeout(() => r.pause(ms), 50);
    setProgress(ms);
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  };

  const validMarkers = (markers ?? []).filter((m) => m.note.trim());

  return (
    <div>
      <div ref={containerRef} style={{ overflow: 'hidden', maxWidth: '800px' }} />
      <div className="player-controls">
        <button onClick={handlePlay} className="play-btn">
          {playing ? '⏸ 暫停' : '▶ 播放'}
        </button>
        <input
          type="range"
          min={0}
          max={duration}
          value={progress}
          onChange={handleSeek}
          style={{ flex: 1, margin: '0 12px' }}
        />
        <span className="time-display">
          {fmtTime(progress)} / {fmtTime(duration)}
        </span>
      </div>

      {validMarkers.length > 0 && (
        <div className="marker-list">
          <h3 className="marker-list-title">📌 時間軸標記</h3>
          {validMarkers
            .slice()
            .sort((a, b) => a.time_sec - b.time_sec)
            .map((m, i) => (
              <div className="marker-row" key={i}>
                <button className="marker-time-btn" onClick={() => seekTo(m.time_sec * 1000)}>
                  {fmtTime(m.time_sec * 1000)}
                </button>
                <span className="marker-note-text">{m.note}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
