# breath-detector

呼吸状態をマイク入力から測定する、依存ゼロの JavaScript ライブラリです。
ブラウザの Web Audio API でマイク音声の振幅エンベロープを解析し、**呼吸イベント**・
**呼吸フェーズ（吸気 / 呼気 / 静止）**・**呼吸数（回/分, BPM）** を推定します。

🔗 **デモ: https://qurihara.github.io/breath-detector/**

## 特徴

- 依存パッケージなし・ビルド不要の単一 ES モジュール
- マイクのみで動作（追加ハードウェア不要、全デバイス対応）
- リアルタイムのイベント（`breath` / `phase` / `data`）
- 呼吸数（BPM）と呼吸フェーズの推定

## 仕組み

1. `getUserMedia` でマイク音声を取得（呼吸音が消えないよう音声処理を無効化）。
2. `AnalyserNode` で時間領域データから RMS 振幅（呼吸エンベロープ）を毎フレーム算出。
3. 指数移動平均で平滑化し、呼吸の遅い波だけを抽出。
4. 適応しきい値（移動平均 ± 標準偏差）でピークを検出して 1 呼吸とみなす。
5. ピーク間隔の中央値から BPM を、エンベロープの傾きからフェーズを推定。

## 使い方

```html
<script type="module">
  import { BreathDetector } from './src/breath-detector.js';

  const detector = new BreathDetector();

  detector.on('breath', (e) => console.log('呼吸検出', e));      // {timestamp, amplitude, count}
  detector.on('phase',  (e) => console.log('フェーズ', e.phase)); // 'inhale'|'exhale'|'hold'|'idle'
  detector.on('data',   (e) => console.log(e.rate, e.phase));    // 毎フレーム

  document.querySelector('#start').onclick = () => detector.start(); // マイク許可が必要
</script>
```

## API

### `new BreathDetector(options)`

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `fftSize` | `2048` | AnalyserNode の FFT サイズ |
| `smoothing` | `0.92` | エンベロープ平滑化係数 (0–1, 大きいほど滑らか) |
| `sensitivity` | `1.0` | 検出感度 (大きいほど検出しやすい) |
| `minBreathInterval` | `1200` | 呼吸イベントの最小間隔 (ms) |
| `idleThreshold` | `0.004` | この振幅未満は静止 (idle) とみなす |
| `rateWindow` | `5` | BPM 算出に使う直近の呼吸間隔の数 |
| `deviceId` | `null` | 使用するマイクの deviceId（null で既定マイク） |

### メソッド / イベント

- `await start(existingStream?)` — マイクを取得し解析開始（許可ダイアログ）
- `stop()` — 停止しリソース解放
- `await listDevices()` — 利用可能なマイク一覧（`MediaDeviceInfo[]`）
- `await setDevice(deviceId)` — 使用マイクを切替（解析中なら自動で再起動）
- `getRate()` — 現在の推定呼吸数（BPM）
- `getState()` — `{ phase, rate, amplitude, breathCount, running }`
- `on(event, handler)` / `off(event, handler)`
- イベント: `start` / `stop` / `breath` / `phase` / `data`

> マイクを複数持つ環境では `listDevices()` で列挙し、`new BreathDetector({ deviceId })`
> または `setDevice(deviceId)` で選択できます。デバイス名(`label`)はマイク許可付与後に
> 取得できます。`listInputDevices()` も名前付きエクスポートとして利用可能です。

## ローカルで試す

マイク取得には HTTPS か `localhost` が必要です。

```bash
npm run demo   # python3 -m http.server 8080
# http://localhost:8080 を開く
```

## ライセンス

MIT
