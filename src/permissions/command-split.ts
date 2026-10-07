// Implements: SPEC-PER-002 (§ 5.4 compound commands, CA-03), SPEC-OUT-008 (RG-02)
// Supports: decisions D-02 and E-008 (prudent splitting: an unrecognised construction is never covered by `allow`)

export type Dialect = "posix" | "powershell";

export interface SplitCommand {
  /** Top-level sub-commands, in order. */
  readonly parts: readonly string[];
  /** Commands found inside sub-shells, substitutions or blocks: they count for `deny` and `ask`, never for `allow`. */
  readonly nested: readonly string[];
  /** False when a construction was not recognised (substitution, sub-shell, here-document, file redirection…). */
  readonly complete: boolean;
}

const HARMLESS_TARGETS = new Set(["/dev/null", "$null", "nul", "NUL"]);

/** Splits a command line on `&&`, `||`, `;`, `|`, `&` and line breaks, outside quotes; see the fields of SplitCommand. */
export function splitCommand(command: string, dialect: Dialect): SplitCommand {
  const parts: string[] = [];
  const nested: string[] = [];
  let complete = true;
  let current = "";
  let i = 0;
  const n = command.length;
  const push = () => {
    const t = current.trim();
    if (t !== "") parts.push(t);
    current = "";
  };
  /** Reads a balanced group starting after `open`; returns its inner text and moves past the closing character. */
  const group = (open: string, close: string): string => {
    let depth = 1;
    let inner = "";
    while (i < n) {
      const c = command[i]!;
      if (c === "'" || c === '"') {
        const end = command.indexOf(c, i + 1);
        const stop = end === -1 ? n : end + 1;
        inner += command.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === open) depth++;
      if (c === close && --depth === 0) {
        i++;
        return inner;
      }
      inner += c;
      i++;
    }
    return inner;
  };
  const addNested = (inner: string) => {
    complete = false;
    const sub = splitCommand(inner, dialect);
    nested.push(...sub.parts, ...sub.nested);
  };
  const escape = dialect === "posix" ? "\\" : "`";

  while (i < n) {
    const c = command[i]!;
    const next = command[i + 1];
    // Escaped character outside quotes.
    if (c === escape && i + 1 < n) {
      current += c + next;
      i += 2;
      continue;
    }
    // Quotes.
    if (c === "'") {
      let end = command.indexOf("'", i + 1);
      if (dialect === "powershell") while (end !== -1 && command[end + 1] === "'") end = command.indexOf("'", end + 2);
      if (end === -1) {
        complete = false;
        current += command.slice(i);
        break;
      }
      current += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === escape) j++;
        else if (command[j] === "$" && command[j + 1] === "(") complete = false; // substitution inside a string
        else if (dialect === "posix" && command[j] === "`") complete = false;
        j++;
      }
      if (j >= n) complete = false;
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // Comments.
    if (c === "#" && (current === "" || /\s$/.test(current))) {
      const eol = command.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    // Substitutions, sub-shells and blocks: their content counts for deny, the whole is never covered by allow.
    if ((c === "$" || c === "@" || c === "<" || c === ">") && next === "(" && (c !== "@" || dialect === "powershell")) {
      i += 2;
      const inner = group("(", ")");
      current += `${c}(${inner})`;
      addNested(inner);
      continue;
    }
    if (c === "`" && dialect === "posix") {
      const end = command.indexOf("`", i + 1);
      const inner = command.slice(i + 1, end === -1 ? n : end);
      current += command.slice(i, end === -1 ? n : end + 1);
      i = end === -1 ? n : end + 1;
      addNested(inner);
      continue;
    }
    if (c === "(" || (c === "{" && (dialect === "powershell" || current.trim() === ""))) {
      i++;
      const close = c === "(" ? ")" : "}";
      const inner = group(c, close);
      current += `${c}${inner}${close}`;
      addNested(inner);
      continue;
    }
    // Here-documents: the rest is data, not commands.
    if (dialect === "posix" && c === "<" && next === "<") {
      complete = false;
      current += command.slice(i);
      break;
    }
    // Redirections to a file are not recognised (they write); descriptor duplication and null devices are.
    if (c === ">" || (c === "&" && next === ">")) {
      let j = i + (c === "&" ? 2 : 1);
      if (command[j] === ">") j++;
      if (command[j] === "&" && /\d/.test(command[j + 1] ?? "")) {
        current += command.slice(i, j + 2);
        i = j + 2;
        continue;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      const target = /^[^\s;&|]+/.exec(command.slice(j))?.[0] ?? "";
      if (!HARMLESS_TARGETS.has(target)) complete = false;
      current += command.slice(i, j + target.length);
      i = j + target.length;
      continue;
    }
    // Operators.
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      push();
      i += 2;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || (c === "&" && (dialect === "posix" || current.trim() !== ""))) {
      push();
      i += c === "|" && next === "&" ? 2 : 1;
      continue;
    }
    if (c === "&" && dialect === "powershell" && current.trim() === "") {
      // Call operator `& cmd`: kept as part of the command.
      current += c;
      i++;
      continue;
    }
    current += c;
    i++;
  }
  push();
  return { parts, nested, complete };
}
