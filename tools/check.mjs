import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'tools', 'icons']);
let errors = 0;
let checked = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (['.js', '.mjs'].includes(extname(entry.name))) await check(full);
  }
}

async function check(file) {
  checked++;
  const src = await readFile(file, 'utf8');
  const tmp = await mkdtemp(join(tmpdir(), 'melodia-check-'));
  const target = join(tmp, 'file.mjs');
  try {
    await writeFile(target, src);
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  } catch (err) {
    errors++;
    console.error(`FALLO  ${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
    console.error(String(err.stderr || err.message).trim().split('\n').slice(0, 4).join('\n'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const dupes = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) !== i);
if (dupes.length) {
  errors++;
  console.error('IDs duplicados en index.html: ' + [...new Set(dupes)].join(', '));
}

for (const file of ['js/app.js', 'js/player.js', 'js/library.js', 'js/db.js', 'js/tags.js', 'sw.js']) {
  const src = await readFile(join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/\$\('([^']+)'\)/g)) {
    if (!htmlIds.has(m[1])) {
      errors++;
      console.error(`${file}: busca el id "${m[1]}" que no existe en index.html`);
    }
  }
}

const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!shellMatch) {
  errors++;
  console.error('sw.js: no se encontro la lista SHELL');
} else {
  const listed = [...shellMatch[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  for (const rel of listed) {
    if (rel === '') continue;
    try {
      await readFile(join(ROOT, rel));
    } catch {
      errors++;
      console.error(`sw.js: SHELL apunta a "${rel}" que no existe (la app no arrancaria offline)`);
    }
  }
  for (const must of ['index.html', 'css/style.css', 'js/app.js', 'manifest.webmanifest']) {
    if (!listed.includes(must)) {
      errors++;
      console.error(`sw.js: falta "${must}" en SHELL`);
    }
  }
}

const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons || []) {
  try {
    await readFile(join(ROOT, icon.src.replace(/^\.\//, '')));
  } catch {
    errors++;
    console.error(`manifest: el icono "${icon.src}" no existe`);
  }
}
for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
  if (!manifest[key]) {
    errors++;
    console.error(`manifest: falta el campo "${key}"`);
  }
}

await walk(ROOT);
console.log(`\n${checked} archivos revisados · ${errors} error${errors === 1 ? '' : 'es'}`);
process.exit(errors ? 1 : 0);
