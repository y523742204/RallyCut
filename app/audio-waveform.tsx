'use client';

import { useRef, useState } from 'react';
import type { AudioAnalysis } from '@/lib/audio-analysis';
import type { SegmentationMode } from '@/lib/rally-segmentation';

type SegmentRange = { id: number; start: number; end: number; keep: boolean };

type Props = {
  analysis: AudioAnalysis;
  duration: number;
  currentTime: number;
  segments: SegmentRange[];
  segmentation: { mode: SegmentationMode; reason: string; averageInterval: number; averageThreshold: number };
  onSeek: (time: number) => void;
  onAddSegment: (start: number, end: number) => boolean;
  onUpdateSegment: (id: number, patch: { start?: number; end?: number }) => void;
};

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const metric = (label: string, value: string, detail: string, accent = false) => (
  <div className={`rounded-2xl p-3.5 ${accent ? 'bg-[#eaff9b]' : 'bg-[#f4f6f4]'}`}>
    <div className={`text-lg font-semibold tracking-tight ${accent ? 'text-[#4d6500]' : 'text-[#17211b]'}`}>{value}</div>
    <div className="mt-1 text-[11px] font-medium text-black/55">{label}</div>
    <div className="mt-0.5 text-[9px] text-black/30">{detail}</div>
  </div>
);

