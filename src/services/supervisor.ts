// Implements: SPEC-MOD-021 (single local supervisor), SPEC-MOD-022 (private registry and attachment leases).
// Supports: SPEC-PER-001 (bounded detached approvals), SPEC-SES-001 (private storage facade).
// Supports: gap E-244 (an endpoint removed during a bounded service read is unavailable).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform, realPathOrSelf } from "../platform/system";
import { tryFileLock } from "../platform/file-lock";
import { residentServer } from "../platform/resident-process";
import {
  storeExists,
  storeMkdir,
  bindPrivateStorage,
} from "../session/private-storage";
import { ResidentWorker, type WorkerRecord } from "./worker";
import { parseJobRestrictions, type JobRestrictions } from "./jobs";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export interface ResidentEndpoint {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}
export function readResidentEndpoint(
  root: string,
  read: typeof readPrivateText = readPrivateText,
): ResidentEndpoint | undefined {
  const path = join(root, "resident-endpoint.json");
  if (!existsSync(path)) return;
  let raw: unknown;
  try { raw = JSON.parse(read(path, 4096)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (
    !object(raw) ||
    !Number.isSafeInteger(raw["port"]) ||
    Number(raw["port"]) < 1 ||
    Number(raw["port"]) > 65535 ||
    typeof raw["token"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw["token"]) ||
    !Number.isSafeInteger(raw["pid"]) ||
    Number(raw["pid"]) < 1
  )
    throw Error("Registre du service local invalide.");
  return {
    port: Number(raw["port"]),
    token: raw["token"],
    pid: Number(raw["pid"]),
  };
}
function directory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !isAbsolute(value)
  )
    throw Error("Dossier de travail absolu attendu.");
  const root = resolve(value),
    stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realPathOrSelf(root) !== root
  )
    throw Error("Dossier de travail lié ou indisponible.");
  return root;
}
function workerRecord(raw: unknown): WorkerRecord {
  if (
    !object(raw) ||
    typeof raw["id"] !== "string" ||
    !UUID.test(raw["id"]) ||
    !["assistant", "background", "job"].includes(String(raw["kind"])) ||
    !["ask", "no_prompt"].includes(String(raw["mode"])) ||
    ![
      "starting",
      "running",
      "waiting",
      "idle",
      "completed",
      "stopped",
      "error",
    ].includes(String(raw["status"])) ||
    !Number.isSafeInteger(raw["createdAt"]) ||
    Number(raw["createdAt"]) < 0 ||
    !Number.isSafeInteger(raw["restarts"]) ||
    Number(raw["restarts"]) < 0 ||
    Number(raw["restarts"]) > 100 ||
    typeof raw["summary"] !== "string" ||
    raw["summary"].length > 1600 ||
    !Array.isArray(raw["pending"]) ||
    raw["pending"].length > 100
  )
    throw Error("Entrée du registre résident invalide.");
  const pending = raw["pending"].map((message) => {
    if (
      !object(message) ||
      typeof message["id"] !== "string" ||
      !UUID.test(message["id"]) ||
      typeof message["text"] !== "string" ||
      !message["text"].trim() ||
      message["text"].length > 65536
    )
      throw Error("Message résident invalide.");
    return { id: message["id"], text: message["text"] };
  });
  if (new Set(pending.map((item) => item.id)).size !== pending.length)
    throw Error("Messages résidents dupliqués.");
  return {
    id: raw["id"],
    kind: raw["kind"] as WorkerRecord["kind"],
    cwd: directory(raw["cwd"]),
    createdAt: Number(raw["createdAt"]),
    mode: raw["mode"] as WorkerRecord["mode"],
    status: raw["status"] as WorkerRecord["status"],
    summary: raw["summary"],
    restarts: Number(raw["restarts"]),
    pending,
    ...(raw["jobRestrictions"] !== undefined
      ? { jobRestrictions: parseJobRestrictions(raw["jobRestrictions"]) }
      : {}),
    ...(typeof raw["template"] === "string" &&
    /^[a-z0-9-]{1,64}$/.test(raw["template"])
      ? { template: raw["template"] }
      : {}),
  };
}
export class ResidentSupervisor {
  #server?: ReturnType<typeof residentServer>;
  #release?: () => void;
  #closed = false;
  #closeTask?: Promise<void>;
  #workers = new Map<string, ResidentWorker>();
  #clients = new Map<string, { worker: string; expires: number }>();
  #log: string[] = [];
  #notifications: number[] = [];
  readonly #token = randomBytes(32).toString("hex");
  readonly #registry: string;
  readonly #endpoint: string;
  readonly #done: Promise<void>;
  #finish!: () => void;
  constructor(
    readonly options: {
      root: string;
      maxConcurrent: number;
      waitMs: number;
      assertPolicy: () => void;
      program: (record: WorkerRecord) => { file: string; args: string[] };
      environment: (record: WorkerRecord) => Record<string, string>;
      wasAccepted: (record: WorkerRecord, id: string) => boolean;
      history: (record: WorkerRecord) => unknown[];
      notify: (
        record: WorkerRecord,
        kind: "completed" | "waiting",
      ) => Promise<void>;
      createJob?: (
        name: string,
        request: string,
      ) => { cwd: string; prompt: string; restrictions: JobRestrictions };
      jobState?: (
        record: WorkerRecord,
      ) => { state: string; summary: string } | undefined;
    },
  ) {
    this.#registry = join(options.root, "background-sessions", "registry.json");
    this.#endpoint = join(options.root, "resident-endpoint.json");
    this.#done = new Promise((r) => (this.#finish = r));
  }
  get done() {
    return this.#done;
  }
  get port() {
    return this.#server?.port;
  }
  async start(): Promise<void> {
    this.options.assertPolicy();
    ordinaryPrivateFile(this.#endpoint, 4096);
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
    const release = tryFileLock(join(this.options.root, "resident.lock"));
    if (!release) throw Error("Un superviseur est déjà actif pour ce profil.");
    this.#release = release;
    try {
      if (storeExists(this.#registry)) {
        const raw: unknown = JSON.parse(
          readPrivateText(this.#registry, 8388608),
        );
        if (
          !object(raw) ||
          raw["schemaVersion"] !== 1 ||
          !Array.isArray(raw["workers"]) ||
          raw["workers"].length > 100
        )
          throw Error("Registre résident illisible ; original conservé.");
        const records = raw["workers"].map(workerRecord);
        if (new Set(records.map((record) => record.id)).size !== records.length)
          throw Error("Travailleurs résidents dupliqués.");
        for (const record of records) this.#add(record);
      }
      this.#server = residentServer(
        bindPrivateStorage((request) => this.#handle(request)),
      );
      writeAtomic(
        this.#endpoint,
        Buffer.from(
          JSON.stringify({
            port: this.#server.port,
            token: this.#token,
            pid: process.pid,
          }),
        ),
        currentPlatform(),
        true,
      );
      for (const worker of this.#workers.values())
        if (!["completed", "stopped", "error"].includes(worker.record.status))
          worker.launch();
      this.#note("Superviseur local actif.");
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  #save = () => {
    storeMkdir(join(this.options.root, "background-sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        workers: [...this.#workers.values()].map((worker) => worker.record),
      }),
    );
    if (bytes.length > 8388608)
      throw Error("Registre résident trop volumineux.");
    writeAtomic(this.#registry, bytes, currentPlatform(), true);
  };
  #note(message: string) {
    this.#log.push(new Date().toISOString() + " " + message);
    if (this.#log.length > 512) this.#log.shift();
  }
  #attached(id: string) {
    const now = Date.now();
    for (const [key, client] of this.#clients)
      if (client.expires <= now) this.#clients.delete(key);
    return [...this.#clients.values()].filter((client) => client.worker === id)
      .length;
  }
  #notify(record: WorkerRecord, kind: "waiting" | "completed") {
    const now = Date.now();
    this.#notifications = this.#notifications.filter(
      (time) => time > now - 3600000,
    );
    if (this.#attached(record.id) || this.#notifications.length >= 10) return;
    this.#notifications.push(now);
    void this.options
      .notify(record, kind)
      .catch(() => this.#note("Notification indisponible."));
  }
  #add(record: WorkerRecord) {
    const worker = new ResidentWorker(record, {
      command: this.options.program,
      environment: this.options.environment,
      persist: bindPrivateStorage(this.#save),
      assertPolicy: this.options.assertPolicy,
      waitMs: this.options.waitMs,
      wasAccepted: bindPrivateStorage(this.options.wasAccepted),
      error: () => this.#note("Erreur d’un travailleur local."),
      waiting: bindPrivateStorage((row) => this.#notify(row, "waiting")),
      completed: bindPrivateStorage((row) => {
        this.#note("Tour terminé : " + row.id);
        this.#notify(row, "completed");
      }),
    });
    this.#workers.set(record.id, worker);
    return worker;
  }
  #view(worker: ResidentWorker) {
    const { pending: _pending, ...record } = worker.record;
    return {
      ...record,
      pid: worker.pid,
      queued: worker.record.pending.length,
      attached: this.#attached(record.id),
      ...(record.kind === "job"
        ? { jobState: this.options.jobState?.(worker.record) }
        : {}),
    };
  }
  async #handle(request: Request): Promise<Response> {
    const supplied = request.headers.get("authorization") ?? "",
      expected = "Bearer " + this.#token;
    if (
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return Response.json(
        { error: "Invalid local capability." },
        { status: 401 },
      );
    const url = new URL(request.url);
    if (url.search || url.hash)
      return Response.json({ error: "Invalid route." }, { status: 400 });
    if (request.method === "GET" && url.pathname === "/state")
      return Response.json({
        pid: process.pid,
        workers: [...this.#workers.values()].map((worker) =>
          this.#view(worker),
        ),
      });
    if (request.method === "GET" && url.pathname === "/log")
      return Response.json({ lines: this.#log });
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "JSON object required." }, { status: 400 });
    }
    if (!object(body)) throw Error("Objet JSON attendu.");
    if (url.pathname === "/stop") {
      setTimeout(() => {
        void this.close();
      }, 10);
      return Response.json({ stopping: true });
    }
    if (this.#closed)
      return Response.json({ error: "Service is closing." }, { status: 503 });
    this.options.assertPolicy();
    if (url.pathname === "/workers") {
      if (
        body["mode"] !== undefined &&
        !["ask", "no_prompt"].includes(String(body["mode"]))
      )
        throw Error("Mode de session détachée invalide.");
      if (
        body["template"] !== undefined &&
        (typeof body["template"] !== "string" ||
          !/^[a-z0-9-]{1,64}$/.test(body["template"]))
      )
        throw Error("Nom de modèle de travail invalide.");
      if (!["assistant", "background", "job"].includes(String(body["kind"])))
        throw Error("Type de travailleur inconnu.");
      const kind = body["kind"] as WorkerRecord["kind"];
      let cwd = kind === "job" ? "" : directory(body["cwd"]);
      const existing =
        kind === "assistant"
          ? [...this.#workers.values()].find(
              (worker) =>
                worker.record.kind === kind &&
                worker.record.cwd === cwd &&
                !["completed", "stopped", "error"].includes(
                  worker.record.status,
                ),
            )
          : undefined;
      if (existing) return Response.json(this.#view(existing));
      if (
        [...this.#workers.values()].filter(
          (worker) =>
            !["completed", "stopped", "error"].includes(worker.record.status),
        ).length >= this.options.maxConcurrent
      )
        throw Error("Trop de travailleurs locaux actifs.");
      if (this.#workers.size >= 100) {
        const retired = [...this.#workers.values()].find((worker) =>
          ["completed", "stopped"].includes(worker.record.status),
        );
        if (!retired) throw Error("Registre résident plein.");
        this.#workers.delete(retired.record.id);
      }
      let prompt = body["prompt"];
      if (
        prompt !== undefined &&
        (typeof prompt !== "string" || !prompt.trim() || prompt.length > 65536)
      )
        throw Error("Consigne invalide.");
      let job:
        ReturnType<NonNullable<typeof this.options.createJob>> | undefined;
      if (kind === "job") {
        if (typeof body["template"] !== "string" || !this.options.createJob)
          throw Error("Modèle de travail requis.");
        job = this.options.createJob(
          body["template"],
          typeof prompt === "string" ? prompt : "",
        );
        cwd = directory(job.cwd);
        prompt = job.prompt;
      }
      const record: WorkerRecord = {
        id: randomUUID(),
        kind,
        cwd,
        createdAt: Date.now(),
        mode: body["mode"] === "no_prompt" ? "no_prompt" : "ask",
        status: "starting",
        summary:
          kind === "job"
            ? `Travail ${body["template"]}`
            : typeof prompt === "string"
              ? prompt.slice(0, 1600)
              : "Assistant disponible.",
        restarts: 0,
        pending:
          typeof prompt === "string"
            ? [{ id: randomUUID(), text: prompt }]
            : [],
        ...(job ? { jobRestrictions: job.restrictions } : {}),
        ...(typeof body["template"] === "string" &&
        /^[a-z0-9-]{1,64}$/.test(body["template"])
          ? { template: body["template"] }
          : {}),
      };
      const worker = this.#add(record);
      try {
        this.#save();
        worker.launch();
      } catch (error) {
        this.#workers.delete(record.id);
        throw error;
      }
      return Response.json(this.#view(worker));
    }
    const match =
        /^\/workers\/([a-f0-9-]{36})\/(attach|events|history|answer|message|cancel|stop|detach)$/.exec(
          url.pathname,
        ),
      worker = match && this.#workers.get(match[1]!);
    if (!match || !worker) return new Response("Not found", { status: 404 });
    const operation = match[2];
    if (operation === "stop") {
      await worker.close();
      return Response.json(this.#view(worker));
    }
    if (operation === "message") {
      if (typeof body["text"] !== "string") throw Error("Message attendu.");
      return Response.json({ id: worker.enqueue(body["text"]) });
    }
    if (operation === "cancel") {
      worker.cancel();
      return Response.json({ cancelled: true });
    }
    if (operation === "attach") {
      this.#attached(worker.record.id);
      if (this.#clients.size >= 128) throw Error("Trop de clients rattachés.");
      const client = randomUUID();
      this.#clients.set(client, {
        worker: worker.record.id,
        expires: Date.now() + 15000,
      });
      const history = this.options.history(worker.record);
      return Response.json({
        client,
        worker: this.#view(worker),
        history: history.slice(0, 50),
        historyTotal: history.length,
        after: worker.latestSequence,
        approvals: worker.approvals,
      });
    }
    const client =
      typeof body["client"] === "string"
        ? this.#clients.get(body["client"])
        : undefined;
    if (
      !client ||
      client.worker !== worker.record.id ||
      client.expires <= Date.now()
    )
      throw Error("Client détaché ou expiré.");
    client.expires = Date.now() + 15000;
    if (operation === "detach") {
      this.#clients.delete(body["client"] as string);
      return Response.json({ detached: true });
    }
    if (operation === "history") {
      const offset = body["offset"];
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 100000
      )
        throw Error("Page d’historique invalide.");
      const history = this.options.history(worker.record);
      return Response.json({
        history: history.slice(Number(offset), Number(offset) + 50),
        historyTotal: history.length,
      });
    }
    if (operation === "answer") {
      if (
        typeof body["id"] !== "string" ||
        typeof body["approved"] !== "boolean"
      )
        throw Error("Réponse humaine attendue.");
      return Response.json({
        accepted: worker.answer(body["id"], body["approved"]),
      });
    }
    const after = body["after"];
    if (!Number.isSafeInteger(after) || Number(after) < 0)
      throw Error("Curseur invalide.");
    return Response.json({
      worker: this.#view(worker),
      events: worker.events(Number(after)),
      approvals: worker.approvals,
    });
  }
  close(): Promise<void> {
    return (this.#closeTask ??= this.#close());
  }
  async #close() {
    this.#closed = true;
    try {
      await Promise.allSettled(
        [...this.#workers.values()].map((worker) => worker.close(false)),
      );
      await this.#server?.close();
      try {
        const entry = readResidentEndpoint(this.options.root);
        if (entry?.token === this.#token) unlinkSync(this.#endpoint);
      } catch {}
      this.#clients.clear();
    } finally {
      this.#release?.();
      this.#release = undefined;
      this.#finish();
    }
  }
}
