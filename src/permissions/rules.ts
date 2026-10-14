// Implements: SPEC-PER-002 (§ 5.1 to 5.5, EF-01 to EF-03, EF-05, EF-06, ERR-01, ERR-02, RG-01, RG-02, CA-01 to CA-08)
// Supports: gap E-034 (anchor of `/path` rules)

import { isAbsolute, join, resolve as resolvePath } from "node:path";
import picomatch from "picomatch";
import type { Origin } from "../config/settings-schema";
import { comparablePath, realPathOrSelf, type PlatformName } from "../platform/system";
import type { RuleSubject } from "../tools/types";
import { splitCommand } from "./command-split";
import { normalizePowerShellPart } from "./powershell-normalize";

export type RuleDecision = "allow" | "ask" | "deny";
export type RuleScope = Exclude<Origin, "default"> | "session";

/** Tool names of SPEC-CAD-003 § 6: a rule naming another tool is ignored (ERR-01). */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file", "write_file", "edit_file", "update_notebook_cell", "find_files", "search_content", "run_shell",
  "run_powershell", "terminal_session", "run_code", "fetch_url", "search_web", "browse_web", "capture_terminal",
  "spawn_agent", "message_agent", "list_peers", "form_team", "disband_team", "work_item_create", "work_item_get",
  "work_item_update", "work_item_list", "background_output", "background_stop", "update_todo_list", "monitor_process",
  "wait", "start_planning", "submit_plan", "check_plan_progress", "open_isolated_copy", "close_isolated_copy",
  "list_connector_resources", "read_connector_resource", "connector_sign_in", "discover_tools", "schedule_create",
  "schedule_delete", "schedule_list", "start_remote_run", "request_user_choice", "message_user", "deliver_file",
  "notify_device", "use_skill", "discover_skills", "configure", "code_intelligence", "submit_result", "run_workflow",
  "prune_history", "inspect_context", "review_artifact", "subscribe_merge_request", "suggest_background_merge_request",
  "overflow_test", "permission_test", "consult_advisor",
]);

const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "update_notebook_cell", "find_files", "search_content", "code_intelligence"]);
const COMMAND_TOOLS = new Set(["run_shell", "run_powershell"]);
const URL_TOOLS = new Set(["fetch_url"]);
/** Tools whose rules designate an element by name, `*` standing for any run of characters (`use_skill(review-*)`). */
const NAME_TOOLS = new Set(["use_skill", "spawn_agent", "list_connector_resources", "read_connector_resource", "run_workflow"]);

/** `domain:<host>` with an optional subdomain wildcard: `*.example.com` covers every subdomain, not the bare domain (§ 5.2). */
export function domainMatches(pattern: string, url: string): boolean {
  if (!pattern.startsWith("domain:")) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const wanted = pattern.slice("domain:".length).trim().toLowerCase();
  if (wanted.startsWith("*.")) return host.endsWith(wanted.slice(1));
  return host === wanted;
}

export interface Rule {
  readonly raw: string;
  readonly decision: RuleDecision;
  readonly scope: RuleScope;
  readonly tool: string;
  readonly pattern?: string;
  /** Base folder of `/path` patterns (gap E-034). */
  readonly anchor: string;
}

export interface RuleIssue {
  readonly code: "ERR-01" | "ERR-02" | "ERR-03";
  readonly severity: "warning";
  readonly message: string;
}

export function parseRule(raw: string, decision: RuleDecision, scope: RuleScope, anchor: string): Rule | RuleIssue {
  const text = raw.trim();
  const open = text.indexOf("(");
  const name = open === -1 ? text : text.slice(0, open);
  if (open !== -1 && !text.endsWith(")")) return { code: "ERR-02", severity: "warning", message: `Règle mal formée : ${raw}.` };
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) return { code: "ERR-02", severity: "warning", message: `Règle mal formée : ${raw}.` };
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return { code: "ERR-02", severity: "warning", message: `Règle mal formée : ${raw}.` };
  if (!KNOWN_TOOL_NAMES.has(name) && !name.startsWith("cnx_")) return { code: "ERR-01", severity: "warning", message: `Règle ignorée : outil inconnu ${name}.` };
  const pattern = open === -1 ? undefined : text.slice(open + 1, -1).trim();
  if (pattern === "") return { code: "ERR-02", severity: "warning", message: `Règle mal formée : ${raw}.` };
  return { raw: text, decision, scope, tool: name, pattern, anchor };
}

export function isRule(value: Rule | RuleIssue): value is Rule {
  return (value as Rule).tool !== undefined;
}

