// Implements: SPEC-MOD-005 (§ 5.5 budget admission, FA-02, FA-08, EF-08 to EF-11, ERR-04, ERR-05, RG-03, RG-05, CA-02, CA-07, CA-08, CA-09 to CA-13, CA-17)
// Supports: SPEC-API-002 (EF-08), SPEC-API-003 (EF-06), gaps E-054 (bound of a call), E-055 (price overrides)

import type { ModelPricing, ResolvedModel } from "../providers/catalog";
import type { ModelRequest, Usage } from "../providers/types";

/** Cost of a usage at a price; undefined without a price (a model without price is never free, EF-05 of SPEC-API-006). */
export function costOf(pricing: ModelPricing | undefined, usage: Usage): number | undefined {
  if (!pricing) return undefined;
  return (
    (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok + usage.cacheReadTokens * pricing.cacheReadPerMTok + usage.cacheWriteTokens * pricing.cacheWritePerMTok) /
    1_000_000
  );
}

/**
 * Upper bound of the cost of a request (§ 5.5, gap E-054): every input token priced at the dearest input category
 * (plain input or cache write), the input counted as its UTF-8 size in bytes (a token is never shorter than one byte)
 * within the context window, and the whole output limit. Undefined when the model has no price: the cost cannot be bounded.
 */
export function requestBound(request: ModelRequest, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify({ s: request.system, t: request.tools, h: request.history }), "utf8");
  const inputTokens = Math.min(bytes, request.model.contextWindow);
  const inputPrice = Math.max(pricing.inputPerMTok, pricing.cacheWritePerMTok, pricing.cacheReadPerMTok);
  return (inputTokens * inputPrice + request.maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
}

export interface Reservation {
  readonly id: number;
  readonly bound: number;
  /** Consumer, for the diagnostics: main loop, sub-agent, classifier… */
  readonly consumer: string;
}

export type Admission = { readonly admitted: true; readonly reservation: Reservation } | { readonly admitted: false; readonly reason: "budget_limit" | "cost_cap_unverifiable"; readonly message: string };

export interface BudgetSnapshot {
  readonly cap?: number;
  readonly currency: string;
  /** Costs confirmed by a usage the provider reported. */
  readonly confirmed: number;
  /** Confirmed costs plus the bounds of the calls whose cost is not reliably known (RG-03: never decreases). */
  readonly conservative: number;
  /** Reservations of calls in progress. */
  readonly reserved: number;
  readonly unknownCost: boolean;
}

/**
 * Budget of one execution, shared by the main agent, its sub-agents and every billable side request (EF-09).
 * JavaScript runs one admission at a time: `admit` checks and reserves in one step, so two concurrent claims
 * on the last remainder cannot both succeed (CA-10).
 */
export class BudgetLedger {
  #confirmed = 0;
  #conservativeExtra = 0;
  #unknownCost = false;
  readonly #reservations = new Map<number, Reservation>();
  #next = 1;

  constructor(
    readonly cap: number | undefined,
    readonly currency: string,
  ) {}

  get snapshot(): BudgetSnapshot {
    return {
      cap: this.cap,
      currency: this.currency,
      confirmed: this.#confirmed,
      conservative: this.#confirmed + this.#conservativeExtra,
      reserved: [...this.#reservations.values()].reduce((n, r) => n + r.bound, 0),
      unknownCost: this.#unknownCost,
    };
  }

  /** EF-08: admitted only if committed costs + reservations + bound of the new call ≤ cap. Every attempt asks again (EF-10). */
  admit(bound: number | undefined, consumer: string): Admission {
    if (this.cap === undefined) {
      const reservation = { id: this.#next++, bound: bound ?? 0, consumer };
      this.#reservations.set(reservation.id, reservation);
      return { admitted: true, reservation };
    }
    if (bound === undefined) {
      // FA-08, ERR-05, CA-09: the cost cannot be bounded, so the call is unavailable under a cap.
      return { admitted: false, reason: "cost_cap_unverifiable", message: "Le plafond de coût ne peut pas être garanti pour ce modèle." };
    }
    const s = this.snapshot;
    if (s.conservative + s.reserved + bound > this.cap) {
      return {
        admitted: false,
        reason: "budget_limit",
        message: `Budget atteint : ${formatAmount(s.conservative + s.reserved, this.currency)} engagés ou réservés sur un plafond de ${formatAmount(this.cap, this.currency)} ; l'appel suivant pourrait coûter jusqu'à ${formatAmount(bound, this.currency)}.`,
      };
    }
    const reservation = { id: this.#next++, bound, consumer };
    this.#reservations.set(reservation.id, reservation);
    return { admitted: true, reservation };
  }

  /** The provider reported the usage: the actual cost is committed and the reservation released. */
  settle(reservation: Reservation, cost: number | undefined): void {
    if (!this.#reservations.delete(reservation.id)) return;
    if (cost === undefined) {
      this.#unknownCost = true;
      if (this.cap !== undefined) this.#conservativeExtra += reservation.bound;
      return;
    }
    this.#confirmed += cost;
  }

  /**
   * No reliable usage (response without usage, cancelled or failed call that may have been billed):
   * the bound stays counted, conservatively (CA-11, CA-12).
   */
  keepConservatively(reservation: Reservation): void {
    if (!this.#reservations.delete(reservation.id)) return;
    this.#conservativeExtra += reservation.bound;
  }

  /** A call that certainly never reached the provider (refused before sending) frees its reservation. */
  release(reservation: Reservation): void {
    this.#reservations.delete(reservation.id);
  }
}

/** Amount for display: two decimals and the reference currency, with the decimal comma of French (CA-17). */
export function formatAmount(amount: number, currency: string): string {
  return `${amount.toFixed(2).replace(".", ",")} ${currency}`;
}

/** Price of a model for the admission (E-055): an override in another currency than the reference one is rejected. */
export function effectivePricing(
  model: ResolvedModel,
  overrides: ReadonlyArray<{ readonly scope: string; readonly value: Readonly<Record<string, unknown>> }>,
  referenceCurrency: string,
  warn: (message: string) => void,
): ModelPricing | undefined {
  let pricing = model.pricing;
  for (const { scope, value } of overrides) {
    const entry = value[model.id] as (Partial<ModelPricing> & { currency?: string }) | undefined;
    if (!entry) continue;
    if (entry.currency !== undefined && entry.currency !== referenceCurrency) {
      warn(`surcharge de tarif ignorée pour ${model.id} (portée ${scope}) : devise ${entry.currency} différente de la devise de référence ${referenceCurrency}.`);
      continue;
    }
    const fields = ["inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheWritePerMTok"] as const;
    if (!fields.every((f) => typeof entry[f] === "number" && entry[f]! >= 0)) {
      warn(`surcharge de tarif ignorée pour ${model.id} (portée ${scope}) : les quatre tarifs sont requis.`);
      continue;
    }
    pricing = { inputPerMTok: entry.inputPerMTok!, outputPerMTok: entry.outputPerMTok!, cacheReadPerMTok: entry.cacheReadPerMTok!, cacheWritePerMTok: entry.cacheWritePerMTok!, effectiveDate: entry.effectiveDate ?? "override", source: `override:${scope}` };
  }
  return pricing;
}
