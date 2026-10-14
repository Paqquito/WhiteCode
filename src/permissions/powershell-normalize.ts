// Supports: SPEC-PER-005 (fixed shell aliases and opaque commands), gap E-169.
/** Default aliases only: each tool invocation starts without a user profile. Arguments retain their spelling. */
const aliases: Readonly<Record<string, string>> = {
  gc: "get-content", cat: "get-content", type: "get-content", gci: "get-childitem", ls: "get-childitem", dir: "get-childitem",
  gl: "get-location", pwd: "get-location", gi: "get-item", sls: "select-string", select: "select-object", sort: "sort-object",
  ft: "format-table", fl: "format-list", gcm: "get-command", echo: "write-output", iex: "invoke-expression",
  ri: "remove-item", rm: "remove-item", del: "remove-item", erase: "remove-item", rd: "remove-item", rmdir: "remove-item",
};
export function normalizePowerShellPart(part: string): string {
  return part.trim().replace(/^([a-z][a-z0-9.-]*)(?=\s|$)/i, word => aliases[word.toLowerCase()] ?? word.toLowerCase());
}
/** Interpreter escapes, opaque encoded input and dynamic evaluation cannot use an automatic allow rule. */
export function opaquePowerShell(command: string): boolean {
  return /(?:^|[;|{}()]|&\s+)\s*(?:powershell|pwsh)(?:\.exe)?(?=\s|$)/i.test(command) || /(?:^|\s)-(?:e|ec|en[a-z]*)(?=\s|:|$)/i.test(command) || /(?:^|[;|{}()]|&\s+)\s*(?:iex|invoke-expression)(?=\s|$)/i.test(command);
}
