// Implements: SPEC-MOD-013/016/017, SPEC-CMD-055/103 (outgoing relay, read-only mirror and single resolution); gap E-185.
import { buildFlag, buildProfile } from "../extension-points/build-flags" with { type: "macro" };
import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  HumanApprovalChannel,
  HumanAnswer,
} from "../permissions/resolver";
interface Owner {
  account: string;
  organizationId: string;
}
interface Account {
  profile(): Promise<
    { account: string; organization: { id: string } } | undefined
  >;
  request(
    service: "sessions",
    path: string,
    body: unknown,
    signal: AbortSignal,
    owner?: Owner,
  ): Promise<unknown>;
}
interface Options {
  readonly mobileEnabled?: () => boolean;
  readonly account: Account;
  readonly webUrl: string;
  readonly mirror: boolean;
  readonly history: () => unknown;
  readonly inject: (text: string) => boolean;
  readonly report: (text: string) => void;
  readonly trace: (event: string) => void;
  readonly redact: (text: string) => string;
  readonly refusal: () => string | undefined;
  readonly intervalMs?: number;
  readonly approvalTimeoutMs?: number;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function autoAttach(o: {
  interactive: boolean;
  build: boolean;
  dynamic: boolean;
  eligible: boolean;
  explicit?: boolean;
}): boolean {
  return o.interactive && o.eligible && (o.explicit ?? (o.build && o.dynamic));
}
/** The service never grants tools or modes. Every injected message enters the ordinary local request queue. */
export class SessionRelay {
  readonly #pushes = new Set<Promise<void>>();
  #lastPush = 0;
  /** Fixed event kinds only: prompts, code and tool output cannot become push text. */
  notifyMobile(kind: "task_completed" | "approval_required"): Promise<void> {
    if (!this.#id || this.#state !== "connected" || !this.options.mobileEnabled?.() || this.#pushes.size >= 4 || Date.now() - this.#lastPush < 1000) return Promise.resolve();
    this.#lastPush = Date.now();
    const id = this.#id, signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(2000)]);
    const task = (async () => {
      try {
        const owner = await this.#current(signal);
        if (!this.options.mobileEnabled?.() || this.#state !== "connected") return;
        await this.options.account.request("sessions", `local/${id}/notifications`, { idempotencyKey: randomUUID(), kind, audience: "mobile" }, signal, owner);
      } catch { this.options.trace("mobile_notification_unavailable"); }
    })().finally(() => this.#pushes.delete(task));
    this.#pushes.add(task); return task;
  }
  #id?: string;
  #url?: string;
  #owner?: Owner;
  #state: "disconnected" | "connected" | "reconnecting" | "closed" =
    "disconnected";
  #seq = 0;
  #after = 0;
  #bytes = 0;
  #failures = 0;
  readonly #events: Array<{ seq: number; event: Record<string, unknown> }> = [];
  readonly #results: Array<{ seq: number; result: string }> = [];
  readonly #pending = new Map<string, (answer: HumanAnswer) => void>();
  readonly #controller = new AbortController();
  #timer?: ReturnType<typeof setTimeout>;
  #busy?: Promise<void>;
  #lastPoll = Date.now();
  constructor(readonly options: Options) {}
  get state() {
    return this.#state;
  }
  get url() {
    return this.#url;
  }
  get buffered() {
    return this.#events.length;
  }
  get pendingApprovals() {
    return this.#pending.size;
  }
  async #current(signal: AbortSignal): Promise<Owner> {
    signal.throwIfAborted();
    const refusal = this.options.refusal();
    if (refusal) throw Error(refusal);
    const profile = await this.options.account.profile();
    if (!profile) throw Error("Connexion à un compte de la société requise.");
    const owner = {
      account: profile.account,
      organizationId: profile.organization.id,
    };
    if (
      this.#owner &&
      (owner.account !== this.#owner.account ||
        owner.organizationId !== this.#owner.organizationId)
    )
      throw Error(
        "Compte ou organisation modifiés ; rattachement distant arrêté.",
      );
    return owner;
  }
  async attach(name: string, parent: AbortSignal): Promise<string> {
    if (this.#state === "closed") throw Error("Connexion distante terminée.");
    if (this.#url) return this.#url;
    if (name.length > 240 || /[\u0000-\u001f\u007f]/.test(name))
      throw Error("Nom de session invalide.");
    const signal = AbortSignal.any([parent, this.#controller.signal]),
      owner = await this.#current(signal),
      history = this.options.redact(JSON.stringify(this.options.history()));
    if (Buffer.byteLength(history) > 1000000)
      throw Error("Historique trop volumineux pour le rattachement distant.");
    const raw = await this.options.account.request(
      "sessions",
      "local/register",
      {
        idempotencyKey: randomUUID(),
        name: this.options.redact(name),
        readOnly: this.options.mirror,
        history: JSON.parse(history),
      },
      signal,
      owner,
    );
    signal.throwIfAborted();
    if (
      !object(raw) ||
      typeof raw.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) ||
      typeof raw.url !== "string" ||
      raw.trustedDevice !== true
    )
      throw Error(
        "Rattachement refusé : appareil non enregistré ou réponse invalide ; reconnectez le compte.",
      );
    const url = new URL(raw.url),
      base = new URL(this.options.webUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 4096
    )
      throw Error("Lien de contrôle hors service autorisé.");
    const current = await this.#current(signal);
    if (
      current.account !== owner.account ||
      current.organizationId !== owner.organizationId
    )
      throw Error("Identité remplacée pendant le rattachement.");
    this.#owner = owner;
    this.#id = raw.id;
    this.#url = url.href;
    this.#state = "connected";
    this.options.report(
      `${this.options.mirror ? "Miroir distant en lecture seule" : "Contrôle distant connecté"} : ${url.href}`,
    );
    this.options.trace("relay_connected");
    this.#schedule();
    return url.href;
  }
  #schedule() {
    clearTimeout(this.#timer);
    if (this.#state === "closed" || !this.#id) return;
    this.#timer = setTimeout(
      () => {
        void this.poll(this.#controller.signal).finally(() => this.#schedule());
      },
      Math.min(
        30000,
        (this.options.intervalMs ?? 1000) *
          Math.max(1, 2 ** Math.min(this.#failures, 5)),
      ),
    );
    this.#timer.unref();
  }
  event(value: Record<string, unknown>): void {
    if (this.#state === "closed" || !this.#id) return;
    const text = this.options.redact(JSON.stringify(value)),
      bytes = Buffer.byteLength(text);
    if (
      bytes > 262144 ||
      this.#events.length >= 2048 ||
      this.#bytes + bytes > 2000000
    ) {
      this.options.report(
        "Relais distant arrêté : retard de réplication trop important. Relancez le rattachement.",
      );
      void this.close();
      return;
    }
    this.#events.push({
      seq: ++this.#seq,
      event: JSON.parse(text) as Record<string, unknown>,
    });
    this.#bytes += bytes;
  }
  poll(parent: AbortSignal): Promise<void> {
    if (this.#busy) return this.#busy;
    this.#busy = this.#poll(parent).finally(() => {
      this.#busy = undefined;
    });
    return this.#busy;
  }
  async #poll(parent: AbortSignal): Promise<void> {
    if (!this.#id || this.#state === "closed") return;
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    try {
      await this.#current(signal);
      if (Date.now() - this.#lastPoll > 120000) {
        this.#failures = 0;
        this.#state = "reconnecting";
        this.options.trace("relay_wake_detected");
      }
      this.#lastPoll = Date.now();
      const batch = this.#events.slice(0, 32),
        results = this.#results.slice(0, 128),
        raw = await this.options.account.request(
          "sessions",
          `local/${this.#id}/poll`,
          { after: this.#after, events: batch, results },
          signal,
          this.#owner,
        );
      signal.throwIfAborted();
      await this.#current(signal);
      if (
        !object(raw) ||
        !Number.isSafeInteger(raw.ack) ||
        Number(raw.ack) < 0 ||
        Number(raw.ack) > (batch.at(-1)?.seq ?? this.#seq) ||
        !Array.isArray(raw.commands) ||
        raw.commands.length > 128
      )
        throw Error("Réponse de relais invalide.");
      this.#results.splice(0, results.length);
      while (this.#events[0] && this.#events[0].seq <= Number(raw.ack)) {
        const removed = this.#events.shift()!;
        this.#bytes -= Buffer.byteLength(JSON.stringify(removed.event));
      }
      for (const row of raw.commands) {
        if (
          !object(row) ||
          !Number.isSafeInteger(row.seq) ||
          Number(row.seq) < 1
        )
          throw Error("Commande distante invalide.");
        const seq = Number(row.seq);
        if (seq <= this.#after) continue;
        if (seq !== this.#after + 1)
          throw Error("Trou dans les commandes distantes.");
        let result = "unsupported";
        if (this.options.mirror) result = "read_only";
        else if (
          row.type === "message" &&
          typeof row.text === "string" &&
          row.text.trim() &&
          row.text.length <= 32000 &&
          !/[\u0000\u001b]/.test(row.text)
        )
          result = this.options.inject(row.text) ? "queued" : "busy";
        else if (
          row.type === "approval" &&
          typeof row.requestId === "string" &&
          (row.answer === "allow" || row.answer === "deny")
        ) {
          const pending = this.#pending.get(row.requestId);
          if (pending) {
            pending({ answer: row.answer === "allow" ? "yes" : "no" });
            result = "resolved";
          } else result = "stale_approval";
        }
        this.#after = seq;
        this.#results.push({ seq, result });
      }
      if (this.#state === "reconnecting") {
        this.options.report("Contrôle distant reconnecté.");
        this.options.trace("relay_reconnected");
      }
      this.#state = "connected";
      this.#failures = 0;
    } catch {
      if (signal.aborted) return;
      this.#state = "reconnecting";
      this.#failures++;
      this.options.trace("relay_disconnected");
      if (this.#failures === 1)
        this.options.report(
          "Contrôle distant interrompu ; reconnexion en cours.",
        );
      if (this.#failures > 8) {
        this.options.report(
          "Contrôle distant indisponible ; session locale conservée.",
        );
        void this.close();
      }
    }
  }
  approvals(local: HumanApprovalChannel): HumanApprovalChannel {
    return {
      ...local,
      request: async (
        request: ApprovalRequest,
        parent: AbortSignal,
      ): Promise<HumanAnswer> => {
        if (this.options.mirror || !this.#id || this.#state === "closed")
          return local.request(request, parent);
        const controller = new AbortController(),
          signal = AbortSignal.any([
            parent,
            this.#controller.signal,
            controller.signal,
          ]),
          requestId = randomUUID();
        let timer: ReturnType<typeof setTimeout> | undefined;
        return new Promise<HumanAnswer>((resolve) => {
          const finish = (answer: HumanAnswer) => {
            if (!this.#pending.delete(requestId)) return;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            controller.abort();
            this.event({ type: "approval_closed", requestId });
            resolve(parent.aborted ? { answer: "no" } : answer);
          };
          const abort = () => finish({ answer: "no" });
          this.#pending.set(requestId, finish);
          signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () => finish({ answer: "no" }),
            this.options.approvalTimeoutMs ?? 300000,
          );
          this.event({
            type: "approval_request",
            requestId,
            callId: request.callId,
            toolName: request.toolName,
            summary: request.summary,
            reason: request.reason,
            input: request.input,
            preview: request.preview,
          });
          if (signal.aborted) {
            abort();
            return;
          }
          void local
            .request(request, signal)
            .then(finish, () => finish({ answer: "no" }));
        });
      },
    };
  }
  kick(state: string): void {
    if (!buildFlag("remote_failure_injection") || buildProfile() !== "internal") throw Error("Injection de défaillance indisponible dans ce profil.");
    if (!["disconnect", "expired-token", "service-error"].includes(state))
      throw Error("État attendu : disconnect, expired-token ou service-error.");
    if (!this.#id || this.#state === "closed")
      throw Error("Aucune connexion active.");
    this.#state = "reconnecting";
    this.options.trace("relay_fault_" + state);
    this.options.report(
      "Défaillance locale injectée : " +
        state +
        " ; reconnexion au prochain échange.",
    );
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.#pushes]);
    if (this.#state === "closed") return;
    this.#state = "closed";
    clearTimeout(this.#timer);
    for (const resolve of [...this.#pending.values()])
      resolve({ answer: "no" });
    this.#controller.abort();
    if (this.#id && this.#owner)
      try {
        await this.options.account.request(
          "sessions",
          `local/${this.#id}/close`,
          {},
          AbortSignal.timeout(2000),
          this.#owner,
        );
      } catch {}
    this.options.trace("relay_closed");
  }
}
