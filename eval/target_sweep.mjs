// 浅い呼吸の判定（目標の呼吸を登録する方法）の設定を、検証用の録音で比べる。
//   node eval/target_sweep.mjs eval/data/a.wav eval/data/b.wav ...
//
// 各録音の最初の普通の呼吸の区間の 8〜28 秒で目標を登録したことにして、
// 強さを求める周波数帯と、目標から何 dB 下回ったら注意にするか（下回る幅）の組み合わせごとに、次を数える。
//   浅い呼吸の区間のうち注意を出せた割合と、区間が始まってから注意が出るまでの秒数
//   普通の呼吸の区間で誤って注意を出した秒数（息止めや浅い呼吸の直後に注意が消えるまでの時間は別に数える）
// 目標を登録しないときの固定の閾値についても同じものを数える。
import fs from 'fs';
import path from 'path';
import { createBandAnalyzer, FRAME_SIZE } from '../monitor/features.js';
import { BreathMonitor } from '../monitor/core.js';
import { readWav } from './lib.mjs';

const REGISTER_AT = 28;
const recs = process.argv.slice(2).map((f) => {
  const p = path.resolve(f);
  const { samples, sr } = readWav(p);
  const label = JSON.parse(fs.readFileSync(p.replace(/\.wav$/, '.json'), 'utf8'));
  const dt = FRAME_SIZE / sr;
  const analyze = createBandAnalyzer(sr, FRAME_SIZE);
  const frames = [];
  const fr = new Float32Array(FRAME_SIZE);
  for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
    for (let k = 0; k < FRAME_SIZE; k++) fr[k] = samples[i + k];
    frames.push(Float64Array.from(analyze(fr)));
  }
  return { name: path.basename(p), label, dt, frames };
});

function run(rec, opts, register) {
  const m = new BreathMonitor({ shallowMode: true, shallowMethod: 'target', ratioWindowSec: 20, ...opts });
  let registered = null;
  const flags = rec.frames.map((b, i) => {
    m.push(b, rec.dt);
    if (register && registered === null && (i + 1) * rec.dt >= REGISTER_AT) registered = m.captureTarget(20);
    return m.isShallow;
  });
  const at = (t) => flags[Math.min(flags.length - 1, Math.floor(t / rec.dt))];
  const secs = (s, e) => { let n = 0; for (let t = s; t < e; t += rec.dt) if (at(t)) n += rec.dt; return n; };
  const res = { cover: [], onset: [], recovery: [], falseSec: 0 };
  rec.label.steps.forEach((st, i) => {
    if (st.kind === 'shallow') {
      res.cover.push(secs(st.start, st.end) / (st.end - st.start));
      let on = null;
      for (let t = st.start; t < st.end; t += rec.dt) if (at(t)) { on = t - st.start; break; }
      res.onset.push(on);
    } else if (st.kind === 'breathe') {
      const after = i > 0 && ['hold', 'shallow'].includes(rec.label.steps[i - 1].kind);
      let r = 0;
      if (after) { for (let t = st.start; t < st.end && at(t); t += rec.dt) r += rec.dt; res.recovery.push(r); }
      res.falseSec += secs(Math.max(st.start + r, 20, register ? REGISTER_AT : 0), st.end);
    }
  });
  return res;
}

const fmt = (rs) => rs.map((r) => {
  const on = r.onset.map((x) => (x === null ? 'なし' : x.toFixed(1) + '秒')).join('、');
  return `浅い呼吸で注意を出せた割合 ${r.cover.map((c) => Math.round(c * 100) + '%').join('、')}（出るまで ${on}）`
    + ` 直後に消えるまで ${r.recovery.map((x) => x.toFixed(1)).join('、')}秒 誤った注意 ${r.falseSec.toFixed(1)}秒`;
}).join(' ｜ ');

console.log('■ 目標を登録した場合（録音ごとに「｜」で区切る）');
for (const band of ['judge', 'all', 'b2', 'b3', 'b4']) {
  for (const drop of [6, 8, 10, 12]) {
    console.log(`  周波数帯 ${band}・下回る幅 ${drop} dB: ${fmt(recs.map((r) => run(r, { strengthBand: band, targetDropDb: drop }, true)))}`);
  }
}
console.log('\n■ 目標を登録しない場合（固定の閾値）');
for (const band of ['judge', 'all', 'b3', 'b4']) {
  for (const th of [10, 12, 15]) {
    console.log(`  周波数帯 ${band}・閾値 ${th} dB: ${fmt(recs.map((r) => run(r, { strengthBand: band, fixedStrengthDb: th }, false)))}`);
  }
}
