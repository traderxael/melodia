const dec = {
  latin: new TextDecoder('iso-8859-1'),
  utf8: new TextDecoder('utf-8'),
  utf16: new TextDecoder('utf-16'),
  utf16be: new TextDecoder('utf-16be'),
};

function clean(s) {
  if (!s) return '';
  return s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimFixed(s) {
  return clean(s.replace(/\u0000/g, ' '));
}

function decodeText(bytes, enc) {
  if (!bytes || !bytes.length) return '';
  try {
    if (enc === 0) return dec.latin.decode(bytes);
    if (enc === 1) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return dec.utf16.decode(bytes.subarray(2));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return dec.utf16be.decode(bytes.subarray(2));
      return dec.utf16.decode(bytes);
    }
    if (enc === 2) return dec.utf16be.decode(bytes);
    return dec.utf8.decode(bytes);
  } catch {
    return dec.latin.decode(bytes);
  }
}

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}
function uint32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function findZero(b, start, end) {
  for (let i = start; i < end; i++) if (b[i] === 0) return i;
  return end;
}

/* ---------------- ID3v2 ---------------- */
function parseID3v2(view, tags) {
  const b = view.bytes;
  if (b.length < 10) return 10;
  const major = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let p = 10;
  if (flags & 0x40) {
    const ext = syncsafe(b, 10);
    p = 10 + ext;
  }
  const end = Math.min(b.length, 10 + size);
  const idLen = major === 2 ? 3 : 4;
  const sizeLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;

  while (p + hdrLen <= end) {
    const id = dec.latin.decode(b.subarray(p, p + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let fsize;
    if (major === 2) fsize = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    else if (major === 3) fsize = uint32(b, p + 4);
    else fsize = syncsafe(b, p + 4);
    const fflags = major === 2 ? 0 : ((b[p + 8] << 8) | b[p + 9]);
    let data = b.subarray(p + hdrLen, p + hdrLen + fsize);
    if (fflags & 0x0001 && major === 4) {
      const dl = syncsafe(data, 0);
      data = data.subarray(dl);
    }
    if (id === 'TIT2' || id === 'TT2') tags.title = clean(firstText(data));
    else if (id === 'TPE1' || id === 'TP1') tags.artist = clean(firstText(data));
    else if (id === 'TPE2' || id === 'TP2') tags.albumArtist = clean(firstText(data));
    else if (id === 'TALB' || id === 'TAL') tags.album = clean(firstText(data));
    else if (id === 'TCON' || id === 'TCO') tags.genre = clean(firstText(data));
    else if (id === 'TRCK' || id === 'TRK') {
      const n = parseInt(firstText(data), 10);
      if (n) tags.trackNo = n;
    }
    else if (id === 'TYER' || id === 'TDRC' || id === 'TYE' || id === 'TDRL') {
      const y = clean(firstText(data));
      if (/^\d{4}/.test(y)) tags.year = y.slice(0, 4);
    }
    else if (id === 'APIC' || id === 'PIC') {
      if (!tags.art) tags.art = parseAPIC(data, major === 2);
    }
    p += hdrLen + fsize;
    if (fsize <= 0) break;
  }
  return 10 + size;
}

function firstText(data) {
  if (!data || !data.length) return '';
  const enc = data[0];
  const s = decodeText(data.subarray(1), enc);
  const nul = s.indexOf('\u0000');
  return nul >= 0 ? s.slice(0, nul) : s;
}

function parseAPIC(data, v22) {
  if (!data || data.length < 4) return null;
  const enc = data[0];
  let p = 1;
  let mime;
  if (v22) {
    mime = dec.latin.decode(data.subarray(p, p + 3));
    p += 3;
  } else {
    const z = findZero(data, p, data.length);
    mime = dec.latin.decode(data.subarray(p, z));
    p = z + 1;
  }
  p += 1;
  const z = findZero(data, p, data.length);
  p = z + 1;
  const bytes = data.subarray(p);
  if (!bytes.length) return null;
  if (!mime || mime === '-->') mime = 'image/jpeg';
  return { blob: new Blob([bytes], { type: mime }), mime };
}

/* ---------------- ID3v1 ---------------- */
function parseID3v1(view, tags) {
  const b = view.bytes;
  if (b.length < 128) return;
  const tail = b.subarray(b.length - 128);
  if (dec.latin.decode(tail.subarray(0, 3)) !== 'TAG') return;
  const txt = (o, l) => trimFixed(dec.latin.decode(tail.subarray(o, o + l)));
  if (!tags.title) tags.title = txt(3, 30);
  if (!tags.artist) tags.artist = txt(33, 30);
  if (!tags.album) tags.album = txt(63, 30);
  if (!tags.year) {
    const y = txt(93, 4);
    if (/^\d{4}$/.test(y)) tags.year = y;
  }
}

/* ---------------- MP4 / M4A ---------------- */
function parseMP4(view, tags) {
  const b = view.bytes;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  let found = false;
  const MAX = Math.min(b.length, 8 * 1024 * 1024);

  function* atoms(start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = dec.latin.decode(b.subarray(p + 4, p + 8));
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        const hi = dv.getUint32(p + 8);
        const lo = dv.getUint32(p + 12);
        size = hi * 4294967296 + lo;
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) {
        if (size < hdr) { p += hdr; continue; }
        break;
      }
      yield { type, start: p + hdr, end: p + size, size };
      p += size;
    }
  };

  for (const a of atoms(0, MAX)) {
    if (a.type !== 'moov') continue;
    found = true;
    for (const u of atoms(a.start, a.end)) {
      if (u.type !== 'udta') continue;
      for (const m of atoms(u.start, u.end)) {
        if (m.type !== 'meta') continue;
        for (const il of atoms(m.start + 4, m.end)) {
          if (il.type !== 'ilst') continue;
          for (const it of atoms(il.start, il.end)) {
            let val = '';
            for (const d of atoms(it.start, it.end)) {
              if (d.type === 'data' && d.end - d.start > 8) {
                const flags = dv.getUint32(d.start) & 0xffffff;
                const raw = b.subarray(d.start + 8, d.end);
                if (it.type === 'trkn' || it.type === 'disk') {
                  if (raw.length >= 4) {
                    const n = dv.getUint16(d.start + 8 + 2);
                    if (n && !tags.trackNo) tags.trackNo = n;
                  }
                } else if (it.type === 'covr') {
                  if (!tags.art) {
                    const mime = flags === 13 ? 'image/jpeg' : 'image/png';
                    tags.art = { blob: new Blob([raw], { type: mime }), mime };
                  }
                } else if (flags === 1) {
                  val = dec.utf8.decode(raw);
                } else if (flags === 0) {
                  val = dec.latin.decode(raw);
                }
              }
            }
            const t = clean(val);
            if (!t) continue;
            if (it.type === '©nam' && !tags.title) tags.title = t;
            else if (it.type === '©ART' && !tags.artist) tags.artist = t;
            else if (it.type === 'aART' && !tags.albumArtist) tags.albumArtist = t;
            else if (it.type === '©alb' && !tags.album) tags.album = t;
            else if (it.type === '©gen' && !tags.genre) tags.genre = t;
            else if (it.type === '©day' && !tags.year) {
              const y = t.slice(0, 4);
              if (/^\d{4}$/.test(y)) tags.year = y;
            }
          }
        }
      }
    }
  }
  return found;
}

