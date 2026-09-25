import { store, uid } from './db.js';
import { Player, trackUrl, releaseUrl } from './player.js';
import { importFiles, addFromUrl, saveToDevice, exportBackup, importBackup, safeFileName } from './library.js';

const $ = id => document.getElementById(id);
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOTE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

const state = {
  tracks: [],
  playlists: [],
  view: 'library',
  filter: 'all',
  sort: 'recent',
  query: '',
  albumTracks: null,
  playlistId: null,
  settings: { volume: 0.8, skip: 10, loudness: false },
  artUrls: new Map(),
  pending: { trackId: null, playlistId: null },
  boot: false,
};

const player = new Player($('audio'));

/* ---------------- utils ---------------- */
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function artUrl(track) {
  if (!track?.art) return null;
  if (!state.artUrls.has(track.id)) state.artUrls.set(track.id, URL.createObjectURL(track.art));
  return state.artUrls.get(track.id);
}

function releaseArt(id) {
  if (state.artUrls.has(id)) {
    URL.revokeObjectURL(state.artUrls.get(id));
    state.artUrls.delete(id);
  }
}

function key(s) {
  return (s || '').trim().toLowerCase();
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 4200 : 2400);
}

function progress(on, frac) {
  let bar = document.querySelector('.progress');
  if (frac === undefined) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'progress';
    document.body.appendChild(bar);
  }
  bar.style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
  if (frac >= 1) setTimeout(() => bar.remove(), 350);
}

