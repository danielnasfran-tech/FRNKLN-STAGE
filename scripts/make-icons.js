/* Gera os ícones PNG do PWA (sem dependências externas).
 * Uso: node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filtro none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
      raw[o++] = rgba[i + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Desenha o ícone: fundo grafite, "F" estilizado em vermelho e barra de palco.
 */
function draw(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = maskable ? size * 0.18 : 0;
  const r = maskable ? size * 0.22 : size * 0.16; // raio do "card"
  const set = (x, y, r_, g_, b_, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r_;
    rgba[i + 1] = g_;
    rgba[i + 2] = b_;
    rgba[i + 3] = a;
  };
  // fundo transparente
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) set(x, y, 0, 0, 0, 0);
  }
  // card grafite
  const x0 = pad;
  const y0 = pad;
  const x1 = size - pad;
  const y1 = size - pad;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = Math.min(x - x0, x1 - x);
      const cy = Math.min(y - y0, y1 - y);
      if (cx < r && cy < r) {
        const dx = r - cx;
        const dy = r - cy;
        if (dx * dx + dy * dy > r * r) continue;
      }
      set(x, y, 0x17, 0x17, 0x1b, 255);
    }
  }
  // letra F estilizada (vermelho)
  const fx = Math.round(size * 0.34);
  const fy = Math.round(size * 0.26);
  const fh = Math.round(size * 0.42);
  const fw = Math.max(2, Math.round(size * 0.09));
  const bar = Math.max(2, Math.round(size * 0.07));
  for (let y = fy; y < fy + fh; y++) {
    for (let x = fx; x < fx + fw; x++) set(x, y, 0xff, 0x3b, 0x30, 255);
  }
  for (let x = fx; x < fx + Math.round(size * 0.26); x++) {
    for (let y = fy; y < fy + bar; y++) set(x, y, 0xff, 0x3b, 0x30, 255);
  }
  for (let x = fx; x < fx + Math.round(size * 0.19); x++) {
    for (let y = fy + Math.round(fh * 0.42); y < fy + Math.round(fh * 0.42) + bar; y++)
      set(x, y, 0xff, 0x3b, 0x30, 255);
  }
  // detalhe verde discreto (indicador de sync)
  const gx = Math.round(size * 0.34);
  const gy = Math.round(size * 0.74);
  const gw = Math.round(size * 0.32);
  const gh = Math.max(2, Math.round(size * 0.045));
  for (let y = gy; y < gy + gh; y++) {
    for (let x = gx; x < gx + gw; x++) set(x, y, 0x34, 0xc7, 0x59, 255);
  }
  return png(size, size, rgba);
}

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon-192.png'), draw(192, false));
fs.writeFileSync(path.join(dir, 'icon-512.png'), draw(512, false));
fs.writeFileSync(path.join(dir, 'icon-maskable-512.png'), draw(512, true));
console.log('ícones gerados em public/icons');