/* ---------------- FLAC ---------------- */
function parseFLAC(view, tags) {
  const b = view.bytes;
  if (dec.latin.decode(b.subarray(0, 4)) !== 'fLaC') return false;
  let p = 4;
  while (p + 4 <= b.length) {
    const last = (b[p] & 0x80) !== 0;
    const type = b[p] & 0x7f;
    const size = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const start = p + 4;
    if (start + size > b.length) break;
    if (type === 0) {
      const min = (b[start + 1] << 8) | b[start + 2];
      tags.bitrate = Math.round(min / 1000);
    } else if (type === 4) {
      parseVorbisComments(b.subarray(start, start + size), tags);
    } else if (type === 6) {
      if (!tags.art) {
        const dv = new DataView(view.buffer, view.byteOffset + start, size);
        const mimeLen = dv.getUint32(0);
        const mime = dec.latin.decode(b.subarray(start + 4, start + 4 + mimeLen));
        const dim = dv.getUint32(4 + mimeLen);
        const depth = dv.getUint32(8 + mimeLen);
        const dlen = dv.getUint32(12 + mimeLen);
        const dOff = start + 4 + mimeLen + 16 + dim * depth;
        const bytes = b.subarray(dOff, dOff + dlen);
        if (bytes.length) tags.art = { blob: new Blob([bytes], { type: mime || 'image/jpeg' }), mime };
      }
    }
    p = start + size;
    if (last) break;
  }
  return true;
}

