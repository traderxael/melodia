import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = 5199;
const child = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', d => (out += d));
child.stderr.on('data', d => (out += d));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'ok  ' : 'FALLO'} ${name}${extra ? '  ' + extra : ''}`);
};

try {
  for (let i = 0; i < 40 && !out.includes('escuchando'); i++) await sleep(100);
  if (!out.includes('escuchando')) throw new Error('el servidor no arranco:\n' + out);

  const base = `http://127.0.0.1:${PORT}`;
  const assets = [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/css/style.css', 'text/css'],
    ['/js/app.js', 'text/javascript'],
    ['/js/db.js', 'text/javascript'],
    ['/js/player.js', 'text/javascript'],
    ['/js/library.js', 'text/javascript'],
    ['/js/tags.js', 'text/javascript'],
    ['/sw.js', 'text/javascript'],
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/icons/icon.svg', 'image/svg+xml'],
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-512-maskable.png', 'image/png'],
  ];

  for (const [path, type] of assets) {
    const res = await fetch(base + path);
    const ct = res.headers.get('content-type') || '';
    check(`GET ${path}`, res.status === 200 && ct.includes(type), `${res.status} ${ct}`);
  }

  const html = await (await fetch(base + '/')).text();
  const scriptSrc = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  const cssHref = html.match(/<link[^>]+stylesheet"[^>]*href="([^"]+)"/)?.[1] || html.match(/href="(\.\/css[^"]+)"/)?.[1];
  check('index.html referencia un modulo', !!scriptSrc, scriptSrc || 'no encontrado');
  check('index.html referencia el css', !!cssHref, cssHref || 'no encontrado');
  check('index.html declara el manifest', html.includes('manifest.webmanifest'));

  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  check('manifest declara standalone', manifest.display === 'standalone');
  check('manifest tiene icono 512', manifest.icons.some(i => i.sizes === '512x512'));

  const png = Buffer.from(await (await fetch(base + '/icons/icon-512.png')).arrayBuffer());
  check('PNG con firma valida', png.subarray(1, 4).toString() === 'PNG');
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  check('PNG 512x512', w === 512 && h === 512, `${w}x${h}`);

  const raw = path =>
    new Promise(resolve => {
      const socket = connect(PORT, '127.0.0.1', () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', d => (data += d));
      socket.on('end', () => resolve(data));
      socket.on('error', () => resolve(''));
    });

  const canary = 'CANARIO-8f3a2b-MELODIA';
  const canaryPath = join(ROOT, '..', 'melodia-traversal-canary.txt');
  await writeFile(canaryPath, canary, 'utf8');
  try {
    for (const attack of [
      '/../melodia-traversal-canary.txt',
      '/%2e%2e/melodia-traversal-canary.txt',
      '/%2e%2e%2fmelodia-traversal-canary.txt',
      '/..%5cmelodia-traversal-canary.txt',
      '/js/../../melodia-traversal-canary.txt',
      '/....//melodia-traversal-canary.txt',
    ]) {
      const res = await raw(attack);
      const leaked = res.includes(canary);
      const status = Number(res.match(/HTTP\/1\.1 (\d+)/)?.[1] || 0);
      check(`bloquea traversal ${attack}`, !leaked, `status ${status}${leaked ? ' FUGA' : ''}`);
    }
  } finally {
    await rm(canaryPath, { force: true });
  }

  const missing = await fetch(base + '/no-existe.js');
  check('404 en archivo inexistente', missing.status === 404);
} catch (err) {
  fail++;
  console.error('FALLO ' + err.message);
} finally {
  child.kill();
}

console.log(`\n${pass} ok · ${fail} fallidas`);
process.exit(fail ? 1 : 0);
