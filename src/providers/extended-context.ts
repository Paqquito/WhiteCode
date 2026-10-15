// Implements: SPEC-API-009 (explicit extended aliases, session eligibility, standard fallback).
import {
  isResolveFailure,
  type ModelCatalog,
  type ResolveOptions,
} from "./catalog";
import type { Identity } from "../identity/identity";

export class ExtendedModels {
  readonly #eligibility = new Map<string, Promise<boolean>>();
  constructor(
    private readonly eligible: (
      model: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly notice: (message: string) => void,
    private readonly owner: () => Promise<string | undefined> = async () =>
      "session",
  ) {}
  async resolve(
    value: string,
    provider: string,
    catalog: ModelCatalog,
    identity: Identity,
    options: ResolveOptions,
    signal: AbortSignal,
  ) {
    if (!/^(large|medium|small|default)-extended$/.test(value))
      return catalog.resolve(value, provider, identity, options);
    const standard = catalog.resolve(
      value.replace(/-extended$/, ""),
      provider,
      identity,
      options,
    );
    if (isResolveFailure(standard)) return standard;
    const entry =
      catalog.find(provider, standard.id) ??
      options.extraEntries?.find(
        (e) => e.provider === provider && e.id === standard.id,
      );
    const variant = entry?.extended;
    const extended = variant
      ? catalog.resolve(variant.model, provider, identity, options)
      : undefined;
    let granted = false;
    if (
      variant &&
      extended &&
      !isResolveFailure(extended) &&
      extended.source !== "none" &&
      extended.contextWindow > standard.contextWindow
    ) {
      if (variant.eligibility === "public") granted = true;
      else {
        const owner = await this.owner(),
          key = owner + "\0" + extended.id;
        if (owner !== undefined) {
          let pending = this.#eligibility.get(key);
          if (!pending) {
            pending = this.eligible(extended.id, signal).catch(() => false);
            this.#eligibility.set(key, pending);
          }
          granted = (await pending) && owner === (await this.owner());
        }
      }
      signal.throwIfAborted();
      if (granted) {
        this.notice(
          `Contexte étendu : ${extended.contextWindow} jetons ; tarif ${extended.pricing ? JSON.stringify(extended.pricing) : "non déclaré"}.`,
        );
        return extended;
      }
    }
    this.notice(
      "Le contexte étendu n'est pas disponible pour votre compte ; le modèle standard est utilisé.",
    );
    return standard;
  }
}