export function AudioWaveform({ analysis, duration, currentTime, segments, segmentation, onSeek, onAddSegment, onUpdateSegment }: Props) {
  // 手动框选的草稿范围(尚未创建为回合)与当前拖拽状态
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const drag = useRef<{ mode: 'create' | 'start' | 'end' | 'seg-start' | 'seg-end'; anchor: number; moved: boolean; segId: number | null } | null>(null);

  if (!analysis.available || !analysis.waveform.length) {
    return (
      <section className="xl:col-span-2 rounded-[24px] border border-black/[0.07] bg-white p-5 shadow-[0_16px_50px_rgba(20,35,25,0.055)] sm:p-6">
        <h2 className="text-lg font-semibold tracking-tight">音频曲线分析</h2>
        <div className="mt-4 rounded-2xl bg-[#f6f8f7] p-5 text-sm text-black/45">音频可信度不足，已使用画面运动切分{segmentation.reason ? `：${segmentation.reason}` : '。'}</div>
      </section>
    );
  }

  const width = 1000;
  const height = 132;
  const middle = height / 2;
  const amplitude = 53;
  const points = analysis.waveform.map((value, index) => ({
    x: analysis.waveform.length === 1 ? 0 : index / (analysis.waveform.length - 1) * width,
    y: Math.max(1.5, value * amplitude),
  }));
  const upper = points.map(point => `${point.x.toFixed(2)},${(middle - point.y).toFixed(2)}`).join(' L ');
  const lower = [...points].reverse().map(point => `${point.x.toFixed(2)},${(middle + point.y).toFixed(2)}`).join(' L ');
  const areaPath = `M ${upper} L ${lower} Z`;
  const playheadX = Math.max(0, Math.min(width, currentTime / Math.max(0.001, duration) * width));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const latestRhythm = analysis.rhythmPoints[analysis.rhythmPoints.length - 1];
  const averageInterval = segmentation.averageInterval || latestRhythm?.averageInterval || 0;
  const dynamicThreshold = segmentation.averageThreshold || latestRhythm?.waitThreshold || 2.5;

  const timeAt = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return ratio * duration;
  };

  // 按下: 草稿手柄 > 已有回合边缘手柄 > 框选新范围
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const t = timeAt(event.clientX, event.currentTarget);
    const scale = Math.max(0.001, duration) / width;
    let mode: 'create' | 'start' | 'end' | 'seg-start' | 'seg-end' = 'create';
    let segId: number | null = null;
    if (draft) {
      if (Math.abs(t - draft.start) <= 12 * scale) mode = 'start';
      else if (Math.abs(t - draft.end) <= 12 * scale) mode = 'end';
    }
    if (mode === 'create') {
      // 已有回合边缘: 取距离最近且在判定阈值内的那条边
      let best: { id: number; edge: 'start' | 'end'; dist: number } | null = null;
      for (const s of segments) {
        if (!s.keep) continue;
        const ds = Math.abs(t - s.start);
        const de = Math.abs(t - s.end);
        if (ds <= 10 * scale && (!best || ds < best.dist)) best = { id: s.id, edge: 'start', dist: ds };
        if (de <= 10 * scale && (!best || de < best.dist)) best = { id: s.id, edge: 'end', dist: de };
      }
      if (best) { mode = best.edge === 'start' ? 'seg-start' : 'seg-end'; segId = best.id; }
    }
    drag.current = { mode, anchor: t, moved: mode !== 'create', segId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(event.clientX, event.currentTarget);
    if (d.mode === 'seg-start' || d.mode === 'seg-end') {
      // 拖动已有回合边缘: 实时更新边界
      const seg = segments.find(s => s.id === d.segId);
      if (seg) {
        onUpdateSegment(seg.id, d.mode === 'seg-start'
          ? { start: Math.max(0, Math.min(t, seg.end - 0.5)) }
          : { end: Math.min(duration, Math.max(t, seg.start + 0.5)) });
      }
    } else if (d.mode === 'create') {
      if (!d.moved && Math.abs(t - d.anchor) < 0.25) return; // 位移太小视为单击
      d.moved = true;
      setDraft({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
    } else {
      setDraft(prev => prev
        ? (d.mode === 'start'
          ? { ...prev, start: Math.min(t, prev.end - 0.5) }
          : { ...prev, end: Math.max(t, prev.start + 0.5) })
        : prev);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.mode === 'create' && !d.moved) onSeek(timeAt(event.clientX, event.currentTarget)); // 单击 = 跳转播放
  };

  return (
    <section className="xl:col-span-2 overflow-hidden rounded-[24px] border border-black/[0.07] bg-white shadow-[0_16px_50px_rgba(20,35,25,0.055)]">
      <div className="flex flex-col justify-between gap-3 border-b border-black/[0.06] p-5 sm:flex-row sm:items-center sm:p-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[#eaff9b] px-2.5 py-1 text-[10px] font-semibold text-[#526d00]"><span className="h-1.5 w-1.5 rounded-full bg-[#789800]" />完整音轨</div>
          <h2 className="text-lg font-semibold tracking-tight">音频曲线分析</h2>
          <p className="mt-1 text-xs text-black/40">击球峰值开启并维持回合，持续无峰值超过动态阈值时结束；点击曲线定位视频，拖动框选可创建新回合，拖动回合两端的绿色手柄可微调边界。</p>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px]"><span className="rounded-full bg-black/[0.05] px-2.5 py-1 text-black/50">平均击球间隔 {averageInterval ? `${averageInterval.toFixed(2)}s` : '—'}</span><span className="rounded-full bg-black/[0.05] px-2.5 py-1 text-black/50">动态结束阈值 {dynamicThreshold.toFixed(2)}s</span></div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-black/45">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#a8d328]" />音量包络</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-[#ff7043]" />击球候选峰值</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#d8ff45]/60" />保留回合</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#ffc857]/60" />静音等待区</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-[#ff496c]" />回合结束点</span>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        {segmentation.mode === 'motion' && <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">音频可信度不足，已使用画面运动切分{segmentation.reason ? `：${segmentation.reason}` : '。'}</div>}
        {segmentation.mode === 'combined' && <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">音频未达单独使用门槛{segmentation.reason ? `（${segmentation.reason}）` : ''}，已结合击球峰值与画面运动共同切分</div>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-9">
          {metric('平均响度', `${analysis.averageDb.toFixed(1)} dB`, '全片 RMS 平均值')}
          {metric('峰值电平', `${analysis.peakDb.toFixed(1)} dB`, '99% 峰值')}
          {metric('噪声底', `${analysis.noiseFloorDb.toFixed(1)} dB`, '环境底噪估计')}
          {metric('动态范围', `${analysis.dynamicRangeDb.toFixed(1)} dB`, '峰值与底噪差')}
          {metric('瞬态峰值', String(analysis.hitCount), '击球声候选', true)}
          {metric('平均间隔', averageInterval ? `${averageInterval.toFixed(2)} s` : '—', '近期有效击球节奏')}
          {metric('结束阈值', `${dynamicThreshold.toFixed(2)} s`, '持续无峰值等待')}
          {metric('音频可信度', `${Math.round(analysis.confidence * 100)}%`, segmentation.mode === 'audio' ? '已用于回合切分' : (segmentation.mode === 'combined' ? '已结合画面共同切分' : '未达到使用门槛'))}
          {metric('静音占比', `${Math.round(analysis.silenceRatio * 100)}%`, analysis.clippingEvents ? `${analysis.clippingEvents} 处疑似削波` : '未发现明显削波')}
        </div>

        {draft && (() => {
          const draftTooShort = draft.end - draft.start < 1;
          const draftOverlap = segments.some(s => draft.start < s.end - 0.1 && draft.end > s.start + 0.1);
          return (
            <div className={`mt-4 flex flex-wrap items-center gap-2 rounded-2xl border px-3 py-2 text-xs ${draftOverlap ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>
              <span className="font-medium">已选 {formatTime(draft.start)} - {formatTime(draft.end)}（{(draft.end - draft.start).toFixed(1)}s），可拖动两端手柄微调</span>
              {draftOverlap && <span className="font-semibold">与现有回合重叠，请调整范围</span>}
              {!draftOverlap && draftTooShort && <span className="font-semibold">回合至少 1 秒</span>}
              <span className="flex-1" />
              <button
                onClick={() => { if (onAddSegment(draft.start, draft.end)) setDraft(null); }}
                disabled={draftTooShort || draftOverlap}
                className="rounded-lg bg-[#17211b] px-3 py-1.5 font-semibold text-white transition hover:bg-black disabled:opacity-40"
              >创建新回合</button>
              <button onClick={() => setDraft(null)} className="rounded-lg px-2.5 py-1.5 font-medium text-sky-700 transition hover:bg-sky-100">取消</button>
            </div>
          );
        })()}

        <div className="mt-5 overflow-hidden rounded-2xl border border-black/[0.06] bg-[#111713] p-3 sm:p-4">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} style={{ touchAction: 'pan-y' }} className="h-40 w-full cursor-crosshair" role="img" aria-label="音频波形，点击定位视频，拖动框选创建回合">
            <defs>
              <linearGradient id="audio-wave-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#d8ff45" stopOpacity="0.95" />
                <stop offset="50%" stopColor="#8fbd15" stopOpacity="0.62" />
                <stop offset="100%" stopColor="#d8ff45" stopOpacity="0.95" />
              </linearGradient>
            </defs>
            {ticks.map(tick => <line key={tick} x1={tick * width} x2={tick * width} y1="0" y2={height} stroke="white" strokeOpacity="0.08" strokeWidth="1" />)}
            <line x1="0" x2={width} y1={middle} y2={middle} stroke="white" strokeOpacity="0.13" strokeWidth="1" />
            {analysis.silenceRegions.map((region, index) => {
              const waitX = Math.max(0, region.waitStart / Math.max(0.001, duration) * width);
              const decisionX = Math.min(width, region.decisionTime / Math.max(0.001, duration) * width);
              const endX = Math.min(width, region.end / Math.max(0.001, duration) * width);
              return <g key={`wait-${index}`}>
                <rect x={waitX} y="0" width={Math.max(0, decisionX - waitX)} height={height} fill="#ffc857" opacity="0.14" />
                <rect x={decisionX} y="0" width={Math.max(0, endX - decisionX)} height={height} fill="#ff496c" opacity="0.07" />
              </g>;
            })}
            {segments.filter(segment => segment.keep).map(segment => <rect key={segment.id} x={segment.start / Math.max(0.001, duration) * width} y="0" width={Math.max(1, (segment.end - segment.start) / Math.max(0.001, duration) * width)} height={height} fill="#d8ff45" opacity="0.07" />)}
            <path d={areaPath} fill="url(#audio-wave-fill)" />
            {analysis.hitTimes.map((time, index) => <line key={`hit-${index}`} x1={time / Math.max(0.001, duration) * width} x2={time / Math.max(0.001, duration) * width} y1="5" y2={height - 5} stroke="#ff7043" strokeWidth="2" opacity="0.9" />)}
            {analysis.silenceRegions.map((region, index) => { const x = Math.min(width, region.decisionTime / Math.max(0.001, duration) * width); return <g key={`decision-${index}`}><line x1={x} x2={x} y1="0" y2={height} stroke="#ff496c" strokeWidth="2" strokeDasharray="5 4" /><path d={`M ${x - 5} 2 L ${x + 5} 2 L ${x} 10 Z`} fill="#ff496c" /></g>; })}
            {segments.filter(s => s.keep).map(segment => (
              <g key={`handle-${segment.id}`}>
                {([segment.start, segment.end] as const).map((time, i) => {
                  const x = time / Math.max(0.001, duration) * width;
                  return (
                    <g key={i} style={{ cursor: 'ew-resize' }}>
                      <rect x={x - 7} y="0" width="14" height={height} fill="transparent" />
                      <rect x={x - 1.25} y="0" width="2.5" height={height} fill="#a8d328" opacity="0.9" />
                      <rect x={x - 3.5} y={middle - 12} width="7" height="24" rx="3" fill="#a8d328" />
                    </g>
                  );
                })}
              </g>
            ))}
            {draft && (() => {
              const x1 = draft.start / Math.max(0.001, duration) * width;
              const x2 = draft.end / Math.max(0.001, duration) * width;
              return (
                <g>
                  <rect x={x1} y="0" width={Math.max(1, x2 - x1)} height={height} fill="#38bdf8" opacity="0.22" />
                  {([['start', x1], ['end', x2]] as const).map(([edge, x]) => (
                    <g key={edge} style={{ cursor: 'ew-resize' }}>
                      <rect x={x - 8} y="0" width="16" height={height} fill="transparent" />
                      <rect x={x - 1.5} y="0" width="3" height={height} fill="#0284c7" />
                      <rect x={x - 4} y={middle - 14} width="8" height="28" rx="3" fill="#0284c7" />
                    </g>
                  ))}
                </g>
              );
            })()}
            <line x1={playheadX} x2={playheadX} y1="0" y2={height} stroke="white" strokeWidth="2" />
            <circle cx={playheadX} cy="8" r="5" fill="white" />
          </svg>
          <div className="mt-2 flex justify-between text-[9px] font-medium text-white/35">
            {ticks.map(tick => <span key={tick}>{formatTime(duration * tick)}</span>)}
          </div>
        </div>

        <div className="mt-4 flex flex-col justify-between gap-2 text-[10px] text-black/35 sm:flex-row sm:items-center">
          <span>采样率 {(analysis.sampleRate / 1000).toFixed(1)} kHz · {analysis.channels === 1 ? '单声道' : `${analysis.channels} 声道`} · {analysis.waveform.length} 个分析窗口</span>
          <span>当前播放位置 {formatTime(currentTime)} / {formatTime(duration)}</span>
        </div>
      </div>
    </section>
  );
}
