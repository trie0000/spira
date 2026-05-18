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
  // Wrap the IIFE in `void(function(){ ... }())` so re-clicking the bookmark doesn't
  // pollute globals or cause "var redeclaration" issues — main.ts handles re-mount idempotency.
  const inlined = `void function(){${js}}()`;
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
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spira インストール</title>
<style>
  :root {
    --ink: #2a2a26; --ink-3: #7a766c; --ink-4: #a8a39a;
    --paper: #fafaf7; --paper-2: #f3f1ea; --paper-3: #e8e4d8;
    --line: rgba(42,42,38,0.12);
    --accent: #7a8a78; --accent-strong: #5e6f5c;
    --code-fg: #8b3a30; --code-bg: rgba(122,118,108,0.16);
    --font: "Meiryo","メイリオ","Hiragino Sans","Yu Gothic UI",-apple-system,"Segoe UI",system-ui,sans-serif;
    --font-mono: ui-monospace,"Cascadia Mono","Consolas",monospace;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--font); max-width: 580px; margin: 60px auto; padding: 0 24px; color: var(--ink); line-height: 1.75; background: var(--paper); }
  h1 { font-size: 28px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 12px; }
  h1::before { content: ""; width: 14px; height: 14px; border-radius: 50%; background: var(--accent); display: inline-block; }
  .sub { color: var(--ink-3); font-size: 14px; margin: 0 0 40px; }

  .step { display: flex; gap: 16px; margin-bottom: 28px; align-items: flex-start; }
  .step-num { width: 28px; height: 28px; background: var(--accent); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
  .step-body h3 { font-size: 16px; font-weight: 600; margin: 0 0 4px; color: var(--ink); }
  .step-body p { font-size: 14px; color: var(--ink-3); margin: 0; }

  .bm-wrap { background: var(--paper-2); border: 2px dashed var(--paper-3); border-radius: 8px; padding: 28px; text-align: center; margin: 20px 0 32px; }
  .bm-wrap p { font-size: 13px; color: var(--ink-3); margin: 0 0 16px; }
  #bm-link {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--accent); color: #fff; text-decoration: none;
    padding: 12px 24px; border-radius: 6px; font-size: 16px; font-weight: 600;
    box-shadow: 0 2px 8px rgba(122,138,120,.25); cursor: grab;
    user-select: none;
  }
  #bm-link:hover { background: var(--accent-strong); }
  #bm-link::before { content: "●"; color: #fff; font-size: 10px; opacity: .85; }

  hr { border: none; border-top: 1px solid var(--paper-3); margin: 32px 0; }
  .alt { font-size: 13px; color: var(--ink-3); }
  code { background: var(--code-bg); color: var(--code-fg); padding: 2px 6px; border-radius: 3px; font-size: 12px; font-family: var(--font-mono); }
  .note { background: rgba(196,127,28,0.10); border-left: 3px solid #c47f1c; padding: 12px 16px; border-radius: 4px; font-size: 13px; color: var(--ink); margin-top: 24px; }
</style>
</head>
<body>

<h1>Spira インストール</h1>
<p class="sub">SharePoint 上で動くメール起票型チケット管理 — bookmarklet 形式</p>

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
    <h3>下のいずれかの方法でブックマークに登録</h3>
    <p><strong>方法 A: ドラッグ</strong> — 小さいバンドル用 (ブラウザによっては失敗します)<br>
       <strong>方法 B: コピー & 手動登録</strong> — 確実 (推奨)</p>
  </div>
</div>

<div class="bm-wrap">
  <p>↓ ① まずはここをブックマークバーにドラッグしてみる ↓</p>
  <a id="bm-link" href="${bookmarkletHref}" onclick="alert('ドラッグしてブックマークバーに登録してください。クリックでは起動しません（このページは SharePoint ではないため）。'); return false;">Spira</a>
  <p style="margin-top:18px;font-size:12px">
    ドラッグできない場合は ↓ コピーして手動登録 (推奨)
  </p>
  <button id="copy-btn" type="button" style="margin-top:6px;background:var(--paper);color:var(--ink);border:1px solid var(--accent);padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">📋 ブックマークレットをコピー</button>
  <p id="copy-status" style="margin-top:8px;font-size:12px;color:var(--ink-3);min-height:1em"></p>
</div>

<details style="background:var(--paper-2);border:1px solid var(--paper-3);border-radius:6px;padding:14px 18px;margin:20px 0">
  <summary style="cursor:pointer;font-weight:600;color:var(--ink)">📋 手動でブックマーク登録する手順 (方法 B)</summary>
  <ol style="margin:12px 0 0;padding-left:20px;line-height:1.8;font-size:14px;color:var(--ink)">
    <li>上の「📋 ブックマークレットをコピー」ボタンを押す</li>
    <li>ブックマークバーの空きを<strong>右クリック</strong> → 「ブックマークを追加」(Chrome) / 「お気に入りの追加」(Edge)</li>
    <li>名前に <code>Spira</code> と入力</li>
    <li>URL 欄に <code>Ctrl+V</code> (Mac: <code>Cmd+V</code>) で貼り付け</li>
    <li>保存 → ブックマークバーに「Spira」が出れば完了</li>
  </ol>
</details>

<div class="step">
  <div class="step-num">3</div>
  <div class="step-body">
    <h3>SharePoint サイトを開いて、ブックマークをクリック</h3>
    <p>同一テナントの SP サイト上でブックマークを実行すると、Spira が起動します。<br>
       初回起動時は SharePoint リスト（Tickets / Comments / InboxMails）が自動作成されます。</p>
  </div>
</div>

<script>
(function(){
  var btn = document.getElementById('copy-btn');
  var status = document.getElementById('copy-status');
  var bmHref = document.getElementById('bm-link').getAttribute('href');
  if (!btn || !bmHref) return;
  btn.addEventListener('click', function(){
    var ok = function(){
      btn.textContent = '✓ コピーしました';
      status.textContent = 'ブックマークバーで右クリック → 新規ブックマーク追加 → URL 欄に貼り付け';
      status.style.color = 'var(--accent-strong)';
      setTimeout(function(){
        btn.textContent = '📋 ブックマークレットをコピー';
      }, 3000);
    };
    var fail = function(err){
      status.textContent = 'コピー失敗: ' + err + ' — 下のテキスト欄から手動でコピーしてください';
      status.style.color = '#c47f1c';
      // フォールバック: textarea を生成して表示
      var ta = document.createElement('textarea');
      ta.value = bmHref;
      ta.style.cssText = 'width:100%;height:120px;margin-top:10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;padding:8px;border:1px solid var(--paper-3);border-radius:4px';
      ta.readOnly = true;
      ta.onclick = function(){ ta.select(); };
      btn.parentElement.appendChild(ta);
      ta.focus(); ta.select();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(bmHref).then(ok).catch(function(e){ fail(e.message || e); });
    } else {
      // 古いブラウザ用 fallback
      var ta = document.createElement('textarea');
      ta.value = bmHref;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { fail(e.message); }
      document.body.removeChild(ta);
    }
  });
})();
</script>

<hr>

<p class="alt"><strong>更新方法</strong>: 新しいバージョンが出たら、このページを再度開いて再度ドラッグしてください（古いブックマークは上書き or 削除）。</p>

<div class="note">
  ⚠ <strong>SharePoint 上で実行する必要があります</strong>。Graph API・外部 SaaS・カスタムスクリプト無効環境でも動作するよう、SP REST API（同一オリジン認証）のみを使用しています。
</div>

</body>
</html>`;
}
