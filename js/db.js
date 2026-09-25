const DB_NAME = 'melodia';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('addedAt', 'addedAt');
        s.createIndex('albumKey', 'albumKey');
        s.createIndex('artistKey', 'artistKey');
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Cierra las otras pestanas de Melodia para actualizar.'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try {
      result = fn(s);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaccion cancelada'));
  }));
}

const wrap = req => ({ __req: req });

function reqp(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

export const store = {
  async allTracks() {
    const db = await open();
    return reqp(db.transaction('tracks').objectStore('tracks').getAll());
  },
  async getTrack(id) {
    const db = await open();
    return reqp(db.transaction('tracks').objectStore('tracks').get(id));
  },
  async putTrack(track) {
    await tx('tracks', 'readwrite', s => s.put(track));
    return track;
  },
  async putTracks(tracks) {
    await tx('tracks', 'readwrite', s => { tracks.forEach(t => s.put(t)); });
    return tracks;
  },
  async deleteTrack(id) {
    await tx('tracks', 'readwrite', s => s.delete(id));
  },
  async clearTracks() {
    await tx('tracks', 'readwrite', s => s.clear());
  },

  async allPlaylists() {
    const db = await open();
    return reqp(db.transaction('playlists').objectStore('playlists').getAll());
  },
  async putPlaylist(pl) {
    await tx('playlists', 'readwrite', s => s.put(pl));
    return pl;
  },
  async deletePlaylist(id) {
    await tx('playlists', 'readwrite', s => s.delete(id));
  },
  async clearPlaylists() {
    await tx('playlists', 'readwrite', s => s.clear());
  },

  async getMeta(key, fallback = null) {
    const db = await open();
    const row = await reqp(db.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : fallback;
  },
  async setMeta(key, value) {
    await tx('meta', 'readwrite', s => s.put({ key, value }));
    return value;
  },
  async estimate() {
    if (navigator.storage?.estimate) {
      try {
        return await navigator.storage.estimate();
      } catch {}
    }
    return { usage: 0, quota: 0 };
  },
  async persist() {
    if (navigator.storage?.persist) {
      try {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch {}
    }
    return false;
  }
};

export { wrap };