function openSheet(id) {
  closeSheets();
  $('sheetBackdrop').hidden = false;
  $(id).hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheets() {
  ['npSheet', 'queueSheet', 'addSheet', 'tagSheet'].forEach(id => {
    $(id).hidden = true;
  });
  $('sheetBackdrop').hidden = true;
  document.body.style.overflow = '';
}

/* ---------------- data ---------------- */
async function loadAll() {
  state.tracks = await store.allTracks();
  state.playlists = await store.allPlaylists();
  state.playlists.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function refresh(keepScroll = true) {
  const scroller = $('content');
  const top = keepScroll ? scroller.scrollTop : 0;
  await loadAll();
  renderAll();
  scroller.scrollTop = top;
}

function visibleTracks() {
  let list = state.tracks.slice();
  const q = key(state.query);
  if (state.albumTracks) {
    const ids = new Set(state.albumTracks.map(t => t.id));
    list = list.filter(t => ids.has(t.id));
  } else if (state.playlistId) {
    const pl = state.playlists.find(p => p.id === state.playlistId);
    if (pl) list = pl.trackIds.map(id => state.tracks.find(t => t.id === id)).filter(Boolean);
  }
  if (q) {
    list = list.filter(t =>
      [t.title, t.artist, t.album, t.albumArtist, t.genre, t.fileName].some(v => key(v).includes(q))
    );
  }
  switch (state.filter) {
    case 'local':
      list = list.filter(t => t.saved);
      break;
    case 'saved':
      list = list.filter(t => t.saved);
      break;
    case 'fav':
      list = list.filter(t => t.liked);
      break;
  }
  const cmp = {
    recent: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'es'),
    artist: (a, b) => (a.artist || '').localeCompare(b.artist || '', 'es'),
    album: (a, b) => (a.album || '').localeCompare(b.album || '', 'es') || (a.trackNo || 0) - (b.trackNo || 0),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  }[state.sort];
  if (cmp) list.sort(cmp);
  return list;
}

/* ---------------- render ---------------- */
function renderAll() {
  renderHeader();
  renderLibrary();
  renderAlbums();
  renderPlaylists();
  renderSettings();
  renderPlayer();
}

function renderHeader() {
  const inCollection = state.albumTracks || state.playlistId;
  const pl = state.playlistId ? state.playlists.find(p => p.id === state.playlistId) : null;
  const album = state.albumTracks
    ? state.albumTracks[0]?.album || 'Album'
    : pl
      ? pl.name
      : 'Melodia';
  $('brandTitle').textContent = state.query ? 'Resultados' : album;
  $('tabs').hidden = !!inCollection;
  if (inCollection) $('tabs').style.display = 'none';
  else $('tabs').style.display = '';
}

function rowHtml(t, i) {
  const art = artUrl(t);
  const cur = player.current?.id === t.id;
  const bars = cur
    ? `<span class="row-bars ${player.audio.paused ? 'paused' : ''}"><i></i><i></i><i></i></span>`
    : '';
  return `<div class="row ${cur ? 'is-playing' : ''}" data-id="${t.id}" data-i="${i}" tabindex="0">
    ${art ? `<img class="row-art" src="${art}" alt="" loading="lazy">` : `<span class="row-art">${NOTE_SVG}</span>`}
    <div class="row-info">
      <div class="row-title">${esc(t.title)}</div>
      <div class="row-sub">${esc(t.artist)}${state.albumTracks || state.playlistId ? '' : t.album ? ' · ' + esc(t.album) : ''}</div>
    </div>
    ${bars}
    <span class="row-dur">${fmtTime(t.duration)}</span>
    <button class="icon-btn row-fav ${t.liked ? 'is-on' : ''}" data-fav="${t.id}" aria-label="Favorita" title="Favorita">
      <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9z"/></svg>
    </button>
    <button class="icon-btn row-more" data-menu="${t.id}" aria-label="Mas opciones" title="Mas opciones">
      <svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
    </button>
  </div>`;
}

function renderLibrary() {
  const list = visibleTracks();
  const el = $('trackList');
  el.innerHTML = list.map(rowHtml).join('');
  $('libraryEmpty').hidden = list.length > 0 || state.query !== '';
  $('filterRow').hidden = !state.tracks.length || !!state.query;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-on', c.dataset.filter === state.filter));
  $('btnPlayAll').disabled = !list.length;
  $('btnShuffleAll').disabled = !list.length;
}

function albumsMap() {
  const map = new Map();
  for (const t of state.tracks) {
    const k = `${key(t.albumArtist || t.artist)}|${key(t.album)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.trackNo || 0) - (b.trackNo || 0) || (a.addedAt - b.addedAt));
  return map;
}

function renderAlbums() {
  const map = albumsMap();
  const el = $('albumList');
  el.innerHTML = [...map.entries()]
    .map(([, arr], i) => {
      const cover = artUrl(arr.find(t => t.art) || arr[0]);
      const total = arr.reduce((s, t) => s + (t.duration || 0), 0);
      return `<div class="card-tile" data-album="${i}">
        ${cover ? `<span class="tile-art"><img src="${cover}" alt="" loading="lazy"></span>` : `<span class="tile-art">${NOTE_SVG}</span>`}
        <div><div class="tile-title">${esc(arr[0].album || 'Sin album')}</div>
        <div class="tile-sub">${esc(arr[0].albumArtist || arr[0].artist)} · ${arr.length} cancion${arr.length > 1 ? 'es' : ''} · ${fmtTime(total)}</div></div>
        <button class="tile-play" data-play-album="${i}" aria-label="Reproducir album"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
      </div>`;
    })
    .join('');
  $('albumsEmpty').hidden = map.size > 0;
  el._albums = map;
}

function renderPlaylists() {
  const el = $('playlistList');
  el.innerHTML = state.playlists
    .map(pl => {
      const items = pl.trackIds.map(id => state.tracks.find(t => t.id === id)).filter(Boolean);
      const cover = artUrl(items.find(t => t.art) || items[0]);
      const total = items.reduce((s, t) => s + (t.duration || 0), 0);
      return `<div class="card-tile" data-playlist="${pl.id}">
        ${cover ? `<span class="tile-art"><img src="${cover}" alt="" loading="lazy"></span>` : `<span class="tile-art">${NOTE_SVG}</span>`}
        <div><div class="tile-title">${esc(pl.name)}</div>
        <div class="tile-sub">${items.length} cancion${items.length === 1 ? '' : 'es'} · ${fmtTime(total)}</div></div>
        <button class="tile-play" data-play-playlist="${pl.id}" aria-label="Reproducir playlist"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
        <button class="tile-del" data-del-playlist="${pl.id}" aria-label="Borrar playlist" title="Borrar playlist">
          <svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z"/></svg>
        </button>
      </div>`;
    })
    .join('');
  $('playlistsEmpty').hidden = state.playlists.length > 0;
}

async function renderSettings() {
  const size = state.tracks.reduce((s, t) => s + (t.size || 0), 0);
  $('statTracks').textContent = state.tracks.length;
  $('statSize').textContent = fmtSize(size);
  $('statPlaylists').textContent = state.playlists.length;
  const est = await store.estimate();
  if (est?.quota) {
    $('persistHint').textContent = `Espacio del navegador: ${fmtSize(est.usage || 0)} de ${fmtSize(est.quota)}. Si las canciones desaparecen, pedi almacenamiento permanente.`;
  }
  $('versionInfo').textContent = `Melodia v${appVersion} · ${navigator.onLine ? 'con conexion' : 'sin conexion'}`;
}

function renderPlayer() {
  const t = player.current;
  $('player').hidden = !t;
  if (!t) return;
  const art = artUrl(t);
  $('npTitle').textContent = t.title;
  $('npArtist').textContent = t.artist;
  $('npSheetTitle').textContent = t.title;
  $('npSheetArtist').textContent = `${t.artist} · ${t.album}`;
  [$('npArt'), $('npBigArt')].forEach(img => {
    if (art) {
      img.src = art;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
  });
  $('npBigPlaceholder').hidden = !!art;
  $('npSourceBadge').textContent = t.saved ? 'En el celu' : 'En la nube';
  $('npSourceBadge').style.color = t.saved ? 'var(--acc-2)' : 'var(--warn)';
  syncFavButtons(t);
  updatePlayIcons();
}

function syncFavButtons(t = player.current) {
  const on = !!t?.liked;
  [$('btnLike'), $('btnSheetFav')].forEach(b => {
    b.classList.toggle('is-on', on);
  });
  $('btnSheetFav').textContent = on ? 'Quitar de favoritas' : 'Marcar favorita';
  $('btnLike').setAttribute('aria-label', on ? 'Quitar de favoritas' : 'Marcar como favorita');
}

function updatePlayIcons() {
  const playing = !player.audio.paused;
  $('icoPlay').hidden = playing;
  $('icoPause').hidden = !playing;
  $('icoPlay2').hidden = playing;
  $('icoPause2').hidden = !playing;
  $('btnPlay').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  $('btnPlay2').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
}

function setSeek(cur, dur, buffered) {
  const total = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const now = Number.isFinite(cur) && cur > 0 ? cur : 0;
  const r = total > 0 ? Math.min(1, now / total) : 0;
  [$('seekFill'), $('seekFill2')].forEach(f => (f.style.width = `${r * 100}%`));
  [$('seekWrap'), $('seekWrap2')].forEach(w => w.setAttribute('aria-valuenow', Math.round(r * 100)));
  if (buffered !== undefined) {
    [$('seekBuffer'), $('seekBuffer2')].forEach(b => (b.style.width = `${Math.min(100, buffered * 100)}%`));
  }
  $('timeCur').textContent = fmtTime(now);
  $('timeDur').textContent = fmtTime(total);
}

function syncToggles() {
  [$('btnShuffle'), $('btnShuffle2')].forEach(b => b.classList.toggle('is-on', player.shuffle));
  [$('btnRepeat'), $('btnRepeat2')].forEach(b => b.classList.toggle('is-on', player.repeat !== 'off'));
  [$('repOne'), $('repOne2')].forEach(b => (b.hidden = player.repeat !== 'one'));
}

/* ---------------- player events ---------------- */
player.addEventListener('track', () => {
  renderPlayer();
  renderLibrary();
  persistNowPlaying();
});

player.addEventListener('time', e => {
  setSeek(e.detail.current, e.detail.duration);
});
player.addEventListener('buffer', e => setSeek(player.audio.currentTime, player.current?.duration || 0, e.detail));
player.addEventListener('duration', t => {
  store.putTrack(t);
  renderLibrary();
});
player.addEventListener('state', () => {
  updatePlayIcons();
  renderLibrary();
});
player.addEventListener('queue', () => {
  $('queueList').innerHTML = player.queue
    .map(
      (t, i) => `<div class="row ${i === player.index ? 'is-playing' : ''}" data-q="${i}">
        <span class="row-art">${t.art ? `<img class="row-art" src="${artUrl(t)}" alt="">` : NOTE_SVG}</span>
        <div class="row-info"><div class="row-title">${esc(t.title)}</div><div class="row-sub">${esc(t.artist)}</div></div>
        <button class="icon-btn row-more" data-qdel="${i}" aria-label="Quitar">
          <svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>
        </button>
      </div>`
    )
    .join('');
});
player.addEventListener('shuffle', syncToggles);
player.addEventListener('repeat', syncToggles);
player.addEventListener('played', async t => {
  await store.putTrack(t);
});
player.addEventListener('error', e => {
  toast(e.detail?.message || 'Error de reproduccion', 'err');
});

async function persistNowPlaying() {
  const t = player.current;
  await store.setMeta('last', t
    ? { id: t.id, time: player.audio.currentTime || 0, shuffle: player.shuffle, repeat: player.repeat, volume: player.volume, queueIds: player.queue.map(x => x.id), index: player.index }
    : null);
}

/* ---------------- actions ---------------- */
function playListOf(list, startIndex = 0) {
  if (!list.length) return toast('No hay canciones todavia', 'err');
  player.setQueue(list, startIndex, true);
  persistNowPlaying();
}

async function toggleLike(id) {
  const t = state.tracks.find(x => x.id === id);
  if (!t) return;
  t.liked = !t.liked;
  await store.putTrack(t);
  if (player.current?.id === id) syncFavButtons(t);
  renderLibrary();
  toast(t.liked ? 'Agregada a favoritas' : 'Quitada de favoritas');
}

async function toggleSaved(id) {
  const t = state.tracks.find(x => x.id === id);
  if (!t) return;
  t.saved = !t.saved;
  await store.putTrack(t);
  renderLibrary();
  if (player.current?.id === id) renderPlayer();
  toast(t.saved ? 'Se guarda en el celu: disponible sin internet' : 'Quitada del almacenamiento del celu');
}

async function removeTrack(id) {
  const t = state.tracks.find(x => x.id === id);
  if (!t) return;
  for (const pl of state.playlists) {
    if (pl.trackIds.includes(id)) {
      pl.trackIds = pl.trackIds.filter(x => x !== id);
      await store.putPlaylist(pl);
    }
  }
  const qi = player.queue.findIndex(x => x.id === id);
  if (qi >= 0) player.removeAt(qi);
  await store.deleteTrack(id);
  releaseUrl(id);
  releaseArt(id);
  state.tracks = state.tracks.filter(x => x.id !== id);
  await refresh();
  toast('Cancion borrada de la biblioteca');
}

async function doImport(files) {
  if (!files?.length) return;
  progress(true, 0);
  const t = toast(`Importando 0/${files.length}...`);
  const res = await importFiles(files, {
    onProgress: (done, total, name) => {
      progress(true, done / total);
      t.textContent = `Importando ${done}/${total}...`;
    },
  });
  progress(true, 1);
  t.remove();
  await refresh(false);
  const parts = [];
  if (res.added.length) parts.push(`${res.added.length} cancion${res.added.length > 1 ? 'es' : ''} importada${res.added.length > 1 ? 's' : ''}`);
  if (res.skipped.length) parts.push(`${res.skipped.length} omitida${res.skipped.length > 1 ? 's' : ''}`);
  toast(parts.join(' · ') || 'Nada nuevo para importar', res.added.length ? 'ok' : 'err');
  if (res.added.length) state.view === 'library' ? null : null;
}

async function createPlaylist(name, trackIds = []) {
  const pl = { id: uid(), name: name.trim() || 'Nueva playlist', trackIds, createdAt: Date.now(), updatedAt: Date.now() };
  await store.putPlaylist(pl);
  state.playlists.unshift(pl);
  return pl;
}

async function addToPlaylist(playlistId, trackIds) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  let added = 0;
  for (const id of trackIds) if (!pl.trackIds.includes(id)) (pl.trackIds.push(id), added++);
  pl.updatedAt = Date.now();
  await store.putPlaylist(pl);
  return added;
}

function openAddSheet(trackIds) {
  state.pending.trackId = Array.isArray(trackIds) ? null : trackIds;
  const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
  state.pending.batch = ids;
  $('addSheetTitle').textContent = ids.length > 1 ? `Agregar ${ids.length} canciones` : 'Agregar a playlist';
  $('addPlaylistList').innerHTML = state.playlists.length
    ? state.playlists
        .map(p => {
          const has = ids.filter(id => p.trackIds.includes(id)).length;
          return `<div class="row" data-add-to="${p.id}">
            <span class="row-art">${NOTE_SVG}</span>
            <div class="row-info"><div class="row-title">${esc(p.name)}</div>
            <div class="row-sub">${p.trackIds.length} cancion${p.trackIds.length === 1 ? '' : 'es'}${has ? ` · ${has} ya esta` : ''}</div></div>
            <span class="row-dur">${has ? '+' + (ids.length - has) : 'Agregar'}</span>
          </div>`;
        })
        .join('')
    : '<p class="hint" style="text-align:center;padding:14px">Todavia no tenes playlists.</p>';
  openSheet('addSheet');
}

async function doSaveToDevice(track) {
  if (!track) return;
  const t = toast('Guardando...');
  try {
    const r = await saveToDevice(track);
    t.remove();
    toast(
      r.cancelled ? 'Cancelado' : r.method === 'picker' ? `Guardado: ${safeFileName(track)}` : `Guardado en Descargas: ${safeFileName(track)}`,
      r.cancelled ? '' : 'ok'
    );
  } catch (err) {
    t.remove();
    toast('No se pudo guardar: ' + (err?.message || 'error'), 'err');
  }
}

/* ---------------- views ---------------- */
function setView(v) {
  state.view = v;
  state.albumTracks = null;
  state.playlistId = null;
  if (v !== 'library') closeSheets();
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('is-active', el.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
  document.querySelectorAll('.dock-btn[data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
  $('content').scrollTop = 0;
  renderAll();
}

function openAlbum(index) {
  const map = $('albumList')._albums;
  const arr = map?.get([...map.keys()][index]);
  if (!arr) return;
  state.albumTracks = arr;
  state.playlistId = null;
  setViewKeep('library');
  toast(`${arr[0].album} · ${arr.length} canciones`);
}

function setViewKeep(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('is-active', el.id === 'view-' + v));
  $('content').scrollTop = 0;
  renderAll();
}

function openPlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  state.playlistId = id;
  state.albumTracks = null;
  setViewKeep('playlists');
  toast(`${pl.name} · ${pl.trackIds.length} canciones`);
}

function backToRoot() {
  if (state.albumTracks || state.playlistId) {
    state.albumTracks = null;
    state.playlistId = null;
    renderAll();
    return true;
  }
  return false;
}

/* ---------------- install / sw ---------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  $('btnInstall').hidden = false;
});
window.addEventListener('appinstalled', () => {
  $('btnInstall').hidden = true;
  toast('Melodia instalada. Abrila desde el icono.', 'ok');
});

async function updateNetPill() {
  $('netPill').hidden = navigator.onLine;
  $('versionInfo').textContent = `Melodia v${appVersion} · ${navigator.onLine ? 'con conexion' : 'sin conexion'}`;
}
window.addEventListener('online', updateNetPill);
window.addEventListener('offline', updateNetPill);

/* ---------------- events ---------------- */
function wire() {
  $('btnImport').onclick = () => $('fileInput').click();
  $('btnImportEmpty').onclick = () => $('fileInput').click();
  $('btnDockAdd').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => {
    doImport(e.target.files);
    e.target.value = '';
  };

  $('btnPlayAll').onclick = () => playListOf(visibleTracks());
  $('btnShuffleAll').onclick = () => {
    const list = visibleTracks().slice().sort(() => Math.random() - 0.5);
    player.shuffle = true;
    syncToggles();
    playListOf(list);
  };

  $('sortSelect').onchange = e => {
    state.sort = e.target.value;
    store.setMeta('sort', state.sort);
    renderLibrary();
  };
  $('filterRow').onclick = e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.filter = c.dataset.filter;
    store.setMeta('filter', state.filter);
    renderLibrary();
  };

  document.querySelectorAll('.tab, .dock-btn[data-view]').forEach(b => {
    b.onclick = () => {
      if (backToRoot()) return;
      setView(b.dataset.view);
    };
  });

  $('btnSearchToggle').onclick = () => {
    const bar = $('searchBar');
    bar.hidden = !bar.hidden;
    if (bar.hidden) {
      state.query = '';
      $('searchInput').value = '';
    } else {
      $('searchInput').focus();
    }
    $('btnSearchClear').hidden = true;
    renderAll();
  };
  let searchTimer;
  $('searchInput').oninput = e => {
    state.query = e.target.value;
    $('btnSearchClear').hidden = !state.query;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderHeader();
      renderLibrary();
      renderAlbums();
    }, 160);
  };
  $('btnSearchClear').onclick = () => {
    state.query = '';
    $('searchInput').value = '';
    $('btnSearchClear').hidden = true;
    renderAll();
  };

  $('playerMain').onclick = () => openSheet('npSheet');
  $('sheetBackdrop').onclick = closeSheets;
  $('btnPlay').onclick = () => player.toggle();
  $('btnPlay2').onclick = () => player.toggle();
  $('btnNext').onclick = () => player.next(true);
  $('btnNext2').onclick = () => player.next(true);
  $('btnPrev').onclick = () => player.prev();
  $('btnPrev2').onclick = () => player.prev();
  $('btnShuffle').onclick = () => player.toggleShuffle();
  $('btnShuffle2').onclick = () => player.toggleShuffle();
  $('btnRepeat').onclick = () => player.cycleRepeat();
  $('btnRepeat2').onclick = () => player.cycleRepeat();
  $('btnLike').onclick = () => player.current && toggleLike(player.current.id);
  $('btnSheetFav').onclick = () => player.current && toggleLike(player.current.id);
  $('btnSheetAdd').onclick = () => player.current && openAddSheet(player.current.id);
  $('btnSheetDownload').onclick = () => doSaveToDevice(player.current);
  $('btnSheetQueue').onclick = () => openSheet('queueSheet');
  $('btnSheetEdit').onclick = () => openTagSheet(player.current);
  $('btnClearQueue').onclick = () => {
    player.clearQueue();
    persistNowPlaying();
    toast('Cola vacia');
  };
  $('btnTagCancel').onclick = closeSheets;
  $('btnCreateForAdd').onclick = () => {
    const name = prompt('Nombre de la playlist');
    if (!name?.trim()) return;
    createPlaylist(name, state.pending.batch || []).then(() => {
      toast('Playlist creada', 'ok');
      openAddSheet(state.pending.batch);
    });
  };

  $('volRange').oninput = e => {
    player.setVolume(+e.target.value);
    $('volOut').textContent = Math.round(player.volume * 100) + '%';
  };
  $('volRange2').oninput = e => {
    player.setVolume(+e.target.value);
    $('volOut').textContent = Math.round(player.volume * 100) + '%';
  };
  $('skipInput').onchange = e => {
    state.settings.skip = Math.min(30, Math.max(3, +e.target.value || 10));
    e.target.value = state.settings.skip;
    store.setMeta('skip', state.settings.skip);
  };
  $('loudnessChk').onchange = e => {
    state.settings.loudness = e.target.checked;
    player.setLoudness(e.target.checked);
    store.setMeta('loudness', e.target.checked);
  };

  $('btnNewPlaylist').onclick = async () => {
    const name = prompt('Nombre de la playlist');
    if (!name?.trim()) return;
    await createPlaylist(name);
    renderPlaylists();
    toast('Playlist creada', 'ok');
  };
  $('playlistList').onclick = async e => {
    const del = e.target.closest('[data-del-playlist]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.delPlaylist;
      const pl = state.playlists.find(p => p.id === id);
      if (!confirm(`Borrar la playlist "${pl?.name}"? Las canciones se quedan en la biblioteca.`)) return;
      await store.deletePlaylist(id);
      state.playlists = state.playlists.filter(p => p.id !== id);
      renderPlaylists();
      toast('Playlist borrada');
      return;
    }
    const play = e.target.closest('[data-play-playlist]');
    if (play) {
      e.stopPropagation();
      const pl = state.playlists.find(p => p.id === play.dataset.playPlaylist);
      const items = pl.trackIds.map(id => state.tracks.find(t => t.id === id)).filter(Boolean);
      return playListOf(items);
    }
    const card = e.target.closest('[data-playlist]');
    if (card) openPlaylist(card.dataset.playlist);
  };

  $('albumList').onclick = e => {
    const play = e.target.closest('[data-play-album]');
    const map = $('albumList')._albums;
    if (!map) return;
    const keys = [...map.keys()];
    if (play) {
      e.stopPropagation();
      return playListOf(map.get(keys[+play.dataset.playAlbum]));
    }
    const card = e.target.closest('[data-album]');
    if (card) openAlbum(+card.dataset.album);
  };

  $('trackList').onclick = async e => {
    const fav = e.target.closest('[data-fav]');
    if (fav) return toggleLike(fav.dataset.fav);
    const menu = e.target.closest('[data-menu]');
    if (menu) return openTrackMenu(menu.dataset.menu, e);
    const row = e.target.closest('.row');
    if (!row) return;
    const list = visibleTracks();
    const i = list.findIndex(t => t.id === row.dataset.id);
    playListOf(list, i < 0 ? 0 : i);
  };
  $('trackList').onkeydown = e => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('.row');
    if (!row) return;
    const list = visibleTracks();
    const i = list.findIndex(t => t.id === row.dataset.id);
    playListOf(list, i < 0 ? 0 : i);
  };

  $('queueList').onclick = e => {
    const del = e.target.closest('[data-qdel]');
    if (del) return player.removeAt(+del.dataset.qdel);
    const row = e.target.closest('[data-q]');
    if (row) player.playIndex(+row.dataset.q);
  };

  $('addPlaylistList').onclick = async e => {
    const row = e.target.closest('[data-add-to]');
    if (!row) return;
    const ids = state.pending.batch || [];
    const n = await addToPlaylist(row.dataset.addTo, ids);
    renderPlaylists();
    toast(n ? `${n} cancion${n > 1 ? 'es' : ''} agregada${n > 1 ? 's' : ''}` : 'Ya estaban todas ahi', 'ok');
  };

  $('tagForm').onsubmit = async e => {
    e.preventDefault();
    const t = state.tracks.find(x => x.id === state.pending.trackId);
    if (!t) return;
    const f = new FormData(e.target);
    t.title = (f.get('title') || '').toString().trim() || t.title;
    t.artist = (f.get('artist') || '').toString().trim() || t.artist;
    t.album = (f.get('album') || '').toString().trim() || t.album;
    t.year = (f.get('year') || '').toString().trim();
    t.genre = (f.get('genre') || '').toString().trim();
    await store.putTrack(t);
    closeSheets();
    await refresh();
    renderPlayer();
    toast('Etiquetas guardadas', 'ok');
  };

  $('btnRequestPersist').onclick = async () => {
    const ok = await store.persist();
    toast(ok ? 'Almacenamiento permanente activado' : 'El navegador no dio almacenamiento permanente', ok ? 'ok' : 'err');
  };
  $('btnExportAll').onclick = async () => {
    const r = await exportBackup();
    toast(`Respaldo con ${r.tracks} canciones y ${r.playlists} playlists`, 'ok');
  };
  $('btnImportBackup').onclick = () => $('backupInput').click();
  $('backupInput').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await importBackup(f);
      await refresh(false);
      toast(`${r.restored} canciones restauradas`, 'ok');
    } catch (err) {
      toast('Respaldo invalido: ' + err.message, 'err');
    }
  };
  $('btnClearAll').onclick = async () => {
    if (!confirm('Borrar TODAS las canciones y playlists del celu? No se puede deshacer.')) return;
    if (!confirm('Seguro? Perdes la biblioteca completa.')) return;
    await store.clearTracks();
    await store.clearPlaylists();
    await store.setMeta('last', null);
    state.tracks = [];
    state.playlists = [];
    for (const id of [...state.artUrls.keys()]) releaseArt(id);
    player.clearQueue();
    await refresh(false);
    toast('Biblioteca vacia');
  };
  $('btnInstall').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('btnInstall').hidden = true;
  };

  wireSeek();
  wireKeys();
}

function openTrackMenu(id, ev) {
  const t = state.tracks.find(x => x.id === id);
  if (!t) return;
  ev?.stopPropagation();
  const act = prompt(
    `Acciones para "${t.title}"\n\n` +
      `1 - Reproducir ahora\n` +
      `2 - Agregar a la cola\n` +
      `3 - ${t.liked ? 'Quitar de' : 'Marcar como'} favorita\n` +
      `4 - ${t.saved ? 'Quitar del' : 'Guardar en'} el celu\n` +
      `5 - Agregar a playlist\n` +
      `6 - Editar etiquetas\n` +
      `7 - Guardar archivo en Descargas\n` +
      `8 - Borrar de la biblioteca`,
    '1'
  );
  const n = parseInt(act, 10);
  if (!n) return;
  if (n === 1) {
    const list = visibleTracks();
    const i = list.findIndex(x => x.id === id);
    playListOf(list, i < 0 ? 0 : i);
  } else if (n === 2) {
    player.addToQueue([t]);
    toast('Agregada a la cola');
  } else if (n === 3) toggleLike(id);
  else if (n === 4) toggleSaved(id);
  else if (n === 5) openAddSheet(id);
  else if (n === 6) openTagSheet(t);
  else if (n === 7) doSaveToDevice(t);
  else if (n === 8) {
    if (confirm(`Borrar "${t.title}" de la biblioteca?`)) removeTrack(id);
  }
}

function openTagSheet(t) {
  if (!t) return;
  state.pending.trackId = t.id;
  const f = $('tagForm');
  f.title.value = t.title || '';
  f.artist.value = t.artist || '';
  f.album.value = t.album || '';
  f.year.value = t.year || '';
  f.genre.value = t.genre || '';
  openSheet('tagSheet');
}

function wireSeek() {
  let dragging = false;
  let ratio = 0;
  const setup = wrap => {
    const onDown = e => {
      dragging = true;
      player.userSeeking = true;
      wrap.classList.add('dragging');
      const r = wrap.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      ratio = Math.min(1, Math.max(0, x / r.width));
      setSeek(ratio * (player.audio.duration || 0), player.audio.duration || 0);
    };
    const onMove = e => {
      if (!dragging) return;
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      ratio = Math.min(1, Math.max(0, x / r.width));
      setSeek(ratio * (player.audio.duration || 0), player.audio.duration || 0);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      player.userSeeking = false;
      wrap.classList.remove('dragging');
      player.seekRatio(ratio);
    };
    wrap.addEventListener('mousedown', onDown);
    wrap.addEventListener('touchstart', onDown, { passive: true });
    wrap.addEventListener('mousemove', onMove);
    wrap.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    wrap.addEventListener('keydown', e => {
      const d = player.audio.duration || 0;
      if (e.key === 'ArrowRight') player.seek(player.audio.currentTime + (state.settings.skip || 10));
      else if (e.key === 'ArrowLeft') player.seek(player.audio.currentTime - (state.settings.skip || 10));
      else if (e.key === 'Home') player.seek(0);
      else if (e.key === 'End') player.seek(d);
    });
  };
  setup($('seekWrap'));
  setup($('seekWrap2'));
}

function wireKeys() {
  document.addEventListener('keydown', e => {
    const typing = /input|textarea|select/i.test(e.target.tagName);
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      player.toggle();
    } else if (e.key === '/') {
      e.preventDefault();
      $('searchBar').hidden = false;
      $('searchInput').focus();
    } else if (e.key === 'Escape') {
      if (!$('sheetBackdrop').hidden) closeSheets();
      else backToRoot();
    } else if (e.key.toLowerCase() === 'n') {
      player.next(true);
    } else if (e.key.toLowerCase() === 'p') {
      player.prev();
    } else if (e.key.toLowerCase() === 'f') {
      player.current && toggleLike(player.current.id);
    } else if (e.key.toLowerCase() === 's') {
      player.toggleShuffle();
    } else if (e.key.toLowerCase() === 'r') {
      player.cycleRepeat();
    } else if (e.key.toLowerCase() === 'e') {
      player.next(true);
    } else if (e.key.toLowerCase() === 'q') {
      player.repeat = 'off';
      syncToggles();
    } else if (e.key === 'ArrowRight' && e.shiftKey) {
      player.next(true);
    }
  });
}

/* ---------------- boot ---------------- */
const appVersion = '1.0.0';

async function boot() {
  state.settings.volume = await store.getMeta('volume', 0.8);
  state.settings.skip = await store.getMeta('skip', 10);
  state.settings.loudness = await store.getMeta('loudness', false);
  state.sort = await store.getMeta('sort', 'recent');
  state.filter = await store.getMeta('filter', 'all');

  wire();
  await loadAll();

  $('sortSelect').value = state.sort;
  $('volRange').value = state.settings.volume;
  $('volRange2').value = state.settings.volume;
  $('volOut').textContent = Math.round(state.settings.volume * 100) + '%';
  $('skipInput').value = state.settings.skip;
  $('loudnessChk').checked = state.settings.loudness;
  player.setVolume(state.settings.volume);
  player.setLoudness(state.settings.loudness);
  player.bindMediaSession();
  updateNetPill();

  player.addEventListener('volume', v => {
    $('volRange').value = v;
    $('volRange2').value = v;
    $('volOut').textContent = Math.round(v * 100) + '%';
    store.setMeta('volume', v);
  });

  const last = await store.getMeta('last', null);
  if (last?.queueIds?.length) {
    const byId = new Map(state.tracks.map(t => [t.id, t]));
    const queue = last.queueIds.map(id => byId.get(id)).filter(Boolean);
    if (queue.length) {
      player.queue = queue;
      player.index = last.index >= 0 && last.index < queue.length ? last.index : 0;
      player.shuffle = !!last.shuffle;
      player.repeat = last.repeat || 'off';
      const cur = queue[player.index];
      const resume = Math.min(last.time || 0, cur.duration || 0);
      const url = trackUrl(cur);
      player.audio.src = url;
      player.audio.load();
      if (resume > 5) player.audio.addEventListener('loadedmetadata', () => player.seek(resume), { once: true });
      renderPlayer();
      setSeek(resume, cur.duration || 0);
    }
  }
  syncToggles();
  renderAll();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  state.boot = true;
}

window.addEventListener('beforeunload', () => {
  if (state.boot) persistNowPlaying();
});

boot().catch(err => {
  console.error(err);
  toast('Error al iniciar: ' + err.message, 'err');
});
