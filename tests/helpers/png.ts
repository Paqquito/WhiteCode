// Synthetic, valid PNGs; independent fixtures for image reading and clipboard tests.
import { deflateSync } from "node:zlib";
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const name = Buffer.from(type), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([header, name, bytes, checksum]);
}
export function png(width: number, height: number, rgba = [222, 33, 99, 128], filter = 0): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1, rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    rows[y * stride] = filter;
    for (let x = 0; x < width; x++) for (let channel = 0; channel < 4; channel++) {
      const value = rgba[channel]!;
      const left = x > 0 ? value : 0, above = y > 0 ? value : 0;
      const prediction = filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >>> 1 : filter === 4 && (x > 0 || y > 0) ? value : 0;
      rows[y * stride + 1 + x * 4 + channel] = (value - prediction) & 255;
    }
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
