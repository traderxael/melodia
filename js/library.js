import { store, uid } from './db.js';
import { readTags, guessMime } from './tags.js';

const norm = s => (s || '').trim().toLowerCase();

function audioDuration(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    let done = false;
    const finish = d => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      resolve(d);
    };
    const timer = setTimeout(() => finish(0), 12000);
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', () => {
      const d = a.duration;
      finish(Number.isFinite(d) && d > 0 ? d : 0);
    });
    a.addEventListener('error', () => finish(0));
    a.src = url;
  });
}

export async function buildTrack(file, sourceType = 'file', sourceUrl = '') {
  const blob = file instanceof Blob ? file : new Blob([file]);
  const name = file.name || 'cancion';
  const mime = blob.type && blob.type.startsWith('audio') ? blob.type : guessMime(name);
  const { tags, estDuration } = await readTags(blob);
  const duration = await audioDuration(blob);
  return {
    id: uid(),
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    albumArtist: tags.albumArtist,
    genre: tags.genre,
    year: tags.year,
    trackNo: tags.trackNo || 0,
    duration: duration || estDuration || 0,
    playCount: 0,
    liked: false,
    saved: sourceType === 'file',
    addedAt: Date.now(),
    size: blob.size,
    mime,
    ext: (name.split('.').pop() || mime.split('/')[1] || 'mp3').toLowerCase(),
    sourceType,
    sourceUrl,
    fileName: name,
    audio: blob,
    art: tags.art ? tags.art.blob : null,
    artMime: tags.art ? tags.art.mime : '',
  };
}

function fingerprint(t) {
  return `${norm(t.artist)}|${norm(t.title)}|${Math.round(t.duration)}|${t.size}`;
}

export async function importFiles(files, { onProgress, duplicates = 'keep' } = {}) {
  const list = Array.from(files).filter(f => f && f.size > 0);
  const existing = await store.allTracks();
  const seen = new Set(existing.map(fingerprint));
  const added = [];
  const skipped = [];
  let done = 0;

  for (const file of list) {
    if (!isProbablyAudio(file)) {
      skipped.push(file.name);
      done++;
      onProgress?.(done, list.length, file.name);
      continue;
    }
    try {
      const track = await buildTrack(file, 'file');
      const fp = fingerprint(track);
      if (seen.has(fp)) {
        skipped.push(file.name);
      } else {
        seen.add(fp);
        added.push(track);
      }
    } catch {
      skipped.push(file.name);
    }
    done++;
    onProgress?.(done, list.length, file.name);
  }

  if (added.length) await store.putTracks(added);
  return { added, skipped };
}

export function isProbablyAudio(file) {
  if (file.type && file.type.startsWith('audio/')) return true;
  if (file.type && /video\/(mp4|webm|ogg)/.test(file.type)) return true;
  return /\.(mp3|m4a|mp4|aac|ogg|oga|opus|wav|wave|flac|webm|aiff?|mka|weba)$/i.test(file.name || '');
}

export async function addFromUrl(url) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`El servidor respondio ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/audio|octet-stream|video\/(mp4|webm)/.test(type)) {
    throw new Error('Esa direccion no parece un archivo de audio.');
  }
  const blob = await res.blob();
  const name = decodeURIComponent((url.split('/').pop() || 'descarga').split('?')[0]) || 'descarga';
  const withName = new File([blob], name, { type: type.split(';')[0] || guessMime(name) });
  const track = await buildTrack(withName, 'url', url);
  const existing = await store.allTracks();
  if (existing.some(t => fingerprint(t) === fingerprint(track))) {
    throw new Error('Esa cancion ya esta en tu biblioteca.');
  }
  await store.putTrack(track);
  return track;
}

export function safeFileName(track) {
  const artist = (track.artist || 'Artista desconocido').replace(/[\\/:*?"<>|]/g, '-');
  const title = (track.title || 'Sin titulo').replace(/[\\/:*?"<>|]/g, '-');
  return `${artist} - ${title}.${track.ext || 'mp3'}`;
}

export async function saveToDevice(track) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: safeFileName(track),
        types: [{ description: 'Audio', accept: { [track.mime || 'audio/mpeg']: ['.' + (track.ext || 'mp3')] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(track.audio);
      await writable.close();
      return { ok: true, method: 'picker' };
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: false, cancelled: true };
    }
  }
  const url = URL.createObjectURL(track.audio);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(track);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { ok: true, method: 'download' };
}

export async function exportBackup() {
  const tracks = await store.allTracks();
  const playlists = await store.allPlaylists();
  const data = {
    app: 'melodia',
    version: 1,
    exportedAt: new Date().toISOString(),
    tracks: tracks.map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumArtist: t.albumArtist,
      genre: t.genre,
      year: t.year,
      trackNo: t.trackNo,
      duration: t.duration,
      playCount: t.playCount,
      liked: t.liked,
      addedAt: t.addedAt,
      fileName: t.fileName,
      ext: t.ext,
      mime: t.mime,
    })),
    playlists,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `melodia-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { tracks: data.tracks.length, playlists: playlists.length };
}

export async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (data.app !== 'melodia') throw new Error('Ese archivo no es un respaldo de Melodia.');
  const current = await store.allTracks();
  const byKey = new Map(current.map(t => [fingerprint(t), t]));
  const merged = [];
  for (const t of data.tracks || []) {
    const k = fingerprint(t);
    const hit = byKey.get(k);
    if (hit) {
      hit.liked = hit.liked || t.liked;
      hit.playCount = Math.max(hit.playCount || 0, t.playCount || 0);
      merged.push(hit);
    } else {
      byKey.set(k, { ...t });
      merged.push(byKey.get(k));
    }
  }
  const restored = merged.filter(t => !current.includes(t));
  if (restored.length) await store.putTracks(restored);
  return { restored: restored.length, total: merged.length };
}
