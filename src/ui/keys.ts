// Implements: SPEC-IHM-014 (§ 5.3 combinations sent by most terminals, FA-04), SPEC-IHM-007 (EF-08 typed content never interpreted as a control sequence), SPEC-IHM-010 (§ 5.1 paste framed by the terminal)
// Raw terminal input to key events: printable text, control combinations, cursor and editing keys, modifiers, and pasted
// text framed by the terminal, delivered whole and never as a series of keys.
// Supports: SPEC-PER-021 (EF-01 standalone Escape timing cannot convert paste contents into consent keys), gap E-129.

export interface KeyEvent {
  /** Enhanced keyboard protocols explicitly report release; a legacy key has no phase. */
  readonly phase?:"press"|"repeat"|"release";
  readonly kind: "key";
  /** `enter`, `tab`, `backspace`, `delete`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `insert`, `f1`…, or a character. */
  readonly name: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly super?: boolean;
  /** Text to insert, for a printable key without control or alternate modifier. */
  readonly text?: string;
}

export interface PasteEvent {
  readonly kind: "paste";
  readonly text: string;
}

export type InputEvent = KeyEvent | PasteEvent | { readonly kind: "focus"; readonly focused: boolean } | { readonly kind: "appearance"; readonly light: boolean };

const key = (name: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; super?: boolean } = {}, text?: string): KeyEvent => ({
  kind: "key",
  name,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
  ...(mods.super ? { super: true } : {}),
  ...(text !== undefined ? { text } : {}),
});

const CSI_TILDE: Readonly<Record<string, string>> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end", "11": "f1", "12": "f2", "13": "f3", "14": "f4", "15": "f5", "17": "f6", "18": "f7", "19": "f8", "20": "f9", "21": "f10", "23": "f11", "24": "f12" };
const CSI_LETTER: Readonly<Record<string, string>> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4" };
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** Modifiers of a CSI parameter: 1 + shift(1) + alt(2) + ctrl(4). */
function modifiers(param: string | undefined) {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0, super: (m & 8) !== 0 };
}

function controlKey(c: string, alt: boolean): KeyEvent {
  const code = c.charCodeAt(0);
  if (c === "\r") return key("enter", { alt });
  if (c === "\t") return key("tab", { alt });
  if (c === "\u007f") return key("backspace", { alt });
  if (c === "\b") return key("backspace", { ctrl: true, alt });
  if (c === "\u001b") return key("escape", { alt });
  if (c === "\u0000") return key("space", { ctrl: true, alt });
  if (code >= 1 && code <= 26) return key(String.fromCharCode(code + 96), { ctrl: true, alt });
  if (code === 0x1c) return key("\\", { ctrl: true, alt });
  if (code === 0x1d) return key("]", { ctrl: true, alt });
  if (code === 0x1e) return key("^", { ctrl: true, alt });
  return key("_", { ctrl: true, alt });
}

