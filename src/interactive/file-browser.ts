// Implements: SPEC-IHM-018 (bounded local matches, ignore files, path checks, previews).
// Supports: SPEC-IHM-015, SPEC-PER-010, E-159.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isWithin, realPathOrSelf, type PlatformName } from "../platform/system";
import { walkFiles } from "../tools/file-walk";
import { matchQuality } from "./completion";

export interface FileMatch { readonly path: string; readonly line?: number; readonly preview: string; readonly language: string }
export class FileBrowser {
  constructor(private readonly options: { root: string; platform: PlatformName; readDenied: (path: string) => boolean; respectIgnoreFiles: boolean; maxMatches: number }) {}
  #read(path: string): string | undefined {
    const o = this.options, full = join(o.root, path), real = realPathOrSelf(full);
    if (!isWithin(full, o.root, o.platform) || !isWithin(real, o.root, o.platform) || o.readDenied(full) || o.readDenied(real)) return;
    let fd: number | undefined;
    try {
      const stat = statSync(full); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2_000_000) return;
      fd = openSync(full, "r"); const opened = fstatSync(fd), after = statSync(full), actual = realPathOrSelf(full);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.dev !== after.dev || opened.ino !== after.ino || !isWithin(actual, o.root, o.platform) || o.readDenied(actual)) return;
      const bytes = Buffer.alloc(Math.min(stat.size, 262_144)); const size = readSync(fd, bytes, 0, bytes.length, 0);
      const body = bytes.subarray(0, size); if (body.includes(0)) return; return body.toString("utf8");
    } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
  }
  matches(query: string, global: boolean): FileMatch[] {
    const o = this.options, deadline = Date.now() + 150;
    const walk = walkFiles(o.root, { respectIgnoreFiles: o.respectIgnoreFiles, caseInsensitive: o.platform !== "linux", stayWithinRoot: true, maxEntries: 20_000, deadline, signal: new AbortController().signal });
    const matches: FileMatch[] = [];
    for (const file of walk.files) {
      if (Date.now() > deadline || matches.length >= o.maxMatches) break;
      if (!global && matchQuality(query, file.relativePath, true) === undefined) continue;
      const content = this.#read(file.relativePath); if (content === undefined) continue;
      const language = file.relativePath.split(".").at(-1) ?? "text", lines = content.split(/\r?\n/);
      if (!global) matches.push({ path: file.relativePath, preview: lines.slice(0, 12).map(line => line.slice(0, 300)).join("\n"), language });
      else if (query.trim()) {
        let count = 0;
        for (let index = 0; index < lines.length && count < 20 && matches.length < o.maxMatches; index++) if (lines[index]!.toLowerCase().includes(query.toLowerCase())) {
          matches.push({ path: file.relativePath, line: index + 1, preview: lines.slice(Math.max(0, index - 2), index + 4).map(line => line.slice(0, 300)).join("\n"), language }); count++;
        }
      }
    }
    return matches;
  }
}
