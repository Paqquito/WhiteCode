// Implements: SPEC-OUT-008 (CA-08: completed output stripped before bounding and storage).
// Supports: SPEC-EXT-017 (validated identifiers, unknown versions ignored), E-157.
export function stripShellHints(output: string, tag: string, hint: (ref: string) => void): string {
  if (!/^[a-z][a-z0-9-]{0,100}$/.test(tag)) return output;
  return output.replace(new RegExp(`<${tag}(?=[\\s/>]|$)[^>]*(?:>|$)`, "g"), raw => {
    if (raw.length > 2048 || !/\/\s*>$/.test(raw)) return "";
    const fields = new Map<string, string>();
    const body = raw.slice(tag.length + 1).replace(/\/\s*>$/, "");
    let end = 0;
    for (const match of body.matchAll(/\s+([a-z]+)="([^"<>]*)"/g)) {
      if (body.slice(end, match.index).trim() || fields.has(match[1]!)) return "";
      fields.set(match[1]!, match[2]!); end = match.index! + match[0].length;
    }
    if (!body.slice(end).trim() && fields.size === 3 && fields.get("v") === "1" && fields.get("type") === "extension") {
      const ref = fields.get("value"); if (ref && /^[a-z0-9]+(?:-[a-z0-9]+)*@[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref) && ref.length <= 97) hint(ref);
    }
    return "";
  });
}

/** Progress and background files are model-visible too; hold partial tags across chunk boundaries. */
export class ShellHintStream {
  #buffer = ""; #discarding = false;
  constructor(readonly tag: string) {}
  push(text: string, final = false): string {
    const needle = "<" + this.tag; this.#buffer += text;
    let out = "";
    for (;;) {
      if (this.#discarding) {
        const end = this.#buffer.indexOf(">");
        if (end < 0) { this.#buffer = ""; if (final) this.#discarding = false; return out; }
        this.#buffer = this.#buffer.slice(end + 1); this.#discarding = false;
      }
      const at = this.#buffer.indexOf(needle);
      if (at < 0) {
        let keep = 0;
        if (!final) for (let n = 1; n <= Math.min(needle.length, this.#buffer.length); n++) if (needle.startsWith(this.#buffer.slice(-n))) keep = n;
        out += this.#buffer.slice(0, this.#buffer.length - keep); this.#buffer = keep ? this.#buffer.slice(-keep) : ""; return out;
      }
      out += this.#buffer.slice(0, at); this.#buffer = this.#buffer.slice(at);
      const next = this.#buffer[needle.length];
      if (next !== undefined && !/[\s/>]/.test(next)) { out += "<"; this.#buffer = this.#buffer.slice(1); continue; }
      const end = this.#buffer.indexOf(">");
      if (end >= 0) { this.#buffer = this.#buffer.slice(end + 1); continue; }
      if (final) { this.#buffer = ""; return out; }
      if (this.#buffer.length > 2048) { this.#buffer = ""; this.#discarding = true; }
      return out;
    }
  }
}