/** Absolute glob for a path pattern, following § 5.3 anchoring and the Git exclusion-file semantics. */
export function pathGlob(pattern: string, anchor: string, cwd: string, home: string): string {
  let base: string;
  let rest: string;
  if (pattern.startsWith("//")) {
    base = "/";
    rest = pattern.slice(2);
    if (/^[A-Za-z]:/.test(rest)) return rest; // Windows drive: `//C:/x/**`
  } else if (pattern.startsWith("~/")) {
    base = home;
    rest = pattern.slice(2);
  } else if (pattern.startsWith("/")) {
    base = anchor;
    rest = pattern.slice(1);
  } else {
    base = cwd;
    rest = pattern;
  }
  const trimmed = rest.replace(/\/+$/, "");
  // Without an inner slash, the pattern matches at any depth below its base.
  const glob = trimmed.includes("/") ? trimmed : `**/${trimmed}`;
  return base === "/" ? `/${glob}` : `${base.replace(/[\\/]+$/, "")}/${glob}`;
}

function pathMatches(rule: Rule, path: string, cwd: string, home: string, platform: PlatformName): boolean {
  if (rule.pattern === undefined) return true;
  const glob = comparablePath(pathGlob(rule.pattern, rule.anchor, cwd, home), platform);
  const matcher = picomatch(glob, { dot: true, nocase: platform === "windows" || platform === "macos" });
  // A pattern designating a folder also covers its content (Git exclusion semantics).
  let current = comparablePath(isAbsolute(path) ? path : resolvePath(cwd, path), platform);
  for (;;) {
    if (matcher(current)) return true;
    const cut = current.lastIndexOf("/");
    if (cut <= 0) return false;
    current = current.slice(0, cut);
  }
}

/** Command-prefix match on whole words: `git log *` covers `git log --oneline`, not `git logout` (EF-03). */
export function commandMatches(pattern: string, command: string): boolean {
  const normalized = command.trim().replace(/^(\w+=\S*\s+)+/, ""); // leading assignments are ignored
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2).trim();
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === pattern.trim();
}

export interface MatchContext {
  readonly cwd: string;
  readonly home: string;
  readonly platform: PlatformName;
}

/**
 * True when the rule covers the call. For paths, both the requested and the real path are checked (EF-05):
 * `allow` requires both to match, `deny` and `ask` apply when either matches.
 */
export function ruleMatches(rule: Rule, toolName: string, subject: RuleSubject, ctx: MatchContext): boolean {
  if (rule.tool !== toolName && !(rule.tool.startsWith("cnx_") && toolName.startsWith(`${rule.tool}_`))) return false;
  if (rule.pattern === undefined) return true;
  if (PATH_TOOLS.has(rule.tool) && subject.kind === "paths") {
    const each = (p: string) => {
      const requested = pathMatches(rule, p, ctx.cwd, ctx.home, ctx.platform);
      const real = pathMatches(rule, realPathOrSelf(isAbsolute(p) ? p : join(ctx.cwd, p)), ctx.cwd, ctx.home, ctx.platform);
      return rule.decision === "allow" ? requested && real : requested || real;
    };
    return rule.decision === "allow" ? subject.paths.every(each) : subject.paths.some(each);
  }
  if (COMMAND_TOOLS.has(rule.tool) && subject.kind === "command") {
    // § 5.4: `allow` covers a compound command only if every sub-command is covered and every construction recognised;
    // `deny` and `ask` apply as soon as one sub-command, even nested, is covered (decision D-02, gap E-008).
    const split = splitCommand(subject.command, rule.tool === "run_powershell" ? "powershell" : "posix");
    const normalize = rule.tool === "run_powershell" ? normalizePowerShellPart : (part: string) => part;
    const pattern = normalize(rule.pattern);
    if (rule.decision === "allow") return split.complete && split.parts.length > 0 && split.parts.every((p) => commandMatches(pattern, normalize(p)));
    return [...split.parts, ...split.nested].some((p) => commandMatches(pattern, normalize(p)));
  }
  if (URL_TOOLS.has(rule.tool) && subject.kind === "url") return domainMatches(rule.pattern, subject.url);
  if (NAME_TOOLS.has(rule.tool) && subject.kind === "name") {
    const pattern = rule.pattern;
    return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(subject.name);
  }
  return false;
}

/** Narrowest reasonable rule suggestion (EF-06). */
export function suggestRule(toolName: string, subject: RuleSubject, platform: PlatformName): string {
  if (subject.kind === "paths" && subject.paths[0]) {
    const p = comparablePath(subject.paths[0], "linux");
    const dir = p.slice(0, Math.max(p.lastIndexOf("/"), 1));
    const abs = platform === "windows" ? dir : dir.replace(/^\//, "");
    return `${toolName}(//${abs}/**)`;
  }
  if (subject.kind === "name") return `${toolName}(${subject.name})`;
  if (subject.kind === "command") {
    const words = subject.command.trim().split(/\s+/).slice(0, 2);
    return `${toolName}(${words.join(" ")} *)`;
  }
  return toolName;
}
