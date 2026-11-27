// 浅い呼吸を知らせるモードの設定（割合を求める窓の長さと閾値）を、検証用の録音で比べる。
//   node eval/shallow_sweep.mjs eval/data/xxx.wav
//
// 出すもの:
//   浅い呼吸の区間が始まってから「呼吸が浅い」と判定するまでの秒数と、その区間のうち判定できていた割合
//   普通の呼吸の区間で「呼吸が浅い」と判定した秒数（誤った注意）。息止めの直後は別に数える
//   息止めが終わってから「呼吸が浅い」の判定が消えるまでの秒数
import fs from 'fs';
import path from 'path';
import { createBandAnalyzer, FRAME_SIZE } from '../monitor/features.js';
import { BreathMonitor } from '../monitor/core.js';
import { readWav } from './lib.mjs';

const file = path.resolve(process.argv[2]);
const { samples, sr } = readWav(file);
const label = JSON.parse(fs.readFileSync(file.replace(/\.wav$/, '.json'), 'utf8'));
const dt = FRAME_SIZE / sr;
const analyze = createBandAnalyzer(sr, FRAME_SIZE);
const frames = [];
const frame = new Float32Array(FRAME_SIZE);
for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
  for (let k = 0; k < FRAME_SIZE; k++) frame[k] = samples[i + k];
  frames.push(Float64Array.from(analyze(frame)));
}

console.log(`■ ${path.basename(file)}`);
for (const win of [15, 20, 30]) {
  for (const ratio of [0.3, 0.4, 0.5]) {
    const m = new BreathMonitor({ shallowMode: true, ratioWindowSec: win, shallowRatio: ratio });
    const shallowFlag = frames.map((b) => { m.push(b, dt); return m.isShallow; });
    const at = (t) => shallowFlag[Math.min(shallowFlag.length - 1, Math.floor(t / dt))];
    const secs = (s, e) => { let n = 0; for (let t = s; t < e; t += dt) if (at(t)) n += dt; return n; };

    const out = [];
    for (const st of label.steps) {
      if (st.kind === 'shallow') {
        let onset = null;
        for (let t = st.start; t < st.end; t += dt) if (at(t)) { onset = t - st.start; break; }
        out.push(`浅い呼吸で判定までの秒数 ${onset === null ? 'なし' : onset.toFixed(1)}、区間のうち判定できた割合 ${(secs(st.start, st.end) / (st.end - st.start) * 100).toFixed(0)}%`);
      }
    }
    let recovery = [], falseSec = 0;
    label.steps.forEach((st, i) => {
      if (st.kind !== 'breathe') return;
      // 息止めや浅い呼吸のすぐあとは、窓の中に前の区間が残るので、判定が消えるまでの秒数を別に数える。
      const prevHold = i > 0 && ['hold', 'shallow'].includes(label.steps[i - 1].kind);
      if (prevHold) {
        let r = 0;
        for (let t = st.start; t < st.end && at(t); t += dt) r += dt;
        recovery.push(r.toFixed(1));
        falseSec += secs(st.start + r, st.end);
      } else {
        falseSec += secs(Math.max(st.start, win), st.end);
      }
    });
    out.push(`息止めや浅い呼吸のあと判定が消えるまで ${recovery.join('、')}秒`);
    out.push(`普通の呼吸での誤った判定 ${falseSec.toFixed(1)}秒`);
    console.log(`  割合を求める時間 ${win}秒・閾値 ${ratio * 100}%: ${out.join(' / ')}`);
  }
}
