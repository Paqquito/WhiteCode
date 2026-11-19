// Implements: SPEC-OUT-008 (§ 5.1, § 5.3 points 4, 5, 7 and 8, FA-02, EF-01 to EF-08, EF-11, ERR-02 to ERR-04, RG-03, ENF-02, CA-01, CA-03, CA-04, CA-06, CA-07),
//             SPEC-OUT-009 (§ 5.1, § 5.3 points 1, 3 to 5, EF-01 to EF-03, EF-05, RG-02, ERR-01, ERR-02, CA-01, CA-04, CA-05)
// Supports: SPEC-CFG-007 (RG-02 environment of child processes), SPEC-MOT-002 (RG-05), gap E-051 (environment snapshot, detection)
// Supports: SPEC-OUT-008 (RG-03, cancellation waits for the process group), gap E-148.
// Supports: SPEC-AGT-016 (background initialization waits asynchronously).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import { runToCompletion, startChild, type Child } from "../platform/process";
import { comparablePath, findExecutable, isWithin, realPathOrSelf, type PlatformName } from "../platform/system";
import type { ResultStore } from "../session/result-store";
import { boundText, cleanOutput } from "./output-bounds";
import { stripShellHints, ShellHintStream } from "./shell-hints";
import { encryptedStore, storeWrite } from "../session/private-storage";
import { randomUUID } from "node:crypto";
import { ShellMetadataStream } from "./shell-metadata";
import type { CommandSandbox } from "../platform/sandbox";

export interface PosixShell {
  readonly path: string;
  /** Name of the shell (`bash`, `zsh`, `sh`…), which selects the snapshot commands. */
  readonly name: string;
}

export interface PowerShellInfo {
  readonly path: string;
  readonly edition: "7" | "5.1";
}

export interface ShellSettings {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly outputLimit: number;
  readonly graceMs: number;
  readonly powershellLoadProfile: boolean;
}

export interface ShellResult {
  readonly sandboxed?: boolean;
  readonly violations?: readonly string[];
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly durationMs: number;
  /** Notice when the working folder left the allowed folders (ERR-04). */
  readonly cwdNotice?: string;
  /** Complete output stored apart when it exceeded the limit. */
  readonly fullOutputPath?: string;
  readonly truncated: boolean;
}

const EXE = (platform: PlatformName, name: string) => (platform === "windows" && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name);

/** Launcher of the Linux subsystem (System32): not a native POSIX shell (EF-01). */
function isSubsystemLauncher(path: string, env: Readonly<Record<string, string>>): boolean {
  const root = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";
  const p = comparablePath(path, "windows");
  return p.startsWith(comparablePath(join(root, "System32"), "windows")) || p.includes("/windowsapps/");
}

/**
 * POSIX shell (EF-01): `tools.shell.default`, otherwise the user's shell, otherwise `bash`.
 * On Windows, only a native POSIX shell (such as the one of Git for Windows) qualifies.
 */
export function detectPosixShell(configured: string | undefined, env: Readonly<Record<string, string>>, platform: PlatformName): PosixShell | undefined {
  const accept = (candidate: string | undefined): PosixShell | undefined => {
    if (!candidate) return undefined;
    const path = isAbsolute(candidate) ? (existsSync(candidate) ? candidate : existsSync(EXE(platform, candidate)) ? EXE(platform, candidate) : undefined) : findExecutable(candidate);
    if (!path) return undefined;
    if (platform === "windows" && isSubsystemLauncher(path, env)) return undefined;
    return { path, name: basename(path).replace(/\.exe$/i, "").toLowerCase() };
  };
  if (configured) return accept(configured);
  const fromUser = accept(env["SHELL"]);
  if (fromUser) return fromUser;
  const bash = accept("bash");
  if (bash) return bash;
  if (platform === "windows") {
    for (const base of [env["ProgramFiles"], env["ProgramW6432"], env["LOCALAPPDATA"] ? join(env["LOCALAPPDATA"], "Programs") : undefined]) {
      if (!base) continue;
      const found = accept(join(base, "Git", "bin", "bash.exe"));
      if (found) return found;
    }
  }
  return undefined;
}

