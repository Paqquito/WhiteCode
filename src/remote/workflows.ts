// Implements: SPEC-CMD-017/018/056/057/064/105, SPEC-AGT-019, SPEC-OUT-032/047, SPEC-EXT-027; gap E-184.
import { randomUUID, createHash } from "node:crypto";
import { RemoteSessions } from "./sessions";
interface Account {
  profile(): Promise<
    { account: string; organization: { id: string } } | undefined
  >;
  request(
    service: "sessions" | "triggers" | "share",
    path: string,
    body: unknown,
    signal: AbortSignal,
    owner?: { account: string; organizationId: string },
  ): Promise<unknown>;
}
interface Repository {
  repository: string;
  branch: string;
  commit: string;
}
export interface RemoteTask {
  id: string;
  url: string;
  kind: "plan" | "review" | "background";
  account: string;
  organizationId: string;
  status: string;
  revision?: string;
}
interface Options {
  readonly account: Account;
  readonly sessionUrl: string;
  readonly webUrl: string;
  readonly repository: () => Promise<Repository>;
  readonly confirm: (question: string, signal: AbortSignal) => Promise<boolean>;
  readonly select: (
    title: string,
    choices: readonly { id: string; name: string }[],
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly environment: () => string | undefined;
  readonly setEnvironment: (id: string) => void;
  readonly record: (event: Record<string, unknown>) => void;
  readonly context: (text: string) => void;
  readonly report: (text: string) => void;
  readonly open: (url: string) => boolean;
  readonly qr: (url: string) => Promise<string>;
  readonly history: () => unknown;
  readonly redact: (text: string) => string;
  readonly refusal: () => string | undefined;
  readonly pollMs?: number;
  readonly maxSuggestions?: () => number;
  readonly ceilings?: () => {
    maxCost?: number;
    managedMaxCost?: number;
    maxDurationSeconds?: number;
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= max &&
  !/[\u0000\u001b]/.test(value);
function serviceLink(value: unknown, base: string): string {
  if (typeof value !== "string" || value.length > 4096)
    throw Error("Lien de service invalide.");
  const url = new URL(value),
    allowed = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.origin !== allowed.origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("Lien hors du service configuré.");
  return url.href;
}
function validRepository(value: Repository): Repository {
  if (
    !bounded(value.repository, 4096) ||
    !bounded(value.branch, 240) ||
    value.branch.startsWith("-") ||
    !/^[a-f0-9]{40,64}$/.test(value.commit)
  )
    throw Error("Dépôt distant invalide.");
  return value;
}
function schedule(input: Record<string, unknown>): {
  prompt: string;
  cron: string;
  timeZone: string;
  description: string;
} {
  if (
    !bounded(input.prompt, 16000) ||
    !bounded(input.cron, 128) ||
    !bounded(input.timeZone, 128)
  )
    throw Error("Prompt, cron and timeZone are required.");
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(input.cron);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    throw Error(
      "Supported remote schedules are daily or weekly, using five cron fields.",
    );
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: input.timeZone }).format();
  } catch {
    throw Error("Invalid IANA time zone.");
  }
  const time = match[2]!.padStart(2, "0") + ":" + match[1]!.padStart(2, "0"),
    days = [
      "dimanche",
      "lundi",
      "mardi",
      "mercredi",
      "jeudi",
      "vendredi",
      "samedi",
    ];
  return {
    prompt: input.prompt,
    cron: input.cron,
    timeZone: input.timeZone,
    description: `${match[3] === "*" ? "chaque jour" : "chaque " + days[Number(match[3])]} à ${time} (${input.timeZone})`,
  };
}
/** Local task state is a projection; closing the terminal never cancels service work. */
export class CloudWorkflows {
  readonly #tasks = new Map<string, RemoteTask>();
  readonly #declined = new Set<string>();
  readonly #controller = new AbortController();
  #timer?: ReturnType<typeof setInterval>;
  #busy?: Promise<void>;
  #suggestions = 0;
  constructor(readonly options: Options) {}
  get tasks(): readonly RemoteTask[] {
    return [...this.#tasks.values()].map((task) => ({ ...task }));
  }
  async #owner() {
    const refusal = this.options.refusal();
    if (refusal) throw Error(refusal);
    this.#controller.signal.throwIfAborted();
    const profile = await this.options.account.profile();
    if (!profile)
      throw Error(
        "Connectez un compte de la société pour utiliser le service distant.",
      );
    return {
      account: profile.account,
      organizationId: profile.organization.id,
    };
  }
  async #assertOwner(owner: { account: string; organizationId: string }) {
    const current = await this.#owner();
    if (
      current.account !== owner.account ||
      current.organizationId !== owner.organizationId
    )
      throw Error("Compte ou organisation modifiés ; recommencez.");
  }
  #save(task: RemoteTask) {
    this.options.record({ event: "remote_task", ...task });
  }
  #start() {
    if (!this.#timer && !this.#controller.signal.aborted) {
      this.#timer = setInterval(() => {
        void this.refresh(this.#controller.signal).catch(() => {});
      }, this.options.pollMs ?? 2000);
      this.#timer.unref();
    }
  }
  async command(
    name: string,
    args: string,
    parent: AbortSignal,
  ): Promise<string> {
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    signal.throwIfAborted();
    if (name === "share") {
      if (args.trim()) throw Error("Usage : /share.");
      const serialized = this.options.redact(
        JSON.stringify(this.options.history()),
      );
      if (Buffer.byteLength(serialized) > 192000)
        throw Error("Conversation trop volumineuse pour ce partage.");
      if (
        !(await this.options.confirm(
          `Partager cette conversation avec les personnes possédant le lien ? Contenu relu :\n${serialized}`,
          signal,
        ))
      )
        return "Partage annulé ; aucun envoi.";
      const owner = await this.#owner(),
        raw = await this.options.account.request(
          "share",
          "create",
          { idempotencyKey: randomUUID(), messages: JSON.parse(serialized) },
          signal,
          owner,
        );
      await this.#assertOwner(owner);
      if (!object(raw)) throw Error("Partage invalide.");
      return "Lien de partage : " + serviceLink(raw.url, this.options.webUrl);
    }
    if (name === "session") {
      if (args.trim()) throw Error("Usage : /session.");
      const task = [...this.#tasks.values()].at(-1);
      if (!task) throw Error("Aucune session distante associée.");
      await this.#assertOwner(task);
      return task.url + "\n" + (await this.options.qr(task.url));
    }
    const owner = await this.#owner();
    if (name === "cloud-environment") {
      if (args.trim()) throw Error("Usage : /cloud-environment.");
      const raw = await this.options.account.request(
        "sessions",
        "environments",
        undefined,
        signal,
        owner,
      );
      if (
        !object(raw) ||
        !Array.isArray(raw.environments) ||
        raw.environments.length > 100 ||
        raw.environments.some(
          (row) => !object(row) || !id(row.id) || !bounded(row.name, 240),
        )
      )
        throw Error("Liste des environnements invalide.");
      const choices = raw.environments as Array<{ id: string; name: string }>;
      if (new Set(choices.map((row) => row.id)).size !== choices.length)
        throw Error("Environnements dupliqués.");
      if (!choices.length)
        return (
          "Aucun environnement accessible. Créez-en un dans " +
          this.options.webUrl
        );
      const selected = await this.options.select(
        "Environnement distant par défaut",
        choices,
        signal,
      );
      await this.#assertOwner(owner);
      if (selected === undefined) return "Choix annulé.";
      if (!choices.some((row) => row.id === selected))
        throw Error("Environnement non accessible.");
      this.options.setEnvironment(selected);
      return "Environnement distant sélectionné : " + selected;
    }
    if (name === "configure-remote") {
      if (args.trim()) throw Error("Usage : /configure-remote.");
      const repo = validRepository(await this.options.repository()),
        url = new URL(
          "integrations/forge/connect",
          this.options.webUrl.replace(/\/?$/, "/"),
        ).href;
      if (
        !(await this.options.confirm(
          `Relier votre forge dans le navigateur : ${url}. Vous réaliserez vous-même la connexion.`,
          signal,
        ))
      )
        return "Configuration annulée.";
      this.options.open(url);
      if (
        !(await this.options.confirm(
          "Le parcours humain dans le navigateur est-il terminé ?",
          signal,
        ))
      )
        return "Configuration interrompue.";
      await this.#assertOwner(owner);
      const raw = await this.options.account.request(
        "sessions",
        "repository-access",
        { repository: repo.repository },
        signal,
        owner,
      );
      if (!object(raw) || raw.accessible !== true)
        throw Error(
          "Le service n’a pas accès à ce dépôt. Configuration : " + url,
        );
      const key = await this.options.account.request(
        "sessions",
        "key-status",
        { repository: repo.repository },
        signal,
        owner,
      );
      return (
        "Dépôt : accès confirmé." +
        (!object(key) || key.delegatedKey !== true
          ? " Aucune clé de fournisseur confiée au service ; ouvrez la console."
          : "")
      );
    }
    if (name !== "deep-plan" && name !== "deep-review")
      throw Error("Commande distante inconnue.");
    if (
      (name === "deep-plan" && !bounded(args, 16000)) ||
      (name === "deep-review" &&
        args.trim() &&
        !/^[1-9]\d{0,8}$/.test(args.trim()))
    )
      throw Error(
        name === "deep-plan"
          ? "Usage : /deep-plan <consigne>."
          : "Usage : /deep-review [numéro].",
      );
    const repo = validRepository(await this.options.repository());
    let estimate = "Estimation indisponible";
    try {
      const raw = await this.options.account.request(
        "sessions",
        "estimate",
        {
          kind: name === "deep-plan" ? "plan" : "review",
          ...repo,
          ...(name === "deep-review" && args.trim()
            ? { mergeRequest: Number(args.trim()) }
            : {}),
        },
        signal,
        owner,
      );
      if (
        object(raw) &&
        raw.available === true &&
        typeof raw.amount === "number" &&
        Number.isFinite(raw.amount) &&
        raw.amount >= 0 &&
        bounded(raw.unit, 32)
      )
        estimate = `Estimation : ${raw.amount} ${raw.unit}`;
    } catch {
      signal.throwIfAborted();
    }
    if (
      !(await this.options.confirm(
        `${estimate}. Lancer ${name === "deep-plan" ? "la planification approfondie (environ 10 à 30 minutes)" : "la revue approfondie"} sur le service distant ? Des appels facturables seront consommés ; les conditions du service s’appliquent.`,
        signal,
      ))
    )
      return "Lancement annulé ; aucune session distante créée.";
    await this.#assertOwner(owner);
    return this.#create(
      name === "deep-plan" ? "plan" : "review",
      name === "deep-plan"
        ? args
        : `Review ${args.trim() ? "merge request " + args.trim() : "the current branch"}. Report only verified findings with locations.`,
      repo,
      owner,
      signal,
      name === "deep-review" && args.trim() ? Number(args.trim()) : undefined,
    );
  }
  async #create(
    kind: RemoteTask["kind"],
    prompt: string,
    repo: Repository,
    owner: { account: string; organizationId: string },
    signal: AbortSignal,
    mergeRequest?: number,
  ): Promise<string> {
    const preflight = await this.options.account.request(
      "sessions",
      "key-status",
      { repository: repo.repository, ...(this.options.environment() ? { environment: this.options.environment() } : {}) },
      signal,
      owner,
    );
    if (!object(preflight) || preflight.repositoryAccessible !== true)
      throw Error("Dépôt inaccessible au service distant.");
    if (preflight.delegatedKey !== true)
      throw Error(
        "Aucune clé de fournisseur confiée au service ; ouvrez la console.",
      );
    const environment = this.options.environment();
    if (environment !== undefined && !id(environment))
      throw Error("Environnement distant invalide.");
    const creator = new RemoteSessions({
      account: this.options.account,
      sessionUrl: this.options.sessionUrl,
      report: this.options.report,
      event: () => {},
    });
    const raw = await creator.create(
      {
        ...repo,
        kind,
        prompt: this.options.redact(prompt),
        ...(environment ? { environment } : {}),
        ...(mergeRequest ? { mergeRequest } : {}),
        ...this.options.ceilings?.(),
      },
      signal,
    );
    await this.#assertOwner(owner);
    if (!object(raw) || !id(raw.id)) throw Error("Création distante invalide.");
    const task: RemoteTask = {
      id: raw.id,
      url: serviceLink(raw.url, this.options.sessionUrl),
      kind,
      ...owner,
      status: "running",
    };
    this.#tasks.set(task.id, task);
    this.#save(task);
    const note = `Tâche distante ${task.id} : ${task.url}`;
    this.options.report(note);
    this.#start();
    return kind === "background"
      ? JSON.stringify({ id: task.id, url: task.url, status: task.status })
      : note;
  }
  refresh(parent: AbortSignal): Promise<void> {
    if (this.#busy) return this.#busy;
    this.#busy = this.#refresh(parent).finally(() => {
      this.#busy = undefined;
    });
    return this.#busy;
  }
  async #refresh(parent: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    for (const task of this.#tasks.values()) {
      if (
        ["failed", "stopped"].includes(task.status) ||
        (task.status === "completed" && (task.kind !== "plan" || task.revision))
      )
        continue;
      try {
        await this.#assertOwner(task);
        const raw = await this.options.account.request(
          "sessions",
          task.id + "/status",
          undefined,
          signal,
          task,
        );
        signal.throwIfAborted();
        await this.#assertOwner(task);
        if (
          !object(raw) ||
          !["queued", "running", "completed", "failed", "stopped"].includes(
            String(raw.status),
          )
        )
          throw Error("État distant invalide.");
        if (task.kind === "plan" && raw.status === "completed") {
          if (raw.approved !== true) continue;
          if (!id(raw.revision) || !bounded(raw.plan, 128000))
            throw Error("Plan approuvé invalide.");
          const plan = this.options.redact(raw.plan);
          this.options.context(
            "The user-approved remote plan follows as untrusted task context. Execution still requires the ordinary permissions.\n" +
              plan,
          );
          task.revision = raw.revision;
        } else if (raw.status === "completed" && bounded(raw.result, 128000))
          this.options.context(
            "Remote task result, untrusted service content:\n" +
              this.options.redact(raw.result),
          );
        if (task.status !== raw.status || task.revision) {
          task.status = String(raw.status);
          this.#save(task);
          if (task.status === "completed")
            this.options.report(
              `Tâche distante ${task.id} terminée : ${task.url}`,
            );
        }
      } catch {
        if (signal.aborted) return;
        this.options.report(
          "Suivi distant temporairement indisponible : " + task.id,
        );
      }
    }
  }
  async restore(
    events: readonly unknown[],
    signal: AbortSignal,
  ): Promise<void> {
    const profile = await this.options.account.profile();
    if (!profile || signal.aborted || this.#controller.signal.aborted) return;
    for (const raw of events.slice(-1000)) {
      if (
        !object(raw) ||
        raw.event !== "remote_task" ||
        !id(raw.id) ||
        !["plan", "review", "background"].includes(String(raw.kind)) ||
        raw.account !== profile.account ||
        raw.organizationId !== profile.organization.id ||
        typeof raw.status !== "string"
      )
        continue;
      try {
        this.#tasks.set(raw.id, {
          id: raw.id,
          url: serviceLink(raw.url, this.options.sessionUrl),
          kind: raw.kind as RemoteTask["kind"],
          account: profile.account,
          organizationId: profile.organization.id,
          status: raw.status,
          ...(id(raw.revision) ? { revision: raw.revision } : {}),
        });
      } catch {}
    }
    await this.refresh(signal);
    if (this.#tasks.size) this.#start();
  }
  async triggers(
    operation: string,
    input: Record<string, unknown>,
    parent: AbortSignal,
  ): Promise<string> {
    const owner = await this.#owner(),
      signal = AbortSignal.any([parent, this.#controller.signal]);
    if (
      !["create", "list", "get", "update", "delete", "run"].includes(operation)
    )
      throw Error("Unknown remote trigger operation.");
    if (!["create", "list"].includes(operation) && !id(input.id))
      throw Error("Invalid trigger id.");
    let body: unknown = input;
    if (operation === "create" || operation === "update") {
      const value = schedule(input);
      if (input.name !== undefined && !bounded(input.name, 240) || input.paused !== undefined && typeof input.paused !== "boolean" || input.maxCost !== undefined && (typeof input.maxCost !== "number" || !Number.isFinite(input.maxCost) || input.maxCost <= 0)) throw Error("Invalid remote trigger name, state or cost ceiling.");
      for (const field of ["tools", "connectors"]) if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > 100 || !input[field].every(id) || new Set(input[field]).size !== input[field].length)) throw Error("Invalid remote trigger tools or connectors.");
      const ceilings = this.options.ceilings?.(), maxCost = typeof input.maxCost === "number" ? input.maxCost : ceilings?.maxCost;
      if (
        !(await this.options.confirm(
          `${operation === "create" ? "Créer" : "Modifier"} ce déclencheur distant ?\n${this.options.redact(value.prompt)}\nCron : ${value.cron}\nHeure locale : ${value.description}${maxCost !== undefined ? `\nPlafond par exécution : ${maxCost}` : ""}${input.tools !== undefined ? `\nOutils : ${(input.tools as string[]).join(", ") || "aucun"}` : ""}${input.connectors !== undefined ? `\nConnecteurs : ${(input.connectors as string[]).join(", ") || "aucun"}` : ""}${input.paused === true ? "\nÉtat : en pause" : ""}\nIl pourra consommer des appels facturables sur le service.`,
          signal,
        ))
      )
        return "Remote trigger creation declined.";
      const repo = validRepository(await this.options.repository()),
        access = await this.options.account.request(
          "sessions",
          "repository-access",
          { repository: repo.repository },
          signal,
          owner,
        );
      if (!object(access) || access.accessible !== true)
        throw Error("Repository is not accessible to the remote service.");
      body = {
        idempotencyKey: randomUUID(),
        ...(operation === "update" ? { id: input.id } : {}),
        ...repo,
        prompt: this.options.redact(value.prompt),
        cron: value.cron,
        timeZone: value.timeZone,
        ...(input.name !== undefined ? { name: this.options.redact(String(input.name)) } : {}),
        ...(input.paused !== undefined ? { paused: input.paused } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.connectors !== undefined ? { connectors: input.connectors } : {}),
        ...(maxCost !== undefined ? { maxCost } : {}),
        ...(ceilings?.managedMaxCost !== undefined ? { clientMaxCost: ceilings.managedMaxCost } : {}),
        ...(ceilings?.maxDurationSeconds !== undefined ? { maxDurationSeconds: ceilings.maxDurationSeconds } : {}),
        ...(this.options.environment()
          ? { environment: this.options.environment() }
          : {}),
      };
    } else if (operation !== "list") {
      if (
        operation !== "get" &&
        !(await this.options.confirm(
          `${operation === "delete" ? "Supprimer" : "Exécuter maintenant"} le déclencheur distant ${input.id} ?`,
          signal,
        ))
      )
        return "Remote trigger action declined.";
      body = { id: input.id };
    } else body = undefined;
    await this.#assertOwner(owner);
    const raw = await this.options.account.request(
      "triggers",
      operation,
      body,
      signal,
      owner,
    );
    const serialized = this.options.redact(JSON.stringify(raw));
    if (serialized.length > 64000)
      throw Error("Remote trigger result too large.");
    return serialized;
  }
  async suggest(
    input: { title: string; reason: string; prompt: string },
    parent: AbortSignal,
  ): Promise<string> {
    if (
      !bounded(input.title, 240) ||
      !bounded(input.reason, 2000) ||
      !bounded(input.prompt, 16000)
    )
      throw Error("Invalid background task proposal.");
    const digest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    if (this.#declined.has(digest))
      return "This proposal was already declined; do not propose it again.";
    if (this.#suggestions++ >= (this.options.maxSuggestions?.() ?? 2))
      return "Too many proposals in this session.";
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    if (
      !(await this.options.confirm(
        `Confier cette tâche annexe à un agent distant ?\n${this.options.redact(input.title)}\n${this.options.redact(input.reason)}\nConsigne : ${this.options.redact(input.prompt)}\nUne demande de fusion séparée et des appels facturables sont prévus.`,
        signal,
      ))
    ) {
      this.#declined.add(digest);
      this.options.record({ event: "remote_suggestion_declined", digest });
      return "Background proposal declined; no remote session was created.";
    }
    const owner = await this.#owner();
    return this.#create(
      "background",
      input.prompt,
      validRepository(await this.options.repository()),
      owner,
      signal,
    );
  }
  async close(): Promise<void> {
    this.#controller.abort();
    clearInterval(this.#timer);
    await this.#busy?.catch(() => {});
  }
}
