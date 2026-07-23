type ClipRange = { start: number; end: number };

type ExportStage = 'recording' | 'loading' | 'converting' | 'preparing';

type ExportOptions = {
  video: HTMLVideoElement;
  sourceFile: File;
  segments: ClipRange[];
  totalDuration: number;
  onStage: (stage: ExportStage, message: string) => void;
  onProgress: (progress: number) => void;
};

type CaptureVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

type FFmpegClient = {
  on: (event: 'progress', callback: (event: { progress: number }) => void) => void;
  load: (config: { coreURL: string; wasmURL: string }) => Promise<boolean>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<void>;
  terminate?: () => void;
};

type FFmpegHostWindow = Window & { FFmpegWASM?: { FFmpeg: new () => FFmpegClient } };

// 部署在子路径 (如 GitHub Pages 的 /RallyCut/) 时, public/ 下的静态资源 URL 不会被
// Next.js 自动加 basePath, 需要在代码里手动拼. 本地开发时该变量为空字符串.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const isIOSSafariBrowser = () => {
  const navigatorWithTouch = navigator as Navigator & { maxTouchPoints?: number };
  const isiOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigatorWithTouch.maxTouchPoints ?? 0) > 1);
  return isiOSDevice && /WebKit/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
};

let ffmpegInstance: FFmpegClient | null = null;
let ffmpegLoading: Promise<FFmpegClient> | null = null;
let conversionProgress: ((value: number) => void) | null = null;

const releaseFFmpeg = (ffmpeg: FFmpegClient) => {
  try { ffmpeg.terminate?.(); } catch {}
  if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
  ffmpegLoading = null;
  conversionProgress = null;
};

const execWithTimeout = async (ffmpeg: FFmpegClient, args: string[], timeoutMs: number) => {
  let timer = 0;
  try {
    return await Promise.race([
      ffmpeg.exec(args),
      new Promise<number>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('本地视频转换长时间无响应')), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('长时间无响应')) releaseFFmpeg(ffmpeg);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

const seekTo = (video: HTMLVideoElement, time: number) => new Promise<void>((resolve, reject) => {
  if (Math.abs(video.currentTime - time) < 0.03) {
    resolve();
    return;
  }
  const timer = window.setTimeout(() => { cleanup(); reject(new Error('视频定位超时')); }, 8000);
  const done = () => { cleanup(); resolve(); };
  const fail = () => { cleanup(); reject(new Error('视频定位失败')); };
  const cleanup = () => {
    window.clearTimeout(timer);
    video.removeEventListener('seeked', done);
    video.removeEventListener('error', fail);
  };
  video.addEventListener('seeked', done, { once: true });
  video.addEventListener('error', fail, { once: true });
  video.currentTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
});

const getFFmpeg = async () => {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    const host = window as FFmpegHostWindow;
    if (!host.FFmpegWASM) {
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-ffmpeg-loader]');
        if (existing?.dataset.loaded === 'true') { resolve(); return; }
        const script = existing ?? document.createElement('script');
        script.src = `${BASE_PATH}/ffmpeg/ffmpeg.js`;
        script.async = true;
        script.dataset.ffmpegLoader = 'true';
        script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
        script.onerror = () => reject(new Error('转换器脚本加载失败'));
        if (!existing) document.head.appendChild(script);
      });
    }
    const FFmpeg = host.FFmpegWASM?.FFmpeg;
    if (!FFmpeg) throw new Error('转换器没有正确初始化');
    const ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => conversionProgress?.(Math.max(0, Math.min(1, progress))));
    let loadTimer = 0;
    try {
      await Promise.race([
        ffmpeg.load({ coreURL: `${BASE_PATH}/ffmpeg/ffmpeg-core.js`, wasmURL: `${BASE_PATH}/ffmpeg/ffmpeg-core.wasm` }),
        new Promise<boolean>((_, reject) => {
          loadTimer = window.setTimeout(() => reject(new Error('MP4 转换器加载超时')), 90_000);
        }),
      ]);
    } catch (error) {
      releaseFFmpeg(ffmpeg);
      throw error;
    } finally {
      window.clearTimeout(loadTimer);
    }
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();
  try {
    return await ffmpegLoading;
  } finally {
    ffmpegLoading = null;
  }
};

const loadConverter = async (onStage: ExportOptions['onStage'], onProgress: ExportOptions['onProgress']) => {
  onStage('loading', '正在加载本地 MP4 转换器，首次使用需要稍等…');
  onProgress(5);
  try {
    return await getFFmpeg();
  } catch {
    throw new Error('MP4 转换器加载失败，请检查网络后重试；成功加载过的设备可继续复用');
  }
};

const chooseMime = (candidates: string[]) => candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';

const recordRanges = async (
  video: HTMLVideoElement,
  stream: MediaStream,
  segments: ClipRange[],
  totalDuration: number,
  mime: string,
  progressCeiling: number,
  onProgress: (progress: number) => void,
) => {
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('浏览器录制视频失败'));
  });
  recorder.start(750);

  try {
    let completed = 0;
    for (const segment of segments) {
      await seekTo(video, segment.start);
      await video.play();
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          const within = Math.max(0, Math.min(segment.end - segment.start, video.currentTime - segment.start));
          onProgress(Math.round(((completed + within) / Math.max(0.1, totalDuration)) * progressCeiling));
          if (video.currentTime >= segment.end - 0.06 || video.ended) {
            cleanup();
            video.pause();
            resolve();
          }
        };
        const fail = () => { cleanup(); reject(new Error('视频播放中断')); };
        const cleanup = () => {
          video.removeEventListener('timeupdate', tick);
          video.removeEventListener('error', fail);
        };
        video.addEventListener('timeupdate', tick);
        video.addEventListener('error', fail, { once: true });
      });
      completed += segment.end - segment.start;
    }
    recorder.stop();
    await stopped;
  } catch (error) {
    video.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    throw error;
  }

  const blob = new Blob(chunks, { type: mime || 'video/webm' });
  if (!blob.size) throw new Error('没有生成有效的视频数据');
  return blob;
};

