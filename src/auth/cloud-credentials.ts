// Implements: SPEC-API-015 (CA-01, EF-01/02, RG-01, command failure and interprocess coordination).
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryFileLock } from "../platform/file-lock";
import { launchLine, startChild } from "../platform/process";
import { securePrivateDirectory } from "../platform/private-file";
import { comparablePath, currentPlatform, realPathOrSelf } from "../platform/system";
import { splitArguments } from "../skills/invoke";
import { writeAtomic } from "../tools/text-file";
import { maskSecrets } from "../shared/secrets";
import { StringDecoder } from "node:string_decoder";

export interface AwsCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; readonly expires?: number }
export interface CloudRefresh { readonly aws?: { readonly refresh?: string; readonly export?: string }; readonly gcp?: { readonly refresh: string } }
const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\x00-\x20\x7f]/.test(value);
export function parseAwsExport(text: string): AwsCredentials {
  let row: Record<string, unknown>;
  try { row = JSON.parse(text); } catch { throw new Error("Export d'identifiants cloud invalide."); }
  if (!row || !valid(row["AccessKeyId"]) || !valid(row["SecretAccessKey"]) || row["SessionToken"] !== undefined && !valid(row["SessionToken"])) throw new Error("Export d'identifiants cloud invalide.");
  const expires = typeof row["Expiration"] === "string" ? Date.parse(row["Expiration"]) : undefined;
  if (expires !== undefined && (!Number.isFinite(expires) || expires <= Date.now()) || row["Expiration"] !== undefined && typeof row["Expiration"] !== "string") throw new Error("Identifiants cloud exportés déjà expirés ou expiration invalide.");
  return { accessKeyId: row["AccessKeyId"], secretAccessKey: row["SecretAccessKey"], ...(typeof row["SessionToken"] === "string" ? { sessionToken: row["SessionToken"] } : {}), ...(expires !== undefined ? { expires } : {}) };
}

