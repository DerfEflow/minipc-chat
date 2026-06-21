// Generates the PWA icons (no image libraries): navy field, copper glow, a small sheen.
// Run: node gen-icons.mjs  -> writes public/icon-192.png, icon-512.png, icon-180.png
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function png(size) {
  const W = size, H = size;
  const raw = Buffer.alloc(H * (1 + W * 4));
  const cx = W / 2, cy = H / 2;
  const rCore = size * 0.17, rGlow = size * 0.45;
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 35; // navy #000023
      const d = Math.hypot(x - cx, y - cy);
      if (d < rGlow) { const t = 1 - d / rGlow; r += t * t * 25; g += t * t * 70; b += t * t * 130; } // blue glow
      if (d < rCore) { r = 200; g = 118; b = 47; }       // copper core
      else if (d < rCore * 1.18) { const t = (d - rCore) / (rCore * 0.18); r = 200 * (1 - t) + r * t; g = 118 * (1 - t) + g * t; b = 47 * (1 - t) + b * t; }
      const sd = Math.hypot(x - (cx - rCore * 0.32), y - (cy - rCore * 0.32)); // top-left sheen
      if (sd < rCore * 0.4) { const t = 1 - sd / (rCore * 0.4); r += (255 - r) * t * 0.6; g += (255 - g) * t * 0.6; b += (255 - b) * t * 0.6; }
      const o = y * (1 + W * 4) + 1 + x * 4;
      raw[o] = clamp(r); raw[o + 1] = clamp(g); raw[o + 2] = clamp(b); raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [192, 512, 180]) {
  const name = s === 180 ? "icon-180.png" : `icon-${s}.png`;
  writeFileSync(join(OUT, name), png(s));
  console.log("wrote", name, "(" + s + "x" + s + ")");
}
