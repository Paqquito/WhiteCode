// Implements: SPEC-SES-013 (bounded turn output persistence and exclusions), gap E-189.
import * as fs from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import picomatch from "picomatch";
interface Options {
  readonly root: string;
  readonly directory: string;
  readonly maxSize: number;
  readonly maxCount: number;
  readonly excluded: readonly string[];
  readonly ignored: (
    paths: readonly string[],
    signal: AbortSignal,
  ) => Promise<ReadonlySet<string>>;
  readonly upload: (
    input: {
      idempotencyKey: string;
      path: string;
      sha256: string;
      data: string;
    },
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly event: (event: {
    type: "output_files";
    files: Array<{ path: string; id: string; sha256: string }>;
    failed: Array<{ path: string; reason: string }>;
  }) => void;
}
function inside(root: string, path: string) {
  const rel = relative(root, resolve(path));
  return (
    !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
  );
}
const stamp = (s: fs.Stats) =>
  `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class OutputFiles {
  constructor(readonly options: Options) {
    if (
      !inside(resolve(options.root), resolve(options.directory)) ||
      !Number.isSafeInteger(options.maxSize) ||
      options.maxSize < 1 ||
      options.maxSize > 10 * 1024 * 1024 ||
      !Number.isSafeInteger(options.maxCount) ||
      options.maxCount < 1 ||
      options.maxCount > 100 ||
      options.excluded.length > 100 ||
      options.excluded.some((pattern) => pattern.length > 240)
    )
      throw Error("Invalid output persistence configuration.");
  }
  async capture(startedAt: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const root = resolve(this.options.root),
      directory = resolve(this.options.directory),
      endedAt = Date.now(),
      files: Array<{ path: string; id: string; sha256: string }> = [],
      failed: Array<{ path: string; reason: string }> = [];
    if (!Number.isFinite(startedAt) || startedAt > endedAt)
      throw Error("Invalid turn start.");
    if (!fs.existsSync(directory)) return;
    if (
      fs.realpathSync(root) !== root ||
      fs.realpathSync(directory) !== directory ||
      fs.lstatSync(directory).isSymbolicLink()
    )
      throw Error("Linked output folder refused.");
    const excluded = picomatch([...this.options.excluded], { dot: true }),
      candidates: Array<{ path: string; absolute: string; stat: fs.Stats }> =
        [];
    let visited = 0;
    const walk = (folder: string, depth: number) => {
      if (depth > 8 || ++visited > 2000) return;
      for (const name of fs.readdirSync(folder)) {
        signal.throwIfAborted();
        if (++visited > 2000) return;
        if ([".git", "node_modules", ".venv", "vendor"].includes(name))
          continue;
        const absolute = join(folder, name),
          path = relative(root, absolute).split(sep).join("/");
        if (excluded(path) || excluded(path + "/")) continue;
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(absolute, depth + 1);
        else if (
          stat.isFile() &&
          stat.nlink === 1 &&
          stat.size <= this.options.maxSize &&
          stat.mtimeMs >= startedAt &&
          stat.mtimeMs <= endedAt + 1
        )
          candidates.push({ path, absolute, stat });
      }
    };
    walk(directory, 0);
    const ignored = candidates.length
      ? await this.options.ignored(
          candidates.map((item) => item.path),
          signal,
        )
      : new Set<string>();
    signal.throwIfAborted();
    let processed = 0;
    for (const item of candidates.sort(
      (a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.path.localeCompare(b.path),
    )) {
      if (ignored.has(item.path)) continue;
      if (processed++ >= this.options.maxCount) {
        failed.push({
          path: item.path,
          reason: "Output file count limit reached.",
        });
        continue;
      }
      let fd: number | undefined;
      try {
        if (
          !inside(root, item.absolute) ||
          fs.realpathSync(item.absolute) !== item.absolute
        )
          throw Error("Output path changed.");
        fd = fs.openSync(
          item.absolute,
          fs.constants.O_RDONLY |
            (fs.constants.O_NOFOLLOW ?? 0) |
            (fs.constants.O_NONBLOCK ?? 0),
        );
        const opened = fs.fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          stamp(opened) !== stamp(item.stat)
        )
          throw Error("Output file changed.");
        const buffer = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = fs.readSync(
            fd,
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (!count) break;
          length += count;
        }
        if (
          length !== opened.size ||
          stamp(fs.fstatSync(fd)) !== stamp(opened) ||
          stamp(fs.lstatSync(item.absolute)) !== stamp(opened)
        )
          throw Error("Output changed during capture.");
        const bytes = buffer.subarray(0, length);
        fs.closeSync(fd);
        fd = undefined;
        const sha256 = createHash("sha256").update(bytes).digest("hex"),
          input = {
            idempotencyKey: randomUUID(),
            path: item.path,
            sha256,
            data: bytes.toString("base64"),
          };
        let result: unknown;
        try {
          result = await this.options.upload(input, signal);
        } catch {
          signal.throwIfAborted();
          result = await this.options.upload(input, signal);
        }
        signal.throwIfAborted();
        if (
          !result ||
          typeof result !== "object" ||
          !("id" in result) ||
          typeof result.id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,200}$/.test(result.id)
        )
          throw Error("Invalid output upload result.");
        files.push({ path: item.path, id: result.id, sha256 });
      } catch {
        signal.throwIfAborted();
        failed.push({
          path: item.path,
          reason: "Output file was changed, unavailable or not persisted.",
        });
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    if (files.length || failed.length)
      this.options.event({ type: "output_files", files, failed });
  }
}