/** Incremental parser: an escape sequence or a paste split across chunks is completed by the next chunk. */
export class KeyParser {
  #appearanceReports = false;
  enableAppearanceReports(enabled: boolean): void { if (!enabled && this.#appearanceReports && this.#buffer.startsWith("\u001b]11;")) this.#buffer = ""; this.#appearanceReports = enabled; }
  #buffer = "";
  #paste: string | undefined;

  /** Only a standalone Escape may time out in a consent dialog; never flush an unfinished paste. */
  get pendingEscape(): boolean { return this.#paste === undefined && this.#buffer === "\u001b"; }

  feed(data: string): InputEvent[] {
    const out: InputEvent[] = [];
    let s = this.#buffer + data;
    this.#buffer = "";
    let i = 0;
    while (i < s.length) {
      if (this.#paste !== undefined) {
        const end = s.indexOf(PASTE_END, i);
        if (end === -1) {
          // Keep a possible beginning of the end marker for the next chunk.
          const keep = Math.max(i, s.length - (PASTE_END.length - 1));
          this.#paste += s.slice(i, keep);
          this.#buffer = s.slice(keep);
          return out;
        }
        out.push({ kind: "paste", text: this.#paste + s.slice(i, end) });
        this.#paste = undefined;
        i = end + PASTE_END.length;
        continue;
      }
      const c = s[i]!;
      if (c === "\u001b") {
        if (s.startsWith(PASTE_START, i)) {
          this.#paste = "";
          i += PASTE_START.length;
          continue;
        }
        if (PASTE_START.startsWith(s.slice(i)) && s.length - i < PASTE_START.length && s.length - i > 1) {
          this.#buffer = s.slice(i);
          return out;
        }
        const parsed = this.#escape(s, i);
        if (parsed === "incomplete") {
          this.#buffer = s.slice(i);
          return out;
        }
        out.push(parsed.event);
        i = parsed.next;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        out.push(controlKey(c, false));
        i++;
        continue;
      }
      // Printable text: one event per code point (a grapheme spread over several events joins in the editor).
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push(key(ch.length === 1 ? ch.toLowerCase() : ch, { shift: ch !== ch.toLowerCase() }, ch));
      i += ch.length;
    }
    return out;
  }

  /** Pending bytes, such as a lone escape: flushed as keys when no continuation arrives. */
  flush(): InputEvent[] {
    if (this.#paste !== undefined) {
      const text = this.#paste + this.#buffer;
      this.#paste = undefined;
      this.#buffer = "";
      return [{ kind: "paste", text }];
    }
    const s = this.#buffer;
    this.#buffer = "";
    if (s === "") return [];
    if (s === "\u001b") return [key("escape")];
    return [key("escape"), ...this.feed(s.slice(1))];
  }

  #escape(s: string, i: number): { event: InputEvent; next: number } | "incomplete" {
    if (i + 1 >= s.length) return "incomplete";
    const n = s[i + 1]!;
    if (this.#appearanceReports && n === "]") {
      const remaining = s.slice(i), prefix = "\u001b]11;";
      if (prefix.startsWith(remaining)) return "incomplete";
      if (remaining.startsWith(prefix)) {
        const end = /\u0007|\u001b\\/.exec(remaining);
        if (!end) return remaining.length > 512 ? { event: key("unknown"), next: s.length } : "incomplete";
        const rgb = /^rgb:([a-f\d]{1,4})\/([a-f\d]{1,4})\/([a-f\d]{1,4})$/i.exec(remaining.slice(prefix.length, end.index));
        const next = i + end.index + end[0].length;
        if (!rgb) return { event: key("unknown"), next };
        const values = rgb.slice(1).map(component => parseInt(component, 16) / (16 ** component.length - 1));
        return { event: { kind: "appearance", light: values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722 > .5 }, next };
      }
    }
    if (n === "[") {
      let k = i + 2;
      while (k < s.length && !(s.charCodeAt(k) >= 0x40 && s.charCodeAt(k) <= 0x7e)) k++;
      if (k >= s.length) return "incomplete";
      const params = s.slice(i + 2, k);
      const final = s[k]!;
      const next = k + 1;
      if (params === "" && (final === "I" || final === "O")) return { event: { kind: "focus", focused: final === "I" }, next };
      const parts = params.split(";");
      if (final === "~") {
        const name = CSI_TILDE[parts[0]!];
        return { event: name ? key(name, modifiers(parts[1])) : key("unknown"), next };
      }
      if (final === "u") {
        // CSI u (code ; modifiers): keys the legacy encoding cannot tell apart, such as shift+enter.
        const code = Number(parts[0]);
        if(!Number.isInteger(code)||code<0||code>0x10ffff||code>=0xd800&&code<=0xdfff)return{event:key("unknown"),next};
        const [modifier,eventType]=parts[1]?.split(":")??[];
        if(eventType!==undefined&&!["1","2","3"].includes(eventType))return{event:key("unknown"),next};
        const mods = modifiers(modifier);
        const name = code===32&&mods.ctrl?"space":code === 13 ? "enter" : code === 9 ? "tab" : code === 27 ? "escape" : code === 127 ? "backspace" : String.fromCodePoint(code).toLowerCase();
        const printable = code >= 0x20 && code !== 127 && !mods.ctrl && !mods.alt && !mods.super;
        return { event: {...key(name, mods, printable ? String.fromCodePoint(code) : undefined),...(eventType?{phase:({"1":"press","2":"repeat","3":"release"} as const)[eventType as "1"|"2"|"3"]}:{})}, next };
      }
      if (final === "Z") return { event: key("tab", { shift: true }), next };
      const name = CSI_LETTER[final];
      return { event: name ? key(name, modifiers(parts[1])) : key("unknown"), next };
    }
    if (n === "O") {
      if (i + 2 >= s.length) return "incomplete";
      const name = CSI_LETTER[s[i + 2]!];
      return { event: name ? key(name) : key("unknown"), next: i + 3 };
    }
    // Alt + key: escape followed by a character.
    const code = n.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return { event: controlKey(n, true), next: i + 2 };
    const cp = s.codePointAt(i + 1)!;
    const ch = String.fromCodePoint(cp);
    return { event: key(ch.toLowerCase(), { alt: true, shift: ch !== ch.toLowerCase() }), next: i + 1 + ch.length };
  }
}

/** Canonical text of a combination, such as `ctrl+c`, `alt+enter`, `shift+tab`: the form of the key bindings. */
export function comboOf(k: KeyEvent): string {
  return `${k.ctrl ? "ctrl+" : ""}${k.alt ? "alt+" : ""}${k.super ? "super+" : ""}${k.shift && k.text === undefined ? "shift+" : ""}${k.name}`;
}
