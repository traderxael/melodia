import { readTags, guessMime } from '../js/tags.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'ok  ' : 'FALLO'} ${name}${ok ? '' : `  ->  "${actual}" (esperado "${expected}")`}`);
}

const enc = new TextEncoder();

function frame(id, payload) {
  const size = payload.length;
  return Buffer.concat([
    Buffer.from(id, 'latin1'),
    Buffer.from([(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, 0, 0]),
    payload,
  ]);
}

function textFrame(id, str) {
  return frame(id, Buffer.concat([Buffer.from([0x03]), enc.encode(str), Buffer.from([0x00])]));
}

function syncSafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function id3v2(frames, { version = 3, padding = 0 } = {}) {
  const body = Buffer.concat(frames);
  const size = body.length + padding;
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([version, 0, 0]),
    syncSafe(size),
    body,
    Buffer.alloc(padding),
  ]);
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function apicFrame(mime, image) {
  return frame(
    'APIC',
    Buffer.concat([
      Buffer.from([0x03]),
      Buffer.from(mime + '\x00', 'latin1'),
      Buffer.from([0x03]),
      Buffer.from('cover\x00', 'latin1'),
      image,
    ])
  );
}

function mpegFrame({ bitrateIdx = 9, srIdx = 0, padding = 0 } = {}) {
  const b1 = 0xff;
  const b2 = 0xfb;
  const b3 = (bitrateIdx << 4) | (srIdx << 2) | (padding << 1);
  return Buffer.from([b1, b2, b3, 0x00, ...new Array(413).fill(0)]);
}

const blobOf = buf => new Blob([buf], { type: 'audio/mpeg' });

/* ---------- 1. ID3v2.3 completo ---------- */
{
  const audio = Buffer.concat([mpegFrame(), mpegFrame(), mpegFrame()]);
  const file = Buffer.concat([
    id3v2([
      textFrame('TIT2', 'Cancion de Prueba'),
      textFrame('TPE1', 'Artista Uno'),
      textFrame('TALB', 'Album Uno'),
      textFrame('TPE2', 'Artista Del Album'),
      textFrame('TCON', 'Rock'),
      textFrame('TRCK', '3/12'),
      textFrame('TYER', '2019'),
      apicFrame('image/png', PNG_1x1),
    ]),
    audio,
  ]);
  const { tags, audioStart } = await readTags(blobOf(file));
  check('ID3v2 titulo', tags.title, 'Cancion de Prueba');
  check('ID3v2 artista', tags.artist, 'Artista Uno');
  check('ID3v2 album', tags.album, 'Album Uno');
  check('ID3v2 artista de album', tags.albumArtist, 'Artista Del Album');
  check('ID3v2 genero', tags.genre, 'Rock');
  check('ID3v2 pista', tags.trackNo, 3);
  check('ID3v2 anio', tags.year, '2019');
  check('ID3v2 caratula', tags.art?.mime, 'image/png');
  check('ID3v2 caratula bytes', tags.art?.blob.size, PNG_1x1.length);
  check('ID3v2 inicio del audio', audioStart, file.length - audio.length);
}

/* ---------- 2. ID3v2.4 con sinchronizacion y UTF-16 ---------- */
{
  const utf16 = Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), Buffer.from('Ñandú Canción', 'utf16le'), Buffer.from([0x00, 0x00])]);
  const frames = [frame('TIT2', utf16), textFrame('TPE1', 'Banda Beta')];
  const file = Buffer.concat([id3v2(frames, { version: 4 }), mpegFrame()]);
  const { tags } = await readTags(blobOf(file));
  check('ID3v2.4 UTF-16 titulo', tags.title, 'Ñandú Canción');
  check('ID3v2.4 artista', tags.artist, 'Banda Beta');
}

/* ---------- 3. ID3v1 como respaldo ---------- */
{
  const pad = Buffer.alloc(100);
  const title = 'Viejo Etiqueta'.padEnd(30, '\x00');
  const artist = 'Artista Clasico'.padEnd(30, '\x00');
  const album = 'Disco 1998'.padEnd(30, '\x00');
  const year = '1998'.padEnd(4, '\x00');
  const tag = Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.from(title, 'latin1'), Buffer.from(artist, 'latin1'), Buffer.from(album, 'latin1'), Buffer.from(year, 'latin1'), Buffer.alloc(30), Buffer.from([12])]);
  const file = Buffer.concat([mpegFrame(), pad, tag]);
  const { tags } = await readTags(blobOf(file));
  check('ID3v1 titulo', tags.title, 'Viejo Etiqueta');
  check('ID3v1 artista', tags.artist, 'Artista Clasico');
  check('ID3v1 album', tags.album, 'Disco 1998');
  check('ID3v1 anio', tags.year, '1998');
}

