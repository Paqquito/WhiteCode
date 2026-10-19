// Implements: SPEC-IHM-037, SPEC-CMD-099 (optional surveys and per-send sharing consent), gap E-188.
import { buildFlag, buildProfile } from "../extension-points/build-flags" with { type: "macro" };
interface Options {
  readonly enabled: () => boolean;
  readonly available: () => boolean;
  readonly busy: () => boolean;
  readonly probability: () => number;
  readonly shareProbability: () => number;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly confirm: (question: string, signal: AbortSignal) => Promise<boolean>;
  readonly comment: (title: string) => Promise<string | undefined>;
  readonly send: (body: unknown, signal: AbortSignal) => Promise<void>;
  readonly history: () => unknown;
  readonly redact: (text: string) => string;
  readonly notice: (text: string) => void;
  readonly refresh: () => void;
  readonly saveLast: (time: number) => void;
  readonly last: number;
}
export class Surveys {
  #pending = false;
  #targetedPrefix?: string;
  #activePrefix?: string;
  #last: number;
  #busy?: Promise<void>;
  readonly #controller = new AbortController();
  constructor(readonly options: Options) {
    this.#last = options.last;
  }
  get prompt() {
    return this.#pending && this.#enabled()
      ? `${this.#activePrefix ?? "Cet échange"} : Alt+1 bien · Alt+2 correct · Alt+3 mal · toute saisie ferme cette enquête`
      : undefined;
  }
  noteTargetedSurvey(prefix?: string): void {
    if (!prefix || !this.#enabled() || (this.#last && this.#now() - this.#last < 7 * 86400000)) { this.#targetedPrefix = undefined; return; }
    if (!this.#pending && !this.#busy) this.#targetedPrefix = prefix;
  }
  #enabled() {
    return (
      !this.#controller.signal.aborted &&
      this.options.enabled() &&
      this.options.available()
    );
  }
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  offer(): void {
    if (!this.#enabled()) { const pending = this.#pending; this.#pending = false; this.#targetedPrefix = undefined; this.#activePrefix = undefined; if (pending) this.options.refresh(); return; }
    if (
      this.#pending ||
      this.#busy ||
      this.options.busy() ||
      (this.#last && this.#now() - this.#last < 7 * 86400000)
    )
      return;
    const probability = this.options.probability();
    const prefix = this.#targetedPrefix;
    this.#targetedPrefix = undefined;
    if (
      !Number.isFinite(probability) ||
      probability <= 0 ||
      (this.options.random?.() ?? Math.random()) >= Math.min(1, probability)
    )
      return;
    this.#pending = true;
    this.#activePrefix = prefix;
    this.options.refresh();
  }
  key(key: {
    name: string;
    alt?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    text?: string;
  }): boolean {
    if (!this.#pending) return false;
    if (!this.#enabled()) {
      this.#pending = false;
      this.options.refresh();
      return false;
    }
    this.#pending = false;
    this.options.refresh();
    if (!key.alt || key.ctrl || !["1", "2", "3"].includes(key.name))
      return false;
    this.#last = this.#now();
    this.options.saveLast(this.#last);
    this.options.notice("Merci pour ce retour.");
    const rating = ({ 1: "good", 2: "fair", 3: "bad" } as const)[
      key.name as "1" | "2" | "3"
    ];
    this.#busy = this.#share(rating).finally(() => {
      this.#busy = undefined;
    });
    return true;
  }
  #history(): unknown {
    const text = this.options.redact(JSON.stringify(this.options.history()));
    if (Buffer.byteLength(text) > 64000)
      throw Error("Échange trop volumineux ; aucun partage automatique.");
    return JSON.parse(text);
  }
  async #share(rating: string): Promise<void> {
    const signal = this.#controller.signal;
    try {
      const probability = this.options.shareProbability();
      if (
        !this.#enabled() ||
        !Number.isFinite(probability) ||
        probability <= 0 ||
        (this.options.random?.() ?? Math.random()) >= Math.min(1, probability)
      )
        return;
      const history = this.#history();
      if (
        !(await this.options.confirm(
          "Partager cet échange pour améliorer le produit ?\n" +
            JSON.stringify(history),
          signal,
        ))
      )
        return;
      if (!this.#enabled() || signal.aborted) return;
      await this.options.send(
        { kind: "survey", rating, messages: history },
        signal,
      );
      this.options.notice("Échange partagé après votre accord.");
    } catch {
      if (!signal.aborted)
        this.options.notice(
          "Envoi impossible ; aucune nouvelle tentative automatique.",
        );
    }
  }
  async praise(input: string, parent: AbortSignal): Promise<string> {
    if (!buildFlag("feedback_positive_report") || buildProfile() !== "internal") throw Error("Retour positif indisponible dans ce profil.");
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    if (!this.options.available())
      throw Error("Service de retours non configuré.");
    const comment = this.options.redact(
      (
        input.trim() ||
        (await this.options.comment("Décrire cet échange réussi")) ||
        ""
      ).slice(0, 16000),
    );
    if (!comment.trim()) return "Retour annulé.";
    let messages: unknown;
    const attach = await this.options.confirm(
      "Joindre l’échange récent à ce retour positif ?",
      signal,
    );
    if (attach) messages = this.#history();
    const body = { kind: "positive", comment, ...(attach ? { messages } : {}) };
    if (
      !(await this.options.confirm(
        "Envoyer ce retour positif ?\n" + JSON.stringify(body),
        signal,
      ))
    )
      return "Retour annulé ; aucun envoi.";
    signal.throwIfAborted();
    await this.options.send(body, signal);
    return "Retour positif envoyé.";
  }
  async idle() {
    await this.#busy;
  }
  close() {
    this.#pending = false;
    this.#targetedPrefix = undefined;
    this.#activePrefix = undefined;
    this.#controller.abort();
    this.options.refresh();
  }
}
