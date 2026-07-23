'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { exportHighlightsToMp4 } from '@/lib/export-mp4';
import { analyzeAudioTrack, type AudioAnalysis } from '@/lib/audio-analysis';
import { AudioWaveform } from './audio-waveform';
import { buildAudioRallySegments, buildMotionRallySegments } from '@/lib/rally-segmentation';

type Segment = {
  id: number;
  start: number;
  end: number;
  score: number;
  keep: boolean;
};

const Icon = ({ name, className = 'h-5 w-5' }: { name: string; className?: string }) => {
  const paths: Record<string, React.ReactNode> = {
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></>,
    spark: <><path d="m12 3-1.2 4.1a5 5 0 0 1-3.4 3.4L3 12l4.4 1.5a5 5 0 0 1 3.3 3.4L12 21l1.3-4.1a5 5 0 0 1 3.3-3.4L21 12l-4.4-1.5a5 5 0 0 1-3.4-3.4Z"/></>,
    play: <path d="m9 7 8 5-8 5Z"/>,
    pause: <><path d="M9 7v10"/><path d="M15 7v10"/></>,
    download: <><path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M5 20h14"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    court: <><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M12 5v14M3 12h18M7 5v14M17 5v14"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>{paths[name]}</svg>;
};

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '00:00';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const isIOSSafariBrowser = () => {
  const navigatorWithTouch = navigator as Navigator & { maxTouchPoints?: number };
  const isiOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigatorWithTouch.maxTouchPoints ?? 0) > 1);
  return isiOSDevice && /WebKit/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
};

const waitUntilVisible = () => {
  if (!document.hidden) return Promise.resolve();
  return new Promise<void>(resolve => {
    const resume = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', resume);
      resolve();
    };
    document.addEventListener('visibilitychange', resume);
  });
};

const seekOnce = (video: HTMLVideoElement, target: number, timeoutMs: number) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(() => { cleanup(); reject(new Error('视频定位超时')); }, timeoutMs);
  const done = () => { cleanup(); resolve(); };
  const fail = () => { cleanup(); reject(new Error('视频定位失败')); };
  const cleanup = () => {
    window.clearTimeout(timer);
    video.removeEventListener('seeked', done);
    video.removeEventListener('error', fail);
  };
  video.addEventListener('seeked', done, { once: true });
  video.addEventListener('error', fail, { once: true });
  video.currentTime = target;
});

