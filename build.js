// Spira build script — esbuild + dev server + bookmarklet generator
import * as esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');
const makeBookmarklet = process.argv.includes('--bookmarklet');
const prod = process.argv.includes('--prod') || makeBookmarklet;

// Build identity — baked in at compile time so the running bundle can show
// "which build is this" in the settings menu. Cache-confusion is the #1
// source of "なにも変わってない" reports.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let gitSha = 'nogit';
let gitDirty = '';
try {
  gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
  const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
  if (dirty) gitDirty = '+';
} catch { /* not a git repo or git missing */ }
const buildTime = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const buildId = `${pkg.version}-${gitSha}${gitDirty} (${buildTime})`;
console.log(`[build] id: ${buildId}`);

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Spira',
  outfile: 'dist/spira.js',
  target: 'es2020',
  platform: 'browser',
  minify: prod,
  sourcemap: !prod,
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
    __SPIRA_BUILD_ID__: JSON.stringify(buildId),
    __SPIRA_BUILD_TIME__: JSON.stringify(buildTime),
    __SPIRA_BUILD_SHA__: JSON.stringify(gitSha + gitDirty),
    __SPIRA_VERSION__: JSON.stringify(pkg.version),
  },
  // Node 専用モジュールをブラウザ向け空スタブに差し替え。
  // @kenjiuno/msgreader が iconv-lite (→ safer-buffer → buffer +
  // string_decoder) を持ち込むが、現代の Unicode .msg ではこれらを実呼び
  // しないため空実装で良い。
  alias: {
    'iconv-lite':     path.resolve('src/lib/_browser-shims.ts'),
    'safer-buffer':   path.resolve('src/lib/_browser-shims.ts'),
    'buffer':         path.resolve('src/lib/_browser-shims.ts'),
    'string_decoder': path.resolve('src/lib/_browser-shims.ts'),
  },
  logLevel: 'info',
};

