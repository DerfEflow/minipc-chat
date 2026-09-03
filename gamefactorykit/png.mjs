/*
 * gamefactorykit/png.mjs -- tiny, zero-dependency PNG encoder + header reader.
 *
 * "Zero deps" holds because node:zlib is a Node BUILT-IN (not an npm package), and Node 22.2+
 * exposes zlib.crc32() directly, so this file needs neither a hand-rolled DEFLATE implementation
 * nor a hand-rolled CRC32 table -- both come from the platform. Measured on this machine
 * (Node v24.14.1): `require("node:zlib").crc32` is a function, and `deflateSync` produces a
 * standard zlib stream (2-byte header + deflate data + 4-byte Adler32), which is exactly the byte
 * format a PNG IDAT chunk's payload must contain (PNG wraps raw scanlines in a zlib stream, not a
 * raw DEFLATE stream). See gamefactoryqa_test.mjs / gamefactorykit_test.mjs for the round-trip
 * proof (fallbackIconPng -> pngSize).
 */
import { deflateSync, crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  // zlib.crc32 returns an unsigned 32-bit checksum already; >>> 0 just guards against any signed
  // representation surprise before writeUInt32BE (which throws on out-of-range values).
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * encodePng({ width, height, rgba }) -> Buffer
 * rgba: Uint8Array/Buffer of length width*height*4, top-to-bottom, row-major, RGBA8 (no
 * premultiplication). Always encodes filter type 0 (None) per scanline -- simplest correct
 * encoder; icons here are small and deterministic so compression ratio is not a concern.
 */
export function encodePng({ width, height, rgba }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error("encodePng: width must be a positive integer");
  if (!Number.isInteger(height) || height <= 0) throw new Error("encodePng: height must be a positive integer");
  const expected = width * height * 4;
  const len = rgba ? rgba.length : -1;
  if (len !== expected) throw new Error(`encodePng: rgba length ${len} does not match ${expected} for ${width}x${height} RGBA8`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0; // compression method (only legal value)
  ihdr[11] = 0; // filter method (only legal value)
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    src.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }

  const idatData = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** pngSize(buffer) -> { width, height } read straight from the IHDR chunk. Throws on a non-PNG buffer. */
export function pngSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("pngSize: not a PNG (bad signature)");
  const type = buf.subarray(12, 16).toString("ascii");
  if (type !== "IHDR") throw new Error("pngSize: first chunk is not IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
