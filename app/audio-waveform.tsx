'use client';

import type { AudioAnalysis } from '@/lib/audio-analysis';

type SegmentRange = { id: number; start: number; end: number; keep: boolean };

type Props = {
  analysis: AudioAnalysis;
  duration: number;
  currentTime: number;
  segments: SegmentRange[];
  segmentation: { mode: 'audio' | 'motion'; reason: string; averageInterval: number; averageThreshold: number };
  onSeek: (time: number) => void;
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

export function AudioWaveform({ analysis, duration, currentTime, segments, segmentation, onSeek }: Props) {
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

  const handleSeek = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    onSeek(ratio * duration);
  };

  return (
    <section className="xl:col-span-2 overflow-hidden rounded-[24px] border border-black/[0.07] bg-white shadow-[0_16px_50px_rgba(20,35,25,0.055)]">
      <div className="flex flex-col justify-between gap-3 border-b border-black/[0.06] p-5 sm:flex-row sm:items-center sm:p-6">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[#eaff9b] px-2.5 py-1 text-[10px] font-semibold text-[#526d00]"><span className="h-1.5 w-1.5 rounded-full bg-[#789800]" />完整音轨</div>
          <h2 className="text-lg font-semibold tracking-tight">音频曲线分析</h2>
          <p className="mt-1 text-xs text-black/40">击球峰值开启并维持回合，持续无峰值超过动态阈值时结束；点击曲线可定位视频。</p>
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
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-9">
          {metric('平均响度', `${analysis.averageDb.toFixed(1)} dB`, '全片 RMS 平均值')}
          {metric('峰值电平', `${analysis.peakDb.toFixed(1)} dB`, '99% 峰值')}
          {metric('噪声底', `${analysis.noiseFloorDb.toFixed(1)} dB`, '环境底噪估计')}
          {metric('动态范围', `${analysis.dynamicRangeDb.toFixed(1)} dB`, '峰值与底噪差')}
          {metric('瞬态峰值', String(analysis.hitCount), '击球声候选', true)}
          {metric('平均间隔', averageInterval ? `${averageInterval.toFixed(2)} s` : '—', '近期有效击球节奏')}
          {metric('结束阈值', `${dynamicThreshold.toFixed(2)} s`, '持续无峰值等待')}
          {metric('音频可信度', `${Math.round(analysis.confidence * 100)}%`, segmentation.mode === 'audio' ? '已用于回合切分' : '未达到使用门槛')}
          {metric('静音占比', `${Math.round(analysis.silenceRatio * 100)}%`, analysis.clippingEvents ? `${analysis.clippingEvents} 处疑似削波` : '未发现明显削波')}
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-black/[0.06] bg-[#111713] p-3 sm:p-4">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onClick={handleSeek} className="h-40 w-full cursor-crosshair touch-manipulation" role="img" aria-label="音频波形，点击可定位视频">
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
