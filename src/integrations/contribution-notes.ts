// Implements: SPEC-INT-010 (bounded file attribution and local Git notes); E-225.
import { createHash } from "node:crypto";
import { relative, resolve, isAbsolute } from "node:path";
import { runToCompletion } from "../platform/process";
import { diffLines, type FileChange } from "../shared/diff";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
interface FileState {
  baseline: string[];
  latest: string[];
  owners: boolean[];
  removed: Record<string, number>;
}
interface State {
  head: string;
  files: Record<string, FileState>;
  messages: number;
  permissions: number;
}
const hashes = (value: string) =>
  value
    .replaceAll("\r\n", "\n")
    .replace(/\n$/, "")
    .split("\n")
    .filter((_, i, a) => value !== "" || i !== 0)
    .map((line) =>
      createHash("sha256").update(line).digest("hex").slice(0, 32),
    );
/** Edits with a human before-image are reconciled first; only actual tool writes acquire ownership. */
function apply(file: FileState, next: string[], agent: boolean): void {
  let old = 0;
  const owners: boolean[] = [];
  for (const op of diffLines(file.latest.join("\n"), next.join("\n")).ops) {
    if (op.kind === "same") owners.push(file.owners[old++] ?? false);
    else if (op.kind === "add") owners.push(agent);
    else {
      old++;
      if (agent) file.removed[op.line] = (file.removed[op.line] ?? 0) + 1;
      else delete file.removed[op.line];
    }
  }
  file.latest = next;
  file.owners = owners;
}
export class ContributionNotes {
  #state: State;
  constructor(
    readonly options: {
      git: string;
      cwd: string;
      environment: Readonly<Record<string, string>>;
      ref: string;
      enabled: () => boolean;
      tier: () => string | undefined;
      surface: string;
      save: (state: unknown) => void;
      warn: (message: string) => void;
      restored?: unknown;
    },
  ) {
    if (!buildFlag("contribution_attribution")) throw Error("Contribution attribution unavailable in this build.");
    const root = this.#git(["rev-parse", "--show-toplevel"]);
    if (root.code === 0 && isAbsolute(root.stdout.trim()))
      options.cwd = root.stdout.trim();
    const head = this.#git(["rev-parse", "--verify", "HEAD"]).stdout.trim();
    this.#state = {
      head,
      files: Object.create(null),
      messages: 0,
      permissions: 0,
    };
    const restored = options.restored;
    if (
      restored &&
      typeof restored === "object" &&
      JSON.stringify(restored).length <= 262144
    ) {
      const s = restored as State;
      if (
        s.head === head &&
        s.files &&
        typeof s.files === "object" &&
        Object.keys(s.files).length <= 32 &&
        Number.isSafeInteger(s.messages) &&
        Number.isSafeInteger(s.permissions) &&
        Object.values(s.files).every(
          (f) =>
            f &&
            Array.isArray(f.baseline) &&
            Array.isArray(f.latest) &&
            Array.isArray(f.owners) &&
            f.latest.length === f.owners.length &&
            f.baseline.length <= 4096 &&
            f.latest.length <= 4096 &&
            [...f.baseline, ...f.latest].every(
              (h) => typeof h === "string" && /^[a-f0-9]{32}$/.test(h),
            ) &&
            f.owners.every((v) => typeof v === "boolean") &&
            f.removed &&
            Object.entries(f.removed).every(
              ([key, n]) =>
                /^[a-f0-9]{32}$/.test(key) && Number.isSafeInteger(n) && n >= 0,
            ),
        )
      )
        this.#state = structuredClone(s);
    }
  }
  #git(args: readonly string[], input?: string) {
    if (!buildFlag("contribution_attribution")) throw Error("Contribution attribution unavailable in this build.");
    return runToCompletion(
      this.options.git,
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        ...args,
      ],
      {
        cwd: this.options.cwd,
        env: this.options.environment,
        timeoutMs: 2000,
        ...(input !== undefined ? { input } : {}),
      },
    );
  }
  #name(path: string): string | undefined {
    const name = relative(this.options.cwd, resolve(path)).replaceAll(
      "\\",
      "/",
    );
    return name &&
      !isAbsolute(name) &&
      !name.startsWith("../") &&
      !/[\u0000-\u001f\u007f]/.test(name) &&
      !/(^|\/)(?:\.git|node_modules|dist|build)(\/|$)|(?:\.lock|\.min\.[cm]?js|\.map)$/.test(
        name,
      )
      ? name
      : undefined;
  }
  #blob(head: string, name: string): string[] | undefined {
    if (!/^[a-f0-9]{40,64}$/.test(head)) return [];
    const meta = this.#git(["ls-tree", "-l", head, "--", name]);
    if (meta.code !== 0) return;
    const line = meta.stdout.trim();
    if (!line) return [];
    const size = /^\d+ blob [a-f0-9]+\s+(\d+)\t/.exec(line);
    if (!size || Number(size[1]) > 1024 * 1024) return;
    const value = this.#git(["show", head + ":" + name]);
    return value.code === 0 && !value.stdout.includes("\0")
      ? hashes(value.stdout)
      : undefined;
  }
  #save() {
    while (JSON.stringify(this.#state).length > 262144) {
      const first = Object.keys(this.#state.files)[0];
      if (!first) break;
      delete this.#state.files[first];
    }
    this.options.save(structuredClone(this.#state));
  }
  message() {
    if (this.options.enabled()) this.#state.messages++;
  }
  permission() {
    if (this.options.enabled()) this.#state.permissions++;
  }
  record(change: FileChange): void {
    if (!buildFlag("contribution_attribution")) return;
    if (
      !this.options.enabled() ||
      change.binary ||
      Buffer.byteLength(change.before ?? "") +
        Buffer.byteLength(change.after ?? "") >
        1024 * 1024
    )
      return;
    const name = this.#name(change.path);
    if (!name) return;
    const generated = this.#git([
      "check-attr",
      "generated",
      "linguist-generated",
      "--",
      name,
    ]);
    if (/: (?:true|set)\s*$/m.test(generated.stdout)) return;
    const before = hashes(change.before ?? ""),
      after = hashes(change.after ?? "");
    if (before.length > 4096 || after.length > 4096) return;
    let file = Object.hasOwn(this.#state.files, name)
      ? this.#state.files[name]
      : undefined;
    if (!file) {
      const baseline = this.#blob(this.#state.head, name);
      if (!baseline || Object.keys(this.#state.files).length >= 32) return;
      file = {
        baseline,
        latest: before,
        owners: before.map(() => false),
        removed: {},
      };
      Object.defineProperty(this.#state.files, name, {
        value: file,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    apply(file, before, false);
    apply(file, after, true);
    this.#save();
  }
  observeCommit(): void {
    if (!buildFlag("contribution_attribution")) return;
    if (!this.options.enabled()) return;
    const next = this.#git(["rev-parse", "--verify", "HEAD"]);
    if (next.code !== 0 || next.stdout.trim() === this.#state.head) return;
    const head = next.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) return;
    if (
      this.#state.head &&
      this.#git(["merge-base", "--is-ancestor", this.#state.head, head])
        .code !== 0
    ) {
      this.#state = {
        head,
        files: Object.create(null),
        messages: 0,
        permissions: 0,
      };
      this.#save();
      return;
    }
    const detail: Record<
      string,
      { agent: number; total: number; percent: number }
    > = Object.create(null);
    let agent = 0,
      total = 0;
    for (const [name, file] of Object.entries(this.#state.files)) {
      if (this.#name(resolve(this.options.cwd, name)) !== name) continue;
      const committed = this.#blob(head, name);
      if (!committed) continue;
      const view: FileState = {
        baseline: file.baseline,
        latest: [...file.latest],
        owners: [...file.owners],
        removed: { ...file.removed },
      };
      apply(view, committed, false);
      let index = 0,
        owned = 0,
        changed = 0;
      const removed = { ...file.removed };
      for (const op of diffLines(file.baseline.join("\n"), committed.join("\n"))
        .ops) {
        if (op.kind === "same") index++;
        else if (op.kind === "add") {
          changed++;
          if (view.owners[index]) owned++;
          index++;
        } else {
          changed++;
          if ((removed[op.line] ?? 0) > 0) {
            owned++;
            removed[op.line]!--;
          }
        }
      }
      if (changed) {
        detail[name] = {
          agent: owned,
          total: changed,
          percent: Math.round((owned / changed) * 100),
        };
        agent += owned;
        total += changed;
        file.baseline = committed;
        file.removed = {};
      }
    }
    if (total) {
      const note = JSON.stringify({
        schemaVersion: 1,
        percent: Math.round((agent / total) * 100),
        files: detail,
        surface: this.options.surface,
        ...(this.options.tier() ? { modelTier: this.options.tier() } : {}),
        messages: this.#state.messages,
        permissionRequests: this.#state.permissions,
      });
      const saved = this.#git(
        ["notes", "--ref=" + this.options.ref, "add", "-F", "-", head],
        note,
      );
      if (saved.code !== 0)
        this.options.warn(
          "Note d’attribution non enregistrée ; le commit reste conservé et aucune note existante n’est remplacée.",
        );
    }
    this.#state.head = head;
    this.#state.messages = 0;
    this.#state.permissions = 0;
    this.#save();
  }
}