export class CloudCredentials {
  #cached?: { value: string; expires: number };
  #operation?: { readonly promise: Promise<string>; readonly controller: AbortController; waiters: number };
  readonly #life = new AbortController();
  readonly #directory: string;
  readonly #scope: string;
  readonly #secrets = new Set<string>();
  #generation?: string;
  constructor(readonly options: { readonly commands: NonNullable<CloudRefresh["aws"]>; readonly initial?: AwsCredentials; readonly service: string; readonly home: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly remember: (secret: string) => void; readonly report: (message: string) => void; readonly assertCurrent: () => void; readonly refreshTimeoutMs?: number; readonly exportTimeoutMs?: number }) {
    this.#directory = join(tmpdir(), "cloud-auth-" + createHash("sha256").update(options.service + "\n" + comparablePath(realPathOrSelf(options.home))).digest("hex"));
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.#directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Dossier de coordination cloud invalide.");
    securePrivateDirectory(this.#directory);
    this.#scope = createHash("sha256").update(JSON.stringify(options.commands)).digest("hex");
    this.#generation = this.#receipt();
    if (options.initial) this.#remember(options.initial);
  }
  #receipt(): string | undefined {
    try {
      const file = join(this.#directory, "generation.json"), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new Error("Coordination cloud invalide.");
      const row = JSON.parse(readFileSync(file, "utf8"));
      return row.scope === this.#scope && typeof row.generation === "string" ? row.generation : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  #remember(credentials: AwsCredentials): string {
    for (const value of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken]) if (value) { this.#secrets.add(value); this.options.remember(value); }
    const value = JSON.stringify(credentials); this.options.remember(value);
    this.#cached = { value, expires: credentials.expires ?? Infinity }; return value;
  }
  async get(signal: AbortSignal, rejected?: string): Promise<string> {
    signal.throwIfAborted(); this.#life.signal.throwIfAborted();
    if (this.#cached && this.#cached.expires > Date.now() && rejected !== this.#cached.value) return this.#cached.value;
    if (this.#operation?.controller.signal.aborted) { await this.#operation.promise.catch(() => undefined); return this.get(signal, rejected); }
    if (!this.#operation) {
      const controller = new AbortController();
      const operation = { controller, waiters: 0, promise: this.#renew(AbortSignal.any([controller.signal, this.#life.signal])).finally(() => { if (this.#operation === operation) this.#operation = undefined; }) };
      this.#operation = operation;
    }
    const operation = this.#operation; operation.waiters++;
    try { return await new Promise<string>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      void operation.promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    }); } finally { operation.waiters--; if (operation.waiters === 0 && this.#operation === operation) operation.controller.abort(); }
  }
  async #renew(signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + 180000; let release: (() => void) | undefined;
    while (!(release = tryFileLock(join(this.#directory, "refresh.lock")))) {
      signal.throwIfAborted(); this.options.assertCurrent();
      if (Date.now() >= deadline) throw new Error("Renouvellement des identifiants cloud occupé trop longtemps.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    try {
      signal.throwIfAborted(); this.options.assertCurrent();
      const generation = this.#receipt();
      if (!generation || generation === this.#generation) {
        if (!this.options.commands.refresh) throw new Error("Renouvellement des identifiants cloud impossible : commande de renouvellement absente.");
        await this.#run(this.options.commands.refresh, false, signal);
        this.#generation = randomUUID();
        writeAtomic(join(this.#directory, "generation.json"), Buffer.from(JSON.stringify({ scope: this.#scope, generation: this.#generation })), currentPlatform(), true);
      } else this.#generation = generation;
    } finally { release(); }
    this.options.assertCurrent(); signal.throwIfAborted();
    if (!this.options.commands.export) throw new Error("Renouvellement des identifiants cloud impossible : commande d'export AWS absente.");
    return this.#remember(parseAwsExport(await this.#run(this.options.commands.export, true, signal)));
  }
  async #run(command: string, exporting: boolean, signal: AbortSignal): Promise<string> {
    this.options.assertCurrent(); signal.throwIfAborted();
    const [program, ...args] = splitArguments(command);
    if (!program) throw new Error("Commande cloud vide.");
    const launch = launchLine(program, args, this.options.env), chunks: Buffer[] = [];
    let bytes = 0, timeout = false, oversized = false, revoked = false, stopping: Promise<void> | undefined;
    const decoder = new StringDecoder("utf8"); let pending = "";
    const report = (text: string) => { let safe = text; for (const secret of this.#secrets) safe = safe.split(secret).join("[redacted credential]"); this.options.report(maskSecrets(safe)); };
    const output = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) { oversized = true; stop(); return; }
      if (exporting) chunks.push(chunk);
      else { pending += decoder.write(chunk); const end = pending.lastIndexOf("\n"); if (end >= 0) { report(pending.slice(0, end + 1)); pending = pending.slice(end + 1); } }
    };
    const child = startChild(launch.file, launch.args, { cwd: this.options.cwd, env: this.options.env, onData: output, onErrorData: exporting ? chunk => { bytes += chunk.length; if (bytes > 65536) { oversized = true; stop(); } } : output });
    const stop = () => { stopping ??= child.killTree(100); }, abort = () => stop();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timeout = true; stop(); }, exporting ? this.options.exportTimeoutMs ?? 10000 : this.options.refreshTimeoutMs ?? 120000);
    const policyTimer = setInterval(() => { try { this.options.assertCurrent(); } catch { revoked = true; stop(); } }, 100);
    try {
      if (signal.aborted) stop(); const code = await child.exited; await stopping;
      if (!exporting && !oversized && pending) report(pending + decoder.end());
      signal.throwIfAborted(); this.options.assertCurrent();
      if (revoked) throw new Error("Renouvellement cloud arrêté : configuration révoquée.");
      if (timeout || oversized || code !== 0) throw new Error("Renouvellement des identifiants cloud impossible : commande en échec, sortie excessive ou délai dépassé.");
      return Buffer.concat(chunks).toString("utf8");
    } finally { clearTimeout(timer); clearInterval(policyTimer); signal.removeEventListener("abort", abort); }
  }
  async close(): Promise<void> { this.#life.abort(); await this.#operation?.promise.catch(() => undefined); this.#cached = undefined; }
}
