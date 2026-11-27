// 旧方式と新方式を、正解の分かっている音で比べる。
//   node eval/run_eval.mjs            合成音の筋書きをすべて評価する
//   node eval/run_eval.mjs data/x.wav 録音（同じ名前の .json に正解）を評価する
//
// 数えるもの:
//   息止めの検出   長い無音（息止め）のうち、警報が出たものの数
//   遅れ           無音が始まってから apneaSec 秒たった時刻から、警報が出るまでの秒数
//   誤警報         長い無音ではないところで出た警報の数
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createBandAnalyzer, FRAME_SIZE } from '../monitor/features.js';
import { BreathMonitor } from '../monitor/core.js';
import { runOldDetector } from './old_detector.mjs';
import { synthesize, SCENARIOS } from './synth.mjs';
import { readWav, writeWav } from './lib.mjs';

const APNEA = 10;
const here = path.dirname(fileURLToPath(import.meta.url));

function runNew(samples, sr, options) {
  const analyze = createBandAnalyzer(sr, FRAME_SIZE);
  const m = new BreathMonitor({ apneaSec: APNEA, ...options });
  const dt = FRAME_SIZE / sr;
  const onsets = [];
  const trace = [];
  let prev = 'warmup';
  const frame = new Float32Array(FRAME_SIZE);
  for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
    for (let k = 0; k < FRAME_SIZE; k++) frame[k] = samples[i + k];
    const s = m.push(analyze(frame), dt);
    if (s.status === 'alarm' && prev !== 'alarm') onsets.push(s.t);
    prev = s.status;
    trace.push(s);
  }
  return { onsets, trace, monitor: m };
}

// 旧方式の呼吸の検出の時刻から、「apneaSec 秒のあいだ検出が無ければ警報」とした場合の警報の時刻を作る。
// 旧方式は呼吸の始まりの時刻だけを出すので、そのままでは呼吸音が終わった時刻が分からない。
// 旧方式に不利にならないよう、旧方式自身が推定した呼吸の間隔の中央値の 8 割
// （吸気と呼気の音が続く長さの目安）だけ、警報を遅らせる。
function oldOnsets(events, duration) {
  const out = [];
  const iv = [];
  for (let i = 1; i < events.length; i++) iv.push(events[i] - events[i - 1]);
  iv.sort((a, b) => a - b);
  const offset = iv.length ? 0.8 * iv[Math.floor(iv.length / 2)] : 0;
  const pts = [0, ...events];
  for (let i = 0; i < pts.length; i++) {
    const next = i + 1 < pts.length ? pts[i + 1] : duration;
    if (next - pts[i] > APNEA + offset) out.push(pts[i] + APNEA + offset);
  }
  return out.filter((t) => t > 10);
}

// 正解の音の区間から、警報が正しい範囲と、判定しない範囲を作る。
function regionsFromSounds(sounds, duration) {
  const gaps = [];
  let prevEnd = 0;
  for (const [s, e] of sounds) { if (s > prevEnd) gaps.push([prevEnd, s]); prevEnd = Math.max(prevEnd, e); }
  if (duration > prevEnd) gaps.push([prevEnd, duration]);
  const targets = [], ignore = [];
  for (const [s, e] of gaps) {
    const len = e - s;
    if (s < 1) continue; // 冒頭は判定の準備の時間なので数えない
    if (len >= APNEA + 1) targets.push({ start: s, region: [s + APNEA - 1, e + 1] });
    else if (len >= APNEA - 1) ignore.push([s + APNEA - 1, e + 1]);
  }
  return { targets, ignore };
}

// 録音では、指示が「息を止めて」に変わった時刻しか分からない。
// 人は指示の前に最後の呼吸を終えていることも、指示のあとで吐き終えることもあるので、
// 警報が正しい範囲の始まりを呼吸 1 回分（5 秒）早め、終わりを 3 秒遅らせる。
function regionsFromHolds(holds) {
  const targets = [];
  for (const [s, e] of holds) {
    if (e - s >= APNEA + 1) targets.push({ start: s, region: [s + APNEA - 5, e + 3] });
  }
  return { targets, ignore: [] };
}

