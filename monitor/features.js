// 1 フレームの音声から、周波数帯ごとの音量 (dB) を求める。
// ブラウザの AudioWorklet と、Node の評価用の道具の両方から読み込む。

export const FRAME_SIZE = 1024;

// 判定に使う周波数帯の候補。'all' は 100 Hz から 8 kHz までの全体である。
export const BANDS = [
  { id: 'b1', name: '100〜300 Hz', lo: 100, hi: 300 },
  { id: 'b2', name: '300 Hz〜1 kHz', lo: 300, hi: 1000 },
  { id: 'b3', name: '1〜3 kHz', lo: 1000, hi: 3000 },
  { id: 'b4', name: '3〜8 kHz', lo: 3000, hi: 8000 },
  { id: 'all', name: '100 Hz〜8 kHz（全体）', lo: 100, hi: 8000 }
];

/**
 * 長さ n（2 のべき）のフレームを受け取り、帯域ごとの音量 (dB) の配列を返す関数を作る。
 * 返す配列の並びは BANDS と同じである。
 */
export function createBandAnalyzer(sampleRate, n = FRAME_SIZE) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('フレームの長さは 2 のべきにする');

  const hann = new Float64Array(n);
  let windowPower = 0;
  for (let i = 0; i < n; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windowPower += hann[i] * hann[i];
  }

  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }

  const binHz = sampleRate / n;
  const ranges = BANDS.map((b) => {
    const lo = Math.max(1, Math.round(b.lo / binHz));
    const hi = Math.min(n / 2 - 1, Math.round(b.hi / binHz));
    return [lo, hi];
  });

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const out = new Float64Array(BANDS.length);

  return function analyze(frame) {
    for (let i = 0; i < n; i++) {
      re[rev[i]] = frame[i] * hann[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let j = 0; j < ranges.length; j++) {
      const [lo, hi] = ranges[j];
      let e = 0;
      for (let k = lo; k <= hi; k++) e += re[k] * re[k] + im[k] * im[k];
      out[j] = 10 * Math.log10((2 * e) / (n * windowPower) + 1e-12);
    }
    return out;
  };
}