const seekTo = async (video: HTMLVideoElement, time: number) => {
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
  if (Math.abs(video.currentTime - target) < 0.035 && video.readyState >= 2) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await seekOnce(video, target, isIOSSafariBrowser() ? 4500 : 7000); return; }
    catch (error) { if (attempt === 1) throw error; await new Promise(resolve => window.setTimeout(resolve, 120)); }
  }
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewIndexRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [scores, setScores] = useState<number[]>([]);
  const [status, setStatus] = useState<'idle' | 'ready' | 'analyzing' | 'done' | 'exporting'>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [exportPhase, setExportPhase] = useState('');
  const [exportingSegmentId, setExportingSegmentId] = useState<number | null>(null);
  const [audioAnalysis, setAudioAnalysis] = useState<AudioAnalysis | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [segmentationInfo, setSegmentationInfo] = useState<{ mode: 'audio' | 'motion'; reason: string; averageInterval: number; averageThreshold: number }>({ mode: 'motion', reason: '', averageInterval: 0, averageThreshold: 2.5 });

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(() => {
    if (!isIOSSafariBrowser()) return;
    const handleVisibility = () => {
      if (document.hidden && status === 'exporting') setMessage('iOS 已暂停后台视频处理，请返回 Safari 并保持屏幕常亮');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [status]);

  const keptSegments = useMemo(() => segments.filter(s => s.keep), [segments]);
  const keptDuration = useMemo(() => keptSegments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0), [keptSegments]);
  const savedPercent = duration ? Math.max(0, Math.round((1 - keptDuration / duration) * 100)) : 0;

  const loadFile = (selected?: File) => {
    if (!selected) return;
    const extension = selected.name.split('.').pop()?.toLowerCase() || '';
    const isVideo = selected.type.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm'].includes(extension);
    if (!isVideo) {
      setMessage('请选择 MP4、MOV、M4V 或 WebM 视频文件');
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(selected);
    setFile(selected);
    setVideoUrl(url);
    setDuration(0);
    setSegments([]);
    setScores([]);
    setAudioAnalysis(null);
    setCurrentTime(0);
    setSegmentationInfo({ mode: 'motion', reason: '', averageInterval: 0, averageThreshold: 2.5 });
    setProgress(0);
    setMessage('');
    setStatus('ready');
    setIsPreviewing(false);
  };

  const analyze = async () => {
    const video = videoRef.current;
    if (!video || !file || !duration) return;
    setStatus('analyzing');
    setProgress(2);
    setMessage('正在提取击球声与画面运动特征…');
    setIsPreviewing(false);
    setSegments([]);
    setScores([]);
    setAudioAnalysis(null);
    setSegmentationInfo({ mode: 'motion', reason: '', averageInterval: 0, averageThreshold: 2.5 });
    video.pause();

    try {
      const isIOSSafari = isIOSSafariBrowser();
      const step = Math.max(isIOSSafari ? 1.2 : 0.8, duration / (isIOSSafari ? 120 : 240));
      const count = Math.max(1, Math.ceil(duration / step));
      const audioPromise = isIOSSafari ? null : analyzeAudioTrack(file, duration, count, step);
      const canvas = document.createElement('canvas');
      canvas.width = isIOSSafari ? 120 : 160;
      canvas.height = isIOSSafari ? 68 : 90;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('无法读取视频画面');
      let previous: Uint8ClampedArray | null = null;
      const motion: number[] = [];
      let consecutiveSeekFailures = 0;

      for (let i = 0; i < count; i++) {
        if (document.hidden) {
          setMessage('页面进入后台，已暂停分析；返回 Safari 后会自动继续');
          await waitUntilVisible();
          setMessage('正在继续分析画面运动…');
        }
        try {
          await seekTo(video, Math.min(duration - 0.05, i * step));
          consecutiveSeekFailures = 0;
        } catch {
          consecutiveSeekFailures++;
          motion.push(motion[motion.length - 1] ?? 0);
          setProgress(Math.round(8 + (i / count) * 72));
          if (consecutiveSeekFailures >= 3) throw new Error('Safari 连续读取视频帧超时，请保持页面在前台后重试');
          continue;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const current = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!previous) {
          motion.push(0);
        } else {
          let diff = 0;
          for (let p = 0; p < current.length; p += 16) {
            const now = current[p] * 0.299 + current[p + 1] * 0.587 + current[p + 2] * 0.114;
            const old = previous[p] * 0.299 + previous[p + 1] * 0.587 + previous[p + 2] * 0.114;
            diff += Math.abs(now - old);
          }
          motion.push(diff / (current.length / 16) / 255);
        }
        previous = new Uint8ClampedArray(current);
        setProgress(Math.round(8 + (i / count) * 72));
      }

      if (isIOSSafari) setMessage('画面分析完成，正在低内存模式下读取击球声…');
      await waitUntilVisible();
      const audio = audioPromise ? await audioPromise : await analyzeAudioTrack(file, duration, count, step);
      const audioEnergy = audio.energy;
      setAudioAnalysis(audio);
      const mLow = percentile(motion, 0.12);
      const mHigh = percentile(motion, 0.92);
      const motionNorm = motion.map(v => Math.max(0, Math.min(1, (v - mLow) / Math.max(0.001, mHigh - mLow))));
      const combined = motionNorm.map((v, i) => v * 0.68 + (audioEnergy[i] ?? 0.35) * 0.32);
      const displayScores = combined.map((_, i) => {
        const nearby = combined.slice(Math.max(0, i - 2), Math.min(combined.length, i + 3));
        return nearby.reduce((a, b) => a + b, 0) / nearby.length;
      });

      const audioSegmentation = buildAudioRallySegments(audio, motionNorm, step, duration);
      const finalSegments = audioSegmentation.usedAudio
        ? audioSegmentation.segments
        : buildMotionRallySegments(motionNorm, step, duration);
      setSegmentationInfo({
        mode: audioSegmentation.usedAudio ? 'audio' : 'motion',
        reason: audioSegmentation.reason,
        averageInterval: audioSegmentation.averageInterval,
        averageThreshold: audioSegmentation.averageThreshold,
      });
      setSegments(finalSegments.map((s, i) => ({ id: i + 1, ...s, keep: true })));
      setScores(displayScores);
      setProgress(100);
      setStatus('done');
      if (audioSegmentation.usedAudio) setMessage(`已按 ${audio.hitCount} 个击球峰值与持续无峰值时间识别 ${finalSegments.length} 个回合`);
      else setMessage(`已识别 ${finalSegments.length} 个回合；${audioSegmentation.reason}，已改用画面运动切分`);
      await seekTo(video, finalSegments[0].start);
    } catch (error) {
      setStatus('ready');
      setMessage(error instanceof Error ? error.message : '分析失败，请换一个视频重试');
    }
  };

  const updateSegment = (id: number, patch: Partial<Segment>) => {
    setSegments(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const jumpTo = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    setIsPreviewing(false);
    video.currentTime = time;
    video.play().catch(() => undefined);
  };

  const togglePreview = async () => {
    const video = videoRef.current;
    if (!video || !keptSegments.length) return;
    if (isPreviewing) {
      video.pause();
      setIsPreviewing(false);
      return;
    }
    previewIndexRef.current = 0;
    await seekTo(video, keptSegments[0].start);
    setIsPreviewing(true);
    await video.play();
  };

  const onTimeUpdate = async () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (!isPreviewing || !keptSegments.length) return;
    const current = keptSegments[previewIndexRef.current];
    if (video.currentTime >= current.end - 0.08) {
      const nextIndex = previewIndexRef.current + 1;
      if (nextIndex >= keptSegments.length) {
        video.pause();
        setIsPreviewing(false);
        return;
      }
      previewIndexRef.current = nextIndex;
      await seekTo(video, keptSegments[nextIndex].start);
      await video.play();
    }
  };

  const exportRanges = async (targetSegments: Segment[], suffix: string, segmentId: number | null = null) => {
    const video = videoRef.current;
    if (!video || !file || !targetSegments.length || status === 'exporting') return;
    if (isIOSSafariBrowser() && file.size > 300 * 1024 * 1024) {
      setMessage('此视频对 iOS Safari 的可用内存压力过大，建议先压缩到 300 MB 内，或在电脑浏览器中导出');
      return;
    }
    await waitUntilVisible();
    const targetDuration = targetSegments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
    setStatus('exporting');
    setExportingSegmentId(segmentId);
    setProgress(0);
    setExportPhase('recording');
    setMessage(segmentId === null ? '正在生成已选回合合并视频…' : `正在生成${suffix}视频…`);
    setIsPreviewing(false);
    try {
      const blob = await exportHighlightsToMp4({
        video,
        sourceFile: file,
        segments: targetSegments,
        totalDuration: targetDuration,
        onStage: (phase, text) => {
          setExportPhase(phase);
          setMessage(text);
        },
        onProgress: value => setProgress(value),
      });
      setExportPhase('preparing');
      setProgress(99);
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `${file.name.replace(/\.[^.]+$/, '') || 'tennis'}-${suffix}.mp4`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setProgress(100);
      setMessage(`${suffix} MP4 已生成并开始下载`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'MP4 导出失败，请重试';
      setMessage(reason);
    } finally {
      setStatus('done');
      setExportPhase('');
      setExportingSegmentId(null);
    }
  };

  const exportVideo = () => {
    void exportRanges(keptSegments, '已选精彩回合');
  };

  const exportSegment = (segment: Segment, index: number) => {
    void exportRanges([segment], `回合-${String(index + 1).padStart(2, '0')}`, segment.id);
  };

  return (
    <main className="min-h-screen bg-[#f6f8f7] text-[#17211b]">
      <header className="border-b border-black/[0.06] bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#d8ff45] text-[#15200f]"><Icon name="court" /></div>
            <div><div className="font-semibold tracking-[-0.02em]">RallyCut</div><div className="text-[10px] font-medium uppercase tracking-[0.18em] text-black/40">Tennis editor</div></div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-[#b6e51f]/50 bg-[#f5ffd5] px-3 py-1.5 text-xs font-medium text-[#536b08] sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#78a000]" />本地分析 · 视频无需上传云端</div>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-5 py-8 lg:px-8 lg:py-10">
        <section className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-[#eaff9b] px-3 py-1 text-xs font-semibold text-[#486000]"><Icon name="spark" className="h-3.5 w-3.5" />智能回合识别</div>
            <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.045em] text-[#152019] sm:text-4xl">留下每一次精彩对拉，<span className="text-[#719500]">自动跳过等待。</span></h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-black/50">结合画面运动与击球声音识别有效回合，自动去除捡球、发球准备、换边和长时间停顿。</p>
          </div>
          {file && <label className="relative shrink-0 cursor-pointer overflow-hidden rounded-xl border border-black/10 bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:border-black/20">更换视频<input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="absolute inset-0 cursor-pointer opacity-0" onChange={(e: ChangeEvent<HTMLInputElement>) => loadFile(e.currentTarget.files?.[0])} /></label>}
        </section>

        {!file ? (
          <section onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); loadFile(e.dataTransfer.files[0]); }} className={`mx-auto flex min-h-[480px] max-w-4xl flex-col items-center justify-center rounded-[28px] border-2 border-dashed bg-white p-8 text-center shadow-[0_24px_80px_rgba(24,35,28,0.06)] transition ${dragging ? 'border-[#8db800] bg-[#fbfff0]' : 'border-black/10'}`}>
            <div className="mb-6 grid h-20 w-20 place-items-center rounded-3xl bg-[#d8ff45] text-[#263300] shadow-[0_12px_30px_rgba(151,196,0,0.22)]"><Icon name="upload" className="h-9 w-9" /></div>
            <h2 className="text-2xl font-semibold tracking-tight">拖入一段网球比赛视频</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-black/45">支持 MP4、MOV、WebM，固定机位和能听清击球声的视频识别效果最佳。</p>
            <label className="relative mt-7 cursor-pointer overflow-hidden rounded-xl bg-[#17211b] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:bg-black">选择视频文件<input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="absolute inset-0 cursor-pointer opacity-0" onChange={(e: ChangeEvent<HTMLInputElement>) => loadFile(e.currentTarget.files?.[0])} /></label>
            <div className="mt-8 grid w-full max-w-lg grid-cols-3 gap-3 text-left">
              {[['01','上传整场','视频仅在浏览器处理'],['02','自动识别','检测运动与击球声'],['03','检查导出','微调后生成成片']].map(item => <div key={item[0]} className="rounded-2xl bg-[#f6f8f7] p-4"><div className="mb-3 text-xs font-semibold text-[#7a9d08]">{item[0]}</div><div className="text-sm font-semibold">{item[1]}</div><div className="mt-1 text-[11px] leading-4 text-black/40">{item[2]}</div></div>)}
            </div>
          </section>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,.75fr)]">
            <section className="overflow-hidden rounded-[24px] border border-black/[0.07] bg-[#111713] shadow-[0_22px_70px_rgba(17,29,21,0.12)]">
              <div className="relative aspect-video bg-black">
                <video ref={videoRef} src={videoUrl} controls={!isPreviewing && status !== 'exporting'} onLoadedMetadata={e => setDuration(e.currentTarget.duration)} onTimeUpdate={onTimeUpdate} className="h-full w-full object-contain" playsInline />
                {status === 'analyzing' && <div className="absolute inset-0 grid place-items-center bg-black/65 backdrop-blur-sm"><div className="w-72 text-center text-white"><div className="mx-auto mb-5 grid h-14 w-14 animate-pulse place-items-center rounded-2xl bg-[#d8ff45] text-black"><Icon name="spark" className="h-7 w-7" /></div><div className="text-lg font-semibold">正在识别有效回合</div><div className="mt-2 text-xs text-white/55">{message}</div><div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-[#d8ff45] transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-2 text-right text-xs text-[#d8ff45]">{progress}%</div></div></div>}
                {status === 'exporting' && <div className="absolute inset-x-0 bottom-0 bg-black/80 p-4 text-white backdrop-blur"><div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="min-w-0"><span className="mr-2 rounded-full bg-[#d8ff45] px-2 py-0.5 font-semibold text-black">{exportPhase === 'recording' ? '录制' : exportPhase === 'loading' ? '加载' : exportPhase === 'converting' ? '转换' : '准备'}</span>{message}</span><span className="shrink-0 text-[#d8ff45]">{progress}%</span></div><div className="h-1 overflow-hidden rounded-full bg-white/20"><div className="h-full bg-[#d8ff45] transition-all" style={{ width: `${progress}%` }} /></div></div>}
              </div>
              <div className="border-t border-white/10 bg-[#151d18] p-4 text-white">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0"><div className="truncate text-sm font-medium">{file.name}</div><div className="mt-1 text-xs text-white/40">{(file.size / 1024 / 1024).toFixed(1)} MB · {formatTime(duration)}</div></div>
                  {status === 'ready' && <button onClick={analyze} disabled={!duration} className="flex shrink-0 items-center gap-2 rounded-xl bg-[#d8ff45] px-5 py-3 text-sm font-semibold text-[#182000] transition hover:bg-[#e5ff7a] disabled:opacity-40"><Icon name="spark" className="h-4 w-4" />开始智能剪辑</button>}
                  {status === 'done' && <button onClick={togglePreview} className="flex shrink-0 items-center gap-2 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-medium transition hover:bg-white/15"><Icon name={isPreviewing ? 'pause' : 'play'} className="h-4 w-4" />{isPreviewing ? '暂停预览' : '连续预览'}</button>}
                </div>
              </div>
            </section>

            <aside className="space-y-5">
              <section className="rounded-[24px] border border-black/[0.07] bg-white p-5 shadow-[0_16px_50px_rgba(20,35,25,0.055)]">
                <div className="mb-5 flex items-center justify-between"><div><h2 className="font-semibold tracking-tight">剪辑概览</h2><p className="mt-1 text-xs text-black/40">识别完成后可逐段检查</p></div><div className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${status === 'done' ? 'bg-[#eaff9b] text-[#526d00]' : 'bg-black/5 text-black/40'}`}>{status === 'done' ? '分析完成' : status === 'analyzing' ? '识别中' : status === 'exporting' ? '生成 MP4' : '待分析'}</div></div>
                <div className="grid grid-cols-3 gap-2">
                  <Stat value={segments.length || '—'} label="有效回合" />
                  <Stat value={keptDuration ? formatTime(keptDuration) : '—'} label="成片时长" />
                  <Stat value={segments.length ? `${savedPercent}%` : '—'} label="预计精简" accent />
                </div>
                {message && <div className="mt-4 flex gap-2 rounded-xl bg-[#f6f8f7] p-3 text-xs leading-5 text-black/55"><Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-[#789800]" />{message}</div>}
              </section>

              <section className="rounded-[24px] border border-black/[0.07] bg-white p-5 shadow-[0_16px_50px_rgba(20,35,25,0.055)]">
                <h3 className="text-sm font-semibold">识别依据</h3>
                <div className="mt-4 space-y-4">
                  <Signal label="画面运动" detail={segmentationInfo.mode === 'motion' ? '当前回合切分主依据' : '辅助过滤孤立噪声'} value={status === 'done' ? (segmentationInfo.mode === 'motion' ? 92 : 78) : 0} />
                  <Signal label="击球声音" detail={segmentationInfo.mode === 'audio' ? `${audioAnalysis?.hitCount ?? 0} 个峰值 · 平均间隔 ${segmentationInfo.averageInterval.toFixed(2)}s` : (segmentationInfo.reason || '音频可信度不足')} value={status === 'done' && audioAnalysis?.available ? Math.round(audioAnalysis.confidence * 100) : 0} />
                  <Signal label="持续无峰值" detail={segmentationInfo.mode === 'audio' ? `超过 ${segmentationInfo.averageThreshold.toFixed(2)}s 后结束回合` : '由画面低运动区判断结束'} value={status === 'done' ? (segmentationInfo.mode === 'audio' ? 94 : 82) : 0} />
                </div>
              </section>

              <button onClick={exportVideo} disabled={status !== 'done' || !keptSegments.length} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#17211b] px-5 py-4 text-sm font-semibold text-white shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:bg-black disabled:cursor-not-allowed disabled:opacity-35"><Icon name="download" />下载已选回合集 <span className="font-normal text-white/45">· {keptSegments.length} 个回合</span></button>
              <p className="px-2 text-center text-[11px] leading-5 text-black/40">全程在本机处理；无法直接录制 MP4 时会自动转换，长视频需要更多时间。</p>
            </aside>

            {audioAnalysis && <AudioWaveform analysis={audioAnalysis} duration={duration} currentTime={currentTime} segments={segments} segmentation={segmentationInfo} onSeek={jumpTo} />}
            {segments.length > 0 && <section className="xl:col-span-2 rounded-[24px] border border-black/[0.07] bg-white p-5 shadow-[0_16px_50px_rgba(20,35,25,0.055)] sm:p-6">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-lg font-semibold tracking-tight">分回合选择与下载</h2><p className="mt-1 text-xs text-black/40">打开开关加入合集，或在回合卡片中单独下载 MP4</p></div><div className="flex flex-wrap items-center gap-2 text-xs"><span className="mr-1 text-black/45">已选 {keptSegments.length}/{segments.length}</span><button onClick={() => setSegments(items => items.map(item => ({ ...item, keep: true })))} disabled={status === 'exporting'} className="rounded-lg bg-[#eaff9b] px-2.5 py-1.5 font-medium text-[#526d00] disabled:opacity-40">全选</button><button onClick={() => setSegments(items => items.map(item => ({ ...item, keep: false })))} disabled={status === 'exporting'} className="rounded-lg bg-black/[0.05] px-2.5 py-1.5 font-medium text-black/50 disabled:opacity-40">清空</button></div></div>
              <div className="relative mt-6 h-16 overflow-hidden rounded-xl bg-[#f1f3f1]">
                {scores.map((score, i) => <div key={i} className="absolute bottom-0 bg-black/[0.08]" style={{ left: `${i / scores.length * 100}%`, width: `${Math.max(0.4, 100 / scores.length)}%`, height: `${15 + score * 45}%` }} />)}
                {segments.map(segment => <button key={segment.id} onClick={() => jumpTo(segment.start)} className={`absolute inset-y-0 border-x border-white/70 transition hover:brightness-95 ${segment.keep ? 'bg-[#b8e532]/75' : 'bg-black/10'}`} style={{ left: `${segment.start / duration * 100}%`, width: `${Math.max(0.6, (segment.end - segment.start) / duration * 100)}%` }} title={`回合 ${segment.id}`} />)}
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {segments.map((segment, index) => <article key={segment.id} className={`rounded-2xl border p-4 transition ${segment.keep ? 'border-[#cce66f] bg-[#fbfff1]' : 'border-black/[0.06] bg-[#f7f8f7]'}`}>
                  <div className="flex items-start justify-between gap-3"><button onClick={() => jumpTo(segment.start)} className="flex min-w-0 items-center gap-3 text-left"><div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${segment.keep ? 'bg-[#d8ff45]' : 'bg-black/5'}`}><Icon name="play" className="h-4 w-4" /></div><div><div className="text-sm font-semibold">回合 {String(index + 1).padStart(2, '0')}</div><div className="mt-0.5 text-[11px] text-black/40">置信度 {Math.round(Math.min(.97, Math.max(.61, segment.score + .28)) * 100)}%</div></div></button><button aria-label="选择或取消此回合" onClick={() => updateSegment(segment.id, { keep: !segment.keep })} disabled={status === 'exporting'} className={`relative h-6 w-11 rounded-full transition disabled:opacity-40 ${segment.keep ? 'bg-[#93bd0d]' : 'bg-black/15'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${segment.keep ? 'left-6' : 'left-1'}`} /></button></div>
                  <div className="mt-4 flex items-center gap-2"><TimeInput value={segment.start} max={segment.end - .5} onChange={value => updateSegment(segment.id, { start: value })} /><span className="text-black/25">—</span><TimeInput value={segment.end} max={duration} onChange={value => updateSegment(segment.id, { end: Math.max(segment.start + .5, value) })} /><span className="ml-auto text-[11px] font-medium text-black/40">{Math.round(segment.end - segment.start)}s</span></div>
                  <button onClick={() => exportSegment(segment, index)} disabled={status === 'exporting'} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-xs font-semibold text-[#273329] shadow-sm transition hover:border-[#a8cf27] hover:bg-[#fbfff0] disabled:cursor-wait disabled:opacity-45"><Icon name="download" className="h-4 w-4" />{exportingSegmentId === segment.id ? '正在生成本回合…' : '单独下载本回合 · MP4'}</button>
                </article>)}
              </div>
            </section>}
          </div>
        )}
      </div>
    </main>
  );
}

