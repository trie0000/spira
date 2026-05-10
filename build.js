// Spira build script — esbuild + dev server
// Output: dist/spira.js (single bundle, IIFE) + dist/spira.css
import * as esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Spira',
  outfile: 'dist/spira.js',
  target: 'es2020',
  sourcemap: true,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info'
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
}