/* ---------- 4. MP4 / M4A ---------- */
{
  const atom = (type, ...payload) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), ...payload]);
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(8 + body.length, 0);
    body.copy(out, 4);
    return out;
  };
  const dataAtom = (value, flags = 1) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(value.length + 16);
    const fl = Buffer.alloc(4);
    fl.writeUInt32BE(flags);
    return Buffer.concat([len, Buffer.from('data', 'latin1'), fl, Buffer.alloc(4), value]);
  };
  const ilst = atom(
    'ilst',
    atom('©nam', dataAtom(enc.encode('Titulo M4A'))),
    atom('©ART', dataAtom(enc.encode('Artista M4A'))),
    atom('©alb', dataAtom(enc.encode('Album M4A'))),
    atom('aART', dataAtom(enc.encode('Album Artist M4A'))),
    atom('covr', dataAtom(PNG_1x1, 13)),
    atom('trkn', dataAtom(Buffer.from([0, 0, 0, 7, 0, 0, 0, 0]), 0))
  );
  const meta = atom('meta', Buffer.alloc(4), atom('hdlr', Buffer.alloc(20)), ilst);
  const udta = atom('udta', meta);
  const moov = atom('moov', atom('mvhd', Buffer.alloc(100)), udta);
  const ftyp = atom('ftyp', Buffer.from('M4A isom', 'latin1'));
  const file = Buffer.concat([ftyp, moov, mpegFrame()]);
  const { tags } = await readTags(new Blob([file], { type: 'audio/mp4' }));
  check('MP4 titulo', tags.title, 'Titulo M4A');
  check('MP4 artista', tags.artist, 'Artista M4A');
  check('MP4 album', tags.album, 'Album M4A');
  check('MP4 artista de album', tags.albumArtist, 'Album Artist M4A');
  check('MP4 caratula', tags.art?.mime, 'image/jpeg');
  check('MP4 pista', tags.trackNo, 7);
}

/* ---------- 5. FLAC con Vorbis comments ---------- */
{
  const vcomment = entries => {
    const vendor = enc.encode('test');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(vendor.length);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(entries.length);
    const parts = [len, vendor, count];
    for (const e of entries) {
      const l = Buffer.alloc(4);
      l.writeUInt32LE(enc.encode(e).length);
      parts.push(l, enc.encode(e));
    }
    return Buffer.concat(parts);
  };
  const block = (type, data, last = false) =>
    Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type]), Buffer.from([(data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff]), data]);
  const vc = vcomment(['TITLE=Flac Cancion', 'ARTIST=Flac Artista', 'ALBUM=Flac Album', 'DATE=2021', 'TRACKNUMBER=5']);
  const file = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    block(0, Buffer.from([0x80, 0, 0x0e, 0x10])),
    block(4, vc, true),
  ]);
  const { tags } = await readTags(new Blob([file], { type: 'audio/flac' }));
  check('FLAC titulo', tags.title, 'Flac Cancion');
  check('FLAC artista', tags.artist, 'Flac Artista');
  check('FLAC album', tags.album, 'Flac Album');
  check('FLAC anio', tags.year, '2021');
  check('FLAC pista', tags.trackNo, 5);
}

/* ---------- 6. Sin etiquetas: usa el nombre del archivo ---------- */
{
  const file = Buffer.concat([mpegFrame()]);
  const blob = new Blob([file], { type: 'audio/mpeg' });
  Object.defineProperty(blob, 'name', { value: 'mi cancion favorita.mp3' });
  const { tags } = await readTags(blob);
  check('fallback titulo desde archivo', tags.title, 'mi cancion favorita');
  check('fallback artista', tags.artist, 'Artista desconocido');
  check('fallback album', tags.album, 'Artista desconocido');
}

/* ---------- 7. Duracion estimada en MP3 CBR ---------- */
{
  const frames = Buffer.concat(Array.from({ length: 40 }, () => mpegFrame({ bitrateIdx: 9, srIdx: 0 })));
  const file = Buffer.concat([id3v2([textFrame('TIT2', 'Larga')]), frames]);
  const { estDuration } = await readTags(blobOf(file));
  const expected = Math.round((frames.length * 8) / 128000);
  check('duracion estimada CBR', estDuration, expected);
}

/* ---------- 8. MIME por extension ---------- */
check('mime mp3', guessMime('a.mp3'), 'audio/mpeg');
check('mime m4a', guessMime('a.m4a'), 'audio/mp4');
check('mime flac', guessMime('a.flac'), 'audio/flac');
check('mime opus', guessMime('a.opus'), 'audio/ogg');
check('mime desconocido', guessMime('a.xyz'), 'audio/mpeg');

console.log(`\n${pass} pruebas ok · ${fail} fallidas`);
process.exit(fail ? 1 : 0);
