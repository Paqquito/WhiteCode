// Implements: SPEC-CMD-001 (§ 5.1 recognition, § 5.2 steps 1 and 2) — the part needed to invoke prompt commands in a request
// An entry whose first non-blank character is a slash followed by a letter is a command; a doubled slash gives a literal one.

export type Recognized = { readonly kind: "text"; readonly text: string } | { readonly kind: "command"; readonly name: string; readonly args: string };

export function recognize(entry: string): Recognized {
  const lead = /^\s*/.exec(entry)![0].length;
  const rest = entry.slice(lead);
  // `//x`: a literal slash, never a command.
  if (rest.startsWith("//") && rest.length > 2 && !/\s/.test(rest[2]!)) return { kind: "text", text: entry.slice(0, lead) + rest.slice(1) };
  if (!/^\/[A-Za-z]/.test(rest)) return { kind: "text", text: entry };
  const space = rest.search(/\s/);
  const name = space === -1 ? rest.slice(1) : rest.slice(1, space);
  const args = space === -1 ? "" : rest.slice(space + 1).trim();
  return { kind: "command", name, args };
}
