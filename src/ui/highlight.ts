// Implements: SPEC-IHM-004 (§ 5.1 language detection, § 5.2 categories, § 5.3 steps 1 to 5, FA-01 to FA-05, EF-01 to EF-07, ERR-01 to ERR-03, RG-01 to RG-03, ENF-02, CA-01 to CA-06)
// Lexical colouring of code: the language is found from the mark of the block, the extension of the file, the first line
// or the content; a lexer per family of languages produces categorised tokens; the theme gives each category a style.
// The text is never changed (RG-01); the analysis is bounded in size and in time and falls back on the raw text.

import { createHash } from "node:crypto";
import type { Style } from "./style";
import type { Span } from "./text";

export type TokenCategory =
  | "keyword" | "type" | "identifier" | "function" | "string" | "escape" | "number" | "comment" | "doc"
  | "operator" | "punctuation" | "annotation" | "preprocessor" | "constant" | "inserted" | "deleted" | "plain";

/** Styles of the categories; every colour comes from the theme (EF-04). */
export interface CodeTheme {
  readonly id: string;
  readonly styles: Readonly<Partial<Record<TokenCategory, Style>>>;
}

export const DEFAULT_CODE_THEME: CodeTheme = {
  id: "default",
  styles: {
    keyword: { fg: { ansi: 5 } },
    type: { fg: { ansi: 6 } },
    function: { fg: { ansi: 4 } },
    string: { fg: { ansi: 2 } },
    escape: { fg: { ansi: 3 } },
    number: { fg: { ansi: 3 } },
    comment: { fg: { ansi: 8 }, italic: true },
    doc: { fg: { ansi: 8 }, italic: true },
    annotation: { fg: { ansi: 3 } },
    preprocessor: { fg: { ansi: 5 } },
    constant: { fg: { ansi: 3 } },
    inserted: { fg: { ansi: 2 } },
    deleted: { fg: { ansi: 1 } },
  },
};

interface StringRule {
  readonly open: string;
  readonly close: string;
  readonly escape?: boolean;
  readonly multiline?: boolean;
}

interface LanguageDef {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly extensions: readonly string[];
  readonly lineComments?: readonly string[];
  readonly blockComments?: ReadonlyArray<readonly [string, string]>;
  readonly strings?: readonly StringRule[];
  readonly keywords?: readonly string[];
  readonly types?: readonly string[];
  readonly constants?: readonly string[];
  readonly annotations?: boolean;
  readonly preprocessor?: boolean;
  readonly caseInsensitive?: boolean;
  /** `$name` and `${…}` variables of the shells. */
  readonly variables?: boolean;
  /** Diff: categories by line mark. */
  readonly lineBased?: "diff";
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const C_STRINGS: StringRule[] = [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }];
const JS_KEYWORDS = words("break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set as satisfies implements interface enum declare namespace type readonly private protected public abstract keyof infer is");

