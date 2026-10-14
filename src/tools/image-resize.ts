// Implements: SPEC-OUT-002 (CA-03, bounded PNG resizing), SPEC-MOT-006 (image preparation).
// Supports: SPEC-IHM-010, SPEC-INT-018; gap E-162.
import { deflateSync, inflate } from "node:zlib";
import { setImmediate } from "node:timers/promises";
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, imageInfo, type ImageInfo } from "./image-header";

export class ImageFailure extends Error {}
export interface PreparedImage extends ImageInfo { readonly bytes: Buffer; readonly resized: boolean }
const EDGE = 2048, MAX_PIXELS = 32_000_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0;
});
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!; return (crc ^ 0xffffffff) >>> 0; }
function chunk(name: string, data: Buffer): Buffer {
  const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length); value.write(name, 4, "ascii"); data.copy(value, 8);
  value.writeUInt32BE(crc32(value.subarray(4, data.length + 8)), data.length + 8); return value;
}
function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft, a = Math.abs(prediction - left), b = Math.abs(prediction - above), c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

/** PNG bytes never enter a temporary file or a child process. Other supported formats retain their existing limits. */
export async function prepareImage(bytes: Buffer, signal?: AbortSignal): Promise<PreparedImage> {
  signal?.throwIfAborted();
  if (bytes.length > IMAGE_MAX_BYTES) throw new ImageFailure(`The image is too large (${bytes.length} bytes, limit ${IMAGE_MAX_BYTES}): reduce it before reading it.`);
  const info = imageInfo(bytes);
  if (!info || info.width < 1 || info.height < 1) throw new ImageFailure("The image cannot be read: unrecognised or damaged format.");
  if (info.width > IMAGE_MAX_DIMENSION || info.height > IMAGE_MAX_DIMENSION) throw new ImageFailure(`The image is too large (${info.width} × ${info.height} pixels, limit ${IMAGE_MAX_DIMENSION}): reduce it before reading it.`);
  if (info.mediaType !== "image/png" || Math.max(info.width, info.height) <= EDGE) return { ...info, bytes, resized: false };
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new ImageFailure("Invalid PNG signature.");
  if (info.width * info.height > MAX_PIXELS) throw new ImageFailure("The decoded PNG exceeds the 32-million-pixel limit: reduce it before reading it.");
  const data: Buffer[] = []; let header: Buffer | undefined, palette: Buffer | undefined, transparency: Buffer | undefined, ended = false, dataEnded = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new ImageFailure("Incomplete PNG chunk.");
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) throw new ImageFailure("Incomplete PNG chunk.");
    const name = bytes.toString("ascii", offset + 4, offset + 8), body = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(name) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new ImageFailure("PNG checksum mismatch.");
    if (offset === 8 && name !== "IHDR") throw new ImageFailure("Missing PNG header.");
    if (name === "IHDR") { if (header || size !== 13 || data.length) throw new ImageFailure("Invalid PNG header."); header = body; }
    else if (name === "IDAT") { if (dataEnded) throw new ImageFailure("Nonconsecutive PNG image data."); data.push(body); }
    else {
      if (data.length) dataEnded = true;
      if (name === "PLTE") { if (palette || data.length || size < 3 || size > 768 || size % 3) throw new ImageFailure("Invalid PNG palette."); palette = body; }
      else if (name === "tRNS") { if (transparency || data.length) throw new ImageFailure("Invalid PNG transparency."); transparency = body; }
      else if (name === "IEND") { if (size || end !== bytes.length) throw new ImageFailure("Invalid PNG end."); ended = true; }
      else if (/^[A-Z]/.test(name)) throw new ImageFailure("Unsupported critical PNG chunk.");
    }
    offset = end;
  }
  if (!header || !ended || !data.length || header[8] !== 8 || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) throw new ImageFailure("PNG resizing requires a complete, noninterlaced 8-bit image.");
  const color = header[9]!, channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels || (color === 3 && !palette) || (transparency && ((color === 0 && transparency.length !== 2) || (color === 2 && transparency.length !== 6) || (color === 3 && transparency.length > palette!.length / 3) || color === 4 || color === 6))) throw new ImageFailure("Unsupported PNG colour or transparency encoding.");
  const stride = info.width * channels, decodedSize = (stride + 1) * info.height;
  let decoded: Buffer;
  try { decoded = await new Promise<Buffer>((resolve, reject) => inflate(Buffer.concat(data), { maxOutputLength: decodedSize }, (error, value) => error ? reject(error) : resolve(value))); }
  catch { throw new ImageFailure("PNG image data cannot be decoded within its declared bounds."); }
  signal?.throwIfAborted(); if (decoded.length !== decodedSize) throw new ImageFailure("PNG scanline size mismatch.");
  const scale = EDGE / Math.max(info.width, info.height), width = Math.max(1, Math.floor(info.width * scale)), height = Math.max(1, Math.floor(info.height * scale));
  const outputStride = width * 4 + 1, output = Buffer.alloc(outputStride * height);
  let previous = Buffer.alloc(stride), row = Buffer.alloc(stride), targetY = 0;
  for (let y = 0; y < info.height; y++) {
    if (y % 64 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    const source = y * (stride + 1), filter = decoded[source]!;
    if (filter > 4) throw new ImageFailure("Unknown PNG filter.");
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? row[index - channels]! : 0, above = previous[index]!, upperLeft = index >= channels ? previous[index - channels]! : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >>> 1 : paeth(left, above, upperLeft);
      row[index] = (decoded[source + 1 + index]! + prediction) & 255;
    }
    if (targetY < height && y === Math.floor(targetY * info.height / height)) {
      for (let x = 0; x < width; x++) {
        const sourcePixel = Math.floor(x * info.width / width) * channels, target = targetY * outputStride + 1 + x * 4, value = row[sourcePixel]!;
        if (color === 3) {
          if (value * 3 + 2 >= palette!.length) throw new ImageFailure("PNG palette index outside its bounds.");
          palette!.copy(output, target, value * 3, value * 3 + 3); output[target + 3] = transparency?.[value] ?? 255;
        } else {
          output[target] = value; output[target + 1] = color === 0 || color === 4 ? value : row[sourcePixel + 1]!; output[target + 2] = color === 0 || color === 4 ? value : row[sourcePixel + 2]!;
          const transparent = transparency && (color === 0 ? value === transparency.readUInt16BE(0) : value === transparency.readUInt16BE(0) && output[target + 1] === transparency.readUInt16BE(2) && output[target + 2] === transparency.readUInt16BE(4));
          output[target + 3] = color === 4 ? row[sourcePixel + 1]! : color === 6 ? row[sourcePixel + 3]! : transparent ? 0 : 255;
        }
      }
      targetY++;
    }
    [previous, row] = [row, previous];
  }
  const targetHeader = Buffer.alloc(13); targetHeader.writeUInt32BE(width); targetHeader.writeUInt32BE(height, 4); targetHeader[8] = 8; targetHeader[9] = 6;
  const result = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", targetHeader), chunk("IDAT", deflateSync(output)), chunk("IEND", Buffer.alloc(0))]);
  signal?.throwIfAborted(); if (result.length > IMAGE_MAX_BYTES) throw new ImageFailure("The resized image still exceeds the byte limit.");
  return { bytes: result, mediaType: "image/png", width, height, resized: true };
}
