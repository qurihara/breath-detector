// 検証用の録音を区間ごとに分析し、判定にどれだけ余裕があるかを調べる。
//   node eval/analyze_rec.mjs eval/data/xxx.wav
//
// 周波数帯ごとに、録音全体の下位5%の音量（静かなときの音量の目安）を基準にして、
//   ・呼吸の区間で、呼吸音の山の高さ（上位10%の音量）が基準より何 dB 大きいか
//   ・息止めの区間で、最も大きい音（上位2%）が基準より何 dB 大きいか（閾値 6 dB を超えると息止めを見逃す）
//   ・新方式の判定で、呼吸の区間のうち「呼吸音あり」だった割合と、最も長い無音の秒数
// を出す。旧方式については、息止めの区間の中で呼吸と数えた時刻を出す。
import fs from 'fs';
import path from 'path';
import { createBandAnalyzer, FRAME_SIZE, BANDS } from '../monitor/features.js';
import { BreathMonitor } from '../monitor/core.js';
import { runOldDetector } from './old_detector.mjs';
import { readWav } from './lib.mjs';

const file = path.resolve(process.argv[2]);
const { samples, sr } = readWav(file);
const label = JSON.parse(fs.readFileSync(file.replace(/\.wav$/, '.json'), 'utf8'));
const dt = FRAME_SIZE / sr;
const analyze = createBandAnalyzer(sr, FRAME_SIZE);

// 0.08 秒の時定数で平滑化した、周波数帯ごとの音量の列
const levels = BANDS.map(() => []);
const sm = new Float64Array(BANDS.length).fill(NaN);
const a = Math.exp(-dt / 0.08);
const frame = new Float32Array(FRAME_SIZE);
for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
  for (let k = 0; k < FRAME_SIZE; k++) frame[k] = samples[i + k];
  const b = analyze(frame);
  for (let j = 0; j < BANDS.length; j++) {
    sm[j] = Number.isNaN(sm[j]) ? b[j] : a * sm[j] + (1 - a) * b[j];
    levels[j].push(sm[j]);
  }
}
const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; };
const seg = (arr, s, e) => arr.slice(Math.floor(s / dt), Math.floor(e / dt));

const NAMES = { breathe: '普通の呼吸', hold: '息止め', shallow: '浅い呼吸' };
console.log(`■ ${path.basename(file)}　マイク: ${label.device}`);
for (let j = 0; j < BANDS.length; j++) {
  const L = levels[j];
  const floor = pct(L, 0.05);
  const parts = label.steps.map((st) => {
    // 指示が変わった直後の 2 秒は、吐き終わりや合図の音が入るので除く。
    const x = seg(L, st.start + 2, st.end);
    const v = st.kind === 'hold' ? pct(x, 0.98) - floor : pct(x, 0.9) - floor;
    return `${NAMES[st.kind]}${st.kind === 'hold' ? '(最大)' : '(山)'} ${v.toFixed(1)}`;
  });
  console.log(`  ${BANDS[j].name.padEnd(14)} 下位5%の音量 ${floor.toFixed(1)} dB | ${parts.join(' / ')}`);
}

for (const band of ['auto', 'all', 'b2']) {
  const m = new BreathMonitor({ band });
  const on = [];
  for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
    for (let k = 0; k < FRAME_SIZE; k++) frame[k] = samples[i + k];
    on.push(m.push(analyze(frame), dt).breathing);
  }
  const rows = label.steps.filter((s) => s.kind !== 'hold').map((st) => {
    const x = seg(on, Math.max(st.start, 8), st.end);
    let longest = 0, run = 0;
    for (const v of x) { run = v ? 0 : run + dt; longest = Math.max(longest, run); }
    const ratio = x.filter(Boolean).length / x.length;
    return `${NAMES[st.kind]}(${st.start}〜${st.end}秒) 呼吸音ありの割合 ${(ratio * 100).toFixed(0)}% 最長の無音 ${longest.toFixed(1)}秒`;
  });
  console.log(`\n  新方式（周波数帯 ${band}）`);
  rows.forEach((r) => console.log('    ' + r));
}

const ev = runOldDetector(samples, sr);
console.log('\n  旧方式が呼吸と数えた時刻（息止めの区間の中）');
for (const [s, e] of label.holds) console.log(`    ${s}〜${e}秒: ${ev.filter((t) => t >= s + 2 && t <= e).map((t) => t.toFixed(1)).join(' ') || 'なし'}`);
const ivs = ev.slice(1).map((t, i) => t - ev[i]);
console.log(`  旧方式が数えた呼吸の回数 ${ev.length}、間隔の中央値 ${pct(ivs, 0.5).toFixed(1)}秒`);
