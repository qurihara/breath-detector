import { BANDS } from './features.js?v=0.2.1';
import { BreathMonitor, DEFAULT_OPTIONS } from './core.js?v=0.2.1';
import { VERSION } from './version.js?v=0.2.1';

const $ = (id) => document.getElementById(id);
const els = {
  version: $('version'), panel: $('statusPanel'), statusText: $('statusText'), silence: $('silence'),
  ack: $('ackBtn'), graph: $('graph'), ratio: $('ratio'), bursts: $('bursts'), bandName: $('bandName'),
  toggle: $('toggle'), mic: $('mic'), apnea: $('apnea'), apneaVal: $('apneaVal'), margin: $('margin'),
  marginVal: $('marginVal'), band: $('band'), sound: $('sound'), wake: $('wake'),
  recBtn: $('recBtn'), recBeep: $('recBeep'), instruction: $('instruction'), error: $('error'),
  mode: $('mode'), shallowRow: $('shallowRow'), shallowRatio: $('shallowRatio'), shallowRatioVal: $('shallowRatioVal'),
  ratioWin: $('ratioWin'), ratioLabel: $('ratioLabel')
};
// 「呼吸音あり」の割合を求める窓の長さ。2026-11-27 の録音で 15・20・30 秒を比べて決めた。
const RATIO_WINDOW_SEC = 20;
els.version.textContent = 'v' + VERSION;

// ---- 設定（ブラウザに保存する） ----
const SETTINGS_KEY = 'breath-monitor-settings';
const settings = Object.assign(
  { apneaSec: 10, marginDb: 6, band: 'auto', sound: true, wake: false, deviceId: '', shallowMode: true, shallowRatio: 40 },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
);
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

els.band.innerHTML = '<option value="auto">自動（呼吸で音量が最もよく上下する帯を選ぶ）</option>' +
  BANDS.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
els.apnea.value = settings.apneaSec; els.apneaVal.textContent = settings.apneaSec;
els.margin.value = settings.marginDb; els.marginVal.textContent = settings.marginDb;
els.band.value = settings.band; els.sound.checked = settings.sound; els.wake.checked = settings.wake;
els.mode.value = settings.shallowMode ? 'shallow' : 'apnea';
els.shallowRatio.value = settings.shallowRatio; els.shallowRatioVal.textContent = settings.shallowRatio;
els.ratioWin.textContent = RATIO_WINDOW_SEC;
updateModeUi();

function monitorOptions() {
  return {
    apneaSec: settings.apneaSec,
    warnSec: Math.max(3, Math.round(settings.apneaSec * 0.6)),
    marginDb: settings.marginDb,
    band: settings.band,
    shallowMode: settings.shallowMode,
    shallowRatio: settings.shallowRatio / 100,
    ratioWindowSec: RATIO_WINDOW_SEC
  };
}

function updateModeUi() {
  els.shallowRow.hidden = !settings.shallowMode;
}

els.apnea.addEventListener('input', () => {
  settings.apneaSec = Number(els.apnea.value); els.apneaVal.textContent = settings.apneaSec;
  if (monitor) Object.assign(monitor.options, monitorOptions());
  saveSettings();
});
els.margin.addEventListener('input', () => {
  settings.marginDb = Number(els.margin.value); els.marginVal.textContent = settings.marginDb;
  if (monitor) Object.assign(monitor.options, monitorOptions());
  saveSettings();
});
els.band.addEventListener('change', () => {
  settings.band = els.band.value;
  if (monitor) Object.assign(monitor.options, monitorOptions());
  saveSettings();
});
els.mode.addEventListener('change', () => {
  settings.shallowMode = els.mode.value === 'shallow';
  if (monitor) Object.assign(monitor.options, monitorOptions());
  updateModeUi(); saveSettings();
});
els.shallowRatio.addEventListener('input', () => {
  settings.shallowRatio = Number(els.shallowRatio.value); els.shallowRatioVal.textContent = settings.shallowRatio;
  if (monitor) Object.assign(monitor.options, monitorOptions());
  saveSettings();
});
els.sound.addEventListener('change', () => { settings.sound = els.sound.checked; saveSettings(); });
els.wake.addEventListener('change', () => { settings.wake = els.wake.checked; saveSettings(); updateWakeLock(); });

