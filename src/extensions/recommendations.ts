// Implements: SPEC-EXT-017 (CA-01/02/03, one explicit recommendation and permanent refusal).
// Supports: SPEC-EXT-018, SPEC-CFG-010, gap E-164.
import { extname } from "node:path";
import { readUserState, updateUserState } from "../config/user-state";
import { currentPlatform, findExecutable } from "../platform/system";
import { maskSecrets } from "../shared/secrets";
export interface LanguageRecommendation { readonly extension: string; readonly binary?: string; readonly install?: string }
const REF = /^[a-z0-9]+(?:-[a-z0-9]+)*@[a-z0-9]+(?:-[a-z0-9]+)*$/;
export class ExtensionRecommendations {
  #shown = false;
  readonly #files = new Map<string, Set<string>>();
  constructor(readonly options: { readonly stateFile: string; readonly enabled: () => boolean; readonly admitted: (ref: string) => boolean; readonly present: (ref: string, origin: string) => void; readonly clear: () => void; readonly threshold: () => number; readonly languages: () => Readonly<Record<string, LanguageRecommendation>> }) {}
  recommend(ref: string, origin: string): boolean {
    if (this.#shown || !this.options.enabled() || !REF.test(ref) || ref.length > 97) return false;
    // Suggestions must not change the outcome of an already completed command.
    try { if (!this.options.admitted(ref) || readUserState(this.options.stateFile).extensionRecommendationsDismissed?.includes(ref)) return false; }
    catch { return false; }
    this.#shown = true; this.options.present(ref, maskSecrets(origin).slice(0, 500)); return true;
  }
  async dismiss(ref: string): Promise<void> {
    if (!REF.test(ref) || ref.length > 97) throw new Error("Référence d’extension invalide.");
    await updateUserState(this.options.stateFile, { extensionRecommendationsDismissed: [ref] }, currentPlatform()); this.options.clear();
  }
  later(): void { this.options.clear(); }
  touched(path: string): void {
    if (this.#shown || !this.options.enabled()) return;
    const extension = extname(path).toLowerCase(), proposal = this.options.languages()[extension]; if (!proposal) return;
    if (proposal.binary && findExecutable(proposal.binary)) return;
    const files = this.#files.get(extension) ?? new Set<string>(); if (files.size < 1000) files.add(path); this.#files.set(extension, files);
    if (files.size >= this.options.threshold()) this.recommend(proposal.extension, `Fichiers ${extension} manipulés sans serveur de langage.${proposal.install ? ` Installation suggérée : ${proposal.install}` : ""}`);
  }
}
