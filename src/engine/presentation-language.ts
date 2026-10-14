// Implements: SPEC-CFG-012 (CA-01/02, model preference independent of UI fallback), gap E-170.
export function presentationLanguage(preference: string, osLocale: string): { ui: "fr" | "en"; instruction: string; requested: string } {
  let requested: string;
  try { requested = Intl.getCanonicalLocales(preference === "auto" ? osLocale.replace(/_/g, "-").replace(/\..*$/, "") : preference)[0] ?? "fr"; } catch { requested = "fr"; }
  const base = requested.split("-")[0]!;
  const name = new Intl.DisplayNames(["en"], { type: "language" }).of(base) ?? base;
  return { ui: base === "en" ? "en" : "fr", requested, instruction: `Respond in ${name} (${requested}), including when the user's input uses another language. Preserve code, identifiers, commands and technical names verbatim.` };
}
