// Implements: SPEC-EXT-039 (CA-01/02, explicit review, session deduplication), gap E-170.
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import { fingerprint } from "../shared/fingerprint";
export interface SkillImprovement { readonly skill: string; readonly reason: string; readonly content: string }
export class SkillImprovements {
  readonly #seen = new Set<string>();
  #turns = 0;
  #busy = false;
  pending?: SkillImprovement;
  constructor(readonly options: { every: () => number; analyze: () => Promise<string | undefined>; allowed: (skill: string) => boolean; present: (proposal: SkillImprovement) => void }) {}
  async turn(): Promise<void> {
    if (!buildFlag("skill_refinement")) return;
    if (this.#busy || this.pending || ++this.#turns < this.options.every()) return;
    this.#turns = 0; this.#busy = true;
    try {
      const raw = await this.options.analyze(); if (!raw || raw.length > 32768) return;
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data["skill"] !== "string" || typeof data["reason"] !== "string" || !data["reason"].trim() || data["reason"].length > 1000 || typeof data["content"] !== "string" || !data["content"].trim() || !this.options.allowed(data["skill"])) return;
      const proposal = { skill: data["skill"], reason: data["reason"], content: data["content"].replace(/\r\n?/g, "\n") }, key = fingerprint({ skill: proposal.skill, content: proposal.content });
      if (this.#seen.has(key)) return;
      this.#seen.add(key); this.pending = proposal; this.options.present(proposal);
    } catch { /* failure leaves every source file unchanged */ } finally { this.#busy = false; }
  }
  dismiss(): void { this.pending = undefined; }
}