/* ---------------- Vorbis comments (OGG / Opus / FLAC) ---------------- */
function parseVorbisComments(b, tags) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const vlen = dv.getUint32(p, true);
  p += 4 + vlen;
  const count = dv.getUint32(p, true);
  p += 4;
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = dv.getUint32(p, true);
    p += 4;
    if (p + len > b.length) break;
    const entry = dec.utf8.decode(b.subarray(p, p + len));
    p += len;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const k = entry.slice(0, eq).toUpperCase();
    const v = clean(entry.slice(eq + 1));
    if (!v) continue;
    if (k === 'TITLE' && !tags.title) tags.title = v;
    else if (k === 'ARTIST' && !tags.artist) tags.artist = v;
    else if (k === 'ALBUMARTIST' && !tags.albumArtist) tags.albumArtist = v;
    else if (k === 'ALBUM' && !tags.album) tags.album = v;
    else if (k === 'GENRE' && !tags.genre) tags.genre = v;
    else if (k === 'DATE' && !tags.year) {
      const y = v.slice(0, 4);
      if (/^\d{4}$/.test(y)) tags.year = y;
    } else if (k === 'TRACKNUMBER' && !tags.trackNo) {
      const n = parseInt(v, 10);
      if (n) tags.trackNo = n;
    } else if (k === 'METADATA_BLOCK_PICTURE' && !tags.art) {
      try {
        const raw = atob(v);
        const arr = new Uint8Array(raw.length);
        for (let j = 0; j < raw.length; j++) arr[j] = raw.charCodeAt(j);
        const inner = arr.buffer;
        const idv = new DataView(inner);
        const mimeLen = idv.getUint32(0);
        const mime = dec.latin.decode(arr.subarray(4, 4 + mimeLen));
        const dim = idv.getUint32(4 + mimeLen);
        const depth = idv.getUint32(8 + mimeLen);
        const dlen = idv.getUint32(12 + mimeLen);
        const dOff = 4 + mimeLen + 16 + dim * depth;
        const bytes = arr.subarray(dOff, dOff + dlen);
        if (bytes.length) tags.art = { blob: new Blob([bytes], { type: mime || 'image/jpeg' }), mime };
      } catch {}
    }
  }
}

function parseOGG(view, tags) {
  const b = view.bytes;
  if (dec.latin.decode(b.subarray(0, 4)) !== 'OggS') return false;
  let p = 28;
  let serial = null;
  for (let i = 0; i < 3 && p + 27 <= b.length; i++) {
    const segs = b[p + 26];
    p += 27;
    let total = 0;
    for (let s = 0; s < segs; s++) {
      total += b[p + s];
    }
    p += segs;
    if (total > 0 && p + total <= b.length) {
      const chunk = b.subarray(p, p + Math.min(total, 8 * 1024 * 1024));
      const head = dec.latin.decode(chunk.subarray(0, 8));
      if (head.startsWith('OpusHead')) {
        tags.mime = 'audio/ogg; codecs=opus';
        if (chunk.length >= 19) {
          tags.sampleRate = new DataView(chunk.buffer, chunk.byteOffset).getUint32(12, true);
        }
      } else if (head.startsWith('vorbis')) {
        tags.mime = 'audio/ogg; codecs=vorbis';
        if (chunk.length > 7) parseVorbisComments(chunk.subarray(7), tags);
      }
      if (serial === null && i === 0) serial = b.subarray(18, 22);
    }
    p += total;
  }
  return true;
}

