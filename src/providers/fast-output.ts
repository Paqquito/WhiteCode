// Implements: SPEC-MOT-026, SPEC-CMD-026 (eligibility, surcharge, cooldown and permanent refusal).
import { ProviderError, type ModelProvider } from "./types";
import type { ResolvedModel } from "./catalog";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
type Eligibility = { eligible: boolean; reason?: string };
export class FastOutput {
  #enabled = false;
  #until = 0;
  #model?: string;
  #denied?: string;
  #generation = 0;
  constructor(
    private readonly eligibility: (
      model: string,
      signal: AbortSignal,
    ) => Promise<Eligibility>,
    private readonly notice: (text: string) => void,
    private readonly clock = Date.now,
    private readonly authorized: () => Promise<boolean> = async () => true,
  ) {}
  get state() {
    return !this.#enabled
      ? "off"
      : this.clock() < this.#until
        ? "cooldown"
        : "active";
  }
  async set(
    enabled: boolean,
    model: ResolvedModel,
    signal: AbortSignal,
  ): Promise<string> {
    const generation = ++this.#generation;
    if (!enabled) {
      this.#enabled = false;
      return "Mode rapide désactivé.";
    }
    this.#enabled = false;
    if (!buildFlag("model_fast_output")) return "Fast output unavailable in this build.";
    const offer = model.providerOptions["fastOutput"] as
      { value?: unknown; multiplier?: unknown } | undefined;
    if (
      model.provider === "anthropic" ||
      !offer ||
      !["priority", "fast"].includes(String(offer.value)) ||
      typeof offer.multiplier !== "number" ||
      !Number.isFinite(offer.multiplier) ||
      offer.multiplier < 1 ||
      offer.multiplier > 100
    )
      return "Mode rapide indisponible : offre non déclarée pour ce modèle et ce protocole.";
    const answer = await this.eligibility(model.id, signal).catch(() => ({
      eligible: false,
      reason: "vérification du contrat impossible",
    }));
    signal.throwIfAborted();
    if (generation !== this.#generation)
      return "Activation remplacée par une demande plus récente.";
    if (!answer.eligible)
      return `Mode rapide indisponible : ${answer.reason ?? "organisation non autorisée"}.`;
    this.#enabled = true;
    this.#model = model.id;
    this.#denied = undefined;
    this.#until = 0;
    return `Mode rapide activé : tarif multiplié par ${offer.multiplier}.`;
  }
  wrap(provider: ModelProvider): ModelProvider {
    if (!buildFlag("model_fast_output")) return provider;
    const mode = this;
    return {
      id: provider.id,
      preconnect: () => provider.preconnect?.(),
      async *stream(request, signal) {
        if (mode.#enabled && !(await mode.authorized())) {
          mode.#enabled = false;
          mode.notice(
            "Mode rapide désactivé : la connexion au compte a changé.",
          );
        }
        const active =
          mode.state === "active" &&
          request.model.id === mode.#model &&
          (!request.purpose || request.purpose === "main");
        if (!active) {
          yield* provider.stream(request, signal);
          return;
        }
        const offer = request.model.providerOptions["fastOutput"] as {
          value: string;
          multiplier: number;
        };
        let started = false;
        try {
          for await (const event of provider.stream(
            { ...request, serviceOptions: { service_tier: offer.value } },
            signal,
          )) {
            started = true;
            yield event.type === "message_complete"
              ? { ...event, serviceCostMultiplier: offer.multiplier }
              : event;
          }
        } catch (error) {
          if (!(error instanceof ProviderError) || started) throw error;
          if (error.kind === "rate_limit" || error.kind === "overloaded") {
            mode.#until =
              mode.clock() +
              Math.max(1000, Math.min(300000, error.retryAfterMs ?? 60000));
            mode.notice(
              "Mode rapide en refroidissement ; poursuite en mode normal.",
            );
          } else if (error.kind === "permission") {
            mode.#enabled = false;
            mode.#denied = "organisation non autorisée par le service";
            mode.notice(`Mode rapide désactivé : ${mode.#denied}.`);
          } else throw error;
          yield* provider.stream(request, signal);
        }
      },
    };
  }
}
