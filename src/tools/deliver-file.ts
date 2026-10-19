// Implements: SPEC-OUT-035 (read permissions, stable bounded files, independently acknowledged delivery); E-226.
import { randomUUID, createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  openSync,
  closeSync,
  readSync,
  fstatSync,
  statSync,
  constants,
} from "node:fs";
import { realPathOrSelf, isWithin } from "../platform/system";
import { ambiguousPathReason } from "../permissions/paths";
import { imageInfo, inlineImageInfo } from "./image-header";
import { maskSecrets } from "../shared/secrets";
import { textOutcome, type Tool } from "./types";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
interface Input {
  files: string[];
  status: "normal" | "proactive";
  caption?: string;
  mode?: "render" | "attach";
}
export function createDeliverFileTool(o: {
  maxBytes: () => number;
  redact: (text: string) => string;
  send: (
    value: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown> | undefined>;
}): Tool<Input> {
  if (!buildFlag("user_file_delivery")) throw Error("File delivery unavailable in this build.");
  const snapshots = new WeakMap<
    object,
    Map<
      string,
      | {
          real: string;
          dev: number;
          ino: number;
          size: number;
          mtimeMs: number;
        }
      | undefined
    >
  >();
  return {
    name: "deliver_file",
    permissionName: "read_file",
    description: () =>
      "Deliver existing local files as user-visible artifacts to the connected client. Required status: normal or proactive. Use render for an inline raster-image preview, attach for a download; omit mode to select automatically. Files are checked against ordinary read permissions and uploaded in acknowledged chunks. A missing, excessive, sensitive or changed file is reported separately; other files continue. Do not send credentials or directories.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4096 },
          minItems: 1,
          maxItems: 10,
        },
        status: { enum: ["normal", "proactive"] },
        caption: { type: "string", maxLength: 2000 },
        mode: { enum: ["render", "attach"] },
      },
      required: ["files", "status"],
      additionalProperties: false,
    },
    isEnabled: () => true,
    flags: () => ({
      readOnly: true,
      concurrencySafe: false,
      destructive: false,
      requiresPermission: false,
      openWorld: false,
    }),
    summary: (input) => "Livrer " + input.files.length + " fichier(s)",
    ruleSubject: (input, ctx) => ({
      kind: "paths",
      access: "read",
      paths: input.files.flatMap((name) => {
        const path = resolve(ctx.cwd, name);
        return [path, realPathOrSelf(path)];
      }),
    }),
    permissionContribution: (input, ctx) => {
      const roots = [
        ...ctx.allowedDirectories,
        ...(ctx.extraReadableDirectories ?? []),
      ];
      return input.files.every((name) => {
        const path = resolve(ctx.cwd, name);
        return [path, realPathOrSelf(path)].every((p) =>
          roots.some((root) => isWithin(p, root, ctx.platform)),
        );
      })
        ? "allow"
        : undefined;
    },
    validate(input, ctx) {
      const records = new Map<
        string,
        | {
            real: string;
            dev: number;
            ino: number;
            size: number;
            mtimeMs: number;
          }
        | undefined
      >();
      for (const name of input.files) {
        const path = resolve(ctx.cwd, name);
        if (ambiguousPathReason(path, ctx.platform))
          return "Ambiguous delivery path.";
        try {
          const real = realPathOrSelf(path),
            s = statSync(path);
          records.set(path, {
            real,
            dev: s.dev,
            ino: s.ino,
            size: s.size,
            mtimeMs: s.mtimeMs,
          });
        } catch {
          records.set(path, undefined);
        }
      }
      snapshots.set(input, records);
      return undefined;
    },
    async execute(input, ctx) {
      const report: string[] = [];
      let delivered = 0;
      for (const name of input.files) {
        ctx.signal.throwIfAborted();
        const path = resolve(ctx.cwd, name),
          id = randomUUID();
        let fd: number | undefined,
          started = false;
        try {
          const before = snapshots.get(input)?.get(path);
          if (!before) throw Error("File not found: " + name);
          if (ctx.readDenied(path) || ctx.readDenied(before.real))
            throw Error(
              "File is not readable under the current rules: " + name,
            );
          if (before.size > Math.min(o.maxBytes(), 50 * 1024 * 1024))
            throw Error("File exceeds delivery size limit: " + name);
          if (realPathOrSelf(path) !== before.real)
            throw Error("File changed before delivery: " + name);
          fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
          const opened = fstatSync(fd);
          if (
            !opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            opened.mtimeMs !== before.mtimeMs
          )
            throw Error("File changed or is not ordinary: " + name);
          const bytes = Buffer.alloc(opened.size);
          for (let at = 0; at < bytes.length;) {
            ctx.signal.throwIfAborted();
            const n = readSync(fd, bytes, at, bytes.length - at, at);
            if (!n) throw Error("File read interrupted: " + name);
            at += n;
          }
          const after = fstatSync(fd),
            named = statSync(path);
          if (
            after.mtimeMs !== before.mtimeMs ||
            after.size !== before.size ||
            named.dev !== before.dev ||
            named.ino !== before.ino ||
            realPathOrSelf(path) !== before.real ||
            ctx.readDenied(path) ||
            ctx.readDenied(before.real)
          )
            throw Error("File changed or became unreadable: " + name);
          const text = bytes.toString("utf8");
          if (
            o.redact(maskSecrets(text)) !== text ||
            o.redact(maskSecrets(input.caption ?? "")) !== (input.caption ?? "")
          )
            throw Error("Sensitive content cannot be delivered: " + name);
          const image = imageInfo(bytes),
            mode = input.mode ?? (image ? "render" : "attach");
          if (mode === "render" && !inlineImageInfo(bytes))
            throw Error(
              "Inline preview requires a supported raster image: " + name,
            );
          const digest = createHash("sha256").update(bytes).digest("hex"),
            metadata = {
              id,
              name: basename(path),
              status: input.status,
              caption: input.caption ?? "",
              mode,
              mediaType: image?.mediaType ?? "application/octet-stream",
              size: bytes.length,
              digest,
            };
          const accepted = await o.send(
            { phase: "start", ...metadata },
            ctx.signal,
          );
          if (accepted?.accepted !== true)
            throw Error("Client refused the file: " + name);
          started = true;
          for (let at = 0; at < bytes.length; at += 49152) {
            if (ctx.readDenied(path) || ctx.readDenied(before.real))
              throw Error("File read permission was revoked: " + name);
            const block = bytes.subarray(at, at + 49152),
              answer = await o.send(
                {
                  phase: "chunk",
                  id,
                  offset: at,
                  dataBase64: block.toString("base64"),
                },
                ctx.signal,
              );
            if (
              answer?.accepted !== true ||
              answer.nextOffset !== at + block.length
            )
              throw Error(
                "Client did not acknowledge an upload chunk: " + name,
              );
          }
          const receipt = await o.send({ phase: "complete", id }, ctx.signal);
          if (
            receipt?.delivered !== true ||
            (mode === "render" && receipt.rendered !== true)
          )
            throw Error("Delivery not confirmed by the client: " + name);
          delivered++;
          report.push("Delivered: " + name + " (" + mode + ")");
        } catch (error) {
          report.push(o.redact(maskSecrets((error as Error).message)));
          if (started && !ctx.signal.aborted)
            await o
              .send({ phase: "cancel", id }, ctx.signal)
              .catch(() => undefined);
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
      return textOutcome(
        `${delivered}/${input.files.length} file(s) delivered.\n${report.join("\n")}`,
        delivered === 0,
        delivered === 0 ? "unavailable" : undefined,
      );
    },
  };
}