/* ---------------- MP3 duration ---------------- */
const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V1L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const BITRATES_V2L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const BITRATES_V2L2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3HeaderAt(b, from) {
  for (let i = from; i < Math.min(b.length - 4, from + 128 * 1024); i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (b[i + 1] >> 3) & 3;
    const layerBits = (b[i + 1] >> 1) & 3;
    if (verBits === 1 || layerBits === 0) continue;
    const brIdx = (b[i + 2] >> 4) & 0xf;
    const srIdx = (b[i + 2] >> 2) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const ver = verBits;
    const layer = 4 - layerBits;
    const table =
      ver === 3 ? (layer === 1 ? BITRATES_V1L1 : layer === 2 ? BITRATES_V1L2 : BITRATES_V1L3)
      : ver === 2 ? (layer === 1 ? BITRATES_V2L1 : BITRATES_V2L2)
      : layer === 1 ? BITRATES_V1L1 : layer === 2 ? BITRATES_V2L2 : BITRATES_V2L1;
    const kbps = table[brIdx];
    const sr = RATES[ver][srIdx];
    if (!kbps || !sr) continue;
    const padding = (b[i + 2] >> 1) & 1;
    const samples = layer === 1 ? 384 : 1152;
    const len = layer === 1 ? (12 * kbps * 1000 / sr + padding) * 4 : (samples / 8) * kbps * 1000 / sr + padding;
    return { kbps, sr, frameLen: Math.floor(len), samples, channelMode: (b[i + 3] >> 6) & 3 };
  }
  return null;
}

function estimateMp3Duration(view, audioStart, fileSize) {
  const h = mp3HeaderAt(view.bytes, audioStart);
  if (!h) return 0;
  const bytes = Math.max(0, fileSize - audioStart);
  if (h.kbps > 0) return Math.round((bytes * 8) / (h.kbps * 1000));
  if (h.sr) return Math.round(bytes / (h.sr * 2));
  return 0;
}

/* ---------------- public API ---------------- */
export async function readTags(blob) {
  const tags = { title: '', artist: '', album: '', albumArtist: '', genre: '', year: '', trackNo: 0 };
  const head = blob.slice(0, 2 * 1024 * 1024);
  const buf = await head.arrayBuffer();
  const view = new DataView(buf);
  const view2 = { buffer: buf, byteOffset: 0, byteLength: buf.byteLength, bytes: new Uint8Array(buf) };

  let audioStart = 0;
  try {
    const isFlac = parseFLAC(view2, tags);
    const isOgg = parseOGG(view2, tags);
    if (!isFlac && !isOgg) {
      audioStart = parseID3v2(view2, tags) || 0;
      if (audioStart < 10) audioStart = 0;
      else {
        const probe = blob.slice(audioStart, audioStart + 4);
        const sig = new Uint8Array(await probe.arrayBuffer());
        const id3 = String.fromCharCode(...sig);
        if (id3 === 'ID3' || id3 === 'ftyp') audioStart = 0;
      }
      if (!parseMP4(view2, tags)) {
        if (head.size > 128) parseID3v1(view2, tags);
      }
    }
  } catch {}

  if (!tags.title) tags.title = '';
  if (head.size > 128) {
    const tailBuf = await blob.slice(Math.max(0, blob.size - 256), blob.size).arrayBuffer();
    const tailView = { bytes: new Uint8Array(tailBuf) };
    parseID3v1(tailView, tags);
  }

  const name = (blob.name || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_/g, ' ').trim();
  if (!tags.title) tags.title = name || 'Sin titulo';
  if (!tags.artist) tags.artist = 'Artista desconocido';
  if (!tags.album) tags.album = tags.artist;
  if (!tags.albumArtist) tags.albumArtist = tags.artist;

  let estDuration = 0;
  const mime = blob.type || '';
  const fileName = blob.name || '';
  if (/^audio\/(mpeg|mp3)$/i.test(mime) || /\.mp3$/i.test(fileName)) {
    estDuration = estimateMp3Duration(view2, audioStart, blob.size);
  }

  return { tags, audioStart, estDuration };
}

export function guessMime(name, fallback = 'audio/mpeg') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    wave: 'audio/wav',
    flac: 'audio/flac',
    webm: 'audio/webm',
    aiff: 'audio/aiff',
    aif: 'audio/aiff',
    mka: 'audio/x-matroska',
  };
  return map[ext] || fallback;
}