/** PowerShell (§ 5.3 point 1): `tools.powershell.path`, otherwise edition 7 and later (`pwsh`), otherwise 5.1 on Windows. */
export function detectPowerShell(configured: string | undefined, platform: PlatformName): PowerShellInfo | undefined {
  const edition = (path: string): "7" | "5.1" => (/^pwsh/i.test(basename(path)) ? "7" : "5.1");
  if (configured) {
    const path = isAbsolute(configured) ? (existsSync(configured) ? configured : undefined) : findExecutable(configured);
    return path ? { path, edition: edition(path) } : undefined;
  }
  const pwsh = findExecutable("pwsh");
  if (pwsh) return { path: pwsh, edition: "7" };
  if (platform === "windows") {
    const legacy = findExecutable("powershell");
    if (legacy) return { path: legacy, edition: "5.1" };
  }
  return undefined;
}

const quotePosix = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const quotePs = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Paths given to a POSIX shell: forward slashes (a Windows native POSIX shell accepts `C:/…`). */
const posixPath = (p: string, platform: PlatformName) => (platform === "windows" ? p.replace(/\\/g, "/") : p);

/** Variables never replayed from the snapshot: volatile ones and those of the shell itself. */
const VOLATILE = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PS1", "PS2", "PS4", "PROMPT_COMMAND", "BASH_EXECUTION_STRING", "SHELLOPTS", "BASHOPTS", "HISTFILE", "TERM_SESSION_ID"]);
const BEGIN = "#--snapshot-begin--";
const END = "#--snapshot-end--";

interface SnapshotCapture {
  readonly controller: AbortController;
  readonly pending: Promise<string | undefined>;
  waiters: number;
}

export interface ShellRuntimeOptions {
  readonly sandbox?: CommandSandbox;
  /** A non-Git custom copy must not accidentally discover the original enclosing repository. */
  readonly repositoryCeiling?: () => string | undefined;
  readonly hintTag?: string;
  readonly recommend?: (ref: string, command: string) => void;
  readonly platform: PlatformName;
  readonly projectCwd: string;
  readonly allowedDirectories: readonly string[];
  /** Environment of the child processes (SPEC-CFG-007 RG-02), prepared by the configuration. */
  readonly childEnv: Readonly<Record<string, string>>;
  /** Variables that must win over the snapshot: `environment.variables` and `CHILD_PROCESS`. */
  readonly forcedVariables: Readonly<Record<string, string>>;
  /** Names never replayed from the snapshot (product variables, secrets). */
  readonly excluded: (name: string) => boolean;
  readonly posix?: PosixShell;
  readonly powershell?: PowerShellInfo;
  /** `{{ENV_PREFIX}}SHELL_INIT_FILE`: sourced before each POSIX command. */
  readonly initFile?: string;
  /** Private folder of the session for the snapshot and the working-folder files. */
  readonly workDir: string;
  readonly settings: ShellSettings;
  readonly store?: ResultStore;
  readonly warn?: (message: string) => void;
}

/** Shell state of a session: working folder kept between calls (EF-02), snapshot, running processes. */
export class ShellRuntime {
  #cwd: string;
  #snapshot: string | undefined | null = null;
  #snapshotText?: string;
  #snapshotCapture?: SnapshotCapture;
  #stopEpoch = 0;
  #preparing = 0;
  readonly #running = new Set<Child>();
  #counter = 0;

  constructor(readonly options: ShellRuntimeOptions) {
    this.#cwd = options.projectCwd;
  }

