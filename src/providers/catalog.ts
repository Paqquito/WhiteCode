// Implements: SPEC-API-006 (EF-01 to EF-06, FA-01, CA-02), SPEC-API-007 (`models.identifierMap`), SPEC-API-001 (FA-02)
// Supports: decisions D-06, D-09, D-10, D-12, D-13; gaps E-010, E-025, E-040, E-041, E-043
// Model catalogue supplied by the distribution. Capabilities are neutral, optional and have a documented default.

import { Type, type Static } from "@sinclair/typebox";
import { compileSchema } from "../shared/schema";
import { MODEL_TIERS, type ModelTier } from "../identity/runtime-catalog";
import type { Identity } from "../identity/identity";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ApiEffort = (typeof EFFORT_LEVELS)[number];

/** Every capability is optional; the default of each one is given by DEFAULT_CAPABILITIES (gap E-025). */
const CapabilitiesSchema = Type.Object(
  {
    toolCalling: Type.Optional(Type.Boolean()),
    thinking: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("optional"), Type.Literal("always")])),
    thinkingBudget: Type.Optional(Type.Boolean()),
    effort: Type.Optional(Type.Array(Type.Union(EFFORT_LEVELS.map((l) => Type.Literal(l))))),
    appendOnlyHistory: Type.Optional(Type.Boolean()),
    images: Type.Optional(Type.Boolean()),
    pdf: Type.Optional(Type.Boolean()),
    toolInputStreaming: Type.Optional(Type.Boolean()),
    forcedToolChoice: Type.Optional(Type.Boolean()),
    contextEditing: Type.Optional(Type.Boolean()),
    serverCompaction: Type.Optional(Type.Boolean()),
    systemMessages: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const PricingSchema = Type.Object(
  {
    inputPerMTok: Type.Number({ minimum: 0 }),
    outputPerMTok: Type.Number({ minimum: 0 }),
    cacheReadPerMTok: Type.Number({ minimum: 0 }),
    cacheWritePerMTok: Type.Number({ minimum: 0 }),
    effectiveDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    source: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ModelEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    family: Type.String({ minLength: 1 }),
    aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    label: Type.String({ minLength: 1 }),
    contextWindow: Type.Integer({ minimum: 1 }),
    maxOutputTokens: Type.Integer({ minimum: 1 }),
    capabilities: Type.Optional(CapabilitiesSchema),
    pricing: Type.Optional(PricingSchema),
    /** Opaque options read only by the adapter of the provider (gap E-043). */
    providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** SPEC-API-008 EF-01: status, retirement date and successor of a model being withdrawn. */
    lifecycle: Type.Optional(
      Type.Object(
        {
          status: Type.Union([Type.Literal("deprecated"), Type.Literal("retired")]),
          retirementDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          successor: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ModelCatalogSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    schemaVersion: Type.Literal(1),
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    models: Type.Array(ModelEntrySchema),
  },
  { additionalProperties: false },
);

export type ModelPricing = Static<typeof PricingSchema>;
export type ModelEntry = Static<typeof ModelEntrySchema>;
export type ModelCatalogData = Static<typeof ModelCatalogSchema>;

export interface ModelCapabilities {
  /** Tool calls in the provider protocol; required to use the model as an agent (D-10). */
  readonly toolCalling: boolean;
  /** `none`: no thinking; `optional`: can be switched on or off; `always`: cannot be disabled (D-13). */
  readonly thinking: "none" | "optional" | "always";
  /** The provider sizes thinking with a token budget. */
  readonly thinkingBudget: boolean;
  /** Effort levels accepted by the provider for this model; empty = no effort setting. */
  readonly effort: readonly ApiEffort[];
  /** Thinking bound to the conversation: history must stay append-only, no local micro-compaction (D-12). */
  readonly appendOnlyHistory: boolean;
  readonly images: boolean;
  readonly pdf: boolean;
  /** Tool inputs are streamed as they are generated. */
  readonly toolInputStreaming: boolean;
  readonly forcedToolChoice: boolean;
  readonly contextEditing: boolean;
  readonly serverCompaction: boolean;
  /** Operator messages may be inserted in the middle of the conversation. */
  readonly systemMessages: boolean;
}

/** Documented defaults (gap E-025): a capability absent from an entry is not available. */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  toolCalling: false,
  thinking: "none",
  thinkingBudget: false,
  effort: [],
  appendOnlyHistory: false,
  images: false,
  pdf: false,
  toolInputStreaming: false,
  forcedToolChoice: false,
  contextEditing: false,
  serverCompaction: false,
  systemMessages: false,
};

export function capabilitiesOf(entry: ModelEntry | undefined): ModelCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...(entry?.capabilities ?? {}) } as ModelCapabilities;
}

const validateCatalog = compileSchema<ModelCatalogData>(ModelCatalogSchema);
const validateEntries = compileSchema<ModelEntry[]>(Type.Array(ModelEntrySchema));

export interface ResolvedModel {
  readonly id: string;
  readonly provider: string;
  readonly family: string;
  /** Label shown to users: the tier label from the identity when the model is a tier (EF-03). */
  readonly label: string;
  readonly tier?: ModelTier;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: ModelCapabilities;
  readonly pricing?: ModelPricing;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly currency: string;
  /** Where the entry comes from; `none` when the model is absent from every catalogue. */
  readonly source: "distribution" | "extra" | "none";
  /** SPEC-API-008: the model is being withdrawn. */
  readonly lifecycle?: ModelEntry["lifecycle"];
}

