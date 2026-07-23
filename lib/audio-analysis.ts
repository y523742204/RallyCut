export type RhythmPoint = {
  time: number;
  averageInterval: number;
  waitThreshold: number;
};

export type SilenceRegion = {
  lastHitTime: number;
  waitStart: number;
  decisionTime: number;
  end: number;
  waitThreshold: number;
};

export type AudioAnalysis = {
  available: boolean;
  energy: number[];
  waveform: number[];
  transients: boolean[];
  hitTimes: number[];
  rhythmPoints: RhythmPoint[];
  silenceRegions: SilenceRegion[];
  confidence: number;
  noiseFloorDb: number;
  averageDb: number;
  peakDb: number;
  dynamicRangeDb: number;
  hitCount: number;
  sampleRate: number;
  channels: number;
  silenceRatio: number;
  clippingEvents: number;
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const median = (values: number[]) => percentile(values, 0.5);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const toDb = (value: number) => 20 * Math.log10(Math.max(0.000001, value));

const buildRhythmAnalysis = (hitTimes: number[], duration: number) => {
  const rhythmPoints: RhythmPoint[] = [];
  const acceptedIntervals: number[] = [];

  hitTimes.forEach((time, index) => {
    if (index > 0) {
      const interval = time - hitTimes[index - 1];
      if (interval >= 0.32 && interval <= 3.2) acceptedIntervals.push(interval);
    }
    const recent = acceptedIntervals.slice(-5);
    const center = recent.length ? median(recent) : 0;
    const filtered = recent.filter(value => !center || Math.abs(value - center) <= Math.max(0.45, center * 0.55));
    const averageInterval = filtered.length
      ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length
      : center;
    const waitThreshold = clamp(Math.max(2.5, (averageInterval || 1.55) * 1.48), 2.5, 4.8);
    rhythmPoints.push({ time, averageInterval, waitThreshold });
  });

  const silenceRegions: SilenceRegion[] = [];
  for (let index = 0; index < hitTimes.length; index++) {
    const lastHitTime = hitTimes[index];
    const nextHit = hitTimes[index + 1] ?? duration;
    const waitThreshold = rhythmPoints[index]?.waitThreshold ?? 2.5;
    const decisionTime = lastHitTime + waitThreshold;
    if (decisionTime <= duration && nextHit >= decisionTime) {
      silenceRegions.push({
        lastHitTime,
        waitStart: Math.min(duration, lastHitTime + 0.45),
        decisionTime,
        end: Math.max(decisionTime, nextHit),
        waitThreshold,
      });
    }
  }

  const allIntervals = hitTimes.slice(1).map((time, index) => time - hitTimes[index]);
  const validIntervals = allIntervals.filter(value => value >= 0.32 && value <= 3.2);
  const rhythmCenter = validIntervals.length ? median(validIntervals) : 0;
  const deviations = validIntervals.map(value => Math.abs(value - rhythmCenter));
  const consistency = rhythmCenter && deviations.length
    ? clamp(1 - median(deviations) / Math.max(0.2, rhythmCenter), 0, 1)
    : 0;
  const validRatio = allIntervals.length ? validIntervals.length / allIntervals.length : 0;
  const countScore = clamp((hitTimes.length - 1) / 7, 0, 1);
  const density = hitTimes.length / Math.max(1, duration);
  const noisePenalty = density > 2.8 ? clamp((density - 2.8) / 2.8, 0, 0.45) : 0;
  const confidence = clamp(countScore * 0.38 + validRatio * 0.34 + consistency * 0.28 - noisePenalty, 0, 1);

  return { rhythmPoints, silenceRegions, confidence };
};

export async function analyzeAudioTrack(source: File, duration: number, energyCount: number, energyStep: number): Promise<AudioAnalysis> {
  try {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error('当前浏览器不支持音频分析');
    const navigatorWithTouch = navigator as Navigator & { maxTouchPoints?: number };
    const lowMemoryMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && (navigatorWithTouch.maxTouchPoints ?? 0) > 1);
    if (lowMemoryMobile && source.size > 250 * 1024 * 1024) throw new Error('移动端跳过超大文件音频解码');
    const context = new AudioContextCtor();
    const decoded = await context.decodeAudioData(await source.arrayBuffer());
    const sampleRate = decoded.sampleRate;
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const waveformCount = Math.max(lowMemoryMobile ? 180 : 240, Math.min(lowMemoryMobile ? 600 : 1200, Math.ceil(duration * (lowMemoryMobile ? 2 : 4))));
    const rmsValues: number[] = [];
    const peakValues: number[] = [];

    for (let bin = 0; bin < waveformCount; bin++) {
      const start = Math.floor((bin / waveformCount) * decoded.length);
      const end = Math.max(start + 1, Math.floor(((bin + 1) / waveformCount) * decoded.length));
      const stride = Math.max(1, Math.floor((end - start) / 2200));
      let sumSquares = 0;
      let peak = 0;
      let samples = 0;
      for (let frame = start; frame < end; frame += stride) {
        let mixed = 0;
        for (const channel of channels) mixed += channel[frame] || 0;
        mixed /= Math.max(1, channels.length);
        const absolute = Math.abs(mixed);
        sumSquares += mixed * mixed;
        peak = Math.max(peak, absolute);
        samples++;
      }
      rmsValues.push(Math.sqrt(sumSquares / Math.max(1, samples)));
      peakValues.push(peak);
    }

    await context.close();
    const rmsDb = rmsValues.map(toDb);
    const peakDbValues = peakValues.map(toDb);
    const noiseFloorDb = percentile(rmsDb, 0.18);
    const peakDb = percentile(peakDbValues, 0.99);
    const averageDb = rmsDb.reduce((sum, value) => sum + value, 0) / Math.max(1, rmsDb.length);
    const dynamicRangeDb = Math.max(0, peakDb - noiseFloorDb);
    const silenceRatio = rmsDb.filter(value => value <= noiseFloorDb + 3).length / Math.max(1, rmsDb.length);
    const clippingEvents = peakValues.filter(value => value >= 0.98).length;
    const waveform = rmsDb.map((db, index) => {
      const rmsLevel = (db - noiseFloorDb) / Math.max(6, peakDb - noiseFloorDb);
      const peakLevel = (peakDbValues[index] - noiseFloorDb) / Math.max(6, peakDb - noiseFloorDb);
      return clamp(rmsLevel * 0.64 + peakLevel * 0.36, 0.015, 1);
    });

    const transientThreshold = Math.max(0.5, percentile(waveform, 0.82));
    const transients = new Array(waveform.length).fill(false);
    const minGap = Math.max(1, Math.round(waveform.length / Math.max(1, duration) * 0.28));
    let lastTransient = -minGap;
    for (let index = 2; index < waveform.length - 2; index++) {
      const localBase = (waveform[index - 2] + waveform[index - 1] + waveform[index + 1] + waveform[index + 2]) / 4;
      const prominence = waveform[index] - localBase;
      const isPeak = waveform[index] >= waveform[index - 1] && waveform[index] >= waveform[index + 1];
      const crest = peakValues[index] / Math.max(0.00001, rmsValues[index]);
      if (isPeak && waveform[index] >= transientThreshold && prominence >= 0.05 && crest >= 1.7 && index - lastTransient >= minGap) {
        transients[index] = true;
        lastTransient = index;
      }
    }

    const hitTimes = transients
      .map((active, index) => active ? (index + 0.5) / waveform.length * duration : -1)
      .filter(time => time >= 0);
    const rhythm = buildRhythmAnalysis(hitTimes, duration);
    const confidence = clamp(rhythm.confidence - Math.min(0.18, clippingEvents / Math.max(1, waveform.length) * 4), 0, 1);

    const energy = Array.from({ length: energyCount }, (_, index) => {
      const centerTime = Math.min(duration, index * energyStep + Math.min(energyStep, 0.5) / 2);
      const waveformIndex = Math.min(waveform.length - 1, Math.floor((centerTime / Math.max(0.001, duration)) * waveform.length));
      const from = Math.max(0, waveformIndex - 1);
      const to = Math.min(waveform.length, waveformIndex + 2);
      const baseEnergy = waveform.slice(from, to).reduce((sum, value) => sum + value, 0) / Math.max(1, to - from);
      const transientBoost = transients.slice(Math.max(0, from - 1), Math.min(transients.length, to + 1)).some(Boolean) ? 0.18 : 0;
      return Math.min(1, baseEnergy + transientBoost);
    });

    return {
      available: true,
      energy,
      waveform,
      transients,
      hitTimes,
      rhythmPoints: rhythm.rhythmPoints,
      silenceRegions: rhythm.silenceRegions,
      confidence,
      noiseFloorDb,
      averageDb,
      peakDb,
      dynamicRangeDb,
      hitCount: hitTimes.length,
      sampleRate,
      channels: decoded.numberOfChannels,
      silenceRatio,
      clippingEvents,
    };
  } catch {
    return {
      available: false,
      energy: new Array(energyCount).fill(0.35),
      waveform: [],
      transients: [],
      hitTimes: [],
      rhythmPoints: [],
      silenceRegions: [],
      confidence: 0,
      noiseFloorDb: 0,
      averageDb: 0,
      peakDb: 0,
      dynamicRangeDb: 0,
      hitCount: 0,
      sampleRate: 0,
      channels: 0,
      silenceRatio: 0,
      clippingEvents: 0,
    };
  }
}
