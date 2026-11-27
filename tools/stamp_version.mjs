// monitor/version.js のバージョンを、monitor/ の中でファイルを読み込むすべての箇所に「?v=バージョン」として書き込む。
//   node tools/stamp_version.mjs          書き込む
//   node tools/stamp_version.mjs --check  書き込み漏れがあれば失敗する（送信の前の確認用）
//
// 公開先の unryu.org は JavaScript のファイルをブラウザに4時間保存させるので、
// URL を変えないと、新しいバージョンを公開しても古いファイルが使われ続ける。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'monitor');
const versionSrc = fs.readFileSync(path.join(root, 'version.js'), 'utf8');
const m = versionSrc.match(/VERSION\s*=\s*'([^']+)'/);
if (!m) throw new Error('monitor/version.js にバージョンが見つからない');
const V = m[1];
const check = process.argv.includes('--check');

let stale = 0;
for (const name of fs.readdirSync(root)) {
  const p = path.join(root, name);
  const src = fs.readFileSync(p, 'utf8');
  let out = src;
  if (name.endsWith('.js')) {
    // import 文、import()、new URL() の中の './名前.js' を書き換える
    out = src.replace(/(['"])(\.\/[\w-]+\.js)(\?v=[^'"]*)?\1/g, (_, q, f) => `${q}${f}?v=${V}${q}`);
  } else if (name.endsWith('.html')) {
    out = src.replace(/\b(src|href)="((?:\.\/)?[\w-]+\.(?:js|css))(\?v=[^"]*)?"/g, (_, attr, f) => `${attr}="${f}?v=${V}"`);
  } else {
    continue;
  }
  if (out !== src) {
    stale++;
    if (check) console.log(`書き込み漏れ: monitor/${name}`);
    else { fs.writeFileSync(p, out); console.log(`書き込んだ: monitor/${name}`); }
  }
}
if (check && stale > 0) { console.log(`node tools/stamp_version.mjs を実行してください（バージョン ${V}）`); process.exit(1); }
if (!check) console.log(`バージョン ${V} を書き込んだ（${stale} 個のファイル）`);
