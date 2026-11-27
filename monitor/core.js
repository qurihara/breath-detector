// 呼吸の継続を判定する中核。音声には触れず、帯域ごとの音量 (dB) の列だけを受け取る。
// ブラウザと Node の評価用の道具の両方から読み込む。
//
// 判定の原理:
//   マイクを鼻の穴の直下に置くと、呼吸している間は気流の雑音が繰り返し出る。
//   静かなときの音量（ノイズフロア）を直近の音量の下位の百分位数で推定し、
//   それより marginDb 以上大きい状態を「呼吸音あり」とする。
//   「呼吸音あり」が途切れてからの時間が apneaSec を超えたら警報を出す。
//   shallowMode では、直近 ratioWindowSec 秒のうち「呼吸音あり」だった割合が
//   shallowRatio を下回ったときも「呼吸が浅い」として知らせる。

import { BANDS } from './features.js';

export const DEFAULT_OPTIONS = {
  apneaSec: 10,        // 呼吸音が途切れてから警報を出すまでの秒数
  warnSec: 6,          // 呼吸音が途切れてから注意を出すまでの秒数
  marginDb: 6,         // ノイズフロアより何 dB 大きければ「呼吸音あり」とするか
  releaseRatio: 0.5,   // 「呼吸音あり」を解除する閾値（marginDb に掛ける割合）
  minActiveSec: 0.15,  // この秒数以上続いた音だけを呼吸音として数える
  smoothSec: 0.08,     // 音量の平滑化の時定数
  floorWindowSec: 60,  // ノイズフロアを推定する窓の長さ
  floorPercentile: 0.05, // ノイズフロアに使う百分位数
  warmupSec: 8,        // 開始から判定を始めるまでの秒数
  band: 'auto',        // 'auto' または BANDS の id
  autoWindowSec: 30,   // 帯域を自動で選ぶときに見る窓の長さ
  autoHysteresisDb: 3, // 帯域を切り替えるのに必要な差
  shallowMode: false,  // true にすると、浅い呼吸も「呼吸不足」として知らせる
  ratioWindowSec: 30,  // 「呼吸音あり」の割合を求める窓の長さ
  shallowRatio: 0.4    // 割合がこれを下回ったら「呼吸が浅い」とする
};

const HIST_STEP = 0.1; // 履歴を保存する間隔（秒）
const DIGITAL_SILENCE_DB = -100; // これより小さい音量は、マイクの入力が完全な無音のときにしか出ない

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

