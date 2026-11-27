// AudioWorklet の処理。音声のスレッドで動くので、タブが裏に回っても止まらない。
// 1024 サンプルごとに周波数帯ごとの音量を求めて送る。録音中は生の音声も送る。
import { createBandAnalyzer, FRAME_SIZE } from './features.js?v=0.3.0';

class BandLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.analyze = createBandAnalyzer(sampleRate, FRAME_SIZE);
    this.buf = new Float32Array(FRAME_SIZE);
    this.pos = 0;
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.recording === 'boolean') this.recording = e.data.recording;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.pos++] = ch[i];
      if (this.pos === FRAME_SIZE) {
        const bands = Float64Array.from(this.analyze(this.buf));
        const msg = { bands, dt: FRAME_SIZE / sampleRate, time: currentTime };
        if (this.recording) msg.pcm = this.buf.slice();
        this.port.postMessage(msg);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('band-level', BandLevelProcessor);
