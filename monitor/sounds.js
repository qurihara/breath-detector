// 警報と注意の音を Web Audio でその場で合成する。音声ファイルは使わない。
// どの関数も、鳴らし始めてから鳴り終わるまでの秒数を返す（アプリはその間、判定を止める）。

const reverbs = new WeakMap();

// 部屋の残響に似た響きを付けるための畳み込み（減衰する雑音を応答として使う）
function reverb(ctx) {
  if (reverbs.has(ctx)) return reverbs.get(ctx);
  const len = Math.round(ctx.sampleRate * 1.4);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  conv.connect(wet);
  wet.connect(ctx.destination);
  const node = { input: conv };
  reverbs.set(ctx, node);
  return node;
}

function out(ctx, gainValue, pan = 0) {
  const g = ctx.createGain();
  g.gain.value = gainValue;
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (p) { p.pan.value = pan; g.connect(p); p.connect(ctx.destination); p.connect(reverb(ctx).input); }
  else { g.connect(ctx.destination); g.connect(reverb(ctx).input); }
  return g;
}

const rand = (a, b) => a + Math.random() * (b - a);

// 小鳥の「チュン」という1声。周波数を素早く滑らせ、細かく震わせる。
function chirp(ctx, dest, t, f0, f1, dur, amp) {
  const osc = ctx.createOscillator();
  const vib = ctx.createOscillator();
  const vibGain = ctx.createGain();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  vib.frequency.value = rand(35, 70);
  vibGain.gain.value = rand(80, 250);
  vib.connect(vibGain); vibGain.connect(osc.frequency);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp, t + 0.006);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(env); env.connect(dest);
  osc.start(t); vib.start(t);
  osc.stop(t + dur + 0.02); vib.stop(t + dur + 0.02);
}

/** 鳥のさえずり（警報）。2羽が少しずれて鳴く。約2秒。 */
export function playBirds(ctx, volume = 0.6) {
  const t0 = ctx.currentTime + 0.02;
  let end = t0;
  for (const bird of [{ base: rand(2800, 3400), pan: -0.4, delay: 0 }, { base: rand(3600, 4300), pan: 0.4, delay: rand(0.5, 0.8) }]) {
    const dest = out(ctx, 0.4 * volume, bird.pan);
    let t = t0 + bird.delay;
    const n = Math.floor(rand(4, 8));
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.25) {
        // 細かいトリル
        for (let k = 0; k < 5; k++) { chirp(ctx, dest, t, bird.base * 1.1, bird.base * 1.25, 0.03, 0.7); t += 0.045; }
      } else {
        const up = Math.random() < 0.6;
        const f0 = bird.base * rand(0.9, 1.1);
        chirp(ctx, dest, t, f0, up ? f0 * rand(1.25, 1.5) : f0 * rand(0.65, 0.8), rand(0.05, 0.11), 1);
        t += rand(0.09, 0.18);
      }
    }
    end = Math.max(end, t);
  }
  return end - ctx.currentTime + 0.8; // 残響が消えるまでを含める
}

/** せせらぎ（注意）。水の流れる音と、ときどき水滴がはねる音。約4秒。 */
export function playStream(ctx, volume = 0.6) {
  const t0 = ctx.currentTime + 0.02;
  const dur = 4;
  const len = Math.round(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6 + (Math.random() * 2 - 1) * 0.15; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
  const wobble = ctx.createOscillator();
  const wobbleGain = ctx.createGain();
  wobble.frequency.value = 0.7; wobbleGain.gain.value = 300;
  wobble.connect(wobbleGain); wobbleGain.connect(bp.frequency);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(1, t0 + 0.9);
  env.gain.setValueAtTime(1, t0 + dur - 1.3);
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  const dest = out(ctx, 0.2 * volume, 0);
  src.connect(bp); bp.connect(env); env.connect(dest);
  src.start(t0); wobble.start(t0);
  src.stop(t0 + dur); wobble.stop(t0 + dur);

  // 水滴：短い正弦波の音程を素早く上げる
  const drops = out(ctx, 0.12 * volume, rand(-0.3, 0.3));
  for (let t = t0 + 0.6; t < t0 + dur - 1; t += rand(0.12, 0.45)) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f = rand(700, 1600);
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * rand(1.6, 2.2), t + 0.035);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(rand(0.4, 1), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g); g.connect(drops);
    osc.start(t); osc.stop(t + 0.08);
  }
  return dur + 0.8; // 残響が消えるまでを含める
}

function tone(ctx, freq, dur, gain, delay = 0) {
  const t0 = ctx.currentTime + 0.01 + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
  return delay + dur + 0.02;
}

/** 電子音の警報（v0.2 までの音） */
export function playBeepAlarm(ctx, volume = 0.6) { return tone(ctx, 880, 0.25, 0.6 * volume); }

/** 電子音の注意（v0.2 までの音） */
export function playBeepShallow(ctx, volume = 0.6) {
  tone(ctx, 523, 0.18, 0.33 * volume);
  return tone(ctx, 392, 0.25, 0.33 * volume, 0.22);
}

/** 指示が変わったことを知らせる短い音（検証用の録音） */
export function playCue(ctx, freq) { return tone(ctx, freq, 0.12, 0.15); }

export const SOUND_THEMES = {
  nature: { name: '鳥のさえずりとせせらぎ', alarm: playBirds, alarmEvery: 3, shallow: playStream, shallowEvery: 10 },
  beep: { name: '電子音', alarm: playBeepAlarm, alarmEvery: 0.8, shallow: playBeepShallow, shallowEvery: 8 }
};
