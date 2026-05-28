import { BreathDetector, listInputDevices } from './src/breath-detector.js';

const els = {
  toggle: document.getElementById('toggle'),
  micSelect: document.getElementById('micSelect'),
  bpm: document.getElementById('bpm'),
  count: document.getElementById('count'),
  phaseStat: document.getElementById('phaseStat'),
  phaseLabel: document.getElementById('phaseLabel'),
  phaseCircle: document.getElementById('phaseCircle'),
  sensitivity: document.getElementById('sensitivity'),
  sensVal: document.getElementById('sensVal'),
  status: document.getElementById('status'),
  canvas: document.getElementById('wave')
};

const ctx = els.canvas.getContext('2d');
const detector = new BreathDetector();

// 波形描画用のリングバッファ
const HISTORY = 240;
const history = new Array(HISTORY).fill(0);
const threshHistory = new Array(HISTORY).fill(0);
let maxSeen = 0.02;

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  els.canvas.width = w * ratio;
  els.canvas.height = h * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

function draw() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const scale = (v) => h - (v / maxSeen) * h * 0.9 - 4;

  // しきい値ライン
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < HISTORY; i++) {
    const x = (i / (HISTORY - 1)) * w;
    const y = scale(threshHistory[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // エンベロープ波形
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#4fd1c5');
  grad.addColorStop(1, '#6366f1');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i < HISTORY; i++) {
    const x = (i / (HISTORY - 1)) * w;
    const y = scale(history[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

detector.on('data', (e) => {
  history.push(e.smoothed);
  history.shift();
  threshHistory.push(e.threshold);
  threshHistory.shift();
  maxSeen = Math.max(maxSeen * 0.995, e.smoothed, e.threshold, 0.02);

  els.bpm.textContent = e.rate > 0 ? e.rate.toFixed(1) : '--';
  els.count.textContent = e.breathCount;
  els.phaseStat.textContent = e.phase;
  els.phaseLabel.textContent = e.phase;

  els.phaseCircle.className = 'phase-circle ' + e.phase;
  const norm = Math.min(e.smoothed / maxSeen, 1);
  els.phaseCircle.style.transform = `scale(${1 + norm * 0.6})`;

  draw();
});

detector.on('breath', () => {
  els.phaseCircle.animate(
    [{ filter: 'brightness(1.8)' }, { filter: 'brightness(1)' }],
    { duration: 300 }
  );
});

els.sensitivity.addEventListener('input', () => {
  const v = parseFloat(els.sensitivity.value);
  detector.options.sensitivity = v;
  els.sensVal.textContent = v.toFixed(1);
});

// 利用可能なマイクを列挙してドロップダウンに反映する。
// label は許可付与後にしか取得できないため、開始後に再列挙する。
async function populateMics() {
  try {
    const devices = await listInputDevices();
    const current = els.micSelect.value;
    els.micSelect.innerHTML = '';
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `マイク ${i + 1}`;
      els.micSelect.appendChild(opt);
    });
    if (current) els.micSelect.value = current;
    els.micSelect.disabled = devices.length <= 1;
  } catch (_) { /* 許可前は列挙に失敗することがある */ }
}

els.micSelect.addEventListener('change', async () => {
  await detector.setDevice(els.micSelect.value || null);
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', populateMics);
}

async function start() {
  try {
    els.status.textContent = '';
    detector.options.deviceId = els.micSelect.value || null;
    await detector.start();
    els.toggle.textContent = '測定を停止';
    els.toggle.classList.add('running');
    // 許可付与後はマイク名が取得できるので一覧を更新する。
    await populateMics();
  } catch (err) {
    els.status.textContent = 'マイクにアクセスできませんでした: ' + err.message;
  }
}

function stop() {
  detector.stop();
  els.toggle.textContent = '測定を開始';
  els.toggle.classList.remove('running');
  els.phaseCircle.style.transform = 'scale(1)';
  els.phaseCircle.className = 'phase-circle idle';
  els.phaseLabel.textContent = 'idle';
}

els.toggle.addEventListener('click', () => {
  detector.running ? stop() : start();
});

resizeCanvas();
draw();
populateMics();
