const urlCache = new Map();
const artUrls = new Map();
const URL_LIMIT = 4;

function cacheUrl(track) {
  if (urlCache.has(track.id)) {
    const hit = urlCache.get(track.id);
    urlCache.delete(track.id);
    urlCache.set(track.id, hit);
    return hit;
  }
  const url = URL.createObjectURL(track.audio);
  urlCache.set(track.id, url);
  while (urlCache.size > URL_LIMIT) {
    const oldest = urlCache.keys().next().value;
    URL.revokeObjectURL(urlCache.get(oldest));
    urlCache.delete(oldest);
  }
  return url;
}

export function trackUrl(track) {
  return cacheUrl(track);
}

export function releaseUrl(id) {
  if (urlCache.has(id)) {
    URL.revokeObjectURL(urlCache.get(id));
    urlCache.delete(id);
  }
  if (artUrls.has(id)) {
    URL.revokeObjectURL(artUrls.get(id));
    artUrls.delete(id);
  }
}

export function releaseAllUrls() {
  for (const id of [...urlCache.keys()]) releaseUrl(id);
  for (const id of [...artUrls.keys()]) releaseUrl(id);
}

export class Player extends EventTarget {
  constructor(audioEl) {
    super();
    this.audio = audioEl;
    this.queue = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.history = [];
    this.userSeeking = false;
    this.loudness = false;
    this.volume = 0.8;
    this.preloadId = null;
    this._bindAudio();
  }

  get current() {
    return this.index >= 0 ? this.queue[this.index] : null;
  }

