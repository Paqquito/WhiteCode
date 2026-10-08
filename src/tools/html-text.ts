// Supports: SPEC-OUT-012 (§ 5.3 step 5: a document converted into light structured text)
// HTML to readable text, without a parser: the scripts and styles removed, the headings, items and links kept legible.

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string, base?: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, "");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.trim()}\n\n`);
  s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    let target = href;
    try {
      if (base) target = new URL(href, base).href;
    } catch {
      // the link as written
    }
    return label && !href.startsWith("#") && !href.startsWith("javascript:") ? `${label} (${target})` : label;
  });
  s = s
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|tr|ul|ol|table|blockquote|pre|h[1-6])\s*>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