function Stat({ value, label, accent = false }: { value: string | number; label: string; accent?: boolean }) {
  return <div className={`rounded-2xl p-3 ${accent ? 'bg-[#eaff9b]' : 'bg-[#f5f7f5]'}`}><div className={`text-xl font-semibold tracking-tight ${accent ? 'text-[#4d6500]' : ''}`}>{value}</div><div className="mt-1 text-[10px] text-black/40">{label}</div></div>;
}

function Signal({ label, detail, value }: { label: string; detail: string; value: number }) {
  return <div><div className="mb-2 flex items-end justify-between"><div><div className="text-xs font-medium">{label}</div><div className="mt-0.5 text-[10px] text-black/35">{detail}</div></div><span className="text-[10px] font-semibold text-[#789800]">{value ? `${value}%` : '—'}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-black/[0.05]"><div className="h-full rounded-full bg-[#a8d328] transition-all duration-700" style={{ width: `${value}%` }} /></div></div>;
}

function TimeInput({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  return <label className="flex items-center gap-1 rounded-lg border border-black/[0.07] bg-white px-2 py-1.5 text-[11px] text-black/50"><Icon name="clock" className="h-3 w-3" /><input type="number" min={0} max={max} step="0.1" value={value.toFixed(1)} onChange={e => onChange(Math.max(0, Math.min(max, Number(e.target.value))))} className="w-12 bg-transparent font-medium text-black outline-none" /></label>;
}
