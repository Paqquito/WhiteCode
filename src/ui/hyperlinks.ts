// Implements: SPEC-IHM-035 (existing files, configured editor line targets, safe terminal links); E-224.
import { statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Frame } from "./screen";
import type { Cell } from "./text";
import { styleKey } from "./style";
import { ambiguousPathReason, isNetworkPath } from "../permissions/paths";
import { currentPlatform } from "../platform/system";
export class Hyperlinks {
  readonly #cache = new Map<string, { at: number; file: boolean }>();
  constructor(readonly options: { cwd: () => string; scheme: () => string }) {}
  #file(path: string): boolean {
    if (
      isNetworkPath(path, currentPlatform()) ||
      ambiguousPathReason(path, currentPlatform())
    )
      return false;
    const cached = this.#cache.get(path);
    if (cached && Date.now() - cached.at < 1000) return cached.file;
    let file = false;
    try {
      file = statSync(path).isFile();
    } catch {}
    if (this.#cache.size >= 256) this.#cache.clear();
    this.#cache.set(path, { at: Date.now(), file });
    return file;
  }
  frame(frame: Frame): Frame {
    return { ...frame, lines: frame.lines.map((line) => this.line(line)) };
  }
  line(line: readonly Cell[]): readonly Cell[] {
    const source = line.map((c) => c.ch).join(""),
      marks: { start: number; end: number; href: string }[] = [];
    for (const m of source.matchAll(
      /https?:\/\/[^\s<>]+|(?:[A-Za-z]:[\\/]|\/)?(?:[\p{L}\p{N}_@. -]+[\\/])*[\p{L}\p{N}_@. -]+\.[a-zA-Z0-9]{1,12}(?::[1-9][0-9]*(?::[1-9][0-9]*)?)?/gu,
    )) {
      let literal = m[0].replace(/[)\],.;]+$/g, ""),
        start = m.index!,
        href: string | undefined;
      if (/^https?:\/\//.test(literal)) {
        try {
          const u = new URL(literal);
          if (!u.username && !u.password) href = u.href;
        } catch {}
      } else {
        while (literal) {
          const suffix = /:(\d+)(?::(\d+))?$/.exec(literal),
            file = suffix ? literal.slice(0, suffix.index) : literal,
            path = isAbsolute(file)
              ? resolve(file)
              : resolve(this.options.cwd(), file);
          if (this.#file(path)) {
            const scheme = this.options.scheme(),
              url = pathToFileURL(path);
            if (
              scheme !== "auto" &&
              /^[a-z][a-z0-9+.-]{1,63}$/.test(scheme) &&
              !["javascript", "data", "vbscript"].includes(scheme)
            )
              href =
                scheme +
                "://file/" +
                encodeURI(path.replaceAll("\\", "/"))
                  .replaceAll("#", "%23")
                  .replaceAll("?", "%3F") +
                (suffix ? ":" + suffix[1] + ":" + (suffix[2] ?? "1") : "");
            else {
              if (suffix) url.hash = "L" + suffix[1];
              href = url.href;
            }
            break;
          }
          const space = literal.indexOf(" ");
          if (space < 0) break;
          literal = literal.slice(space + 1);
          start += space + 1;
        }
      }
      if (href && !/[\u0000-\u0020\u007f-\u009f]/.test(href))
        marks.push({ start, end: start + literal.length, href });
    }
    let offset = 0;
    return line.map((cell) => {
      const start = offset;
      offset += cell.ch.length;
      const mark = marks.find((m) => start >= m.start && start < m.end);
      if (!mark) return cell;
      const style = { ...cell.style, underline: true, href: mark.href };
      return { ...cell, style, key: styleKey(style) };
    });
  }
}
