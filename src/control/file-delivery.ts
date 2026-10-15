// Supports: SPEC-OUT-035 (client-side bounded receiving, verified cards and raster preview); E-226.
import { createHash } from "node:crypto";
import { inlineImageInfo } from "../tools/image-header";
export interface DeliveredFile {
  readonly id: string;
  readonly name: string;
  readonly caption: string;
  readonly status: "normal" | "proactive";
  readonly mode: "render" | "attach";
  readonly mediaType: string;
  readonly bytes: Buffer;
}
interface Pending {
  file: Omit<DeliveredFile, "bytes">;
  bytes: Buffer;
  offset: number;
  digest: string;
  timer: ReturnType<typeof setTimeout>;
}
/** Embedders acknowledge completion only after their own user-visible presentation succeeds. No disk overwrite. */
export class FileDeliveryReceiver {
  #closed = false;
  readonly #pending = new Map<string, Pending>();
  constructor(
    readonly publish: (file: DeliveredFile) => Promise<void>,
    readonly maxBytes = 50 * 1024 * 1024,
  ) {}
  #remove(id: string) {
    const value = this.#pending.get(id);
    if (value) clearTimeout(value.timer);
    this.#pending.delete(id);
  }
  close() {
    this.#closed = true;
    for (const id of this.#pending.keys()) this.#remove(id);
  }
  async receive(
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) return { accepted: false };
    const id = value.id;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
      return { accepted: false };
    if (value.phase === "start") {
      if (
        this.#pending.has(id) ||
        this.#pending.size >= 2 ||
        typeof value.name !== "string" ||
        value.name.length > 255 ||
        /[\\/\p{Cc}]/u.test(value.name) ||
        typeof value.caption !== "string" ||
        value.caption.length > 2000 ||
        !["normal", "proactive"].includes(String(value.status)) ||
        !["attach", "render"].includes(String(value.mode)) ||
        !Number.isSafeInteger(value.size) ||
        Number(value.size) < 0 ||
        Number(value.size) > Math.min(this.maxBytes, 50 * 1024 * 1024) ||
        typeof value.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.digest) ||
        typeof value.mediaType !== "string" ||
        ![
          "application/octet-stream",
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
        ].includes(value.mediaType) ||
        (value.mode === "render" && !value.mediaType.startsWith("image/"))
      )
        return { accepted: false };
      const timer = setTimeout(() => this.#remove(id), 30000);
      timer.unref();
      this.#pending.set(id, {
        file: {
          id,
          name: value.name,
          caption: value.caption,
          status: value.status as "normal" | "proactive",
          mode: value.mode as "render" | "attach",
          mediaType: value.mediaType,
        },
        bytes: Buffer.alloc(Number(value.size)),
        offset: 0,
        digest: value.digest,
        timer,
      });
      return { accepted: true };
    }
    const pending = this.#pending.get(id);
    if (!pending) return { accepted: false };
    if (value.phase === "cancel") {
      this.#remove(id);
      return { accepted: true };
    }
    if (value.phase === "chunk") {
      if (
        value.offset !== pending.offset ||
        typeof value.dataBase64 !== "string" ||
        value.dataBase64.length > 65536
      )
        return { accepted: false };
      const block = Buffer.from(value.dataBase64, "base64");
      if (
        block.toString("base64") !== value.dataBase64 ||
        !block.length ||
        pending.offset + block.length > pending.bytes.length
      )
        return { accepted: false };
      block.copy(pending.bytes, pending.offset);
      pending.offset += block.length;
      pending.timer.refresh();
      return { accepted: true, nextOffset: pending.offset };
    }
    if (value.phase !== "complete") return { accepted: false };
    this.#remove(id);
    if (
      pending.offset !== pending.bytes.length ||
      createHash("sha256").update(pending.bytes).digest("hex") !==
        pending.digest ||
      (pending.file.mode === "render" &&
        inlineImageInfo(pending.bytes)?.mediaType !== pending.file.mediaType)
    )
      return { delivered: false };
    try {
      await this.publish({ ...pending.file, bytes: pending.bytes });
      return { delivered: true, rendered: pending.file.mode === "render" };
    } catch {
      return { delivered: false };
    }
  }
}
const escape = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
/** A static client card: no scripts, remote fetches, SVG or executable inline documents. */
export function fileCardHtml(file: DeliveredFile): string {
  const raster =
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      file.mediaType,
    ) && inlineImageInfo(file.bytes)?.mediaType === file.mediaType;
  const mime = raster ? file.mediaType : "application/octet-stream",
    data = "data:" + mime + ";base64," + file.bytes.toString("base64"),
    caption = escape(file.caption),
    name = escape(file.name);
  return `<figure data-delivery-id="${escape(file.id)}" data-status="${escape(file.status)}">${file.mode === "render" && raster ? `<img src="${data}" alt="${caption || name}" style="max-width:100%;height:auto">` : `<a href="${data}" download="${name}">${name}</a>`}<figcaption>${caption || name}</figcaption></figure>`;
}
