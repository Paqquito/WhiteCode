// Implements: SPEC-PER-012 (§ 5.1, § 5.3, FA-01, EF-01, EF-02, RG-01, CA-01), SPEC-PER-009 (§ 5.1: broad `allow` rules
// on interpreters are pointed out)
// Supports: SPEC-CMD-047 (step 2, CA-01, CA-02), gap E-115

import picomatch from "picomatch";
import { pathGlob, type Rule, type RuleDecision } from "./rules";

const COMMAND_TOOLS = new Set(["run_shell", "run_powershell"]);
const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "update_notebook_cell", "find_files", "search_content"]);
const NAME_TOOLS = new Set(["use_skill", "spawn_agent"]);

/** The decision that wins over another one, whatever the scope (SPEC-PER-001: deny, then ask, then allow). */
const RANK: Record<RuleDecision, number> = { deny: 3, ask: 2, allow: 1 };

/**
 * EF-02: true only when every call covered by `masked` is certainly covered by `masker`. A pattern that cannot be
 * analysed for coverage gives false (edge case of § 8: ignored).
 */
export function covers(masker: Rule, masked: Rule): boolean {
  const sameTool = masker.tool === masked.tool || (masker.tool.startsWith("cnx_") && masked.tool.startsWith(`${masker.tool}_`));
  if (!sameTool) return false;
  if (masker.pattern === undefined) return true;
  if (masked.pattern === undefined || masker.tool !== masked.tool) return false;
  const [a, b] = [masker.pattern.trim(), masked.pattern.trim()];
  if (a === b && (!PATH_TOOLS.has(masker.tool) || masker.anchor === masked.anchor)) return true;
  if (COMMAND_TOOLS.has(masker.tool)) {
    if (!a.endsWith(" *")) return false;
    const prefix = a.slice(0, -2).trim();
    const inner = b.endsWith(" *") ? b.slice(0, -2).trim() : b;
    return inner === prefix || inner.startsWith(`${prefix} `);
  }
  if (masker.tool === "fetch_url") {
    if (!a.startsWith("domain:*.") || !b.startsWith("domain:")) return false;
    const suffix = a.slice("domain:*".length).toLowerCase();
    const host = b.slice("domain:".length).replace(/^\*\./, "").toLowerCase();
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (NAME_TOOLS.has(masker.tool)) {
    // A joker of the masked pattern is covered by a joker of the masker, which matches any run of characters.
    return new RegExp(`^${a.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(b);
  }
  if (PATH_TOOLS.has(masker.tool)) {
    // Only a literal masked path with an inner slash (one place, not any depth), under the same anchor, is compared
    // with the glob of the masker.
    if (/[*?[\]{}!]/.test(b) || !b.replace(/\/+$/, "").includes("/") || masker.anchor !== masked.anchor) return false;
    const [anchor, cwd, home] = ["/__anchor__", "/__cwd__", "/__home__"];
    return picomatch(pathGlob(a, anchor, cwd, home), { dot: true })(pathGlob(b, anchor, cwd, home));
  }
  return false;
}

export interface Masking {
  readonly masked: Rule;
  readonly by: Rule;
}

/** § 5.3 step 1: every rule hidden by a rule of a stronger decision whose pattern covers it entirely. */
export function maskedRules(rules: readonly Rule[]): Masking[] {
  const out: Masking[] = [];
  for (const masked of rules) {
    const by = rules.find((r) => r !== masked && RANK[r.decision] > RANK[masked.decision] && covers(r, masked));
    if (by) out.push({ masked, by });
  }
  return out;
}

const SCOPE_NAMES: Record<string, string> = { managed: "gérée", cli: "ligne de commande", env: "environnement", local: "locale", project: "projet partagé", user: "utilisateur", session: "session" };
export const scopeName = (scope: string) => SCOPE_NAMES[scope] ?? scope;

/** Step 2: the report of one masking, with the advice; FA-01 when the masking rule is managed. */
export function describeMasking(m: Masking, sourceOf: (r: Rule) => string): string {
  const side = (r: Rule) => `${r.decision} ${r.raw} (portée ${scopeName(r.scope)}, ${sourceOf(r)})`;
  const advice =
    m.by.scope === "managed"
      ? "la règle masquante est gérée par l'organisation et ne peut pas être modifiée localement : retirez la règle inutile."
      : "retirez la règle inutile, ou restreignez la règle masquante si elle vous est propre.";
  return `Règle masquée : ${side(m.masked)}, masquée par ${side(m.by)}. Conseil : ${advice}`;
}

/** Interpreters and launchers that run any code they are given: an `allow` rule covering all their uses is broad. */
const INTERPRETERS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "python", "python3", "py", "node", "bun", "deno",
  "ruby", "perl", "php", "lua", "osascript", "npx", "bunx", "env", "sudo", "eval", "exec", "xargs", "invoke-expression", "iex",
]);

/** SPEC-PER-009 § 5.1, SPEC-CMD-047 CA-02: why an `allow` rule is broad, or undefined. */
export function broadAllowWarning(rule: Rule): string | undefined {
  if (rule.decision !== "allow" || !COMMAND_TOOLS.has(rule.tool)) return undefined;
  if (rule.pattern === undefined || rule.pattern.trim() === "*") return `la règle ${rule.raw} autorise toutes les commandes sans confirmation.`;
  const first = rule.pattern.trim().split(/\s+/)[0]!.toLowerCase().replace(/\.exe$/, "");
  const rest = rule.pattern.trim().slice(first.length).trim();
  if (INTERPRETERS.has(first) && (rest === "" || rest === "*" || rest === "-c *" || rest === "-e *")) {
    return `la règle ${rule.raw} couvre un interpréteur générique (${first}) : elle autorise l'exécution de n'importe quel code.`;
  }
  return undefined;
}
