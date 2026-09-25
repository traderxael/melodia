import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const C1 = [124, 92, 255];
const C2 = [34, 211, 238];

function roundedRect(x, y, w, h, r) {
  return (px, py) => {
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

function ellipse(cx, cy, rx, ry, deg) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  return (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    const u = dx * cos - dy * sin;
    const v = dx * sin + dy * cos;
    return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1;
  };
}

function rect(x, y, w, h) {
  return (px, py) => px >= x && py >= y && px <= x + w && py <= y + h;
}

function poly(pts) {
  return (px, py) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

function note(scale) {
  const u = v => (v / 512) * scale;
  const s = f => u(f);
  return [
    ellipse(s(186), s(330), s(52), s(39), -20),
    ellipse(s(326), s(292), s(52), s(39), -20),
    rect(s(228), s(140), s(22), s(196)),
    rect(s(368), s(106), s(22), s(196)),
    poly([
      [s(228), s(140)],
      [s(390), s(106)],
      [s(390), s(158)],
      [s(228), s(192)],
    ]),
  ];
}

function render(size, { maskable = false } = {}) {
  const SS = 3;
  const buf = Buffer.alloc(size * size * 4);
  const inset = maskable ? 0 : size * 0.0;
  const radius = maskable ? 0 : size * 0.219;
  const bg = roundedRect(inset, inset, size - inset * 2, size - inset * 2, radius);
  const shapes = maskable ? note(size * 0.72) : note(size);
  const fg = (px, py) => shapes.some(f => f(px, py));
  const fgOffset = maskable ? (size - size * 0.72) / 2 : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgH = 0;
      let fgH = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (bg(px, py)) bgH++;
          if (fg(px - fgOffset, py - fgOffset)) fgH++;
        }
      }
      const total = SS * SS;
      const t = (x / size + y / size) / 2;
      const base = mix(C1, C2, Math.min(1, t * 1.05));
      const a = bgH / total;
      const fa = fgH / total;
      const o = (y * size + x) * 4;
      const r = base[0] * (1 - fa) + 255 * fa;
      const g = base[1] * (1 - fa) + 255 * fa;
      const b = base[2] * (1 - fa) + 255 * fa;
      buf[o] = Math.round(r);
      buf[o + 1] = Math.round(g);
      buf[o + 2] = Math.round(b);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-512-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of jobs) {
  const png = render(size, opts);
  writeFileSync(join(OUT, name), png);
  console.log(`${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
