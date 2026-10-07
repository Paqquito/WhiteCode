// Implements: SPEC-MOT-003 (§ 5.3, FA-01, § 5.6 sections 1 to 4, 9, 10, 12 and 13, EF-01 to EF-05, EF-08, ERR-02 to ERR-04, RG-01, RG-03, CA-01 to CA-07),
//             SPEC-MOT-004 (EF-03, EF-04, RG-03), SPEC-MOT-007 (EF-02)
// Supports: decision D-12 (instructions frozen per segment), SPEC-MOT-045 (variants)

import type { Identity } from "../identity/identity";
import type { ResolvedModel } from "../providers/catalog";
import type { SystemBlock } from "../providers/types";
import { REMINDER_EXPLANATION } from "./reminders";
import { assembleContract, CONTRACT_VERSION, CURRENT_CONTRACT, FALLBACK_CONTRACT, selectFamily, type ContractText, type Variant } from "./behavior-contract";

export interface InstructionsContext {
  readonly identity: Identity;
  readonly variant: Variant;
  readonly nonInteractive: boolean;
  readonly model: ResolvedModel;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly shellTool?: string;
  readonly date: Date;
  readonly promptFamily: string;
  readonly budgetTokens: number;
  /** Git state captured once at session start (section 10, increment 4); undefined outside a repository. */
  readonly gitState?: string;
  /** Section 12: the project instructions files, already rendered (SPEC-MOT-005). */
  readonly projectInstructions?: string;
  /** SPEC-MOT-004: replacement of the default sections and text added at the end. */
  readonly customInstructions?: { readonly replacement?: string; readonly addition?: string };
}

export interface SectionProvider {
  readonly id: number;
  readonly name: string;
  readonly stable: boolean;
  readonly required: boolean;
  readonly reducible: boolean;
  produce(ctx: InstructionsContext): string | undefined;
  /** Reduction to about `maxTokens` (§ 5.6 "Réductible": truncated descriptions, truncated status…); default: cut at the end. */
  reduce?(text: string, maxTokens: number): string;
}

export interface BuiltInstructions {
  readonly blocks: readonly SystemBlock[];
  readonly estimatedTokens: number;
  readonly contractVersion: string;
  readonly family: string;
  readonly usedFallback: readonly number[];
  readonly warnings: readonly string[];
}

export class RequiredSectionUnavailable extends Error {}

/** Rough token estimate (about four characters per token, SPEC-MOT-010); overestimates rather than underestimates. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function contractSections(ctx: InstructionsContext, contract: ContractText) {
  return assembleContract(contract, ctx.variant, ctx.nonInteractive);
}

export function defaultSectionProviders(contract: () => ContractText = CURRENT_CONTRACT): SectionProvider[] {
  return [
    {
      id: 1,
      name: "identity",
      stable: true,
      required: true,
      reducible: false,
      // Model-facing texts are written in English (SPEC-MOT-045 § 5.1); the brand statement comes from the identity (RG-03).
      produce: (ctx) => ctx.identity.get("IDENTITY_STATEMENT", "en"),
    },
    { id: 2, name: "rules", stable: true, required: true, reducible: false, produce: (ctx) => contractSections(ctx, contract()).rules },
    { id: 3, name: "method", stable: true, required: false, reducible: false, produce: (ctx) => contractSections(ctx, contract()).method },
    { id: 4, name: "tools", stable: true, required: true, reducible: false, produce: (ctx) => contractSections(ctx, contract()).tools },
    {
      id: 9,
      name: "environment",
      stable: false,
      required: false,
      reducible: false,
      produce: (ctx) =>
        [
          "# Environment",
          `- Working directory: ${ctx.cwd}`,
          `- Additional directories: ${ctx.additionalDirectories.length > 0 ? ctx.additionalDirectories.join(", ") : "none"}`,
          `- Platform: ${ctx.platform} (${ctx.arch}), system version ${ctx.osRelease}`,
          `- Shell tool: ${ctx.shellTool ?? "none available in this session"}`,
          `- Date: ${ctx.date.toISOString().slice(0, 10)}`,
          `- Model: ${ctx.model.label} (${ctx.model.id})`,
          ctx.nonInteractive ? "- Run mode: non-interactive; nobody can answer questions or confirm actions during this run." : "- Run mode: interactive.",
          `- ${REMINDER_EXPLANATION}`,
        ].join("\n"),
    },
    {
      id: 10,
      name: "repository",
      stable: false,
      required: false,
      reducible: true,
      produce: (ctx) => (ctx.gitState ? `# Repository state (snapshot taken at session start)\n${ctx.gitState}` : undefined),
    },
    { id: 12, name: "project-instructions", stable: false, required: false, reducible: false, produce: (ctx) => ctx.projectInstructions },
    // SPEC-MOT-004 CA-01: the added text comes last, as given.
    { id: 13, name: "custom-addition", stable: false, required: false, reducible: false, produce: (ctx) => ctx.customInstructions?.addition },
  ];
}

/**
 * Sections kept when the user replaces the default instructions (SPEC-MOT-003 FA-01, SPEC-MOT-004 EF-04, RG-03, gap E-075):
 * identity, rules of conduct, use of the tools, environment, and the added text (EF-03).
 */
