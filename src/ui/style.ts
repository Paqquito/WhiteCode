// Implements: SPEC-IHM-001 (§ 5.2 colour depth and style attributes, EF-03, EF-05, FA-02, CA-02)
// Styles and their terminal sequences. A colour is downgraded to the depth of the terminal, never refused (EF-05);
// without colour only the attributes remain, and every coloured information is doubled by a symbol or a label (tones).

export type ColorDepth = "none" | "16" | "256" | "truecolor";

export type Color = { readonly ansi: number } | { readonly rgb: readonly [number, number, number] };

export interface Style {
  readonly href?: string;
  readonly fg?: Color;
  readonly bg?: Color;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strike?: boolean;
}

const colorKey = (c: Color | undefined) => (c === undefined ? "" : "ansi" in c ? `a${c.ansi}` : `r${c.rgb.join(",")}`);

/** Stable key of a style, to compare cells. */
export function styleKey(s: Style | undefined): string {
  if (!s) return "";
  return `${colorKey(s.fg)}/${colorKey(s.bg)}/${s.bold ? "b" : ""}${s.dim ? "d" : ""}${s.italic ? "i" : ""}${s.underline ? "u" : ""}${s.inverse ? "v" : ""}${s.strike ? "s" : ""}${s.href ? "/href:"+s.href : ""}`;
}

/** The 16 standard colours, as their usual RGB values, for the nearest match. */
const ANSI16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function nearest16(rgb: readonly [number, number, number]): number {
  let best = 0;
  let bestD = Infinity;
  ANSI16.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function to256(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb;
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function colorParams(c: Color, background: boolean, depth: ColorDepth): string | undefined {
  if (depth === "none") return undefined;
  if ("ansi" in c) {
    const i = c.ansi;
    return String((i < 8 ? 30 : 90) + (i % 8) + (background ? 10 : 0));
  }
  if (depth === "truecolor") return `${background ? 48 : 38};2;${c.rgb[0]};${c.rgb[1]};${c.rgb[2]}`;
  if (depth === "256") return `${background ? 48 : 38};5;${to256(c.rgb)}`;
  return colorParams({ ansi: nearest16(c.rgb) }, background, depth);
}

/** SGR sequence selecting exactly `style` (after a reset), for `depth`. */
export function sgr(style: Style | undefined, depth: ColorDepth): string {
  const p: string[] = ["0"];
  if (style) {
    if (style.bold) p.push("1");
    if (style.dim) p.push("2");
    if (style.italic) p.push("3");
    if (style.underline) p.push("4");
    if (style.inverse) p.push("7");
    if (style.strike) p.push("9");
    const fg = style.fg && colorParams(style.fg, false, depth);
    const bg = style.bg && colorParams(style.bg, true, depth);
    if (fg) p.push(fg);
    if (bg) p.push(bg);
  }
  return `\u001b[${p.join(";")}m`;
}

export type UnicodeLevel = "full" | "restricted" | "ascii";

/** Kinds of information conveyed by a colour, each doubled by a symbol (EF-03, CA-02). */
export type Tone = "error" | "warning" | "success" | "info" | "system";

const TONE_COLOR: Readonly<Record<Tone, Color | undefined>> = {
  error: { ansi: 1 },
  warning: { ansi: 3 },
  success: { ansi: 2 },
  info: { ansi: 6 },
  system: undefined,
};

const TONE_SYMBOL: Readonly<Record<Tone, Readonly<Record<UnicodeLevel, string>>>> = {
  error: { full: "✗", restricted: "✗", ascii: "x" },
  warning: { full: "⚠", restricted: "!", ascii: "!" },
  success: { full: "✓", restricted: "✓", ascii: "v" },
  info: { full: "ℹ", restricted: "i", ascii: "i" },
  system: { full: "●", restricted: "*", ascii: "*" },
};

/** Symbol and style of a tone: the symbol is always shown, so the information survives without colour. */
export function tone(t: Tone, level: UnicodeLevel): { readonly symbol: string; readonly style: Style } {
  const fg = TONE_COLOR[t];
  return { symbol: TONE_SYMBOL[t][level], style: { ...(fg ? { fg } : {}), bold: t === "error" } };
}