function score(onsets, { targets, ignore }) {
  const used = new Set();
  let hits = 0;
  const delays = [];
  for (const tg of targets) {
    const i = onsets.findIndex((t, k) => !used.has(k) && t >= tg.region[0] && t <= tg.region[1]);
    if (i >= 0) { used.add(i); hits++; delays.push(onsets[i] - (tg.start + APNEA)); }
  }
  let falseAlarms = 0;
  onsets.forEach((t, k) => {
    if (used.has(k)) return;
    if (ignore.some(([a, b]) => t >= a && t <= b)) return;
    if (targets.some((tg) => t >= tg.region[0] && t <= tg.region[1])) return; // 同じ息止めの中での警報の出し直し
    falseAlarms++;
  });
  return { hits, total: targets.length, delays, falseAlarms };
}

function fmt(r) {
  const d = r.delays.length ? (r.delays.reduce((a, b) => a + b, 0) / r.delays.length).toFixed(1) + '秒' : '-';
  return `息止めの検出 ${r.hits}/${r.total}  平均の遅れ ${d}  誤警報 ${r.falseAlarms}`;
}

const METHODS = [
  { key: 'old', label: '旧方式（呼吸の検出が途切れたら警報）' },
  { key: 'newAuto', label: '新方式（帯域を自動で選ぶ）', opts: { band: 'auto' } },
  { key: 'newAll', label: '新方式（100 Hz〜8 kHz の全体）', opts: { band: 'all' } }
];

function evaluate(samples, sr, regions, duration) {
  const res = {};
  const ev = runOldDetector(samples, sr);
  res.old = { ...score(oldOnsets(ev, duration), regions), events: ev.length };
  for (const m of METHODS.slice(1)) {
    const r = runNew(samples, sr, m.opts);
    res[m.key] = { ...score(r.onsets, regions), band: r.monitor.band.name, bursts: r.monitor.burstCount };
  }
  return res;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  const totals = {};
  for (const m of METHODS) totals[m.key] = { hits: 0, total: 0, delays: [], falseAlarms: 0 };
  for (const sc of SCENARIOS) {
    console.log(`\n■ ${sc.name}`);
    for (const seed of [1, 2, 3]) {
      const syn = synthesize({ seed, ...sc });
      if (seed === 1 && process.env.SAVE_WAV) {
        writeWav(path.join(here, 'synth_out', `${SCENARIOS.indexOf(sc)}.wav`), syn.samples, syn.sr);
      }
      const regions = regionsFromSounds(syn.sounds, syn.duration);
      const res = evaluate(syn.samples, syn.sr, regions, syn.duration);
      const cycles = syn.sounds.length / 2;
      console.log(`  種${seed}: 呼吸の回数の正解 ${cycles}、旧方式が数えた回数 ${res.old.events}`);
      for (const m of METHODS) {
        const r = res[m.key];
        console.log(`    ${m.label}: ${fmt(r)}${r.band ? `  使った帯域 ${r.band}` : ''}`);
        const T = totals[m.key];
        T.hits += r.hits; T.total += r.total; T.delays.push(...r.delays); T.falseAlarms += r.falseAlarms;
      }
    }
  }
  console.log('\n■ 合計');
  for (const m of METHODS) console.log(`  ${m.label}: ${fmt(totals[m.key])}`);
} else {
  for (const f of args) {
    const p = path.resolve(f);
    const { samples, sr } = readWav(p);
    const labelPath = p.replace(/\.wav$/, '.json');
    const label = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
    const regions = regionsFromHolds(label.holds);
    const res = evaluate(samples, sr, regions, samples.length / sr);
    console.log(`\n■ ${path.basename(p)}（${(samples.length / sr).toFixed(0)}秒、標本化周波数 ${sr} Hz）`);
    for (const m of METHODS) console.log(`  ${m.label}: ${fmt(res[m.key])}${res[m.key].band ? `  使った帯域 ${res[m.key].band}` : ''}`);
  }
}