const KEPT_ON_REPLACEMENT = new Set([1, 2, 4, 9, 13]);

const FALLBACK_PROVIDERS = (): Map<number, SectionProvider> =>
  new Map(defaultSectionProviders(FALLBACK_CONTRACT).filter((p) => p.required).map((p) => [p.id, p]));

/**
 * Assembles the system instructions in section order, stable part first (EF-01, EF-02).
 * Built once per segment by the engine: the result never changes within a segment (D-12).
 */
export function buildSystemInstructions(ctx: InstructionsContext, providers: readonly SectionProvider[] = defaultSectionProviders()): BuiltInstructions {
  const warnings: string[] = [];
  const usedFallback: number[] = [];
  const fallback = FALLBACK_PROVIDERS();
  const family = selectFamily(ctx.promptFamily, ctx.model.family);
  if (family.warning) warnings.push(family.warning);

  // SPEC-MOT-003 FA-01: a replacement keeps the "always" sections and takes the place of the others, in the stable part.
  const replacement = ctx.customInstructions?.replacement;
  const active =
    replacement === undefined
      ? providers
      : [
          ...providers.filter((p) => KEPT_ON_REPLACEMENT.has(p.id)),
          { id: 4.5, name: "custom-replacement", stable: true, required: false, reducible: false, produce: () => replacement },
        ];

  const produced: Array<{ provider: SectionProvider; text: string }> = [];
  for (const provider of [...active].sort((a, b) => a.id - b.id)) {
    let text: string | undefined;
    try {
      text = provider.produce(ctx);
    } catch (error) {
      if (!provider.required) {
        warnings.push(`Section ${provider.id} (${provider.name}) indisponible : ${(error as Error).message}`); // ERR-03
        continue;
      }
      // ERR-04 / EF-08: approved fallback version, otherwise the request is not sent.
      const backup = fallback.get(provider.id);
      try {
        text = backup?.produce(ctx);
      } catch {
        text = undefined;
      }
      if (text === undefined) throw new RequiredSectionUnavailable("Les consignes obligatoires n'ont pas pu être chargées ; la requête n'a pas été envoyée.");
      usedFallback.push(provider.id);
    }
    if (text !== undefined && text.trim() !== "") produced.push({ provider, text: text.trim() });
  }

  // EF-05: reduce the reducible sections, last first, when over budget.
  let total = produced.reduce((n, s) => n + estimateTokens(s.text), 0);
  for (let i = produced.length - 1; i >= 0 && total > ctx.budgetTokens; i--) {
    const s = produced[i]!;
    if (!s.provider.reducible) continue;
    const allowed = Math.max(60, ctx.budgetTokens - (total - estimateTokens(s.text)));
    const reduced = s.provider.reduce ? s.provider.reduce(s.text, allowed) : `${s.text.slice(0, Math.floor(Math.max(0, allowed - 10) * 3.5))}\n[… section shortened]`;
    total -= estimateTokens(s.text) - estimateTokens(reduced);
    produced[i] = { provider: s.provider, text: reduced };
  }
  if (total > ctx.budgetTokens) warnings.push("Les instructions système sont très volumineuses ; réduisez vos fichiers d'instructions."); // ERR-02

  const stable = produced.filter((s) => s.provider.stable);
  const variable = produced.filter((s) => !s.provider.stable);
  const blocks: SystemBlock[] = [
    ...stable.map((s, i) => ({ text: s.text, cacheBoundary: i === stable.length - 1 })),
    ...variable.map((s) => ({ text: s.text })),
  ];
  return { blocks, estimatedTokens: total, contractVersion: CONTRACT_VERSION, family: family.family, usedFallback, warnings };
}
