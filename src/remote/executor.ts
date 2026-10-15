// Implements: SPEC-MOD-023/024, SPEC-API-028 (separate bounded executor credential, isolated work and revocation); gap E-186.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export class ExecutorCredentialInvalid extends Error {
  constructor() {
    super(
      "Identifiant d’exécuteur invalide : demandez-en un nouveau à l’administrateur.",
    );
  }
}
export interface ExecutorCredential {
  readonly kind: "executor";
  readonly token: string;
  readonly organizationId: string;
  readonly environment: string;
  readonly expiresAt: number;
}
export interface Assignment {
  readonly id: string;
  readonly environment: string;
  readonly labels: readonly string[];
  readonly repository: string;
  readonly commit: string;
  readonly prompt: string;
  readonly workSecret: string;
  readonly expiresAt: number;
}
interface Options {
  readonly kind: "session" | "job";
  readonly environment: string;
  readonly organizationId: string;
  readonly labels: readonly string[];
  readonly capacity: number;
  readonly root: string;
  readonly credential: () => Promise<ExecutorCredential | undefined>;
  readonly request: (
    path: string,
    body: unknown,
    signal: AbortSignal,
    credential: string,
  ) => Promise<unknown>;
  readonly prepare: (
    directory: string,
    assignment: Assignment,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly run: (
    directory: string,
    input: Pick<Assignment, "id" | "prompt">,
    signal: AbortSignal,
    write: (text: string) => void,
  ) => Promise<{ code: number; result: string }>;
  readonly report: (message: string) => void;
  readonly redact?: (text: string) => string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function assignment(raw: unknown, now: number): Assignment | undefined {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "id",
          "environment",
          "labels",
          "repository",
          "commit",
          "prompt",
          "workSecret",
          "expiresAt",
        ].includes(key),
    ) ||
    !identifier(raw.id) ||
    !identifier(raw.environment) ||
    !Array.isArray(raw.labels) ||
    raw.labels.length > 32 ||
    !raw.labels.every(identifier) ||
    typeof raw.repository !== "string" ||
    raw.repository.length > 4096 ||
    typeof raw.commit !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(raw.commit) ||
    typeof raw.prompt !== "string" ||
    !raw.prompt.trim() ||
    raw.prompt.length > 32000 ||
    /[\u0000\u001b]/.test(raw.prompt) ||
    typeof raw.workSecret !== "string" ||
    !/^work_[A-Za-z0-9_-]{32,256}$/.test(raw.workSecret) ||
    typeof raw.expiresAt !== "number" ||
    !Number.isFinite(raw.expiresAt) ||
    raw.expiresAt <= now ||
    raw.expiresAt > now + 86400000
  )
    return;
  try {
    const url = new URL(raw.repository);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      return;
  } catch {
    return;
  }
  return raw as unknown as Assignment;
}
/** Machine credential and ephemeral work capabilities never enter a child process or model request. */
export class Executor {
  #id?: string;
  #state: "stopped" | "registered" | "revoked" | "closed" = "stopped";
  #credential?: ExecutorCredential;
  #root?: string;
  #invalid = false;
  readonly #running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  readonly #seen = new Set<string>();
  readonly #controller = new AbortController();
  constructor(readonly options: Options) {
    if (
      !identifier(options.environment) ||
      !identifier(options.organizationId) ||
      !Number.isSafeInteger(options.capacity) ||
      options.capacity < 1 ||
      options.capacity > 16 ||
      options.labels.length > 32 ||
      !options.labels.every(identifier)
    )
      throw Error("Configuration d’exécuteur invalide.");
  }
  get state() {
    return this.#state;
  }
  get running() {
    return this.#running.size;
  }
  get credentialInvalid() {
    return this.#invalid;
  }
  async #key(): Promise<ExecutorCredential> {
    const key = await this.options.credential();
    if (
      !key ||
      key.kind !== "executor" ||
      !/^executor_[A-Za-z0-9_-]{32,256}$/.test(key.token) ||
      key.organizationId !== this.options.organizationId ||
      key.environment !== this.options.environment ||
      !Number.isFinite(key.expiresAt) ||
      key.expiresAt <= Date.now() ||
      key.expiresAt > Date.now() + 31 * 86400000
    )
      throw new ExecutorCredentialInvalid();
    if (this.#credential && this.#credential.token !== key.token)
      throw new ExecutorCredentialInvalid();
    return key;
  }
  async register(parent: AbortSignal): Promise<void> {
    if (this.#state !== "stopped")
      throw Error("Exécuteur déjà inscrit ou terminé.");
    const key = await this.#key(),
      signal = AbortSignal.any([parent, this.#controller.signal]);
    const raw = await this.options.request(
      "register",
      {
        kind: this.options.kind,
        organizationId: this.options.organizationId,
        environment: this.options.environment,
        labels: this.options.labels,
        capacity: this.options.capacity,
      },
      signal,
      key.token,
    );
    signal.throwIfAborted();
    if (
      !object(raw) ||
      !identifier(raw.id) ||
      raw.credentialType !== "executor" ||
      raw.organizationId !== key.organizationId ||
      raw.environment !== key.environment ||
      raw.account !== undefined
    )
      throw new ExecutorCredentialInvalid();
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.options.root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Racine d’exécuteur non autorisée.");
    this.#root = realpathSync(this.options.root);
    this.#credential = key;
    this.#id = raw.id;
    this.#state = "registered";
    this.options.report("Exécuteur inscrit : " + raw.id);
  }
  async poll(parent: AbortSignal): Promise<void> {
    if (this.#state !== "registered") return;
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    try {
      const key = await this.#key(),
        raw = await this.options.request(
          "poll",
          {
            id: this.#id,
            capacity: this.options.capacity - this.#running.size,
            labels: this.options.labels,
          },
          signal,
          key.token,
        );
      signal.throwIfAborted();
      if (this.#state !== "registered") return;
      if (!object(raw) || !Array.isArray(raw.jobs) || raw.jobs.length > 32)
        throw Error("Affectations invalides.");
      for (const input of raw.jobs) {
        const work = assignment(input, Date.now());
        if (!work) {
          this.options.report("Affectation invalide refusée.");
          continue;
        }
        if (this.#seen.has(work.id)) continue;
        if (
          work.environment !== this.options.environment ||
          work.labels.some((label) => !this.options.labels.includes(label)) ||
          this.#running.size >= this.options.capacity
        ) {
          await this.options.request(
            `work/${work.id}/reject`,
            { reason: "incompatible_or_capacity" },
            signal,
            key.token,
          );
          continue;
        }
        if (this.#seen.size >= 10000)
          throw Error(
            "Limite d’affectations atteinte ; redémarrez l’exécuteur.",
          );
        this.#seen.add(work.id);
        const controller = new AbortController(),
          done = Promise.resolve()
            .then(() =>
              this.#execute(
                work,
                AbortSignal.any([
                  signal,
                  controller.signal,
                  this.#controller.signal,
                ]),
              ),
            )
            .finally(() => this.#running.delete(work.id));
        this.#running.set(work.id, { controller, done });
      }
    } catch (error) {
      if (error instanceof ExecutorCredentialInvalid) {
        this.#revoke();
        return;
      }
      if (!signal.aborted)
        this.options.report(
          "Interrogation de l’exécuteur indisponible ; aucun nouveau travail attribué.",
        );
    }
  }
  #revoke() {
    this.#invalid = true;
    this.#state = "revoked";
    this.options.report(new ExecutorCredentialInvalid().message);
    this.#controller.abort();
    for (const work of this.#running.values()) work.controller.abort();
  }
  async #execute(work: Assignment, parent: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([
        parent,
        AbortSignal.timeout(Math.max(1, work.expiresAt - Date.now())),
      ]),
      root = this.#root!;
    let directory: string | undefined;
    let initial: { ino: number; dev: number } | undefined;
    let log = "",
      truncated = false;
    const redact = (value: string) =>
      (this.options.redact?.(value) ?? value)
        .split(work.workSecret)
        .join("[redacted work credential]")
        .split(this.#credential!.token)
        .join("[redacted executor credential]");
    try {
      await this.#key();
      signal.throwIfAborted();
      if (
        realpathSync(this.options.root) !== root ||
        lstatSync(this.options.root).isSymbolicLink()
      )
        throw Error("Racine d’exécuteur remplacée.");
      directory = mkdtempSync(join(root, "work-"));
      const stat = lstatSync(directory);
      initial = { ino: stat.ino, dev: stat.dev };
      await this.options.prepare(directory, work, signal);
      signal.throwIfAborted();
      const result = await this.options.run(
        directory,
        { id: work.id, prompt: work.prompt },
        signal,
        (text) => {
          if (log.length < 64000)
            log += redact(text).slice(0, 64000 - log.length);
          else truncated = true;
        },
      );
      signal.throwIfAborted();
      await this.#key();
      await this.options.request(
        `work/${work.id}/result`,
        {
          code: result.code,
          result: redact(result.result).slice(0, 64000),
          log,
          ...(truncated ? { truncated: true } : {}),
        },
        signal,
        work.workSecret,
      );
    } catch (error) {
      if (error instanceof ExecutorCredentialInvalid) this.#revoke();
      else if (!this.#controller.signal.aborted)
        try {
          await this.options.request(
            `work/${work.id}/result`,
            {
              code: parent.aborted ? 130 : 1,
              result: "Execution failed or its work lease expired.",
              log,
            },
            AbortSignal.timeout(2000),
            work.workSecret,
          );
        } catch (failure) {
          if (failure instanceof ExecutorCredentialInvalid) this.#revoke();
        }
    } finally {
      if (directory && initial)
        try {
          const rel = relative(root, resolve(directory)),
            stat = lstatSync(directory);
          if (
            !rel ||
            isAbsolute(rel) ||
            rel === ".." ||
            rel.startsWith(".." + sep) ||
            stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            stat.ino !== initial.ino ||
            stat.dev !== initial.dev ||
            realpathSync(directory) !== resolve(directory) ||
            realpathSync(this.options.root) !== root
          )
            throw Error("Dossier remplacé.");
          rmSync(directory, { recursive: true });
        } catch {
          this.options.report(
            "Nettoyage refusé : espace de travail remplacé ou inaccessible.",
          );
        }
    }
  }
  async idle(): Promise<void> {
    await Promise.all([...this.#running.values()].map((work) => work.done));
  }
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    const revoked = this.#state === "revoked";
    this.#state = "closed";
    this.#controller.abort();
    for (const work of this.#running.values()) work.controller.abort();
    await this.idle();
    if (!revoked && this.#id && this.#credential)
      try {
        await this.options.request(
          "unregister",
          { id: this.#id },
          AbortSignal.timeout(2000),
          this.#credential.token,
        );
      } catch {}
  }
}
