// Supports: SPEC-OUT-002 (§ 5.3 point 5 images), gap E-027 (size limits read from the file header, no decoder in lot 1)

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageInfo {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

/** Maximum weight and dimension of an attached image (gap E-027). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 8000;

/** Supports: SPEC-OUT-035. Refuse excessive decoded raster surfaces before a client starts decoding. */
export function inlineImageInfo(bytes:Buffer):ImageInfo|undefined{
  const info=imageInfo(bytes);return info&&info.width>0&&info.height>0&&info.width<=IMAGE_MAX_DIMENSION&&info.height<=IMAGE_MAX_DIMENSION&&info.width*info.height<=32000000?info:undefined;
}

function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    const length = b.readUInt16BE(i + 2);
    // Start-of-frame markers carry the dimensions (all SOFn except DHT, JPG and DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
}

function webpSize(b: Buffer): { width: number; height: number } | undefined {
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X" && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Type and dimensions from the signature and header; undefined for an unrecognised or damaged image. */
export function imageInfo(b: Buffer): ImageInfo | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") {
    return { mediaType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const size = jpegSize(b);
    return size ? { mediaType: "image/jpeg", ...size } : undefined;
  }
  if (b.length >= 10 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) {
    return { mediaType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 16 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const size = webpSize(b);
    return size ? { mediaType: "image/webp", ...size } : undefined;
  }
  return undefined;
}