  get running(): boolean { return this.#preparing > 0 || this.#running.size > 0; }
  get sandboxEnabled(): boolean { return this.options.sandbox?.profile(this.#cwd, this.options.allowedDirectories).enabled ?? false; }
  sandboxRefusal(command: string, outside = false) { return this.options.sandbox?.refusal(command, this.#cwd, this.options.allowedDirectories, outside); }
  sandboxContribution(command: string, outside = false) { return this.options.sandbox?.contribution(command, this.#cwd, this.options.allowedDirectories, outside); }
  /** Supports: SPEC-OUT-026; trusted composition changes the working folder only while idle. */
  selectWorkingDirectory(path: string): void {
    if (this.running || !this.options.allowedDirectories.some(folder => isWithin(path, folder, this.options.platform))) throw new Error("Shell working folder cannot change while active or outside its perimeter.");
    this.#cwd = path;
  }

  get cwd(): string {
    return this.#cwd;
  }

  /** Stops every process still running (RG-03: none outlives the session). */
  async stopAll(): Promise<void> {
    this.#stopEpoch++;
    const capture = this.#snapshotCapture;
    capture?.controller.abort();
    await Promise.all([...this.#running].map((c) => c.killTree(this.options.settings.graceMs)));
    await capture?.pending.catch(() => {});
  }

  /** Environment snapshot (EF-03): aliases, functions and exported variables of the user's shell, captured once. */
  async snapshot(signal = new AbortController().signal): Promise<string | undefined> {
    signal.throwIfAborted();
    if (this.sandboxEnabled) return undefined;
    if (this.#snapshotCapture?.controller.signal.aborted) {
      // Join the cancelled generation before a new caller retries the capture.
      await this.#snapshotCapture.pending.catch(() => {});
      return this.snapshot(signal);
    }
    if (!this.#snapshotCapture) {
      if (this.#snapshot !== null) return this.#snapshot;
      this.#snapshot = undefined;
      const controller = new AbortController();
      const capture: SnapshotCapture = {
        controller, waiters: 0,
        pending: this.#captureSnapshot(controller.signal).catch(error => {
          if (controller.signal.aborted) this.#snapshot = null;
          throw error;
        }).finally(() => { if (this.#snapshotCapture === capture) this.#snapshotCapture = undefined; }),
      };
      this.#snapshotCapture = capture;
    }
    const capture = this.#snapshotCapture;
    capture.waiters++;
    let onAbort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([capture.pending, cancelled]);
      signal.throwIfAborted();
      return value;
    } finally {
      signal.removeEventListener("abort", onAbort);
      capture.waiters--;
      if (signal.aborted && capture.waiters === 0) {
        capture.controller.abort();
        await capture.pending.catch(() => {});
      }
    }
  }

  async #captureSnapshot(signal: AbortSignal): Promise<string | undefined> {
    const shell = this.options.posix;
    if (!shell) return undefined;
    const dump =
      shell.name === "zsh"
        ? `echo '${BEGIN}'; alias -L; for f in \${(k)functions}; do [[ $f == _* ]] || typeset -f -- "$f"; done; export -p; echo '${END}'`
        : shell.name === "bash"
          ? `echo '${BEGIN}'; echo 'shopt -s expand_aliases'; alias -p; for f in $(declare -F | awk '{print $3}'); do case "$f" in _*) ;; *) declare -f -- "$f";; esac; done; export -p; echo '${END}'`
          : `echo '${BEGIN}'; alias 2>/dev/null; export -p; echo '${END}'`;
    const args = shell.name === "bash" || shell.name === "zsh" ? ["-i", "-c", dump] : ["-c", dump];
    const chunks: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, stopped = false, stopping: Promise<void> | undefined;
    let child: Child;
    const stop = () => { stopped = true; return stopping ??= child.killTree(this.options.settings.graceMs); };
    const receive = (chunk: Buffer, error: boolean) => {
      if (error) stderrBytes += chunk.length; else stdoutBytes += chunk.length;
      // Bound each initialization stream to one MiB; oversized capture is discarded.
      if (stdoutBytes > 1_048_576 || stderrBytes > 1_048_576) { void stop(); return; }
      if (!error) chunks.push(chunk);
    };
    const unavailable = () => { this.options.warn?.("instantané de l'environnement du shell indisponible : les commandes s'exécutent sans les alias ni les fonctions de l'utilisateur."); return undefined; };
    try { child = startChild(shell.path, args, { cwd: this.options.projectCwd, env: this.options.childEnv, onData: chunk => receive(chunk, false), onErrorData: chunk => receive(chunk, true) }); }
    catch { return unavailable(); }
    const tracked: Child = { ...child, killTree: () => stop() };
    this.#running.add(tracked);
    const onAbort = () => { void stop(); };
    signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
    const timer = setTimeout(onAbort, 10_000);
    try { await child.exited; await stopping; signal.throwIfAborted(); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); this.#running.delete(tracked); }
    const stdout = Buffer.concat(chunks).toString("utf8"), start = stdout.indexOf(BEGIN), end = stdout.lastIndexOf(END);
    if (stopped || start === -1 || end === -1) {
      return unavailable();
    }
    const body = stdout.slice(start + BEGIN.length, end).replace(/\r\n/g, "\n");
    const kept: string[] = [];
    let keep = true;
    for (const line of body.split("\n")) {
      const exported = /^(?:declare -x|export|typeset -x) ([A-Za-z_][A-Za-z0-9_]*)(=|$)/.exec(line);
      if (exported) keep = !this.options.excluded(exported[1]!) && !VOLATILE.has(exported[1]!) && !(exported[1]! in this.options.forcedVariables);
      else if (/^(?:declare -[a-wyzA-Z]+x?|declare -[a-z]*x[a-z]*) /.test(line)) keep = false; // readonly or typed exports
      else if (/^(alias |[A-Za-z_][\w:-]* \(\) |[A-Za-z_][\w:-]* \(\)$|function |shopt )/.test(line)) keep = true;
      if (keep) kept.push(line);
    }
    const forced = Object.entries(this.options.forcedVariables).map(([k, v]) => `export ${k}=${quotePosix(v)}`);
    if (encryptedStore(this.options.workDir)) { this.#snapshotText = [...kept, ...forced, ""].join("\n"); return undefined; }
    mkdirSync(this.options.workDir, { recursive: true });
    const file = join(this.options.workDir, "shell-snapshot.sh");
    writeFileSync(file, [...kept, ...forced, ""].join("\n"), "utf8");
    this.#snapshot = file;
    return file;
  }

  #newCwd(reported: string | undefined): string | undefined {
    if (!reported) return undefined;
    const raw = reported.trim().replace(/^\uFEFF/, "");
    if (raw === "") return undefined;
    // A native POSIX shell on Windows may report `/c/x`; `pwd -W` gives `C:/x`.
    const windowsDrive = /^\/([a-zA-Z])\/(.*)$/.exec(raw);
    const path = this.options.platform === "windows" && windowsDrive ? `${windowsDrive[1]!.toUpperCase()}:/${windowsDrive[2]}` : raw;
    return normalize(path);
  }

  /** Runs `command` in the POSIX shell (§ 5.3). */
  async runPosix(command: string, timeoutMs: number, signal: AbortSignal, onOutput?: (chunk: string) => void, outside = false): Promise<ShellResult> {
    const shell = this.options.posix!;
    let confined = this.options.sandbox?.mode(command, this.#cwd, this.options.allowedDirectories, outside) === "confined";
    const p = (x: string) => posixPath(x, this.options.platform);
    const epoch = this.#stopEpoch, preparingAt = Date.now(); let snapshot: string | undefined;
    this.#preparing++;
    try {
      snapshot = confined ? undefined : await this.snapshot(signal);
      signal.throwIfAborted();
      if (epoch !== this.#stopEpoch) throw Object.assign(new Error("Shell operation stopped."), { name: "AbortError" });
      // The live managed policy may have changed while the profile process was pending.
      confined = this.options.sandbox?.mode(command, this.#cwd, this.options.allowedDirectories, outside) === "confined";
      if (confined) snapshot = undefined;
    } catch (error) {
      if (signal.aborted || epoch !== this.#stopEpoch) {
        return { output: "", exitCode: null, timedOut: false, interrupted: true, durationMs: Date.now() - preparingAt, truncated: false };
      }
      throw error;
    } finally { this.#preparing--; }
    const privateMode = confined || encryptedStore(this.options.workDir);
    const metadata = privateMode ? randomUUID() : undefined;
    const cwdFile = join(this.options.workDir, `cwd-${process.pid}-${++this.#counter}`);
    // Windows: the POSIX layer's own process id, to stop the command's process group through the shell (gap E-051).
    const groupFile = this.options.platform === "windows" && !privateMode ? `${cwdFile}.group` : undefined;
    if (!privateMode) mkdirSync(this.options.workDir, { recursive: true });
    const lines = [
      groupFile ? `echo $$ > ${quotePosix(p(groupFile))}` : "",
      snapshot ? `. ${quotePosix(p(snapshot))} >/dev/null 2>&1` : "",
      !confined && this.#snapshotText ? ". /dev/stdin >/dev/null 2>&1 || :" : "",
      !confined && this.options.initFile ? `. ${quotePosix(p(this.options.initFile))}` : "",
      `cd -- ${quotePosix(p(this.#cwd))} || exit 1`,
      this.options.repositoryCeiling?.() ? `export GIT_CEILING_DIRECTORIES=${quotePosix(p(this.options.repositoryCeiling()!))}` : "",
      `eval ${quotePosix(command)}`,
      "__status=$?",
      metadata ? `printf '\\036${metadata}:'; pwd -W 2>/dev/null || pwd -P; printf '\\037'` : `{ pwd -W 2>/dev/null || pwd -P; } > ${quotePosix(p(cwdFile))} 2>/dev/null`,
      "exit $__status",
    ];
    const stopDescendants = groupFile
      ? () => {
          const group = readFileSync(groupFile, "utf8").trim();
          if (/^\d+$/.test(group)) runToCompletion(shell.path, ["-c", `kill -KILL -- -${group}`], { cwd: this.options.projectCwd, env: this.options.childEnv, timeoutMs: 5_000 });
        }
      : undefined;
    try {
      return await this.#run(shell.path, ["-c", lines.filter((l) => l !== "").join("\n")], cwdFile, timeoutMs, signal, stopDescendants, onOutput, command, confined ? undefined : this.#snapshotText, metadata, confined);
    } finally {
      if (groupFile) rmSync(groupFile, { force: true });
    }
  }

  /** Runs `command` in PowerShell (§ 5.3 of SPEC-OUT-009): no profile unless configured, UTF-8 output, syntax errors reported. */
  async runPowerShell(command: string, timeoutMs: number, signal: AbortSignal, onOutput?: (chunk: string) => void, outside = false, choiceNonce?: string): Promise<ShellResult> {
    const ps = this.options.powershell!;
    const confined = this.options.sandbox?.mode(command, this.#cwd, this.options.allowedDirectories, outside) === "confined";
    const cwdFile = join(this.options.workDir, `cwd-${process.pid}-${++this.#counter}`);
    const privateMode = confined || encryptedStore(this.options.workDir);
    const metadata = privateMode ? randomUUID() : undefined;
    if (!privateMode) mkdirSync(this.options.workDir, { recursive: true });
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Continue'",
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
      "$OutputEncoding = [Console]::OutputEncoding",
      ...(choiceNonce ? [`$env:TOOL_CHOICE_NONCE = ${quotePs(choiceNonce)}`] : []),
      `Set-Location -LiteralPath ${quotePs(this.#cwd)}`,
      this.options.repositoryCeiling?.() ? `$env:GIT_CEILING_DIRECTORIES = ${quotePs(this.options.repositoryCeiling()!)}` : "",
      `$__source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      "try { $__block = [ScriptBlock]::Create($__source) } catch { [Console]::Out.WriteLine('Syntax error: ' + $_.Exception.InnerException.Message); if (-not $_.Exception.InnerException) { [Console]::Out.WriteLine($_.Exception.Message) }; exit 1 }",
      "$global:LASTEXITCODE = 0",
      "$__errors = $Error.Count",
      "$__ok = $true",
      // Standard error of native programs is not merged: text on it with exit code 0 is not a failure (§ 5.3 point 4, CA-04).
      "try { . $__block | Out-String -Stream -Width 4096 | ForEach-Object { [Console]::Out.WriteLine($_) }; $__ok = ($Error.Count -eq $__errors) } catch { [Console]::Out.WriteLine(($_ | Out-String).TrimEnd()); $__ok = $false }",
      "$__code = if ($global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } elseif (-not $__ok) { 1 } else { 0 }",
      metadata ? `[Console]::Out.Write([char]30 + '${metadata}:' + (Get-Location).ProviderPath + [char]31)` : `[IO.File]::WriteAllText(${quotePs(cwdFile)}, (Get-Location).ProviderPath)`,
      "exit $__code",
    ].join("\n");
    const args = ["-NoLogo", "-NonInteractive", ...(!confined && this.options.settings.powershellLoadProfile ? [] : ["-NoProfile"]), "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    const result = await this.#run(ps.path, args, cwdFile, timeoutMs, signal, undefined, onOutput, command, undefined, metadata, confined);
    // ERR-02: a script blocked by the execution policy of the machine is stated explicitly.
    if (/PSSecurityException|UnauthorizedAccess|running scripts is disabled/i.test(result.output)) {
      return { ...result, output: `${result.output}\n[Script execution is blocked by the execution policy of this machine.]` };
    }
    return result;
  }

  async #run(file: string, args: string[], cwdFile: string, timeoutMs: number, signal: AbortSignal, stopDescendants?: () => void, onOutput?: (chunk: string) => void, command = "", input?: string, metadataNonce?: string, confined = false): Promise<ShellResult> {
    const started = Date.now();
    const chunks: Buffer[] = [];
    // The output as it comes, for the shell mode of the interface (SPEC-IHM-012 EF-04).
    const decoder = new TextDecoder();
    const metadataDecoder = new TextDecoder(); let privateCwd: string | undefined;
    const metadata = metadataNonce ? new ShellMetadataStream(metadataNonce, path => { privateCwd = path; }) : undefined;
    const hints = this.options.hintTag ? new ShellHintStream(this.options.hintTag) : undefined;
    const onData = (raw: Buffer) => {
      const c = metadata ? Buffer.from(metadata.push(metadataDecoder.decode(raw, { stream: true }))) : raw;
      chunks.push(c);
      if (onOutput) { const decoded = decoder.decode(c, { stream: true }); const safe = hints ? hints.push(decoded) : decoded; if (safe) onOutput(safe); }
    };
    const launch = confined ? this.options.sandbox!.launch({ command, file, args, cwd: this.#cwd, allowed: this.options.allowedDirectories, environment: this.options.childEnv }) : undefined;
    let child: Child;
    try { child = startChild(launch?.file ?? file, launch?.args ?? args, { cwd: existsSync(this.#cwd) ? this.#cwd : this.options.projectCwd, env: launch?.environment ?? this.options.childEnv, extraFds: launch?.fds, onData, stopDescendants, input }); launch?.spawned(); }
    catch (error) { launch?.close(); throw error; }
    this.#running.add(child);
    let timedOut = false;
    let interrupted = false;
    let stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= child.killTree(this.options.settings.graceMs); };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      stop();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const exitCode = await child.exited;
    if (metadata) { const last = Buffer.from(metadata.push(metadataDecoder.decode(), true)); if (last.length) { chunks.push(last); if (onOutput) { const decoded = decoder.decode(last, { stream: true }), safe = hints ? hints.push(decoded) : decoded; if (safe) onOutput(safe); } } }
    if (onOutput) { const decoded = decoder.decode(), safe = hints ? hints.push(decoded, true) : decoded; if (safe) onOutput(safe); }
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // The group can outlive its leader: wait for cancellation before returning a stopped result.
    await stopping;
    this.#running.delete(child);
    launch?.close();

    // New working folder (§ 5.3 point 5): kept when inside the allowed folders, otherwise reset (ERR-04, CA-07).
    let cwdNotice: string | undefined;
    let reported: string | undefined;
    try {
      reported = metadata ? privateCwd : readFileSync(cwdFile, "utf8");
      if (!metadata) rmSync(cwdFile, { force: true });
    } catch {
      reported = undefined;
    }
    const next = this.#newCwd(reported);
    if (next && comparablePath(next, this.options.platform) !== comparablePath(this.#cwd, this.options.platform)) {
      const real = realPathOrSelf(next);
      const allowed = this.options.allowedDirectories.some((d) => isWithin(next, d, this.options.platform) && isWithin(real, d, this.options.platform));
      if (allowed) this.#cwd = next;
      else {
        this.#cwd = this.options.projectCwd;
        cwdNotice = `Working directory reset to ${this.options.projectCwd}: ${next} is outside the allowed folders.`;
      }
    }

    // Bounded output (§ 5.3 point 7); the complete output is stored apart.
    const raw = cleanOutput(Buffer.concat(chunks));
    const full = this.options.hintTag ? stripShellHints(raw, this.options.hintTag, ref => this.options.recommend?.(ref, command)) : raw;
    const violations = [...(launch?.violations ?? [])];
    if (confined && /Read-only file system|Permission denied|Operation not permitted|Sandbox relay disconnected/i.test(full)) { const message = "Sandbox filesystem or system access denied; see command diagnostics."; violations.push(message); this.options.warn?.(message); }
    const bounded = boundText(full, this.options.settings.outputLimit);
    const fullOutputPath = bounded.truncated && this.options.store ? this.options.store.store(`shell-${started}-${this.#counter}`, full) : undefined;
    return { output: bounded.text, exitCode, timedOut, interrupted, durationMs: Date.now() - started, cwdNotice, fullOutputPath, truncated: bounded.truncated, ...(confined ? { sandboxed: true, violations } : {}) };
  }
}

/** Text returned to the model (§ 5.3 point 8): output, exit code, and the notices of time limit, interruption and working folder. */
export function formatShellResult(r: ShellResult, timeoutMs: number): string {
  const notes: string[] = [];
  if (r.sandboxed) notes.push("Confined command.");
  if (r.violations?.length) notes.push(...r.violations);
  if (r.timedOut) notes.push(`Command stopped after ${Math.round(timeoutMs / 1000)} s (time limit); the output above is partial.`); // ERR-03
  else if (r.interrupted) notes.push("Command interrupted.");
  else if (r.exitCode !== 0) notes.push(`Exit code ${r.exitCode ?? "unknown (ended by a signal)"}.`); // ERR-01: not a tool error
  if (r.truncated) notes.push(r.fullOutputPath ? `Output truncated; the complete output is in ${r.fullOutputPath} (readable with read_file).` : "Output truncated.");
  if (r.cwdNotice) notes.push(r.cwdNotice);
  const body = r.output === "" ? "(no output)" : r.output.replace(/\n$/, "");
  return notes.length > 0 ? `${body}\n\n[${notes.join(" ")}]` : body;
}