const LANGUAGES: readonly LanguageDef[] = [
  {
    name: "typescript", aliases: ["ts", "tsx", "typescript", "javascript", "js", "jsx", "mjs", "cjs"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    lineComments: ["//"], blockComments: [["/*", "*/"]], strings: [...C_STRINGS, { open: "`", close: "`", escape: true, multiline: true }],
    keywords: JS_KEYWORDS, types: words("string number boolean bigint symbol object any unknown never void undefined Array Promise Record Map Set ReadonlyArray Readonly Partial"), constants: words("true false null undefined NaN Infinity"), annotations: true,
  },
  { name: "json", aliases: ["json", "jsonc", "json5"], extensions: [".json", ".jsonc", ".json5"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: [{ open: '"', close: '"', escape: true }], constants: words("true false null") },
  {
    name: "python", aliases: ["python", "py", "python3"], extensions: [".py", ".pyi"], lineComments: ["#"],
    strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: "'''", close: "'''", escape: true, multiline: true }, ...C_STRINGS],
    keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    types: words("int float str bool list dict set tuple bytes object type None"), constants: words("True False None"), annotations: true,
  },
  {
    name: "shell", aliases: ["sh", "bash", "zsh", "shell", "console", "shellscript"], extensions: [".sh", ".bash", ".zsh"], lineComments: ["#"],
    strings: [{ open: '"', close: '"', escape: true, multiline: true }, { open: "'", close: "'", multiline: true }],
    keywords: words("if then else elif fi for while until do done case esac function in return local export readonly declare set unset shift exit break continue source"), variables: true,
  },
  {
    name: "powershell", aliases: ["powershell", "ps1", "pwsh", "ps"], extensions: [".ps1", ".psm1", ".psd1"], lineComments: ["#"], blockComments: [["<#", "#>"]],
    strings: [{ open: '"', close: '"', escape: true, multiline: true }, { open: "'", close: "'", multiline: true }],
    keywords: words("if else elseif switch foreach for while do until function param begin process end return break continue try catch finally throw trap filter in"), variables: true, caseInsensitive: true, constants: words("$true $false $null"),
  },
  { name: "go", aliases: ["go", "golang"], extensions: [".go"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: [...C_STRINGS, { open: "`", close: "`", multiline: true }], keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"), types: words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any"), constants: words("true false nil iota") },
  { name: "rust", aliases: ["rust", "rs"], extensions: [".rs"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: [{ open: '"', close: '"', escape: true, multiline: true }], keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"), types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box"), constants: words("true false None Some Ok Err"), annotations: true },
  { name: "java", aliases: ["java", "kotlin", "kt", "scala"], extensions: [".java", ".kt", ".kts", ".scala"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: [{ open: '"""', close: '"""', multiline: true }, ...C_STRINGS], keywords: words("abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static super switch synchronized this throw throws transient try volatile while var val fun when object override"), types: words("int long short byte char float double boolean void String Object List Map"), constants: words("true false null"), annotations: true },
  { name: "c", aliases: ["c", "cpp", "c++", "h", "hpp", "cc", "objc"], extensions: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: C_STRINGS, keywords: words("auto break case catch class const constexpr continue default delete do else enum explicit extern for friend goto if inline namespace new noexcept operator private protected public return sizeof static struct switch template this throw try typedef typename union using virtual volatile while"), types: words("int long short char float double bool void unsigned signed size_t auto std string vector"), constants: words("true false NULL nullptr"), preprocessor: true },
  { name: "csharp", aliases: ["csharp", "cs", "c#"], extensions: [".cs"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: [{ open: '@"', close: '"', multiline: true }, ...C_STRINGS], keywords: words("abstract as async await base break case catch class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof static struct switch this throw try typeof unsafe using var virtual void volatile while record"), types: words("int long short byte char float double decimal bool string object dynamic"), constants: words("true false null"), preprocessor: true },
  { name: "ruby", aliases: ["ruby", "rb"], extensions: [".rb"], lineComments: ["#"], strings: C_STRINGS, keywords: words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require"), constants: words("true false nil") },
  { name: "php", aliases: ["php"], extensions: [".php"], lineComments: ["//", "#"], blockComments: [["/*", "*/"]], strings: C_STRINGS, keywords: words("abstract and array as break case catch class clone const continue declare default do echo else elseif empty endif extends final finally fn for foreach function global if implements include instanceof interface isset list namespace new or print private protected public require return static switch throw trait try unset use var while yield"), constants: words("true false null"), variables: true },
  { name: "yaml", aliases: ["yaml", "yml"], extensions: [".yaml", ".yml"], lineComments: ["#"], strings: C_STRINGS, constants: words("true false null yes no on off") },
  { name: "toml", aliases: ["toml", "ini"], extensions: [".toml", ".ini", ".cfg"], lineComments: ["#", ";"], strings: [{ open: '"""', close: '"""', multiline: true }, ...C_STRINGS], constants: words("true false") },
  { name: "sql", aliases: ["sql"], extensions: [".sql"], lineComments: ["--"], blockComments: [["/*", "*/"]], strings: [{ open: "'", close: "'" }], caseInsensitive: true, keywords: words("select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all case when then else end primary key foreign references null is in like between exists with returning"), types: words("int integer bigint smallint varchar char text boolean date timestamp numeric decimal real float serial") },
  { name: "html", aliases: ["html", "xml", "svg", "vue"], extensions: [".html", ".htm", ".xml", ".svg", ".vue"], blockComments: [["<!--", "-->"]], strings: C_STRINGS },
  { name: "css", aliases: ["css", "scss", "less"], extensions: [".css", ".scss", ".less"], lineComments: ["//"], blockComments: [["/*", "*/"]], strings: C_STRINGS, annotations: true },
  { name: "diff", aliases: ["diff", "patch"], extensions: [".diff", ".patch"], lineBased: "diff" },
];

const BY_ALIAS = new Map<string, LanguageDef>();
const BY_EXTENSION = new Map<string, LanguageDef>();
for (const l of LANGUAGES) {
  for (const a of l.aliases) BY_ALIAS.set(a, l);
  for (const e of l.extensions) BY_EXTENSION.set(e, l);
}

/**
 * § 5.1: the mark of the block, then the extension of the file, then an interpreter on the first line, then a
 * recognition of the content; otherwise no colouring. `extra` maps extensions to languages (`ui.syntaxHighlighting.extraLanguages`).
 */
export function detectLanguage(o: { readonly mark?: string; readonly path?: string; readonly content: string; readonly extra?: Readonly<Record<string, string>> }): string | undefined {
  const mark = o.mark?.trim().toLowerCase().split(/[\s{]/)[0];
  if (mark && BY_ALIAS.has(mark)) return BY_ALIAS.get(mark)!.name;
  if (o.path) {
    const dot = o.path.lastIndexOf(".");
    const ext = dot >= 0 ? o.path.slice(dot).toLowerCase() : "";
    const extra = o.extra?.[ext] ?? o.extra?.[ext.slice(1)];
    if (extra && BY_ALIAS.has(extra.toLowerCase())) return BY_ALIAS.get(extra.toLowerCase())!.name;
    if (BY_EXTENSION.has(ext)) return BY_EXTENSION.get(ext)!.name;
  }
  if (mark) return undefined; // FA-01: an announced language that is unknown
  const first = o.content.split("\n", 1)[0] ?? "";
  const shebang = /^#!.*\b(python3?|node|bun|deno|bash|sh|zsh|pwsh|ruby|php)\b/.exec(first);
  if (shebang) return BY_ALIAS.get({ node: "js", bun: "ts", deno: "ts", pwsh: "powershell" }[shebang[1]!] ?? shebang[1]!.replace(/3$/, ""))?.name;
  const t = o.content.trimStart();
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(o.content);
      return "json";
    } catch {
      // not JSON
    }
  }
  if (/^<\?php/.test(t)) return "php";
  if (/^(diff --git|--- \S|@@ )/m.test(t) && /^[+-]/m.test(t)) return "diff";
  if (/^<(!doctype|html|\?xml)/i.test(t)) return "html";
  if (/^(import |export |const |let |function |interface )/m.test(t) && /[;{}]/.test(t)) return "typescript";
  if (/^def \w+\(.*\):\s*$/m.test(t)) return "python";
  return undefined;
}

export function knownLanguage(name: string): boolean {
  return BY_ALIAS.has(name.toLowerCase());
}

interface Token {
  readonly text: string;
  readonly category: TokenCategory;
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/;
const IDENT = /^[A-Za-z_$][\w$]*/;
const OPERATOR = /^[+\-*/%=<>!&|^~?:]+/;
const PUNCTUATION = /^[()[\]{};,.]/;

/** § 5.3 step 3: the tokens of a text, tolerant of an incomplete text (FA-03); stopped at `deadline` (FA-02). */
function tokenize(text: string, lang: LanguageDef, deadline: number): { tokens: Token[]; complete: boolean } {
  const tokens: Token[] = [];
  if (lang.lineBased === "diff") {
    for (const line of text.split(/(?<=\n)/)) {
      const category: TokenCategory = line.startsWith("+++") || line.startsWith("---") ? "keyword" : line.startsWith("+") ? "inserted" : line.startsWith("-") ? "deleted" : line.startsWith("@@") ? "annotation" : "plain";
      tokens.push({ text: line, category });
    }
    return { tokens, complete: true };
  }
  const keywords = new Set((lang.keywords ?? []).map((k) => (lang.caseInsensitive ? k.toLowerCase() : k)));
  const types = new Set((lang.types ?? []).map((k) => (lang.caseInsensitive ? k.toLowerCase() : k)));
  const constants = new Set((lang.constants ?? []).map((k) => (lang.caseInsensitive ? k.toLowerCase() : k)));
  let i = 0;
  let lineStart = true;
  let count = 0;
  const push = (t: string, category: TokenCategory) => {
    tokens.push({ text: t, category });
    i += t.length;
  };
  while (i < text.length) {
    if (++count % 256 === 0 && Date.now() > deadline) {
      tokens.push({ text: text.slice(i), category: "plain" }); // ERR-02: the rest stays raw
      return { tokens, complete: false };
    }
    const rest = text.slice(i, i + 4096);
    const c = text[i]!;
    if (c === "\n") {
      push("\n", "plain");
      lineStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push(/^[ \t\r]+/.exec(rest)![0], "plain");
      continue;
    }
    const startOfLine = lineStart;
    lineStart = false;
    if (lang.preprocessor && startOfLine && c === "#") {
      const end = text.indexOf("\n", i);
      push(text.slice(i, end === -1 ? text.length : end), "preprocessor");
      continue;
    }
    const block = lang.blockComments?.find(([open]) => text.startsWith(open, i));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? text.length : end + block[1].length;
      push(text.slice(i, stop), text.startsWith("/**", i) ? "doc" : "comment");
      continue;
    }
    const line = lang.lineComments?.find((m) => text.startsWith(m, i));
    if (line) {
      const end = text.indexOf("\n", i);
      push(text.slice(i, end === -1 ? text.length : end), "comment");
      continue;
    }
    const str = lang.strings?.find((s) => text.startsWith(s.open, i));
    if (str) {
      let j = i + str.open.length;
      let segment = i;
      const parts: Token[] = [];
      while (j < text.length) {
        if (str.escape && text[j] === "\\" && j + 1 < text.length) {
          if (j > segment) parts.push({ text: text.slice(segment, j), category: "string" });
          parts.push({ text: text.slice(j, j + 2), category: "escape" });
          j += 2;
          segment = j;
          continue;
        }
        if (text.startsWith(str.close, j)) {
          j += str.close.length;
          break;
        }
        if (text[j] === "\n" && !str.multiline) break; // FA-03: an unterminated string ends with its line
        j++;
      }
      if (j > segment) parts.push({ text: text.slice(segment, j), category: "string" });
      for (const p of parts) push(p.text, p.category);
      continue;
    }
    if (lang.variables && c === "$") {
      const v = /^\$(?:\{[^}\n]*\}?|[A-Za-z_][\w:]*|[0-9@#?*!$-])/.exec(rest);
      if (v) {
        push(v[0], constants.has(v[0].toLowerCase()) ? "constant" : "type");
        continue;
      }
    }
    if (lang.annotations && c === "@") {
      const a = /^@[A-Za-z_][\w.]*/.exec(rest);
      if (a) {
        push(a[0], "annotation");
        continue;
      }
    }
    const num = NUMBER.exec(rest);
    if (num && !/[A-Za-z_$]/.test(text[i - 1] ?? "")) {
      push(num[0], "number");
      continue;
    }
    const id = IDENT.exec(rest);
    if (id) {
      const key = lang.caseInsensitive ? id[0].toLowerCase() : id[0];
      const next = text.slice(i + id[0].length).match(/^\s*\(/);
      push(id[0], keywords.has(key) ? "keyword" : constants.has(key) ? "constant" : types.has(key) ? "type" : next ? "function" : "identifier");
      continue;
    }
    const op = OPERATOR.exec(rest);
    if (op) {
      push(op[0], "operator");
      continue;
    }
    if (PUNCTUATION.test(c)) {
      push(c, "punctuation");
      continue;
    }
    // Any other character, or a surrogate pair, as plain text.
    push(String.fromCodePoint(text.codePointAt(i)!), "plain");
  }
  return { tokens, complete: true };
}

export interface HighlightOptions {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly theme: CodeTheme;
}

const CACHE_LIMIT = 200;
const cache = new Map<string, Span[]>();

/**
 * The code as styled spans (§ 5.3). Disabled colouring, an unknown language, a block beyond the maximal size or a
 * failing lexer give the raw text (EF-02, EF-05, ERR-01, ERR-03); the result is cached by content, language and theme
 * (step 5, RG-03, ENF-02).
 */
export function highlight(code: string, language: string | undefined, o: HighlightOptions): Span[] {
  const lang = language ? BY_ALIAS.get(language.toLowerCase()) : undefined;
  if (!o.enabled || !lang || Buffer.byteLength(code, "utf8") > o.maxBytes) return [{ text: code }];
  // The cache is keyed by a fingerprint of the content, so that it does not hold the texts twice.
  const key = `${o.theme.id}\u0000${lang.name}\u0000${createHash("sha256").update(code).digest("base64")}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let spans: Span[];
  try {
    const { tokens } = tokenize(code, lang, Date.now() + o.timeoutMs);
    spans = tokens.map((t) => ({ text: t.text, style: o.theme.styles[t.category] }));
  } catch {
    return [{ text: code }];
  }
  if (spans.map((s) => s.text).join("") !== code) return [{ text: code }]; // RG-01: never a changed text
  cache.set(key, spans);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return spans;
}
