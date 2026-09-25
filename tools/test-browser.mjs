import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5211;
const CDP_PORT = 9333;
const SHOT = join(ROOT, 'tools', 'screenshot.png');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find(p => p && existsSync(p));
if (!chromePath) {
  console.log('sin Chrome/Edge: se saltea el test de navegador');
  process.exit(0);
}

let WebSocket;
for (const spec of ['ws', 'file:///C:/Users/USUARIO/Documents/Default%20Project/node_modules/ws/index.js']) {
  try {
    const mod = await import(spec).catch(() => createRequire(import.meta.url)(spec));
    WebSocket = mod.default || mod.WebSocket || (await import(spec)).default;
    if (WebSocket) break;
  } catch {}
}
if (!WebSocket) {
  console.log('sin modulo ws: se saltea el test de navegador');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'ok  ' : 'FALLO'} ${name}${extra ? '  ' + extra : ''}`);
};

const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', d => (serverOut += d));
server.stderr.on('data', d => (serverOut += d));

const profile = join(process.env.TEMP || '.', 'melodia-e2e-profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const browser = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--window-size=412,915',
  'about:blank',
]);
browser.stderr.on('data', () => {});

let ws;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function evaluate(expr, sessionId) {
  const res = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'excepcion en la evaluacion');
  }
  return res.result?.value;
}

try {
  for (let i = 0; i < 40 && !serverOut.includes('escuchando'); i++) await sleep(100);
  if (!serverOut.includes('escuchando')) throw new Error('el servidor no arranco');

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('no se pudo conectar con Chrome por CDP');

  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: true,
  }, sessionId);

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` }, sessionId);

  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    booted = await evaluate(`!!document.querySelector('.dock-btn.is-active') && !!document.getElementById('libraryEmpty') && !document.getElementById('libraryEmpty').hidden`, sessionId);
    if (booted) break;
  }
  check('la app arranca y muestra el estado vacio', !!booted);

  check('sin excepciones de JS', exceptions.length === 0, exceptions.join(' | ').slice(0, 400));
  check('sin errores de consola', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));

  const counts = await evaluate(
    `JSON.stringify({
       dock: document.querySelectorAll('.dock-btn').length,
       tabs: document.querySelectorAll('.tab').length,
       settings: document.querySelectorAll('.view#view-settings .card').length,
       sw: 'serviceWorker' in navigator,
       media: 'mediaSession' in navigator
     })`,
    sessionId
  );
  const c = JSON.parse(counts);
  check('5 botones en la barra inferior', c.dock === 5, String(c.dock));
  check('4 pestanas', c.tabs === 4, String(c.tabs));
  check('5 tarjetas de ajustes', c.settings === 5, String(c.settings));
  check('soporta service worker', c.sw === true);
  check('soporta Media Session', c.media === true);

  let swReg = 'none';
  for (let i = 0; i < 40 && swReg === 'none'; i++) {
    swReg = await evaluate(
      `navigator.serviceWorker.getRegistration().then(r => r ? (r.active ? 'active' : r.installing ? 'installing' : r.waiting ? 'waiting' : 'registrando') : 'none')`,
      sessionId
    );
    if (swReg === 'none') await sleep(250);
  }
  check('service worker registrado', swReg !== 'none', swReg);

  const dbOk = await evaluate(
    `(async () => {
       const d = await new Promise((res, rej) => {
         const r = indexedDB.open('melodia');
         r.onsuccess = () => res(r.result);
         r.onerror = () => rej(new Error('no se pudo abrir'));
         r.onblocked = () => rej(new Error('bloqueado'));
       });
       return [...d.objectStoreNames].sort().join(',');
     })()`,
    sessionId
  );
  check('IndexedDB con los 3 stores', dbOk === 'meta,playlists,tracks', dbOk);

  const inyecto = await evaluate(
    `(async () => {
       const id = 'e2e-track-1';
       const enc = new TextEncoder();
       const audio = new Blob([enc.encode('contenido de audio simulado')], { type: 'audio/mpeg' });
       const art = await new Promise(res => {
         const c = document.createElement('canvas'); c.width = c.height = 8;
         c.toBlob(res, 'image/png');
       });
       const t = {
         id, title: 'Cancion de Prueba E2E', artist: 'Artista E2E', album: 'Album E2E',
         albumArtist: 'Artista E2E', genre: 'Rock', year: '2024', trackNo: 1,
         duration: 213, playCount: 0, liked: true, saved: true, addedAt: Date.now(),
         size: 12345, mime: 'audio/mpeg', ext: 'mp3', sourceType: 'file', sourceUrl: '',
         fileName: id + '.mp3', audio, art, artMime: 'image/png'
       };
       const db = await new Promise(res => { const r = indexedDB.open('melodia'); r.onsuccess = () => res(r.result); });
       await new Promise(res => { const tx = db.transaction('tracks', 'readwrite'); tx.objectStore('tracks').put(t); tx.oncomplete = res; });
       return true;
     })()`,
    sessionId
  );
  check('se puede escribir en IndexedDB', inyecto === true);

  await send('Page.reload', { ignoreCache: false }, sessionId);
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const rows = await evaluate(`document.querySelectorAll('#trackList .row').length`, sessionId);
    if (rows > 0) break;
  }

  const row = await evaluate(
    `(() => {
       const r = document.querySelector('#trackList .row');
       if (!r) return null;
       return JSON.stringify({
         title: r.querySelector('.row-title')?.textContent,
         sub: r.querySelector('.row-sub')?.textContent,
         dur: r.querySelector('.row-dur')?.textContent,
         fav: r.querySelector('[data-fav]')?.classList.contains('is-on'),
         art: !!r.querySelector('.row-art')
       });
     })()`,
    sessionId
  );
  check('la lista renderiza la cancion importada', !!row, row || 'sin filas');
  if (row) {
    const r = JSON.parse(row);
    check('muestra el titulo', r.title === 'Cancion de Prueba E2E', r.title);
    check('muestra artista y album', r.sub === 'Artista E2E · Album E2E', r.sub);
    check('muestra la duracion formateada', r.dur === '3:33', r.dur);
    check('marca la favorita', r.fav === true);
    check('muestra la caratula', r.art === true);
  }

  const vacio = await evaluate(`document.getElementById('libraryEmpty').hidden === true`, sessionId);
  check('el estado vacio se oculta al haber canciones', vacio === true);

  const albumes = await evaluate(
    `(() => { document.querySelector('[data-view="albums"]').click(); return new Promise(r => setTimeout(() => r(document.querySelectorAll('#albumList .card-tile').length), 200)); })()`,
    sessionId
  );
  check('la vista de albums agrupa 1 album', albumes === 1, String(albumes));

  const playlist = await evaluate(
    `(async () => {
       const btn = document.querySelector('[data-view="playlists"]');
       btn.click();
       window.prompt = () => 'Mi Playlist E2E';
       document.getElementById('btnNewPlaylist').click();
       await new Promise(r => setTimeout(r, 400));
       return document.querySelectorAll('#playlistList .card-tile').length;
     })()`,
    sessionId
  );
  check('se crea una playlist', playlist === 1, String(playlist));

  const busqueda = await evaluate(
    `(async () => {
       document.querySelector('[data-view="library"]').click();
       await new Promise(r => setTimeout(r, 150));
       document.getElementById('btnSearchToggle').click();
       const i = document.getElementById('searchInput');
       i.value = 'prueba';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(r => setTimeout(r, 400));
       const n = document.querySelectorAll('#trackList .row').length;
       i.value = 'zzz-no-existe';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(r => setTimeout(r, 400));
       const m = document.querySelectorAll('#trackList .row').length;
       return JSON.stringify({ conResultado: n, sinResultado: m });
     })()`,
    sessionId
  );
  const b = JSON.parse(busqueda);
  check('la busqueda encuentra la cancion', b.conResultado === 1, JSON.stringify(b));
  check('la busqueda sin resultados vacia la lista', b.sinResultado === 0, JSON.stringify(b));

  await evaluate(
    `(async () => {
       const enc = new TextEncoder();
       const db = await new Promise(res => { const r = indexedDB.open('melodia'); r.onsuccess = () => res(r.result); });
       const many = [];
       for (let n = 2; n <= 16; n++) {
         const id = 'e2e-track-' + n;
         many.push({
           id, title: 'Cancion Numero ' + n, artist: 'Artista E2E', album: 'Album E2E ' + (n % 3),
           albumArtist: 'Artista E2E', genre: 'Rock', year: '2024', trackNo: n,
           duration: 100 + n * 7, playCount: 0, liked: false, saved: true, addedAt: Date.now() - n * 1000,
           size: 20000, mime: 'audio/mpeg', ext: 'mp3', sourceType: 'file', sourceUrl: '',
           fileName: id + '.mp3', audio: new Blob([enc.encode('x')], { type: 'audio/mpeg' }), art: null, artMime: ''
         });
       }
       await new Promise(res => {
         const tx = db.transaction('tracks', 'readwrite');
         many.forEach(t => tx.objectStore('tracks').put(t));
         tx.oncomplete = res;
       });
       return many.length;
     })()`,
    sessionId
  );
  await send('Page.reload', {}, sessionId);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const n = await evaluate(`document.querySelectorAll('#trackList .row').length`, sessionId);
    if (n >= 16) break;
  }
  check('renderiza las 16 canciones', (await evaluate(`document.querySelectorAll('#trackList .row').length`, sessionId)) === 16);

  const layout = await evaluate(
    `(() => {
       const c = document.getElementById('content');
       const cs = getComputedStyle(c);
       return JSON.stringify({ overflowY: cs.overflowY, scrollH: c.scrollHeight, clientH: c.clientHeight, padBottom: cs.paddingBottom });
     })()`,
    sessionId
  );
  const lay = JSON.parse(layout);
  check('el contenido scrollea en vertical', lay.overflowY === 'auto', lay.overflowY);
  check('con muchas canciones la lista scrollea', lay.scrollH > lay.clientH, `${lay.scrollH} > ${lay.clientH}`);

  const overflow = await evaluate(
    `(() => {
       const c = document.getElementById('content');
       return JSON.stringify({ bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth });
     })()`,
    sessionId
  );
  check('sin scroll horizontal', JSON.parse(overflow).bodyOverflowX <= 0, JSON.parse(overflow).bodyOverflowX);

  const dock = await evaluate(
    `(() => {
       const c = document.getElementById('content');
       c.scrollTop = c.scrollHeight;
       const d = document.getElementById('dock').getBoundingClientRect();
       const last = document.querySelector('#trackList .row:last-child');
       const r = last.getBoundingClientRect();
       return JSON.stringify({
         dockVisible: d.height > 2,
         tapado: r.bottom > d.top + 1,
         solapamientoPx: Math.round(Math.max(0, r.bottom - d.top))
       });
     })()`,
    sessionId
  );
  const dk = JSON.parse(dock);
  check('el dock de navegacion es visible en movil', dk.dockVisible === true);
  check('la ultima fila no queda tapada al scrollear', dk.tapado === false, `solapamiento ${dk.solapamientoPx}px`);

  const tapTarget = await evaluate(
    `(() => {
       const b = document.getElementById('btnDockAdd').getBoundingClientRect();
       const d = document.querySelector('.dock-btn[data-view="settings"]').getBoundingClientRect();
       return JSON.stringify({ addW: Math.round(b.width), addH: Math.round(b.height), dockW: Math.round(d.width) });
     })()`,
    sessionId
  );
  const tt = JSON.parse(tapTarget);
  check('el boton de importar es comodo al dedo', tt.addH >= 36, `${tt.addH}px`);

  const reproduce = await evaluate(
    `(async () => {
       document.getElementById('btnSearchClear').click();
       document.getElementById('btnSearchToggle').click();
       await new Promise(r => setTimeout(r, 200));
       const rows = [...document.querySelectorAll('#trackList .row')];
       rows[0].click();
       await new Promise(r => setTimeout(r, 500));
       const p = document.getElementById('player');
       return JSON.stringify({
         visible: !p.hidden,
         title: document.getElementById('npTitle').textContent,
         artist: document.getElementById('npArtist').textContent,
         dur: document.getElementById('timeDur').textContent,
         repetido: !!document.querySelector('#trackList .row.is-playing'),
         cola: document.getElementById('audio').src.startsWith('blob:')
       });
     })()`,
    sessionId
  );
  const rp = JSON.parse(reproduce);
  check('el reproductor aparece al tocar una cancion', rp.visible === true);
  check('muestra el titulo en el reproductor', /^Cancion/.test(rp.title), rp.title);
  check('muestra el artista en el reproductor', rp.artist === 'Artista E2E', rp.artist);
  check('muestra la duracion', /^\d+:\d\d$/.test(rp.dur), rp.dur);
  check('marca la fila como sonando', rp.repetido === true);
  check('carga el audio como blob local', rp.cola === true);

  const sheet = await evaluate(
    `(async () => {
       document.getElementById('playerMain').click();
       await new Promise(r => setTimeout(r, 350));
       const s = document.getElementById('npSheet');
       const r = s.getBoundingClientRect();
       return JSON.stringify({
         visible: !s.hidden,
         enPantalla: r.top < window.innerHeight && r.bottom > 0,
         alto: Math.round(r.height),
         acciones: s.querySelectorAll('.sheet-actions .btn').length
       });
     })()`,
    sessionId
  );
  const sh = JSON.parse(sheet);
  check('se abre el reproductor completo', sh.visible === true && sh.enPantalla === true, JSON.stringify(sh));
  check('el reproductor completo ofrece 5 acciones', sh.acciones === 5, String(sh.acciones));

  const sheetShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SHOT.replace('.png', '-player.png'), Buffer.from(sheetShot.data, 'base64'));

  await evaluate(`document.getElementById('sheetBackdrop').click()`, sessionId);

  const cola = await evaluate(
    `(async () => {
       const b = document.getElementById('btnSheetQueue');
       document.getElementById('playerMain').click();
       await new Promise(r => setTimeout(r, 250));
       document.getElementById('btnSheetQueue').click();
       await new Promise(r => setTimeout(r, 250));
       const n = document.querySelectorAll('#queueList .row').length;
       document.getElementById('btnClearQueue').click();
       await new Promise(r => setTimeout(r, 250));
       return JSON.stringify({ antes: n, despues: document.querySelectorAll('#queueList .row').length, oculto: document.getElementById('player').hidden });
     })()`,
    sessionId
  );
  const cq = JSON.parse(cola);
  check('la cola lista las 16 canciones', cq.antes === 16, String(cq.antes));
  check('vaciar la cola oculta el reproductor', cq.oculto === true, JSON.stringify(cq));

  const ocultos = await evaluate(
    `(() => {
       const shown = el => el && getComputedStyle(el).display !== 'none';
       const visible = el => shown(el) && el.getBoundingClientRect().height > 0;
       const bar = document.getElementById('searchBar');
       const install = document.getElementById('btnInstall');
       const rep = document.getElementById('repOne');
       const ph = document.getElementById('npBigPlaceholder');
       const out = { installVisible: visible(install) };

       bar.hidden = true;
       out.barraOculta = !visible(bar);
       document.getElementById('btnSearchToggle').click();
       out.barraAlAbrir = visible(bar);
       document.getElementById('btnSearchToggle').click();
       out.barraAlCerrar = visible(bar);
       bar.hidden = true;

       for (let i = 0; i < 4 && rep.hidden; i++) document.getElementById('btnRepeat').click();
       out.repBadgeEnRepetirUna = shown(rep);
       out.repOn = document.getElementById('btnRepeat').classList.contains('is-on');
       for (let i = 0; i < 4 && document.getElementById('btnRepeat').classList.contains('is-on'); i++) {
         document.getElementById('btnRepeat').click();
       }
       out.repBadgeAlApagar = shown(rep);
       out.repApagado = !document.getElementById('btnRepeat').classList.contains('is-on');
       return JSON.stringify(out);
     })()`,
    sessionId
  );
  const oc = JSON.parse(ocultos);
  check('la barra de busqueda se oculta de verdad', oc.barraOculta === true);
  check('la barra de busqueda se abre', oc.barraAlAbrir === true);
  check('la barra de busqueda se cierra de verdad', oc.barraAlCerrar === false);
  check('el badge "repetir una" aparece solo en ese modo', oc.repBadgeEnRepetirUna === true && oc.repBadgeAlApagar === false, JSON.stringify(oc));
  check('el boton de repetir se apaga del todo', oc.repApagado === true);
  check('el boton de instalar arranca oculto', oc.installVisible === false);

  const caratula = await evaluate(
    `(async () => {
       const shown = el => el && getComputedStyle(el).display !== 'none';
       const conArt = [...document.querySelectorAll('#trackList .row')].find(r => r.querySelector('.row-title').textContent === 'Cancion de Prueba E2E');
       conArt.click();
       await new Promise(r => setTimeout(r, 400));
       const conImg = { art: shown(document.getElementById('npArt')), big: shown(document.getElementById('npBigArt')), placeholder: shown(document.getElementById('npBigPlaceholder')) };
       const sinArt = [...document.querySelectorAll('#trackList .row')].find(r => !r.querySelector('img.row-art'));
       sinArt.click();
       await new Promise(r => setTimeout(r, 400));
       const sinImg = { art: shown(document.getElementById('npArt')), big: shown(document.getElementById('npBigArt')), placeholder: shown(document.getElementById('npBigPlaceholder')) };
       return JSON.stringify({ conImg, sinImg });
     })()`,
    sessionId
  );
  const ct = JSON.parse(caratula);
  check('con caratula muestra la imagen y oculta el placeholder', ct.conImg.art === true && ct.conImg.big === true && ct.conImg.placeholder === false, JSON.stringify(ct.conImg));
  check('sin caratula muestra el placeholder y oculta la imagen', ct.sinImg.art === false && ct.sinImg.big === false && ct.sinImg.placeholder === true, JSON.stringify(ct.sinImg));

  const captura = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SHOT, Buffer.from(captura.data, 'base64'));
  check('captura de pantalla generada', existsSync(SHOT));

  for (let i = 0; i < 40; i++) {
    const st = await evaluate(
      `navigator.serviceWorker.getRegistration().then(r => r ? (r.active ? 'active' : 'no') : 'none')`,
      sessionId
    );
    if (st === 'active') break;
    await sleep(250);
  }

  exceptions.length = 0;
  consoleErrors.length = 0;
  await send(
    'Network.enable',
    {},
    sessionId
  );
  await send(
    'Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    sessionId
  );
  server.kill();
  await sleep(400);

  await send('Page.reload', { ignoreCache: true }, sessionId);
  let offlineBoot = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      offlineBoot = await evaluate(
        `!!document.querySelector('.dock-btn.is-active') && document.querySelectorAll('#trackList .row').length === 16`,
        sessionId
      );
    } catch {}
    if (offlineBoot) break;
  }
  check('arranca SIN internet (servidor apagado)', offlineBoot === true);

  const offlineRows = await evaluate(
    `JSON.stringify({
       rows: document.querySelectorAll('#trackList .row').length,
       pill: !document.getElementById('netPill').hidden,
       pillText: document.getElementById('netPill').textContent.trim()
     })`,
    sessionId
  );
  const or = JSON.parse(offlineRows);
  check('las 16 canciones siguen disponibles sin internet', or.rows === 16, String(or.rows));
  check('muestra el aviso de sin conexion', or.pill === true && /conexion/i.test(or.pillText), or.pillText);

  const shotOffline = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SHOT.replace('.png', '-offline.png'), Buffer.from(shotOffline.data, 'base64'));

  check('sin excepciones al final', exceptions.length === 0, exceptions.join(' | ').slice(0, 500));
  check('sin errores de consola al final', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));
} catch (err) {
  fail++;
  console.error('FALLO ' + err.message);
} finally {
  try {
    ws?.close();
  } catch {}
  browser.kill();
  server.kill();
  await sleep(600);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

console.log(`\n${pass} ok · ${fail} fallidas`);
process.exit(fail ? 1 : 0);