const readMp4Blob = async (ffmpeg: FFmpegClient, outputName: string) => {
  const data = await ffmpeg.readFile(outputName);
  if (typeof data === 'string' || !data.byteLength) throw new Error('MP4 输出为空');
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return new Blob([bytes.buffer], { type: 'video/mp4' });
};

const transcodeRecordedBlob = async (source: Blob, onStage: ExportOptions['onStage'], onProgress: ExportOptions['onProgress']) => {
  const ffmpeg = await loadConverter(onStage, onProgress);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputName = `input-${token}.webm`;
  const outputName = `output-${token}.mp4`;
  conversionProgress = value => onProgress(10 + Math.round(value * 87));
  onStage('converting', '正在本机转换为 MP4，长视频可能需要几分钟…');

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await source.arrayBuffer()));
    const result = await execWithTimeout(ffmpeg, [
      '-i', inputName,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputName,
    ], 10 * 60 * 1000);
    if (result !== 0) throw new Error('MP4 转换失败');
    return await readMp4Blob(ffmpeg, outputName);
  } catch (error) {
    if (error instanceof RangeError) throw new Error('设备内存不足，建议减少保留回合或使用性能更好的设备');
    throw error instanceof Error ? error : new Error('MP4 转换失败，请重试');
  } finally {
    conversionProgress = null;
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
    if (isIOSSafariBrowser()) releaseFFmpeg(ffmpeg);
  }
};

const transcodeSourceRanges = async (
  sourceFile: File,
  segments: ClipRange[],
  onStage: ExportOptions['onStage'],
  onProgress: ExportOptions['onProgress'],
) => {
  const ffmpeg = await loadConverter(onStage, onProgress);
  onStage('converting', '当前浏览器将直接从原视频生成 MP4，请保持页面打开…');
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const extension = sourceFile.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'mp4';
  const inputName = `source-${token}.${extension}`;
  const listName = `concat-${token}.txt`;
  const outputName = `output-${token}.mp4`;
  const partNames = segments.map((_, index) => `part-${token}-${index}.mp4`);

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await sourceFile.arrayBuffer()));
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      conversionProgress = value => onProgress(8 + Math.round(((index + value) / (segments.length + 1)) * 87));
      const result = await execWithTimeout(ffmpeg, [
        '-ss', segment.start.toFixed(3), '-t', (segment.end - segment.start).toFixed(3), '-i', inputName,
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', partNames[index],
      ], Math.min(12 * 60 * 1000, Math.max(3 * 60 * 1000, (segment.end - segment.start) * 20_000)));
      if (result !== 0) throw new Error(`第 ${index + 1} 个回合转换失败`);
    }
    const concatList = partNames.map(name => `file '${name}'`).join('\n');
    await ffmpeg.writeFile(listName, new TextEncoder().encode(concatList));
    conversionProgress = value => onProgress(92 + Math.round(value * 5));
    const concatResult = await execWithTimeout(ffmpeg, [
      '-f', 'concat', '-safe', '0', '-i', listName,
      '-c', 'copy', '-movflags', '+faststart', outputName,
    ], 3 * 60 * 1000);
    if (concatResult !== 0) throw new Error('精彩回合合并失败');
    return await readMp4Blob(ffmpeg, outputName);
  } catch (error) {
    if (error instanceof RangeError) throw new Error('设备内存不足，建议减少保留回合或换用性能更好的设备');
    throw error instanceof Error ? error : new Error('本地 MP4 转换失败，请重试');
  } finally {
    conversionProgress = null;
    for (const name of [inputName, listName, outputName, ...partNames]) {
      try { await ffmpeg.deleteFile(name); } catch {}
    }
    if (isIOSSafariBrowser()) releaseFFmpeg(ffmpeg);
  }
};

export async function exportHighlightsToMp4({ video, sourceFile, segments, totalDuration, onStage, onProgress }: ExportOptions) {
  const captureVideo = video as CaptureVideo;
  const capture = captureVideo.captureStream?.bind(captureVideo) ?? captureVideo.mozCaptureStream?.bind(captureVideo);

  if (!capture || typeof MediaRecorder === 'undefined') {
    return await transcodeSourceRanges(sourceFile, segments, onStage, onProgress);
  }

  const directMp4Mime = chooseMime([
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ]);
  const intermediateMime = directMp4Mime || chooseMime([
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]);
  if (!intermediateMime) return await transcodeSourceRanges(sourceFile, segments, onStage, onProgress);

  let stream: MediaStream | null = null;
  try {
    stream = capture();
    if (!stream.getVideoTracks().length) return await transcodeSourceRanges(sourceFile, segments, onStage, onProgress);
    onStage('recording', directMp4Mime ? '正在录制精彩回合并生成 MP4…' : '正在录制精彩回合，随后将转换为 MP4…');
    const recorded = await recordRanges(video, stream, segments, totalDuration, intermediateMime, directMp4Mime ? 96 : 55, onProgress);
    if (directMp4Mime) return new Blob([recorded], { type: 'video/mp4' });
    return await transcodeRecordedBlob(recorded, onStage, onProgress);
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    return await transcodeSourceRanges(sourceFile, segments, onStage, onProgress);
  } finally {
    video.pause();
    stream?.getTracks().forEach(track => track.stop());
  }
}
