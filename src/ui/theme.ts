// Implements: SPEC-IHM-020 (semantic palettes, EF-02/03, FA-02, RG-01, CA-02).
// Supports: SPEC-IHM-019 (theme preview and cancellation), SPEC-CMD-072, gap E-142.
// Palette application is local to an application; terminal control characters remain owned by the renderer.
import { styleKey, type Color, type ColorDepth, type Style } from "./style";
import { blank, type Cell, type Line } from "./text";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

export const THEMES = [
  { id: "dark", label: "Sombre", description: "Fond sombre, différences vertes et rouges." },
  { id: "light", label: "Clair", description: "Fond clair, différences vertes et rouges." },
  { id: "dark-accessible", label: "Sombre adapté au daltonisme", description: "Ajouts bleus (+), suppressions ambrées (-)." },
  { id: "light-accessible", label: "Clair adapté au daltonisme", description: "Ajouts bleus (+), suppressions ambrées (-)." },
  ...(buildFlag("ui_auto_theme") ? [{ id: "auto", label: "Automatique selon le terminal", description: "Suit la couleur de fond ; sombre si le terminal ne répond pas." }] as const : []),
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
type RGB = readonly [number, number, number];
export interface Theme {
  readonly id: ThemeId;
  readonly text: Color;
  readonly background: Color;
  readonly palette: readonly Color[];
}
const rgb = (r: number, g: number, b: number): Color => ({ rgb: [r, g, b] });
// WCAG relative luminance and contrast: https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
export function contrast(a: RGB, b: RGB): number {
  const luminance = (c: RGB) => c.reduce((sum, v, i) => { const x = v / 255; return sum + [0.2126, 0.7152, 0.0722][i]! * (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); }, 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function readable(color: Color, background: Color, light: boolean): Color {
  if (!("rgb" in color) || !("rgb" in background)) return color;
  let c = color.rgb;
  const next = (v: number) => Math.round(v * 0.8 + (light ? 0 : 255) * 0.2);
  for (let i = 0; i < 32 && contrast(c, background.rgb) < 4.5; i++) c = [next(c[0]), next(c[1]), next(c[2])];
  return { rgb: c };
}
export function resolveTheme(id: string, brand: string): Theme {
  const themeId: ThemeId = THEMES.some((t) => t.id === id) ? id as ThemeId : "dark";
  const light = themeId.startsWith("light"), accessible = themeId.endsWith("accessible");
  const background = light ? rgb(255, 255, 255) : rgb(16, 24, 32), text = light ? rgb(24, 32, 40) : rgb(235, 240, 245);
  const accent = /^#[a-f\d]{6}$/i.test(brand) ? rgb(parseInt(brand.slice(1, 3), 16), parseInt(brand.slice(3, 5), 16), parseInt(brand.slice(5, 7), 16)) : text;
  const blue = light ? rgb(0, 80, 160) : rgb(115, 180, 255), amber = light ? rgb(140, 75, 0) : rgb(255, 195, 105);
  const red = light ? rgb(165, 30, 45) : rgb(255, 130, 145), green = light ? rgb(15, 105, 60) : rgb(110, 215, 155);
  const palette = [text, accessible ? amber : red, accessible ? blue : green, amber, blue, accent, light ? rgb(0, 100, 120) : rgb(110, 210, 235), text, light ? rgb(90, 100, 110) : rgb(155, 165, 175)].map((c) => readable(c, background, light));
  return { id: themeId, text, background, palette };
}
/** Existing ANSI indices express semantic roles; resolve them at the final boundary, including code and differences. */
export function themeLines(lines: readonly Line[], theme: Theme | undefined, width: number, depth?: ColorDepth): Cell[][] {
  if (!theme) return lines.map((line) => [...line]);
  const color = (c: Color | undefined): Color | undefined => {
    if (!c || !("ansi" in c)) return c;
    const index = c.ansi % 8 === 0 && c.ansi !== 0 ? 8 : c.ansi % 8;
    // The nearest RGB approximation of light amber is red in a 16-colour terminal; preserve the semantic distinction.
    if (depth === "16" && theme.id.endsWith("accessible") && [1, 2, 3].includes(index)) return { ansi: index === 2 ? 4 : 3 };
    return theme.palette[index];
  };
  return lines.map((line) => Array.from({ length: Math.max(line.length, width) }, (_, i) => {
    const cell = line[i] ?? blank();
    const style: Style = { ...cell.style, fg: color(cell.style?.fg) ?? theme.text, bg: color(cell.style?.bg) ?? theme.background, ...(cell.style?.dim ? { dim: false, fg: theme.palette[8] } : {}) };
    return { ...cell, style, key: styleKey(style) };
  }));
}