// ---- マイクの一覧 ----
async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    els.mic.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || 'マイク ' + (i + 1)}</option>`).join('');
    if (settings.deviceId && devs.some((d) => d.deviceId === settings.deviceId)) els.mic.value = settings.deviceId;
  } catch (_) { /* 許可の前は失敗することがある */ }
}
els.mic.addEventListener('change', async () => {
  settings.deviceId = els.mic.value; saveSettings();
  if (running) { stop(); await start(); }
});
navigator.mediaDevices?.addEventListener?.('devicechange', listMics);

// ---- 音声の処理 ----
let ctx = null, stream = null, node = null, sink = null, monitor = null, running = false;
let suppressUntil = 0;      // この時刻（AudioContext の時刻）までは判定に使わない
let nextBeepAt = 0, acked = false, prevStatus = 'warmup', shallowMuteUntil = 0;
let wakeLock = null;

async function start() {
  els.error.textContent = '';
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (settings.deviceId) audio.deviceId = { exact: settings.deviceId };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    els.error.textContent = 'マイクを使えませんでした: ' + err.message;
    return;
  }
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL('./worklet.js?v=0.2.1', import.meta.url));
  const src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'band-level', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();

  monitor = new BreathMonitor(monitorOptions());
  history.length = 0;
  acked = false; prevStatus = 'warmup';
  node.port.onmessage = (e) => onFrame(e.data);
  running = true;
  els.toggle.textContent = '監視を停止';
  els.toggle.classList.add('running');
  await listMics();
  const label = stream.getAudioTracks()[0]?.label;
  const match = [...els.mic.options].find((o) => o.textContent === label);
  if (match) els.mic.value = match.value;
  updateWakeLock();
  requestAnimationFrame(draw);
}

function stop() {
  if (recording) finishRecording(true);
  running = false;
  node?.port && (node.port.onmessage = null);
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  ctx = null; node = null; stream = null;
  els.toggle.textContent = '監視を開始';
  els.toggle.classList.remove('running');
  els.panel.className = 'status-panel warmup';
  els.statusText.textContent = '停止しています';
  els.silence.textContent = '--';
  els.ack.hidden = true;
  document.title = '呼吸モニター';
  updateWakeLock();
}

els.toggle.addEventListener('click', () => (running ? stop() : start()));
els.ack.addEventListener('click', () => {
  if (monitor?.status === 'shallow') shallowMuteUntil = ctx.currentTime + 60;
  else acked = true;
  els.ack.hidden = true;
});

function beep(freq, dur, gain, delay = 0) {
  if (!ctx) return;
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
  // イヤホンの音をマイクが拾っても呼吸音と取り違えないよう、鳴っている間と直後は判定に使わない。
  suppressUntil = Math.max(suppressUntil, t0 + dur + 0.15);
}

// ---- 1 フレームごとの判定 ----
const history = []; // グラフ用：0.1 秒ごとの記録
let nextHistT = 0;

function onFrame(msg) {
  if (!monitor) return;
  const suppress = msg.time < suppressUntil;
  const s = monitor.push(msg.bands, msg.dt, suppress);

  if (recording) recordFrame(msg, s);

  if (s.breathing) acked = false;
  if (s.status === 'alarm' && prevStatus !== 'alarm') {
    navigator.vibrate?.([300, 200, 300]);
    if (recording) recAlarms.push(Number(recT.toFixed(2)));
  }
  if (s.status === 'alarm' && settings.sound && !acked && !recording && ctx.currentTime >= nextBeepAt) {
    beep(880, 0.25, 0.4);
    nextBeepAt = ctx.currentTime + 0.8;
  }
  // 浅い呼吸の注意の音は、警報と区別できるよう低く、間隔を空けて鳴らす。
  if (s.status === 'shallow' && settings.sound && !recording && ctx.currentTime >= shallowMuteUntil && ctx.currentTime >= nextBeepAt) {
    beep(523, 0.18, 0.2);
    beep(392, 0.25, 0.2, 0.22);
    nextBeepAt = ctx.currentTime + 8;
  }
  if (s.status !== prevStatus) {
    if (recording) recStatus.push([Number(recT.toFixed(2)), s.status]);
    if (s.status === 'shallow' && prevStatus !== 'shallow') nextBeepAt = Math.max(nextBeepAt, ctx.currentTime);
  }
  prevStatus = s.status;

  if (s.t >= nextHistT) {
    nextHistT = s.t + 0.1;
    history.push({ t: s.t, level: s.level, floor: s.floor, th: s.threshold, on: s.breathing, sup: suppress });
    while (history.length && history[0].t < s.t - 60) history.shift();
  }
  updatePanel(s);
}

const STATUS_TEXT = {
  warmup: '準備中（静かなときの音量を推定しています）',
  ok: '呼吸音を検出しています',
  warn: '呼吸音が途切れています',
  shallow: '呼吸が浅くなっています',
  alarm: '警報：呼吸音が長く途切れています'
};

function updatePanel(s) {
  els.panel.className = 'status-panel ' + s.status;
  els.statusText.textContent = STATUS_TEXT[s.status];
  els.silence.textContent = s.silenceSec.toFixed(1);
  const showAck = settings.sound && !recording &&
    ((s.status === 'alarm' && !acked) || (s.status === 'shallow' && ctx.currentTime >= shallowMuteUntil));
  els.ack.hidden = !showAck;
  els.ack.textContent = s.status === 'shallow' ? '注意の音を1分間止める' : '警報の音を止める（次の呼吸音まで）';
  if (s.status === 'shallow') {
    els.statusText.textContent = `呼吸が浅くなっています（直近${RATIO_WINDOW_SEC}秒の呼吸音の割合 ${Math.round(s.activeRatio * 100)}%、目安は${settings.shallowRatio}%以上）`;
  }
  els.ratio.textContent = Math.round(s.activeRatio * 100) + '%';
  els.bursts.textContent = s.burstCount;
  els.bandName.textContent = s.band.name + (settings.band === 'auto' ? '（自動）' : '');
  document.title = s.status === 'alarm' ? '【警報】呼吸モニター' : s.status === 'shallow' ? '【注意】呼吸モニター' : '呼吸モニター';
}

// ---- グラフ ----
const g2 = els.graph.getContext('2d');
function draw() {
  if (!running) return;
  requestAnimationFrame(draw);
  if (document.hidden) return;
  const ratio = window.devicePixelRatio || 1;
  const w = els.graph.clientWidth, h = els.graph.clientHeight;
  if (els.graph.width !== Math.round(w * ratio)) { els.graph.width = Math.round(w * ratio); els.graph.height = Math.round(h * ratio); }
  g2.setTransform(ratio, 0, 0, ratio, 0, 0);
  g2.clearRect(0, 0, w, h);
  if (history.length < 2) return;
  const tEnd = history[history.length - 1].t;
  const vals = history.flatMap((p) => [p.level, p.floor, p.th]).filter((v) => Number.isFinite(v) && v > -100);
  if (vals.length === 0) return;
  const lo = Math.min(...vals) - 3, hi = Math.max(...vals) + 3;
  const X = (t) => w - ((tEnd - t) / 60) * w;
  const Y = (v) => h - ((v - lo) / (hi - lo)) * (h - 8) - 4;
  const css = getComputedStyle(document.documentElement);

  g2.fillStyle = 'rgba(31, 157, 85, 0.25)';
  for (const p of history) if (p.on) g2.fillRect(X(p.t) - 0.5, 0, w / 600 + 1, h);
  g2.fillStyle = 'rgba(128, 128, 128, 0.25)';
  for (const p of history) if (p.sup) g2.fillRect(X(p.t) - 0.5, 0, w / 600 + 1, h);

  const line = (key, color, width) => {
    g2.strokeStyle = color; g2.lineWidth = width; g2.beginPath();
    let first = true;
    for (const p of history) {
      if (!Number.isFinite(p[key]) || p[key] <= -100) { first = true; continue; }
      first ? g2.moveTo(X(p.t), Y(p[key])) : g2.lineTo(X(p.t), Y(p[key]));
      first = false;
    }
    g2.stroke();
  };
  line('floor', css.getPropertyValue('--idle').trim(), 1);
  line('th', css.getPropertyValue('--alarm').trim(), 1.5);
  line('level', css.getPropertyValue('--accent').trim(), 2);
  g2.fillStyle = css.getPropertyValue('--muted').trim();
  g2.font = '11px system-ui';
  g2.fillText('60秒前', 4, h - 4);
  g2.fillText('いま', w - 26, h - 4);
}

// ---- 画面を消さない ----
async function updateWakeLock() {
  try {
    if (settings.wake && running && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if ((!settings.wake || !running) && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch (_) { /* 対応していないブラウザでは何もしない */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateWakeLock(); });

// ---- 検証用の録音 ----
// 指示の順番。息止めの区間が正解になる。
// v0.2.0 で、普通の呼吸から浅い呼吸へ直接移る区間と、浅い呼吸から普通の呼吸へ戻る区間を入れた。
const PROTOCOL = [
  { kind: 'breathe', dur: 30, text: '普通に呼吸してください' },
  { kind: 'hold', dur: 15, text: '息を止めてください' },
  { kind: 'breathe', dur: 30, text: '普通に呼吸してください' },
  { kind: 'shallow', dur: 40, text: 'できるだけ浅く、静かに呼吸してください' },
  { kind: 'breathe', dur: 25, text: '普通に呼吸してください' },
  { kind: 'hold', dur: 20, text: '息を止めてください' },
  { kind: 'breathe', dur: 20, text: '普通に呼吸してください' }
];
const PROTOCOL_TOTAL = PROTOCOL.reduce((a, s) => a + s.dur, 0);
let recording = false, recChunks = [], recSamples = 0, recSr = 48000, recT = 0, recStep = -1;
let recAlarms = [], recBeeps = [], recStatus = [], recStartedAt = null;

els.recBtn.addEventListener('click', async () => {
  if (recording) { finishRecording(true); return; }
  if (!running) await start();
  if (!running) return;
  recording = true; recChunks = []; recSamples = 0; recSr = ctx.sampleRate; recT = 0; recStep = -1;
  recAlarms = []; recBeeps = []; recStatus = []; recStartedAt = new Date();
  node.port.postMessage({ recording: true });
  els.recBtn.textContent = '録音を中止する';
  els.instruction.hidden = false;
});

function recordFrame(msg, s) {
  if (!msg.pcm) return;
  recChunks.push(msg.pcm);
  recSamples += msg.pcm.length;
  recT = recSamples / recSr;
  let acc = 0, step = PROTOCOL.length;
  for (let i = 0; i < PROTOCOL.length; i++) { if (recT < acc + PROTOCOL[i].dur) { step = i; break; } acc += PROTOCOL[i].dur; }
  if (step >= PROTOCOL.length) { finishRecording(false); return; }
  if (step !== recStep) {
    recStep = step;
    if (els.recBeep.checked) { beep(step === 0 ? 660 : 520, 0.12, 0.15); recBeeps.push(Number(recT.toFixed(2))); }
  }
  const remain = acc + PROTOCOL[step].dur - recT;
  els.instruction.innerHTML = `${PROTOCOL[step].text}<small>あと ${Math.ceil(remain)} 秒（全体で ${Math.round(recT)} / ${PROTOCOL_TOTAL} 秒）</small>`;
}

function finishRecording(aborted) {
  recording = false;
  node?.port.postMessage({ recording: false });
  els.recBtn.textContent = '検証用の録音を始める';
  els.instruction.hidden = true;
  if (aborted || recSamples === 0) return;
  const stamp = recStartedAt.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const name = `breath-rec-${stamp}`;
  download(encodeWav(recChunks, recSamples, recSr), name + '.wav');
  let acc = 0;
  const steps = PROTOCOL.map((p) => { const r = { kind: p.kind, start: acc, end: acc + p.dur }; acc += p.dur; return r; });
  const label = {
    app: 'breath-monitor', version: VERSION, recordedAt: recStartedAt.toISOString(), sampleRate: recSr,
    device: stream?.getAudioTracks()[0]?.label || '', userAgent: navigator.userAgent,
    settings: { ...DEFAULT_OPTIONS, ...monitorOptions() },
    steps, holds: steps.filter((s) => s.kind === 'hold').map((s) => [s.start, s.end]),
    beeps: recBeeps, onlineAlarms: recAlarms, onlineStatus: recStatus
  };
  download(new Blob([JSON.stringify(label, null, 2)], { type: 'application/json' }), name + '.json');
  els.instruction.hidden = false;
  els.instruction.innerHTML = `録音が終わりました<small>${name}.wav と ${name}.json を保存しました。この2つのファイルを評価に使います。</small>`;
}

function encodeWav(chunks, n, sr) {
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++) {
    const x = Math.max(-1, Math.min(1, c[i]));
    v.setInt16(o, Math.round(x * 32767), true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

listMics();
