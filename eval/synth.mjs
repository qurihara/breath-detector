// 正解の分かっている合成の呼吸音を作る。
// これは判定の論理を確かめるための音であり、実際の呼吸音の代わりにはならない。
// 本当の精度は、録音した呼吸音（eval/data/ に置く）で測る。
import { rng, biquad, rms } from './lib.mjs';

export const SR = 48000;

function dbToGain(db) { return Math.pow(10, db / 20); }

// 部屋の雑音：低い音に偏った雑音と電源のハム
function ambient(n, r, rmsTarget) {
  const lp = biquad('lowpass', 400, 0.7, SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = r.gauss();
    out[i] = lp(w) + 0.15 * w + 0.05 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.03 * Math.sin((2 * Math.PI * 150 * i) / SR);
  }
  const g = rmsTarget / rms(out);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

// 1 回の呼気または吸気の音を out の start から書き込む。
// 呼気は鼻息がマイクに当たる低い風の音と、高い気流の音からなる。吸気は気流の音だけで弱い。
function breathSound(out, r, start, dur, kind, gain) {
  const n = Math.round(dur * SR);
  const hiss = [biquad('highpass', 800, 0.7, SR), biquad('lowpass', 5000, 0.7, SR)];
  const wind = biquad('lowpass', 250, 0.7, SR);
  const windGain = kind === 'exhale' ? 1.6 : 0.15;
  const hissGain = kind === 'exhale' ? 1.0 : 0.5;
  const s0 = Math.round(start * SR);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const x = i / n;
    const env = Math.pow(Math.sin(Math.PI * x), 0.8);
    const h = hiss[1](hiss[0](r.gauss()));
    const w = wind(r.gauss()) * 4;
    out[s0 + i] += gain * env * (hissGain * h + windGain * w) * 0.1;
  }
}

// 近くの人の話し声に似た音：倍音の列を音節の単位で鳴らす
function speech(out, r, start, dur, gain) {
  const s0 = Math.round(start * SR);
  const n = Math.round(dur * SR);
  let phase = 0;
  let f0 = r.range(110, 200);
  let syll = 0, syllLen = 0;
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    if (syll <= 0) { syllLen = Math.round(r.range(0.12, 0.3) * SR); syll = syllLen; f0 = r.range(110, 200); }
    syll--;
    const env = Math.sin((Math.PI * (syllLen - syll)) / syllLen);
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let k = 1; k <= 20; k++) v += Math.sin(k * phase) / k;
    out[s0 + i] += gain * env * v * 0.05;
  }
}

/**
 * 筋書きに沿って合成音を作る。
 * segments: [{ type: 'breathe', dur, rate, gainDb }, { type: 'hold', dur }]
 * 返り値: { samples, sr, sounds: [[開始, 終了], ...], holds: [[開始, 終了], ...] }
 */
export function synthesize({ seed, segments, ambientDb = -50, breathDb = -20, speechSegs = [], speechDb = -30 }) {
  const r = rng(seed);
  const total = segments.reduce((s, x) => s + x.dur, 0);
  const n = Math.round(total * SR);
  const out = ambient(n, r, dbToGain(ambientDb));
  const sounds = [];
  const holds = [];
  let t = 0;
  for (const seg of segments) {
    const end = t + seg.dur;
    if (seg.type === 'hold') {
      holds.push([t, end]);
    } else {
      const gain = dbToGain(breathDb + (seg.gainDb || 0)) * 10;
      while (true) {
        const cycle = (60 / seg.rate) * r.range(0.85, 1.15);
        const inh = cycle * r.range(0.33, 0.4);
        const exh = cycle * r.range(0.42, 0.5);
        if (t + inh + exh > end) break;
        breathSound(out, r, t, inh, 'inhale', gain);
        sounds.push([t, t + inh]);
        breathSound(out, r, t + inh, exh, 'exhale', gain);
        sounds.push([t + inh, t + inh + exh]);
        t += cycle;
        if (t >= end) break;
      }
    }
    t = end;
  }
  for (const [s, d] of speechSegs) speech(out, r, s, d, dbToGain(speechDb) * 10);
  return { samples: out, sr: SR, sounds, holds, duration: total };
}

const B = (dur, rate = 15, gainDb = 0) => ({ type: 'breathe', dur, rate, gainDb });
const H = (dur) => ({ type: 'hold', dur });

// 評価に使う筋書き。各筋書きを 3 つの乱数の種で作る。
export const SCENARIOS = [
  { name: '静かな部屋・普通の呼吸・息止め15秒と20秒', ambientDb: -55, segments: [B(40), H(15), B(40), H(20), B(40)] },
  { name: '静かな部屋・浅い呼吸(-12dB)・息止め15秒と20秒', ambientDb: -55, segments: [B(40, 15, -12), H(15), B(40, 15, -12), H(20), B(40, 15, -12)] },
  { name: '騒がしい部屋(+15dB)・普通の呼吸・息止め', ambientDb: -40, segments: [B(40), H(15), B(40), H(20), B(40)] },
  { name: '騒がしい部屋・浅い呼吸・息止め', ambientDb: -40, segments: [B(40, 15, -12), H(15), B(40, 15, -12), H(20), B(40, 15, -12)] },
  { name: '速い呼吸(24回/分)・息止め', ambientDb: -55, segments: [B(40, 24), H(15), B(40, 24), H(12), B(40, 24)] },
  { name: 'ゆっくりの呼吸(6回/分)・息止めなし', ambientDb: -55, segments: [B(180, 6)] },
  { name: '普通の呼吸だけ10分', ambientDb: -50, segments: [B(600)] },
  { name: '息止め中に近くで話し声', ambientDb: -55, segments: [B(40), H(20), B(40), H(20), B(40)], speechSegs: [[45, 10], [105, 6]], speechDb: -35 }
];
