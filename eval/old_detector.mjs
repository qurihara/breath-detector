// 旧方式（src/breath-detector.js の _analyzeFrame）を、音声の配列に対して再現する。
// ブラウザでは requestAnimationFrame ごと（多くの画面で毎秒 60 回）に、
// 直近の 2048 サンプルの RMS を求めて判定していた。ここでも毎秒 60 回で同じ計算をする。
const DEFAULTS = {
  fftSize: 2048, smoothing: 0.92, sensitivity: 1.0,
  minBreathInterval: 1200, idleThreshold: 0.004, fps: 60
};

export function runOldDetector(samples, sr, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let smoothed = 0, mean = 0, variance = 0;
  let lastBreathTime = 0, above = false;
  const events = [];
  const step = 1 / o.fps;
  for (let t = o.fftSize / sr; t * sr < samples.length; t += step) {
    const end = Math.floor(t * sr);
    let s = 0;
    for (let i = end - o.fftSize; i < end; i++) s += samples[i] * samples[i];
    const r = Math.sqrt(s / o.fftSize);
    smoothed = o.smoothing * smoothed + (1 - o.smoothing) * r;
    const diff = smoothed - mean;
    mean = 0.99 * mean + 0.01 * smoothed;
    variance = 0.99 * variance + 0.01 * diff * diff;
    const std = Math.sqrt(variance);
    const now = t * 1000;
    const idle = smoothed < o.idleThreshold;
    const threshold = mean + std * (1.0 / o.sensitivity);
    if (!idle && smoothed > threshold) {
      if (!above) {
        above = true;
        if (now - lastBreathTime >= o.minBreathInterval) {
          lastBreathTime = now;
          events.push(t);
        }
      }
    } else if (smoothed < mean) {
      above = false;
    }
  }
  return events;
}