export type ResolveFailure =
  | { readonly error: "unknown_alias"; readonly value: string }
  | { readonly error: "tier_unmapped"; readonly alias: string; readonly tier: ModelTier };

export class ModelCatalogError extends Error {}

export const MODEL_ALIASES = ["large", "medium", "small", "default", "background"] as const;
const TIER_ALIAS: Record<ModelTier, "large" | "medium" | "small"> = { MODEL_LARGE: "large", MODEL_MEDIUM: "medium", MODEL_SMALL: "small" };

export interface ResolveOptions {
  readonly unknownContextWindow: number;
  readonly language?: string;
  /** `models.identifierMap` (SPEC-API-007): tier alias → identifier; wins over the identity (gap E-040). */
  readonly identifierMap?: Readonly<Record<string, string>>;
  /** `models.extraCatalog` entries, for models absent from the distribution catalogue (gap E-041, decision D-16). */
  readonly extraEntries?: readonly ModelEntry[];
}

export class ModelCatalog {
  readonly #data: ModelCatalogData;

  constructor(data: unknown) {
    const result = validateCatalog(data);
    if (!result.ok) throw new ModelCatalogError(`Catalogue de modèles invalide : ${result.errors.join(" ; ")}`);
    this.#data = result.value;
  }

  get currency(): string {
    return this.#data.currency;
  }

  get entries(): readonly ModelEntry[] {
    return this.#data.models;
  }

  find(provider: string, id: string): ModelEntry | undefined {
    return this.#data.models.find((m) => m.provider === provider && (m.id === id || (m.aliases ?? []).includes(id)));
  }

  /** Validates local entries; entries naming a model of the distribution catalogue are rejected (E-041). */
  validateExtraEntries(raw: unknown): { entries: ModelEntry[]; problems: string[] } {
    const result = validateEntries(raw);
    if (!result.ok) return { entries: [], problems: result.errors };
    const problems: string[] = [];
    const entries = result.value.filter((e) => {
      // Decision D-16: never a change to an entry of the distribution.
      if (this.find(e.provider, e.id)) {
        problems.push(`Le modèle ${e.id} appartient au catalogue de la distribution : l'entrée de models.extraCatalog est ignorée.`);
        return false;
      }
      // Decision D-16: tool calls must be declared explicitly, true or false.
      if (typeof e.capabilities?.toolCalling !== "boolean") {
        problems.push(`Le modèle ${e.id} de models.extraCatalog ne déclare pas "capabilities": { "toolCalling": … } : l'entrée est ignorée.`);
        return false;
      }
      return true;
    });
    return { entries, problems };
  }

  /**
   * Resolves an alias (`large`, `medium`, `small`, `default`, `background`), a tier variable name or a full identifier,
   * for the configured provider.
   */
  resolve(value: string, provider: string, identity: Identity, options: ResolveOptions): ResolvedModel | ResolveFailure {
    const tier = aliasToTier(value, identity);
    let id = value;
    if (tier) {
      const alias = TIER_ALIAS[tier];
      const mapped = options.identifierMap?.[alias] ?? identity.modelTier(tier)?.ids[provider];
      if (!mapped) return { error: "tier_unmapped", alias, tier };
      id = mapped;
    } else if ((MODEL_ALIASES as readonly string[]).includes(value)) {
      return { error: "unknown_alias", value };
    }
    const distribution = this.find(provider, id);
    const extra = distribution ? undefined : options.extraEntries?.find((e) => e.provider === provider && (e.id === id || (e.aliases ?? []).includes(id)));
    const entry = distribution ?? extra;
    const tierOfId = tier ?? MODEL_TIERS.find((t) => (options.identifierMap?.[TIER_ALIAS[t]] ?? identity.modelTier(t)?.ids[provider]) === id);
    const tierLabel = tierOfId ? identity.tierLabel(tierOfId, options.language) : undefined;
    return {
      id: entry?.id ?? id,
      provider,
      family: entry?.family ?? "generic",
      label: tierLabel ?? entry?.label ?? id,
      tier: tierOfId,
      contextWindow: entry?.contextWindow ?? options.unknownContextWindow,
      maxOutputTokens: entry?.maxOutputTokens ?? 16_000,
      capabilities: capabilitiesOf(entry),
      pricing: entry?.pricing,
      providerOptions: entry?.providerOptions ?? {},
      currency: this.#data.currency,
      source: distribution ? "distribution" : extra ? "extra" : "none",
      ...(entry?.lifecycle ? { lifecycle: entry.lifecycle } : {}),
    };
  }
}

export function isResolveFailure(v: ResolvedModel | ResolveFailure): v is ResolveFailure {
  return (v as ResolveFailure).error !== undefined;
}

function aliasToTier(value: string, identity: Identity): ModelTier | undefined {
  switch (value) {
    case "large":
      return "MODEL_LARGE";
    case "medium":
      return "MODEL_MEDIUM";
    case "small":
      return "MODEL_SMALL";
    case "default":
      return identity.modelDefault;
    case "background":
      return identity.modelBackground;
    default:
      return (MODEL_TIERS as readonly string[]).includes(value) ? (value as ModelTier) : undefined;
  }
}
