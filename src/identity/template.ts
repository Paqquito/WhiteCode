// Implements: SPEC-CAD-002 (EF-13, EF-14, EF-23, EF-24)
// Variable substitution syntax: {{NAME}}, {{NAME|transform|transform}}, escape \{{.

export const TRANSFORMS = ["lower", "upper", "kebab", "snake", "const", "title", "url"] as const;
export type Transform = (typeof TRANSFORMS)[number];

function asciiWords(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
}

export function applyTransform(value: string, transform: Transform): string {
  switch (transform) {
    case "lower":
      return value.toLowerCase();
    case "upper":
      return value.toUpperCase();
    case "kebab":
      return asciiWords(value).join("-").toLowerCase();
    case "snake":
      return asciiWords(value).join("_").toLowerCase();
    case "const":
      return asciiWords(value).join("_").toUpperCase();
    case "title":
      return value.replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
    case "url":
      return encodeURIComponent(value);
  }
}

export function isTransform(name: string): name is Transform {
  return (TRANSFORMS as readonly string[]).includes(name);
}

export type TemplatePart =
  | { kind: "literal"; text: string }
  | { kind: "variable"; name: string; transforms: string[]; raw: string };

// `\\{{` (two backslashes) = literal backslash then a substitution, for Windows paths (gap E-036); `\{{` = literal `{{`.
const TOKEN = /\\\\(?=\{\{)|\\\{\{|\{\{([^{}]*)\}\}/g;

/** Splits a template into literal and variable parts. `\{{` yields a literal `{{`. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "literal", text: template.slice(last, index) });
    if (match[0] === "\\\\") {
      parts.push({ kind: "literal", text: "\\" });
    } else if (match[0] === "\\{{") {
      parts.push({ kind: "literal", text: "{{" });
    } else {
      const inner = (match[1] ?? "").trim();
      const [name = "", ...transforms] = inner.split("|").map((s) => s.trim());
      parts.push({ kind: "variable", name, transforms, raw: match[0] });
    }
    last = index + match[0].length;
  }
  if (last < template.length) parts.push({ kind: "literal", text: template.slice(last) });
  return parts;
}

/** Names of the variables referenced by a template. */
export function referencedVariables(template: string): string[] {
  return parseTemplate(template)
    .filter((p): p is Extract<TemplatePart, { kind: "variable" }> => p.kind === "variable")
    .map((p) => p.name);
}

export interface RenderOptions {
  /** Returns the value of a variable, or undefined when unknown. */
  lookup(name: string): string | undefined;
  onUnknownVariable?(name: string): void;
  onUnknownTransform?(name: string): void;
}

export function renderTemplate(template: string, options: RenderOptions): string {
  let out = "";
  for (const part of parseTemplate(template)) {
    if (part.kind === "literal") {
      out += part.text;
      continue;
    }
    let value = options.lookup(part.name);
    if (value === undefined) {
      options.onUnknownVariable?.(part.name);
      out += part.raw;
      continue;
    }
    for (const t of part.transforms) {
      if (isTransform(t)) value = applyTransform(value, t);
      else options.onUnknownTransform?.(t);
    }
    out += value;
  }
  return out;
}

/**
 * Renders a Markdown document, leaving fenced code blocks annotated `literal` untouched (EF-24).
 */
export function renderDocument(markdown: string, options: RenderOptions): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let literal = false;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) out.push(renderTemplate(buffer.join("\n"), options));
    buffer = [];
  };
  for (const line of lines) {
    const opening = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null && opening) {
      flush();
      fence = opening[2] ?? "```";
      literal = /\bliteral\b/.test(opening[3] ?? "");
      if (literal) out.push(line);
      else buffer.push(line);
      continue;
    }
    if (fence !== null && line.trim().startsWith(fence)) {
      if (literal) out.push(line);
      else buffer.push(line);
      fence = null;
      literal = false;
      if (!literal) flush();
      continue;
    }
    if (literal) out.push(line);
    else buffer.push(line);
  }
  flush();
  return out.join("\n");
}
