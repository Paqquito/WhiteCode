// Implements: SPEC-SES-014 (internal repository snapshots, owner-pinned background upload, exclusions, CA-01 to CA-03), gap E-213.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, resolve, relative } from "node:path";
import { startChild } from "../platform/process";
import { isWithin, realPathOrSelf, currentPlatform } from "../platform/system";
import { containsSecret } from "../shared/secrets";
import type { CompanyAccount } from "../auth/company-account";
export interface CaptureOptions {
  readonly account: CompanyAccount;
  readonly git: string;
  readonly cwd: () => string;
  readonly environment: Readonly<Record<string, string>>;
  readonly organizations: () => readonly string[];
  readonly disabled: () => boolean;
  readonly maxFileSize: () => number;
  readonly sessionId: string;
  readonly report: (state: "success" | "failure", reason?: string) => void;
  readonly redact: (text: string) => string;
  readonly projectDirectory: string;
}
/** Each name is host/organization; an organization on an unrelated forge never qualifies. */
function forgeOwner(remote: string): string | undefined {
  try {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(remote);
    const url = new URL(
      remote.includes("://")
        ? remote
        : scp
          ? `ssh://${scp[1]}/${scp[2]}`
          : remote,
    );
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const pieces = url.pathname.split("/").filter(Boolean);
    if (
      pieces.length !== 2 ||
      !pieces.every((p) => /^[A-Za-z0-9._-]+$/.test(p))
    )
      return;
    return (url.hostname + "/" + pieces[0]).toLowerCase();
  } catch {
    return;
  }
}
const secretPath = (path: string, projectDirectory: string) =>
  path
    .split(/[\\/]/)
    .some(
      (part) =>
        part === projectDirectory ||
        /^(?:\.env.*|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(
          part,
        ),
    );
const sensitiveContent = (text: string) =>
  containsSecret(text) ||
  /["']?(?:[a-z][\w-]*[_-])?(?:password|passwd|secret|api[_-]?key|token|private[_-]?key)["']?\s*[:=]\s*["']?[^\s"']{6,}/i.test(
    text,
  );
async function gitRun(
  o: CaptureOptions,
  cwd: string,
  args: readonly string[],
  deadline: number,
  signal: AbortSignal,
  input?: string | Promise<string>,
  allowOne = false,
): Promise<Buffer> {
  const left = deadline - Date.now();
  if (left <= 0 || signal.aborted) throw Error("Snapshot deadline.");
  const chunks: Buffer[] = [];
  let length = 0,
    excess = false;
  const child = startChild(
    o.git,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=",
      ...args,
    ],
    {
      cwd,
      env: { ...o.environment, GIT_TERMINAL_PROMPT: "0" },
      input: typeof input === "string" ? input : undefined,
      keepInputOpen: input instanceof Promise,
      onData: (chunk) => {
        if ((length += chunk.length) > 2 * 1024 * 1024) {
          excess = true;
          void child.killTree(0);
        } else chunks.push(chunk);
      },
      onErrorData: () => {},
    },
  );
  if (input instanceof Promise)
    void input.then(
      (text) => {
        if (!signal.aborted) {
          child.input?.write(text);
          child.input?.end();
        }
      },
      () => child.killTree(0),
    );
  const stop = () => {
    void child.killTree(0);
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, left);
  try {
    const code = await child.exited;
    if (
      signal.aborted ||
      excess ||
      (code !== 0 && !(allowOne && code === 1)) ||
      Date.now() > deadline
    )
      throw Error(
        `Snapshot Git operation failed (${args[0]}, exit ${code}, deadline ${Date.now() > deadline}).`,
      );
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
function contents(
  path: string,
  max: number,
): { data: string; mode: number } | undefined {
  let fd: number | undefined;
  try {
    const named = lstatSync(path);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      named.size > max
    )
      return;
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== named.size
    )
      return;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) return;
      offset += n;
    }
    const after = fstatSync(fd),
      again = lstatSync(path);
    if (
      after.mtimeMs !== before.mtimeMs ||
      after.size !== before.size ||
      again.ino !== before.ino ||
      again.dev !== before.dev ||
      again.isSymbolicLink() ||
      again.nlink !== 1
    )
      return;
    return { data: bytes.toString("base64"), mode: before.mode & 0o777 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export class StateCapture {
  #controller = new AbortController();
  #busy?: Promise<void>;
  #pending?: number;
  #last?: string;
  #message = 0;
  #closed = false;
  constructor(readonly options: CaptureOptions) {}
  turnEnded(): void {
    const message = ++this.#message;
    if (this.#closed || this.options.disabled()) return;
    this.#pending = message;
    this.#launch();
  }
  #launch(): void {
    if (!this.#busy)
      this.#busy = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(() => this.#drain())
        .finally(() => {
          this.#busy = undefined;
          if (this.#pending !== undefined && !this.#closed) this.#launch();
        });
  }
  async #drain(): Promise<void> {
    while (this.#pending !== undefined && !this.#controller.signal.aborted) {
      const message = this.#pending;
      this.#pending = undefined;
      try {
        await this.#capture(message);
      } catch (error) {
        if (!this.options.disabled() && !this.#controller.signal.aborted)
          this.options.report(
            "failure",
            this.options.redact((error as Error).message),
          );
      }
    }
  }
  async #capture(message: number): Promise<void> {
    const o = this.options,
      signal = this.#controller.signal;
    if (o.disabled() || !o.organizations().length) return;
    const binding = await o.account.sessionBinding(),
      profile = await o.account.profile();
    if (!profile || binding !== (await o.account.sessionBinding())) return;
    const cwd = realPathOrSelf(o.cwd()),
      deadline = Date.now() + 500,
      run = (
        args: string[],
        input?: string | Promise<string>,
        allowOne = false,
      ) => gitRun(o, cwd, args, deadline, signal, input, allowOne);
    const metadata = await Promise.allSettled([
      run(["remote", "get-url", "origin"]),
      run(["rev-parse", "--show-toplevel", "HEAD"]),
    ]);
    for (const result of metadata)
      if (result.status === "rejected") throw result.reason;
    const remote = (metadata[0] as PromiseFulfilledResult<Buffer>).value
        .toString()
        .trim(),
      owner = forgeOwner(remote);
    if (
      !owner ||
      !o
        .organizations()
        .map((v) => v.toLowerCase())
        .includes(owner)
    )
      return;
    const [root, base] = (metadata[1] as PromiseFulfilledResult<Buffer>).value
      .toString()
      .trim()
      .split(/\r?\n/);
    if (
      !root ||
      !base ||
      realPathOrSelf(root) !== cwd ||
      !/^[a-f0-9]{40,64}$/.test(base)
    )
      return;
    const namesTask = run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).then((bytes) => {
      const status = bytes.toString().split("\0"),
        paths: string[] = [];
      for (let i = 0; i < status.length; i++) {
        const record = status[i]!;
        if (!record) continue;
        paths.push(record.slice(3));
        if (/[RC]/.test(record.slice(0, 2)) && status[i + 1])
          paths.push(status[++i]!);
      }
      const names = [...new Set(paths)].sort();
      if (names.length > 1000) throw Error("Snapshot contains too many files.");
      return names;
    });
    // Start the exclusion reader alongside status, then feed it the discovered names through its pipe.
    const ignoredTask = run(
      ["check-ignore", "--no-index", "-z", "--stdin"],
      namesTask.then((names) => (names.length ? names.join("\0") + "\0" : "")),
      true,
    );
    const selections = await Promise.allSettled([namesTask, ignoredTask]);
    for (const result of selections)
      if (result.status === "rejected") throw result.reason;
    const names = (selections[0] as PromiseFulfilledResult<string[]>).value,
      ignored = new Set(
        (selections[1] as PromiseFulfilledResult<Buffer>).value
          .toString()
          .split("\0")
          .filter(Boolean),
      );
    const files: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const name of names) {
      if (Date.now() > deadline || signal.aborted)
        throw Error("Snapshot deadline.");
      if (
        ignored.has(name) ||
        secretPath(name, o.projectDirectory) ||
        containsSecret(name) ||
        o.redact(name) !== name
      )
        continue;
      const path = resolve(root, name);
      if (
        !isWithin(path, root, currentPlatform()) ||
        path === root ||
        realPathOrSelf(path) !== path ||
        relative(root, path).startsWith("..")
      )
        continue;
      try {
        const file = contents(
          path,
          Math.min(o.maxFileSize(), Math.max(0, 4 * 1024 * 1024 - total)),
        );
        if (!file) {
          files.push({ path: name, omitted: "size_or_link" });
          continue;
        }
        const text = Buffer.from(file.data, "base64").toString("utf8");
        if (sensitiveContent(text) || o.redact(text) !== text) continue;
        total += Buffer.byteLength(file.data, "base64");
        files.push({ path: name, encoding: "base64", ...file });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          files.push({ path: name, deleted: true });
        else throw error;
      }
    }
    if (
      o.disabled() ||
      !o
        .organizations()
        .map((value) => value.toLowerCase())
        .includes(owner) ||
      binding !== (await o.account.sessionBinding())
    )
      return;
    const snapshot = {
      base,
      repository:
        owner +
        "/" +
        basename(
          new URL(
            remote.includes("://")
              ? remote
              : `ssh://${remote.replace(":", "/")}`,
          ).pathname,
        ).replace(/\.git$/, ""),
      files,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    if (this.#last === binding + digest) return;
    // STATE_CAPTURE_PAYLOAD_V1: no prompt, model response or transcript is accepted by this API.
    await o.account.request(
      "account",
      "state-captures",
      { version: 1, sessionId: o.sessionId, message, digest, snapshot },
      signal,
      { account: profile.account, organizationId: profile.organization.id },
    );
    if (binding !== (await o.account.sessionBinding())) return;
    this.#last = binding + digest;
    o.report("success");
  }
  async close(): Promise<void> {
    this.#closed = true;
    const timer = setTimeout(() => this.#controller.abort(), 1000);
    try {
      await this.#busy;
    } finally {
      clearTimeout(timer);
      this.#controller.abort();
    }
  }
}