  _emitBuffer() {
    const a = this.audio;
    if (!a.buffered.length) return;
    const dur = this._duration();
    if (dur <= 0) return;
    this._emit('buffer', a.buffered.end(a.buffered.length - 1) / dur);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _duration() {
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    const known = this.current?.duration;
    return Number.isFinite(known) && known > 0 ? known : 0;
  }

  _bindAudio() {
    const a = this.audio;
    a.volume = this.volume;

    a.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(a.duration) && a.duration > 0) {
        const t = this.current;
        if (t && !t.duration) {
          t.duration = a.duration;
          this._emit('duration', t);
        }
        this._emit('ready');
      }
    });

    a.addEventListener('timeupdate', () => {
      if (!this.userSeeking) this._emit('time', { current: a.currentTime, duration: this._duration() });
      this._emitBuffer();
    });

    a.addEventListener('progress', () => this._emitBuffer());
    a.addEventListener('durationchange', () => this._emitBuffer());

    a.addEventListener('play', () => {
      this._applyLoudness();
      this._emit('state', 'playing');
      this._updateSession();
    });
    a.addEventListener('pause', () => {
      this._emit('state', 'paused');
      this._updateSession();
    });
    a.addEventListener('waiting', () => this._emit('state', 'buffering'));
    a.addEventListener('playing', () => this._emit('state', 'playing'));
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => {
      const t = this.current;
      const code = a.error?.code;
      const msg =
        code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? `El celu no puede reproducir este formato (${t ? t.ext || '?' : '?'}). Convertilo a MP3 o M4A.`
          : 'No se pudo reproducir esta cancion.';
      this._emit('error', { track: t, message: msg });
      this._emit('state', 'paused');
    });
  }

  setLoudness(on) {
    this.loudness = on;
    this._applyLoudness();
  }

  _applyLoudness() {
    if (!('preservesPitch' in this.audio)) return;
    this.audio.preservesPitch = !this.loudness;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.audio.volume = this.volume;
    this._emit('volume', this.volume);
  }

  async play() {
    if (this.index < 0) return this.playIndex(0);
    if (!this.audio.src) this._load(this.current);
    try {
      await this.audio.play();
    } catch (err) {
      if (err?.name !== 'AbortError') this._emit('error', { message: 'El navegador bloqueo la reproduccion automatica. Toca el boton de play.' });
    }
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  _load(track) {
    if (!track) return;
    const url = trackUrl(track);
    this.audio.src = url;
    this.audio.load();
    this._emit('track', track);
    this._emit('time', { current: 0, duration: track.duration || 0 });
    this._emit('buffer', 0);
    this._preloadNext();
    this._updateSession();
  }

  async playIndex(i, autoplay = true) {
    if (i < 0 || i >= this.queue.length) return;
    if (this.index >= 0 && this.index !== i) this.history.push(this.index);
    if (this.history.length > 100) this.history.shift();
    this.index = i;
    this._load(this.queue[i]);
    if (autoplay) {
      try {
        await this.audio.play();
      } catch {}
    }
  }

  setQueue(tracks, startIndex = 0, autoplay = true) {
    this.queue = tracks.slice();
    this.index = -1;
    this.history = [];
    if (!this.queue.length) {
      this.stop();
      this._emit('queue', this.queue);
      return;
    }
    this.playIndex(startIndex, autoplay);
    this._emit('queue', this.queue);
  }

  addToQueue(tracks, { play = false } = {}) {
    this.queue.push(...tracks);
    this._emit('queue', this.queue);
    if (this.index < 0 && this.queue.length) this.playIndex(0, play);
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    const wasCurrent = i === this.index;
    this.queue.splice(i, 1);
    this._emit('queue', this.queue);
    if (wasCurrent) {
      if (!this.queue.length) this.stop();
      else this.playIndex(Math.min(i, this.queue.length - 1));
    } else if (i < this.index) {
      this.index--;
      this.history = this.history.map(h => (h > i ? h - 1 : h)).filter(h => h !== i);
    }
  }

  clearQueue() {
    this.queue = [];
    this.history = [];
    this.stop();
    this._emit('queue', this.queue);
  }

  reorder(from, to) {
    if (from === to) return;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this._emit('queue', this.queue);
  }

  moveCurrent(dir) {
    const i = this.index;
    const to = i + dir;
    if (to < 0 || to >= this.queue.length) return;
    this.playIndex(to);
  }

  next(user = true) {
    if (this.repeat === 'one' && !user) {
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    if (user) {
      const i = this.index;
      if (i >= 0) this.history.push(i);
      if (this.history.length > 100) this.history.shift();
    }
    let n;
    if (this.shuffle) n = this._randomIndex();
    else n = this.index + 1;
    if (n >= this.queue.length) {
      if (this.repeat === 'all') n = 0;
      else {
        this.audio.pause();
        this.audio.currentTime = 0;
        if (this.queue.length && this.index >= 0) this.index = 0;
        this._emit('track', this.current);
        this._emit('state', 'paused');
        return;
      }
    }
    this.index = n;
    this._load(this.queue[n]);
    this.play();
  }

  _randomIndex() {
    if (this.queue.length <= 1) return Math.max(0, this.index);
    let n = this.index;
    let guard = 0;
    while (n === this.index && guard++ < 40) n = Math.floor(Math.random() * this.queue.length);
    return n;
  }

  prev() {
    if (this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    if (this.history.length) {
      const p = this.history.pop();
      this.index = p;
      this._load(this.queue[p]);
      this.play();
      return;
    }
    if (this.shuffle) {
      const n = this._randomIndex();
      if (n !== this.index) {
        this.index = n;
        this._load(this.queue[n]);
        this.play();
        return;
      }
    }
    if (this.index > 0) {
      this.index--;
      this._load(this.queue[this.index]);
      this.play();
    } else {
      this.seek(0);
    }
  }

  onEnded() {
    const t = this.current;
    if (t) {
      t.playCount = (t.playCount || 0) + 1;
      this._emit('played', t);
    }
    this.next(false);
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.index = -1;
    this._emit('state', 'stopped');
    this._emit('track', null);
  }

  seek(sec) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.min(Math.max(0, sec), this.audio.duration - 0.05);
    this._emit('time', { current: this.audio.currentTime, duration: this.audio.duration });
  }

  seekRatio(r) {
    if (Number.isFinite(this.audio.duration)) this.seek(r * this.audio.duration);
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    this._emit('repeat', this.repeat);
    this._updateSession();
    return this.repeat;
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this._emit('shuffle', this.shuffle);
    return this.shuffle;
  }

  _preloadNext() {
    const n = this.index + 1;
    if (n < this.queue.length && this.queue[n] && this.queue[n] !== this.preloadId) {
      this.preloadId = this.queue[n].id;
      try {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = trackUrl(this.queue[n]);
        document.head.appendChild(link);
        setTimeout(() => link.remove(), 8000);
      } catch {}
    }
  }

  _updateSession() {
    if (!('mediaSession' in navigator)) return;
    const t = this.current;
    if (!t) return;
    let artwork;
    if (t.art) {
      if (!artUrls.has(t.id)) artUrls.set(t.id, URL.createObjectURL(t.art));
      artwork = [{ src: artUrls.get(t.id), sizes: '512x512', type: t.artMime || 'image/jpeg' }];
    } else {
      artwork = [{ src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album,
        artwork,
      });
      navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
    } catch {}
  }

  bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const h = {
      play: () => this.play(),
      pause: () => this.pause(),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(true),
      seekbackward: d => this.seek(this.audio.currentTime - (d?.seekOffset || 10)),
      seekforward: d => this.seek(this.audio.currentTime + (d?.seekOffset || 10)),
      seekto: d => this.seek(d.seekTime),
      stop: () => this.stop(),
    };
    for (const [k, fn] of Object.entries(h)) {
      try {
        navigator.mediaSession.setActionHandler(k, fn);
      } catch {}
    }
  }
}
