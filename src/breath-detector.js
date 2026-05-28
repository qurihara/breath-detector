/**
 * breath-detector
 * 呼吸状態をマイク入力から測定する依存ゼロの JavaScript ライブラリ。
 *
 * Web Audio API でマイク音声の振幅エンベロープを解析し、呼吸イベント・
 * 呼吸フェーズ(吸気/呼気/静止)・呼吸数(BPM)を推定する。
 *
 * @example
 *   import { BreathDetector } from './src/breath-detector.js';
 *   const d = new BreathDetector();
 *   d.on('breath', e => console.log('breath', e));
 *   d.on('data', e => console.log(e.rate, e.phase));
 *   await d.start();
 */

const DEFAULTS = {
  fftSize: 2048,        // AnalyserNode の FFT サイズ
  smoothing: 0.92,      // エンベロープ平滑化(EMA)係数 (0-1, 大きいほど滑らか)
  sensitivity: 1.0,     // しきい値の感度 (大きいほど検出しやすい)
  minBreathInterval: 1200, // ms: 呼吸イベントの最小間隔(デバウンス)
  idleThreshold: 0.004, // この振幅未満は無音(idle)とみなす
  rateWindow: 5         // BPM 算出に使う直近の呼吸間隔の数
};

/** 中央値を返す。空配列は 0。 */
function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class BreathDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this._listeners = new Map();

    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this._timeData = null;
    this._rafId = null;
    this.running = false;

    // 解析状態
    this._smoothed = 0;        // 平滑化済みエンベロープ
    this._prevSmoothed = 0;
    this._mean = 0;            // 振幅の移動平均(適応しきい値の基準)
    this._variance = 0;        // 振幅の移動分散
    this._phase = 'idle';
    this._lastBreathTime = 0;
    this._aboveThreshold = false;
    this._intervals = [];      // 直近の呼吸間隔(ms)
    this._breathCount = 0;
    this._startTime = 0;
  }

  /** イベント購読。 */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return this;
  }

  /** イベント購読解除。 */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
    return this;
  }

  _emit(event, payload) {
    this._listeners.get(event)?.forEach((h) => {
      try { h(payload); } catch (e) { console.error(e); }
    });
  }

  /**
   * マイクを取得して解析を開始する。マイク許可ダイアログが出る。
   * @param {MediaStream} [existingStream] 既存のストリームを使う場合に指定。
   */
  async start(existingStream) {
    if (this.running) return;

    this.stream = existingStream || await navigator.mediaDevices.getUserMedia({
      audio: {
        // 呼吸音が消されないよう音声処理を無効化する。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.options.fftSize;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);

    this._timeData = new Float32Array(this.analyser.fftSize);

    // 状態リセット
    this._smoothed = 0;
    this._prevSmoothed = 0;
    this._mean = 0;
    this._variance = 0;
    this._phase = 'idle';
    this._lastBreathTime = 0;
    this._aboveThreshold = false;
    this._intervals = [];
    this._breathCount = 0;
    this._startTime = performance.now();
    this.running = true;

    this._emit('start', { timestamp: this._startTime });
    this._loop();
  }

  /** 解析を停止しリソースを解放する。 */
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close();
    this.audioContext = null;
    this._emit('stop', { timestamp: performance.now() });
  }

  /** 現在の推定呼吸数 (breaths per minute)。 */
  getRate() {
    const m = median(this._intervals);
    return m > 0 ? Math.round((60000 / m) * 10) / 10 : 0;
  }

  /** 現在の状態スナップショット。 */
  getState() {
    return {
      phase: this._phase,
      rate: this.getRate(),
      amplitude: this._smoothed,
      breathCount: this._breathCount,
      running: this.running
    };
  }

  _loop() {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(() => this._loop());
    this._analyzeFrame();
  }

  _analyzeFrame() {
    const analyser = this.analyser;
    // 時間領域データから RMS 振幅(呼吸エンベロープ)を算出。
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(this._timeData);
    } else {
      // 古いブラウザ向けフォールバック
      const bytes = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(bytes);
      for (let i = 0; i < bytes.length; i++) this._timeData[i] = (bytes[i] - 128) / 128;
    }

    let sumSq = 0;
    for (let i = 0; i < this._timeData.length; i++) {
      const v = this._timeData[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this._timeData.length);

    // 指数移動平均で平滑化(呼吸の遅い波だけを残す)。
    const a = this.options.smoothing;
    this._prevSmoothed = this._smoothed;
    this._smoothed = a * this._smoothed + (1 - a) * rms;

    // 適応しきい値の基準となる移動平均・分散を更新。
    const ma = 0.99;
    const diff = this._smoothed - this._mean;
    this._mean = ma * this._mean + (1 - ma) * this._smoothed;
    this._variance = ma * this._variance + (1 - ma) * diff * diff;
    const std = Math.sqrt(this._variance);

    const now = performance.now();
    const idle = this._smoothed < this.options.idleThreshold;

    // フェーズ判定: エンベロープの傾き。
    const slope = this._smoothed - this._prevSmoothed;
    let phase;
    if (idle) {
      phase = 'idle';
    } else if (slope > std * 0.05) {
      phase = 'inhale';
    } else if (slope < -std * 0.05) {
      phase = 'exhale';
    } else {
      phase = 'hold';
    }
    if (phase !== this._phase) {
      this._phase = phase;
      this._emit('phase', { phase, timestamp: now });
    }

    // 呼吸イベント検出: 適応しきい値を上向きに横切った瞬間。
    const threshold = this._mean + std * (1.0 / this.options.sensitivity);
    if (!idle && this._smoothed > threshold) {
      if (!this._aboveThreshold) {
        this._aboveThreshold = true;
        if (now - this._lastBreathTime >= this.options.minBreathInterval) {
          if (this._lastBreathTime > 0) {
            this._intervals.push(now - this._lastBreathTime);
            if (this._intervals.length > this.options.rateWindow) this._intervals.shift();
          }
          this._lastBreathTime = now;
          this._breathCount++;
          this._emit('breath', {
            timestamp: now,
            amplitude: this._smoothed,
            count: this._breathCount
          });
        }
      }
    } else if (this._smoothed < this._mean) {
      this._aboveThreshold = false;
    }

    this._emit('data', {
      timestamp: now,
      amplitude: rms,
      smoothed: this._smoothed,
      threshold,
      phase: this._phase,
      rate: this.getRate(),
      breathCount: this._breathCount
    });
  }
}

export default BreathDetector;