export class BreathMonitor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reset();
  }

  reset() {
    const nb = BANDS.length;
    this.t = 0;
    this.smoothed = new Float64Array(nb).fill(NaN);
    this.hist = BANDS.map(() => []);     // 帯域ごとの音量の履歴（HIST_STEP 秒ごと）
    this.nextHistT = 0;
    this.floor = new Float64Array(nb).fill(NaN);
    this.depth = new Float64Array(nb).fill(0);
    this.nextStatT = 0;
    this.bandIndex = BANDS.findIndex((b) => b.id === 'all');
    this.active = false;       // 閾値を超えている（平滑化後の音量で判定）
    this.activeSince = null;   // 閾値を超え始めた時刻
    this.breathing = false;    // minActiveSec 以上続いた「呼吸音あり」
    this.lastBreathT = null;   // 最後に「呼吸音あり」だった時刻
    this.burstCount = 0;       // 「呼吸音あり」の区間の数
    this.activeLog = [];       // 直近 ratioWindowSec 秒の「呼吸音あり」の割合を出すための記録
    this._activeSum = 0;
    this._logDur = 0;
    this.status = 'warmup';
  }

  get band() { return BANDS[this.bandIndex]; }

  /**
   * 1 フレーム分の帯域ごとの音量 (dB) を与えて状態を進める。
   * @param {ArrayLike<number>} bandDb BANDS と同じ並びの音量
   * @param {number} dt このフレームの長さ（秒）
   * @param {boolean} suppress 警報の音を鳴らしている間は true にする。
   *   イヤホンの音をマイクが拾って呼吸音と取り違えないよう、そのフレームを判定に使わない。
   */
  push(bandDb, dt, suppress = false) {
    const o = this.options;
    this.t += dt;
    // マイクが動き出す前などの完全な無音（数値がすべて 0）は、静かなときの音量の推定を狂わせるので使わない。
    let maxDb = -Infinity;
    for (let j = 0; j < bandDb.length; j++) maxDb = Math.max(maxDb, bandDb[j]);
    if (maxDb < DIGITAL_SILENCE_DB) suppress = true;
    if (suppress) {
      this.active = false;
      this.activeSince = null;
      this.breathing = false;
      this._updateStatus();
      return this.getState();
    }
    const a = Math.exp(-dt / o.smoothSec);
    for (let j = 0; j < bandDb.length; j++) {
      const v = bandDb[j];
      this.smoothed[j] = Number.isNaN(this.smoothed[j]) ? v : a * this.smoothed[j] + (1 - a) * v;
    }

    if (this.t >= this.nextHistT) {
      this.nextHistT += HIST_STEP;
      const maxLen = Math.round(Math.max(o.floorWindowSec, o.autoWindowSec) / HIST_STEP);
      for (let j = 0; j < bandDb.length; j++) {
        const h = this.hist[j];
        h.push(this.smoothed[j]);
        if (h.length > maxLen) h.shift();
      }
    }

    if (this.t >= this.nextStatT) {
      this.nextStatT += 0.5;
      this._updateStats();
    }

    const j = this.bandIndex;
    const level = this.smoothed[j];
    const floor = this.floor[j];
    const onTh = floor + o.marginDb;
    const offTh = floor + o.marginDb * o.releaseRatio;

    if (!Number.isNaN(floor)) {
      if (!this.active && level > onTh) {
        this.active = true;
        this.activeSince = this.t;
      } else if (this.active && level < offTh) {
        this.active = false;
        this.activeSince = null;
        this.breathing = false;
      }
    }
    if (this.active && this.t - this.activeSince >= o.minActiveSec) {
      if (!this.breathing) this.burstCount++;
      this.breathing = true;
    }
    if (this.breathing) this.lastBreathT = this.t;

    const on = this.breathing ? dt : 0;
    this.activeLog.push([dt, on]);
    this._activeSum += on;
    this._logDur += dt;
    while (this._logDur > o.ratioWindowSec && this.activeLog.length > 1) {
      const [d, x] = this.activeLog.shift();
      this._activeSum -= x;
      this._logDur -= d;
    }

    this._updateStatus();
    return this.getState();
  }

  _updateStatus() {
    const o = this.options;
    const silence = this.silenceSec;
    if (this.t < o.warmupSec || Number.isNaN(this.floor[this.bandIndex])) this.status = 'warmup';
    else if (silence >= o.apneaSec) this.status = 'alarm';
    else if (silence >= o.warnSec) this.status = 'warn';
    else if (this.isShallow) this.status = 'shallow';
    else this.status = 'ok';
  }

  // 呼吸音が途切れてからの秒数。開始直後は開始からの秒数を使う。
  get silenceSec() {
    return this.lastBreathT === null ? this.t : this.t - this.lastBreathT;
  }

  get activeRatio() {
    return this._logDur ? this._activeSum / this._logDur : 0;
  }

  // 浅い呼吸の判定。窓が埋まるまで（開始から ratioWindowSec 秒）は判定しない。
  get isShallow() {
    const o = this.options;
    return o.shallowMode && this._logDur >= o.ratioWindowSec * 0.95 && this.activeRatio < o.shallowRatio;
  }

  _updateStats() {
    const o = this.options;
    const nFloor = Math.round(o.floorWindowSec / HIST_STEP);
    const nAuto = Math.round(o.autoWindowSec / HIST_STEP);
    for (let j = 0; j < this.hist.length; j++) {
      const h = this.hist[j];
      if (h.length < 10) continue;
      const fl = h.slice(-nFloor).sort((x, y) => x - y);
      this.floor[j] = percentile(fl, o.floorPercentile);
      const au = h.slice(-nAuto).sort((x, y) => x - y);
      this.depth[j] = percentile(au, 0.9) - percentile(au, 0.1);
    }
    if (o.band === 'auto') {
      let best = this.bandIndex;
      for (let j = 0; j < this.depth.length; j++) {
        if (this.depth[j] > this.depth[best]) best = j;
      }
      if (best !== this.bandIndex && this.depth[best] - this.depth[this.bandIndex] >= o.autoHysteresisDb) {
        this.bandIndex = best;
      }
    } else {
      const k = BANDS.findIndex((b) => b.id === o.band);
      if (k >= 0) this.bandIndex = k;
    }
  }

  getState() {
    const j = this.bandIndex;
    return {
      t: this.t,
      status: this.status,
      silenceSec: this.silenceSec,
      breathing: this.breathing,
      level: this.smoothed[j],
      floor: this.floor[j],
      threshold: this.floor[j] + this.options.marginDb,
      depth: this.depth[j],
      band: BANDS[j],
      burstCount: this.burstCount,
      activeRatio: this.activeRatio
    };
  }
}
