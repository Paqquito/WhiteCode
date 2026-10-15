// Supports: SPEC-EXT-016 (bounded ZIP reader, integrity and portable paths), gap E-190.
// Format references: PKWARE APPNOTE 6.3.10 sections 4.3.7, 4.3.9, 4.3.12 and 4.3.16.
import { inflateRawSync, crc32 } from "node:zlib";
function portable(path: string): boolean {
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f:]/.test(path) ||
    path.normalize("NFC") !== path
  )
    return false;
  const parts = path.replace(/\/$/, "").split("/");
  return (
    parts.length <= 16 &&
    parts.every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  );
}
export function readConnectorZip(
  input: Uint8Array,
  maxSize: number,
): Map<string, Buffer> {
  if (
    !Number.isSafeInteger(maxSize) ||
    maxSize < 1 ||
    maxSize > 64 * 1024 * 1024 ||
    input.byteLength > maxSize ||
    input.byteLength < 22
  )
    throw Error("Archive size refused.");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength),
    result = new Map<string, Buffer>(),
    names = new Map<string, boolean>(),
    regions: Array<{ start: number; end: number }> = [];
  const range = (offset: number, length: number) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > bytes.length
    )
      throw Error("Archive bounds refused.");
  };
  const u16 = (offset: number) => {
      range(offset, 2);
      return bytes.readUInt16LE(offset);
    },
    u32 = (offset: number) => {
      range(offset, 4);
      return bytes.readUInt32LE(offset);
    };
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  )
    if (
      u32(offset) === 0x06054b50 &&
      offset + 22 + u16(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  if (
    end < 0 ||
    u16(end + 4) !== 0 ||
    u16(end + 6) !== 0 ||
    u16(end + 8) !== u16(end + 10)
  )
    throw Error("Split or malformed archive refused.");
  const count = u16(end + 10),
    start = u32(end + 16),
    size = u32(end + 12);
  if (count < 1 || count > 10000 || start + size !== end)
    throw Error("Unsupported ZIP directory.");
  let cursor = start,
    total = 0;
  for (let index = 0; index < count; index++) {
    range(cursor, 46);
    if (
      u32(cursor) !== 0x02014b50 ||
      u16(cursor + 6) > 20 ||
      u16(cursor + 34) !== 0
    )
      throw Error("Unsupported archive entry.");
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      crc = u32(cursor + 16),
      compressed = u32(cursor + 20),
      expanded = u32(cursor + 24),
      length = u16(cursor + 28),
      extra = u16(cursor + 30),
      comment = u16(cursor + 32),
      attributes = u32(cursor + 38),
      offset = u32(cursor + 42);
    if (
      flags & ~0x80e ||
      ![0, 8].includes(method) ||
      !length ||
      length > 4096 ||
      expanded > maxSize ||
      (total += expanded) > maxSize
    )
      throw Error("Unsupported or oversized archive entry.");
    range(cursor + 46, length + extra + comment);
    if (cursor + 46 + length + extra + comment > end)
      throw Error("Archive entry crosses its directory.");
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + length);
    if (!(flags & 0x800) && rawName.some((byte) => byte > 127))
      throw Error("Non-UTF8 archive name refused.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName),
      directory = name.endsWith("/"),
      kind = (attributes >>> 16) & 0xf000;
    if (
      !portable(name) ||
      names.has(name.toLowerCase().replace(/\/$/, "")) ||
      (kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) ||
      (directory && expanded !== 0)
    )
      throw Error("Archive path or link refused.");
    names.set(name.toLowerCase().replace(/\/$/, ""), directory);
    range(offset, 30);
    if (
      u32(offset) !== 0x04034b50 ||
      u16(offset + 6) !== flags ||
      u16(offset + 8) !== method ||
      u16(offset + 26) !== length
    )
      throw Error("Archive header mismatch.");
    const data = offset + 30 + length + u16(offset + 28);
    range(offset + 30, length);
    if (
      !bytes.subarray(offset + 30, offset + 30 + length).equals(rawName) ||
      data + compressed > start
    )
      throw Error("Archive local path mismatch.");
    range(data, compressed);
    if (
      !(flags & 8) &&
      (u32(offset + 14) !== crc ||
        u32(offset + 18) !== compressed ||
        u32(offset + 22) !== expanded)
    )
      throw Error("Archive integrity metadata mismatch.");
    let tail = data + compressed;
    if (flags & 8) {
      if (u32(tail) === 0x08074b50) tail += 4;
      if (
        u32(tail) !== crc ||
        u32(tail + 4) !== compressed ||
        u32(tail + 8) !== expanded
      )
        throw Error("Archive descriptor mismatch.");
      tail += 12;
    }
    if (tail > start) throw Error("Archive data overlaps its directory.");
    regions.push({ start: offset, end: tail });
    {
      const source = bytes.subarray(data, data + compressed),
        content =
          method === 0
            ? Buffer.from(source)
            : inflateRawSync(source, {
                maxOutputLength: Math.max(1, expanded),
              });
      if (content.length !== expanded || crc32(content) !== crc)
        throw Error("Archive checksum mismatch.");
      if (!directory) result.set(name, content);
    }
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw Error("Extra archive directory data refused.");
  regions.sort((a, b) => a.start - b.start);
  let next = 0;
  for (const region of regions) {
    if (region.start !== next)
      throw Error("Overlapping or hidden archive data refused.");
    next = region.end;
  }
  if (next !== start) throw Error("Archive data gap refused.");
  for (const name of names.keys()) {
    const parts = name.split("/");
    parts.pop();
    let parent = "";
    for (const part of parts) {
      parent += (parent ? "/" : "") + part;
      if (names.get(parent) === false)
        throw Error("File and directory conflict in archive.");
    }
  }
  return result;
}
