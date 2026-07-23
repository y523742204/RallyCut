import type { AudioAnalysis } from './audio-analysis';

export type RallySegment = { start: number; end: number; score: number };

export type AudioSegmentationResult = {
  usedAudio: boolean;
  segments: RallySegment[];
  reason: string;
  averageInterval: number;
  averageThreshold: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const motionNear = (time: number, motion: number[], step: number) => {
  if (!motion.length) return 0;
  const center = Math.min(motion.length - 1, Math.max(0, Math.round(time / Math.max(0.001, step))));
  const values = motion.slice(Math.max(0, center - 1), Math.min(motion.length, center + 2));
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
};

export function buildAudioRallySegments(
  audio: AudioAnalysis,
  motion: number[],
  motionStep: number,
  duration: number,
): AudioSegmentationResult {
  const validRhythms = audio.rhythmPoints.map(point => point.averageInterval).filter(value => value >= 0.32 && value <= 3.2);
  const averageInterval = validRhythms.length
    ? validRhythms.reduce((sum, value) => sum + value, 0) / validRhythms.length
    : 0;
  const averageThreshold = audio.rhythmPoints.length
    ? audio.rhythmPoints.reduce((sum, point) => sum + point.waitThreshold, 0) / audio.rhythmPoints.length
    : 2.5;

  if (!audio.available) return { usedAudio: false, segments: [], reason: '音轨无法解码', averageInterval, averageThreshold };
  if (audio.hitTimes.length < 2) return { usedAudio: false, segments: [], reason: '可信击球峰值不足', averageInterval, averageThreshold };
  if (audio.confidence < 0.42) return { usedAudio: false, segments: [], reason: '音频节奏可信度不足', averageInterval, averageThreshold };
  if (audio.dynamicRangeDb < 7) return { usedAudio: false, segments: [], reason: '击球声与背景噪声区分度不足', averageInterval, averageThreshold };

  const groups: number[][] = [];
  let current: number[] = [audio.hitTimes[0]];
  for (let index = 1; index < audio.hitTimes.length; index++) {
    const previous = audio.hitTimes[index - 1];
    const next = audio.hitTimes[index];
    const waitThreshold = audio.rhythmPoints[index - 1]?.waitThreshold ?? 2.5;
    if (next - previous <= waitThreshold) current.push(next);
    else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);

  const raw = groups.flatMap((group, groupIndex) => {
    if (group.length < 2) return [];
    const intervals = group.slice(1).map((time, index) => time - group[index]);
    const plausibleIntervals = intervals.filter(value => value >= 0.32 && value <= 3.2);
    if (!plausibleIntervals.length) return [];
    const motionValues = group.map(time => motionNear(time, motion, motionStep));
    const averageMotion = motionValues.reduce((sum, value) => sum + value, 0) / motionValues.length;
    if (averageMotion < 0.035) return [];
    if (group.length < 4 && averageMotion < 0.075) return [];
    const firstHit = group[0];
    const lastHit = group[group.length - 1];
    const hasEndingDecision = audio.silenceRegions.some(region => Math.abs(region.lastHitTime - lastHit) < 0.08);
    const reachesVideoEndWhileActive = groupIndex === groups.length - 1 && !hasEndingDecision;
    const score = clamp(audio.confidence * 0.62 + averageMotion * 0.25 + Math.min(0.13, group.length * 0.018), 0.55, 0.98);
    return [{
      start: Math.max(0, firstHit - 1),
      end: reachesVideoEndWhileActive ? duration : Math.min(duration, lastHit + 0.65),
      score,
    }];
  });

  const merged: RallySegment[] = [];
  for (const segment of raw) {
    const last = merged[merged.length - 1];
    if (last && segment.start - last.end < 0.45) {
      last.end = Math.max(last.end, segment.end);
      last.score = Math.max(last.score, segment.score);
    } else if (segment.end - segment.start >= 1.2) {
      merged.push({ ...segment });
    }
  }

  if (!merged.length) return { usedAudio: false, segments: [], reason: '峰值序列缺少连续对打特征', averageInterval, averageThreshold };
  return { usedAudio: true, segments: merged, reason: '', averageInterval, averageThreshold };
}

export function buildMotionRallySegments(motion: number[], step: number, duration: number): RallySegment[] {
  const smooth = motion.map((_, index) => {
    const nearby = motion.slice(Math.max(0, index - 2), Math.min(motion.length, index + 3));
    return nearby.reduce((sum, value) => sum + value, 0) / Math.max(1, nearby.length);
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const threshold = Math.max(0.28, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.53))] || 0.28);
  const active = smooth.map(value => value >= threshold);
  const raw: RallySegment[] = [];
  let start: number | null = null;
  let inactiveCount = 0;

  active.forEach((yes, index) => {
    if (yes) {
      inactiveCount = 0;
      if (start === null) start = index;
    } else if (start !== null) {
      inactiveCount++;
      if (inactiveCount >= Math.max(2, Math.round(4 / step))) {
        const endIndex = index - inactiveCount + 1;
        const values = smooth.slice(start, Math.max(start + 1, endIndex));
        raw.push({
          start: Math.max(0, start * step - 1.8),
          end: Math.min(duration, endIndex * step + 2.2),
          score: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
        });
        start = null;
        inactiveCount = 0;
      }
    }
  });
  if (start !== null) raw.push({ start: Math.max(0, start * step - 1.8), end: duration, score: 0.72 });

  const merged: RallySegment[] = [];
  raw.forEach(item => {
    const last = merged[merged.length - 1];
    if (last && item.start - last.end < 3.5) {
      last.end = item.end;
      last.score = Math.max(last.score, item.score);
    } else if (item.end - item.start >= 3) merged.push({ ...item });
  });
  return merged.length ? merged : [{ start: 0, end: duration, score: 0.5 }];
}