if (watch || serve) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[esbuild] watching...');

  if (serve) {
    const port = 5176;
    http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url === '/') url = '/dev/index.html';
      const filePath = path.join(process.cwd(), url);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const ext = path.extname(filePath);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js':   'application/javascript; charset=utf-8',
        '.css':  'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.map':  'application/json; charset=utf-8'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
    }).listen(port, () => console.log(`[dev] http://localhost:${port}/`));
  }
} else {
  await esbuild.build(buildOptions);
  console.log('[esbuild] build complete');

  // Single-file HTML output: upload to SharePoint document library and open directly.
  // CSS is already inlined into the JS bundle (esbuild loader: '.css': 'text' + main.ts injects <style>).
  const js = fs.readFileSync('dist/spira.js', 'utf8');
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spira</title>
<style>html,body{margin:0;padding:0;background:#fafaf7}</style>
</head>
<body>
<script>${js}
</script>
</body>
</html>`;
  fs.writeFileSync('dist/index.html', html);
  const sizeKb = (s) => (fs.statSync(s).size / 1024).toFixed(1);
  console.log(`[html] dist/index.html: ${sizeKb('dist/index.html')} KB`);

  // install.html: drag-to-bookmark installer with the entire minified bundle inlined.
  // Wrap the IIFE in `void(function(){ ... })()` — n365 (shapion) と同じ
  // 括弧付きパターン。`void function(){...}()` だと URL に %20 (空白) が
  // 入って Edge の bookmarklet 判定ヒューリスティクスを通らない疑いあり。
  // 機能的には等価だが、URL 形を n365 と完全一致させてドラッグ受け付けを
  // 安定化する。
  const inlined = `void(function(){${js}})()`;
  const bookmarkletHref = 'javascript:' + encodeURIComponent(inlined);
  const installHtml = renderInstallHtml(bookmarkletHref);
  fs.writeFileSync('dist/install.html', installHtml);
  console.log(`[install] dist/install.html: ${sizeKb('dist/install.html')} KB (bookmarklet inlined)`);

  if (makeBookmarklet) {
    const url = process.env.SPIRA_BUNDLE_URL || '__SPIRA_BUNDLE_URL__';
    // loader: removes any prior <script id="spira-script"> then injects the bundle.
    // cache-bust with timestamp so reloads always pull the latest hosted bundle.
    const loader =
      `(function(){var d=document,o=d.getElementById('spira-script');if(o)o.remove();` +
      `var s=d.createElement('script');s.id='spira-script';` +
      `s.src=${JSON.stringify(url)}+'?v='+Date.now();` +
      `d.body.appendChild(s);})();`;

    fs.writeFileSync('dist/spira.loader.js', loader);
    fs.writeFileSync('dist/bookmarklet.txt', 'javascript:' + encodeURIComponent(loader));

    const sizeKb = (s) => (fs.statSync(s).size / 1024).toFixed(1);
    console.log(`[bookmarklet] dist/spira.js (minified): ${sizeKb('dist/spira.js')} KB`);
    console.log(`[bookmarklet] dist/spira.loader.js:    ${sizeKb('dist/spira.loader.js')} KB`);
    console.log(`[bookmarklet] dist/bookmarklet.txt:    ${sizeKb('dist/bookmarklet.txt')} KB`);
    console.log('');
    console.log('  ▶ ホスト先 URL を SPIRA_BUNDLE_URL 環境変数で指定してください。');
    console.log('    例: SPIRA_BUNDLE_URL="https://contoso.sharepoint.com/sites/spira/SiteAssets/spira.js" node build.js --bookmarklet');
    if (url === '__SPIRA_BUNDLE_URL__') {
      console.log('  ⚠ 現在は __SPIRA_BUNDLE_URL__ プレースホルダのままです。dist/bookmarklet.txt を実 URL に置換して使ってください。');
    } else {
      console.log(`  ✔ Bundle URL: ${url}`);
    }
  }
}

function renderInstallHtml(bookmarkletHref) {
  // n365 (shapion) の install.html を踏襲。Edge の drag-to-bookmark が
  // 正しく動くことを保証するため、構造・属性・スタイルを最小限にする。
  // 重要:
  //   - <a> に `draggable` 属性を明示しない (デフォルトで true)
  //   - <a> に onclick / その他のハンドラを付けない
  //   - <a> の周囲にコピー ボタンなど別 UI を入れない (.bm-wrap の中身は
  //     <p> + <a> のみ)
  //   - CSS は最小限。`user-select` / `::before` 疑似要素は付けない
  //   - 「コピー して手動登録」用には別途 <textarea readonly> を別ブロックに置く
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>Spira インストール</title>
<style>
body { font-family: "Meiryo","メイリオ","Hiragino Sans","Yu Gothic UI",-apple-system,"Segoe UI",system-ui,sans-serif; max-width: 580px; margin: 60px auto; padding: 0 24px; color: #2a2a26; line-height: 1.75; background: #fafaf7; }
h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.01em; }
.sub { color: #7a766c; font-size: 14px; margin-bottom: 40px; }
.step { display: flex; gap: 16px; margin-bottom: 28px; align-items: flex-start; }
.step-num { width: 28px; height: 28px; background: #7a8a78; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
.step-body h3 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.step-body p { font-size: 14px; color: #7a766c; margin: 0; }
.bm-wrap { background: #f3f1ea; border: 2px dashed #d6d0c0; border-radius: 8px; padding: 28px; text-align: center; margin: 20px 0 32px; }
.bm-wrap p { font-size: 13px; color: #7a766c; margin: 0 0 16px; }
#bm-link { display: inline-flex; align-items: center; gap: 8px; background: #7a8a78; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 2px 8px rgba(122,138,120,.25); cursor: grab; }
#bm-link:hover { background: #5e6f5c; }
hr { border: none; border-top: 1px solid #e8e4d8; margin: 32px 0; }
.alt { font-size: 13px; color: #7a766c; }
code { background: rgba(122, 118, 108, 0.16); color: #8b3a30; padding: 2px 6px; border-radius: 3px; font-size: 12px; font-family: "Cascadia Mono","SFMono-Regular", Menlo, Consolas, monospace; }
#copy-area { width: 100%; height: 100px; font-size: 11px; font-family: "Cascadia Mono","SFMono-Regular", Menlo, Consolas, monospace; border: 1px solid #e8e4d8; border-radius: 4px; padding: 8px; resize: none; word-break: break-all; margin-top: 8px; cursor: pointer; display: block; background: #fafaf7; color: #2a2a26; box-sizing: border-box; }
.note { background: rgba(196,127,28,0.10); border-left: 3px solid #c47f1c; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: #2a2a26; margin-top: 24px; }
</style>
</head>
<body>

<h1>Spira インストール</h1>
<p class="sub">SharePoint 上で動くメール起票型チケット管理 — bookmarklet 形式</p>

<div id="file-warn" style="display:none;background:#fef3c7;border:1px solid #f59e0b;color:#78350f;border-radius:6px;padding:14px 18px;margin:20px 0;font-size:13px;line-height:1.7">
  ⚠ <strong>このページは <code>file://</code> から開かれています</strong>。Edge / Chrome は
  <code>file://</code> オリジンからの <code>javascript:</code> bookmarklet のドラッグ登録を
  セキュリティ上拒否します (ドラッグすると禁止アイコン ⊘ が出る)。
  <br><br>
  対処は以下のいずれか:
  <ul style="margin:6px 0 0;padding-left:20px">
    <li><strong>SharePoint にアップロード</strong>して <code>https://</code> で開き直す (推奨)</li>
    <li>ローカル HTTP サーバで開く: <code>python -m http.server 8000</code> → <code>http://localhost:8000/install.html</code></li>
    <li>このページ下の <strong>「ドラッグできない場合」</strong>欄からテキストをコピーして手動でブックマーク追加 (file:// でも OK)</li>
  </ul>
</div>

<script>
  // file:// で開かれているときだけ警告バナーを表示。
  if (location.protocol === 'file:') {
    document.getElementById('file-warn').style.display = '';
  }
</script>

<div class="step">
  <div class="step-num">1</div>
  <div class="step-body">
    <h3>ブックマークバーを表示する</h3>
    <p>Chrome / Edge: <code>Ctrl+Shift+B</code>（Mac: <code>Cmd+Shift+B</code>）</p>
  </div>
</div>

<div class="step">
  <div class="step-num">2</div>
  <div class="step-body">
    <h3>下のボタンをブックマークバーにドラッグ</h3>
    <p>右クリック → 「リンクをブックマーク」 でも OK です。</p>
  </div>
</div>

<div class="bm-wrap">
  <p>↓ このボタンをブックマークバーにドラッグ ↓</p>
  <a id="bm-link" href="${bookmarkletHref}">Spira</a>
</div>

<div class="step">
  <div class="step-num">3</div>
  <div class="step-body">
    <h3>SharePoint サイトを開いて、ブックマークをクリック</h3>
    <p>同一テナントの SP サイト上でブックマークを実行すると、Spira が起動します。<br>
       初回起動時は SharePoint リスト（Tickets / Comments / InboxMails）が自動作成されます。</p>
  </div>
</div>

<hr>
<p class="alt">ドラッグできない場合 — 下のテキスト欄をクリックして全選択 → <code>Ctrl+C</code> でコピー後、ブックマークバーで右クリック → 「ブックマークを追加」→ URL 欄に貼り付けてください：</p>
<textarea id="copy-area" readonly onclick="this.select()">${bookmarkletHref}</textarea>

<div class="note">
  ⚠ <strong>SharePoint 上で実行する必要があります</strong>。Graph API・外部 SaaS・カスタムスクリプト無効環境でも動作するよう、SP REST API（同一オリジン認証）のみを使用しています。
</div>

</body>
</html>`;
}
