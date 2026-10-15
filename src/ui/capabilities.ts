// Implements: SPEC-IHM-001 (§ 5.2 capabilities of the terminal, EF-05, FA-02, § 11 `ui.colorMode`, `ui.unicodeLevel`)
// Capabilities of the terminal, from the settings, the options and the public variables of the environment. A missing
// capability degrades the display; it never fails (EF-05).

import type { ColorDepth, UnicodeLevel } from "./style";

export interface Capabilities {
  readonly hyperlinks?: boolean;
  readonly colors: ColorDepth;
  readonly unicode: UnicodeLevel;
  /** Updates framed by the synchronised output mode, so that a frame appears at once. */
  readonly synchronizedOutput: boolean;
  /** Pasted text framed by the terminal (SPEC-IHM-010 § 5.1). */
  readonly bracketedPaste: boolean;
  /** The terminal rewraps its lines when its width changes; used to find the top of the live area after a resize. */
  readonly reflowOnResize: boolean;
}

export interface CapabilityInputs {
  /** `ui.colorMode`: `auto`, `none`, `16`, `256` or `truecolor`. */
  readonly colorMode: string;
  /** `ui.unicodeLevel`. */
  readonly unicodeLevel: UnicodeLevel;
  /** `--no-color`. */
  readonly noColorOption: boolean;
  /** Public variable of the environment. */
  readonly variable: (name: string) => string | undefined;
  readonly platform: string;
}

export function detectCapabilities(i: CapabilityInputs): Capabilities {
  const term = (i.variable("TERM") ?? "").toLowerCase();
  const dumb = term === "dumb";
  return {
    hyperlinks: !dumb && (i.variable("WT_SESSION") !== undefined || i.variable("VTE_VERSION") !== undefined || /^(?:iTerm.app|WezTerm|vscode|ghostty)$/.test(i.variable("TERM_PROGRAM") ?? "")),
    colors: colorDepth(i, term, dumb),
    unicode: dumb ? "ascii" : i.unicodeLevel,
    synchronizedOutput: !dumb && term !== "linux",
    bracketedPaste: !dumb,
    reflowOnResize: true,
  };
}

function colorDepth(i: CapabilityInputs, term: string, dumb: boolean): ColorDepth {
  if (i.noColorOption) return "none";
  if (i.colorMode === "none" || i.colorMode === "16" || i.colorMode === "256" || i.colorMode === "truecolor") return i.colorMode;
  // `auto`: the usual conventions of the variables.
  const noColor = i.variable("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return "none";
  const force = i.variable("FORCE_COLOR");
  if (force === "0") return "none";
  if (force === "1") return "16";
  if (force === "2") return "256";
  if (force === "3") return "truecolor";
  if (dumb) return "none";
  const colorterm = (i.variable("COLORTERM") ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (i.variable("WT_SESSION") !== undefined || i.platform === "windows") return "truecolor";
  if (term.includes("256color")) return "256";
  return "16";
}
