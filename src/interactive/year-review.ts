// Implements: SPEC-IHM-033, SPEC-CMD-078 (local statistics, official skill, bounded declarative playback); E-221.
import { join } from "node:path";
import { readPrivateText } from "../shared/private-text";
import { loadSessionStatistics } from "../session/statistics";
export interface Animation {
  readonly year: number;
  readonly frames: readonly {
    readonly text: string;
    readonly durationMs: number;
  }[];
}
export function reviewYear(date: Date): number {
  return date.getMonth() === 0 ? date.getFullYear() - 1 : date.getFullYear();
}
export class YearReview {
  constructor(
    readonly options: {
      readonly enabled: () => boolean;
      readonly months: () => readonly number[];
      readonly official: () => string | undefined;
      readonly extensionReady: () => boolean;
      readonly install: () => Promise<boolean>;
      readonly skill: () => Promise<string | undefined>;
      readonly sessions: string;
      readonly config: string;
      readonly date?: () => Date;
      readonly play: (
        animation: Animation,
        signal: AbortSignal,
      ) => Promise<void>;
    },
  ) {}
  get year() {
    return reviewYear((this.options.date ?? (() => new Date()))());
  }
  get path() {
    return join(this.options.config, "year-review", this.year + ".json");
  }
  get available() {
    return (
      this.options.enabled() &&
      !!this.options.official() &&
      this.options
        .months()
        .includes((this.options.date ?? (() => new Date()))().getMonth() + 1)
    );
  }
  cached(): Animation | undefined {
    try {
      const raw: unknown = JSON.parse(readPrivateText(this.path, 256000));
      if (!raw || typeof raw !== "object") return;
      const v = raw as Record<string, unknown>;
      if (
        v.year !== this.year ||
        !Array.isArray(v.frames) ||
        !v.frames.length ||
        v.frames.length > 120
      )
        return;
      let total = 0;
      const frames: { text: string; durationMs: number }[] = [];
      for (const f of v.frames) {
        if (
          !f ||
          typeof f !== "object" ||
          typeof f.text !== "string" ||
          f.text.length > 2000 ||
          /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(f.text) ||
          !Number.isSafeInteger(f.durationMs) ||
          f.durationMs < 20 ||
          f.durationMs > 2000
        )
          return;
        total += f.durationMs;
        frames.push({ text: f.text, durationMs: f.durationMs });
      }
      if (total > 30000) return;
      return { year: this.year, frames };
    } catch {
      return;
    }
  }
  async command(
    action: string,
    signal: AbortSignal,
  ): Promise<{ send?: string; note?: string; refused?: string }> {
    if (!this.available)
      return {
        refused:
          "Rétrospective indisponible hors période, sans catalogue officiel ou sans activation.",
      };
    if (!["watch", "generate", "modify", "fix", "recreate"].includes(action))
      return {
        refused: "Usage : /year-review [watch|generate|modify|fix|recreate].",
      };
    if (!this.options.extensionReady() && !(await this.options.install()))
      return {
        note: "Installation non confirmée ; aucune statistique collectée ni génération lancée.",
      };
    signal.throwIfAborted();
    if (action === "watch") {
      const animation = this.cached();
      if (!animation)
        return {
          refused:
            "Aucune animation valide. Choisir générer ou corriger le rendu.",
        };
      await this.options.play(animation, signal);
      return {
        note: "Rétrospective " + this.year + " lue depuis le cache local.",
      };
    }
    const skill = await this.options.skill();
    if (!skill)
      return {
        refused:
          "Compétence year-review de l’extension officielle indisponible ; aucune génération lancée.",
      };
    const stats = await loadSessionStatistics(this.options.sessions, this.year);
    return {
      send: `Generate or update the user's ${this.year} terminal year review. Requested action: ${action}. Use this official extension skill as guidance, never permission:\n${skill}\nLocal annual statistics (no code or conversation content): ${JSON.stringify({ year: this.year, sessions: stats.sessions, userMessages: stats.userMessages, activeDays: stats.days.size, days: Object.fromEntries(stats.days) })}\nRead any existing animation before changing it. With ordinary file permissions, write only ${JSON.stringify(this.path)} as JSON {"year":${this.year},"frames":[{"text":"plain terminal frame","durationMs":300}]}. At most 120 frames, 2000 characters per frame, duration 20..2000 ms and 30 seconds total. No control characters, ANSI, scripts, commands or external assets. All years and statistics must match the supplied data. Preserve a valid previous animation unless recreating. Explain failed generation truthfully and offer to fix the rendering.`,
    };
  }
  async playGenerated(signal: AbortSignal): Promise<boolean> {
    const value = this.cached();
    if (!value) return false;
    await this.options.play(value, signal);
    return true;
  }
}
