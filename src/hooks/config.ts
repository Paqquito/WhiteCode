// Implements: SPEC-HOK-002 (§ 5.1 format, § 5.2 sources and merging, § 5.4 steps 1 to 3, EF-01, EF-02, EF-04, EF-05 for optional declarations, ERR-01, ERR-02, CA-04, CA-05, CA-07),
//             SPEC-HOK-012 (§ 5.1, § 5.3 steps 1 and 2, FA-01, EF-01 to EF-03, RG-01), SPEC-HOK-004 (§ 5.1 fields of an `http` action)
// Snapshot of the hooks of a session: declarations of every scope kept apart, filtered by the administrator controls.

import { createHash } from "node:crypto";
import { parseDuration } from "../config/units";
import { suggest } from "../shared/suggest";
import { HOOK_EVENTS } from "./events";

export type HookScope = "managed" | "cli" | "local" | "project" | "user";

export interface CommandAction {
  readonly type: "command";
  readonly command: string;
  readonly timeoutMs?: number;
  readonly shell?: string;
}

export interface HttpAction {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type HookAction = CommandAction | HttpAction;

export interface HookDeclaration {
  readonly event: string;
  /** Raw filter, as written. */
  readonly match?: string;
  readonly matches: (value: string | undefined) => boolean;
  readonly actions: readonly HookAction[];
  readonly id?: string;
  /** Managed control hook (SPEC-HOK-012 EF-04): its failure refuses the action it frames. */
  readonly mandatory: boolean;
  readonly async?: boolean;
  readonly scope: HookScope;
  /** Settings file (or option) that declares the hook. */
  readonly file: string;
  /** Digest of the declaration as written: any change of it gives another fingerprint (SPEC-PER-001 § 5.3 point c). */
  readonly fingerprint: string;
  /** Display name: `<scope>/<event>/<id or position>` (EF-03). */
  readonly label: string;
}

export interface HookSnapshot {
  readonly declarations: readonly HookDeclaration[];
  /** Declarations left aside and why (SPEC-HOK-012 EF-03). */
  readonly ignored: readonly { readonly label: string; readonly reason: string }[];
  readonly warnings: readonly string[];
  /** `approval_needed` hooks habilitated to answer a request (SPEC-PER-001 § 5.3 point c). */
  readonly habilitated?: ReadonlySet<HookDeclaration>;
}

export interface SnapshotControls {
  /** `hooksConfig.disabled` with the scope it comes from. */
  readonly disabled?: { readonly value: boolean; readonly origin: string };
  /** `hooksConfig.managedOnly` (managed scope only; the settings reject it elsewhere, ERR-01). */
  readonly managedOnly: boolean;
  /** `--no-hooks` (FA-01). */
  readonly noHooks: boolean;
  /** Upper bound of the time limit of one action (SPEC-HOK-003 § 6: at most 10 min). */
  readonly maxTimeoutMs: number;
}

const TYPES_LATER = new Set(["prompt", "agent"]);
const SCOPE_ORDER: readonly HookScope[] = ["managed", "cli", "local", "project", "user"];

/** `match`: exact names, alternatives `a|b`, joker `*` (SPEC-HOK-002 § 5.1); undefined when invalid (EF-05). */
export function compileMatch(match: string | undefined): ((value: string | undefined) => boolean) | undefined {
  if (match === undefined || match === "") return () => true;
  const alternatives = match.split("|").map((a) => a.trim());
  if (alternatives.some((a) => !/^[A-Za-z0-9_.*-]+$/.test(a))) return undefined;
  const res = alternatives.map((a) => new RegExp(`^${a.replace(/[.\-]/g, (c) => `\\${c}`).replace(/\*/g, ".*")}$`));
  return (value) => value !== undefined && res.some((r) => r.test(value));
}

/** JSON with sorted keys, so that the fingerprint does not depend on the order of the keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function fingerprintOf(event: string, declaration: unknown): string {
  return `sha256:${createHash("sha256").update(canonical({ event, declaration })).digest("hex")}`;
}

/** An `http` action (SPEC-HOK-004 § 5.1): `https`, or `http` to the local host only; checked again before each request. */
function httpAction(a: Record<string, unknown>, label: string, warnings: string[], maxTimeoutMs: number): HttpAction | undefined {
  let url: URL;
  try {
    url = new URL(String(a["url"]));
  } catch {
    warnings.push(`Crochet ${label} : URL invalide ; action ignorée.`);
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    warnings.push(`Crochet ${label} : schéma ${url.protocol} non admis (https, ou http vers l'hôte local) ; action ignorée.`);
    return undefined;
  }
  const headers: Record<string, string> = {};
  const raw = a["headers"];
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== "string"))) warnings.push(`Crochet ${label} : en-têtes invalides (texte attendu) ; ignorés.`);
  else if (raw) Object.assign(headers, raw);
  const timeout = a["timeout"];
  const timeoutMs = timeout === undefined ? undefined : parseDuration(timeout);
  if (timeout !== undefined && timeoutMs === undefined) warnings.push(`Crochet ${label} : délai invalide ; délai par défaut appliqué.`);
  return { type: "http", url: url.href, headers: Object.keys(headers).length > 0 ? headers : undefined, timeoutMs: timeoutMs === undefined ? undefined : Math.min(timeoutMs, maxTimeoutMs) };
}

/** Steps 1 and 2: declarations of each scope, validated, then filtered by the controls of SPEC-HOK-012. */
export function buildSnapshot(byScope: ReadonlyArray<{ readonly origin: string; readonly value: unknown; readonly file?: string }>, controls: SnapshotControls): HookSnapshot {
  const declarations: HookDeclaration[] = [];
  const ignored: Array<{ label: string; reason: string }> = [];
  const warnings: string[] = [];
  const sources = [...byScope].filter((s) => SCOPE_ORDER.includes(s.origin as HookScope)).sort((a, b) => SCOPE_ORDER.indexOf(a.origin as HookScope) - SCOPE_ORDER.indexOf(b.origin as HookScope));
  for (const { origin, value, file } of sources) {
    const scope = origin as HookScope;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const seen = new Set<string>();
    for (const [event, list] of Object.entries(value as Record<string, unknown>)) {
      if (!(event in HOOK_EVENTS)) {
        const near = suggest(event, Object.keys(HOOK_EVENTS), 3);
        warnings.push(`Événement de crochet inconnu : ${event} (portée ${scope}).${near.length > 0 ? ` Vouliez-vous dire : ${near.join(", ")} ?` : ""}`); // ERR-01
        continue;
      }
      if (!Array.isArray(list)) continue;
      list.forEach((raw, i) => {
        const d = (raw ?? {}) as Record<string, unknown>;
        const id = typeof d["id"] === "string" ? d["id"] : undefined;
        const label = `${scope}/${event}/${id ?? `#${i + 1}`}`;
        let mandatory = d["mandatory"] === true;
        if (mandatory && scope !== "managed") {
          warnings.push(`Crochet ${label} : « mandatory » n'est admis qu'en portée gérée ; il est ignoré.`);
          mandatory = false;
        }
        if ((mandatory || event === "approval_needed") && id === undefined) {
          ignored.push({ label, reason: "identifiant obligatoire absent" });
          return;
        }
        const match = typeof d["match"] === "string" ? d["match"] : undefined;
        const matches = compileMatch(match);
        if (!matches) {
          ignored.push({ label, reason: `filtre invalide : ${match}` }); // EF-05
          return;
        }
        const actions: HookAction[] = [];
        for (const a of Array.isArray(d["actions"]) ? (d["actions"] as Array<Record<string, unknown>>) : []) {
          const type = String(a?.["type"]);
          if (type === "http") {
            const h = httpAction(a, label, warnings, controls.maxTimeoutMs);
            if (h) actions.push(h);
            continue;
          }
          if (type !== "command") {
            warnings.push(TYPES_LATER.has(type) ? `Crochet ${label} : le type « ${type} » n'est pas disponible dans cette version ; action ignorée.` : `Type de crochet inconnu : ${type} (${label}).`); // ERR-02
            continue;
          }
          if (typeof a["command"] !== "string" || a["command"].trim() === "") {
            warnings.push(`Crochet ${label} : commande vide ; action ignorée.`);
            continue;
          }
          const timeout = a["timeout"] ?? d["timeout"];
          const timeoutMs = timeout === undefined ? undefined : parseDuration(timeout);
          if (timeout !== undefined && timeoutMs === undefined) warnings.push(`Crochet ${label} : délai invalide ; délai par défaut appliqué.`);
          actions.push({ type: "command", command: a["command"], timeoutMs: timeoutMs === undefined ? undefined : Math.min(timeoutMs, controls.maxTimeoutMs), shell: typeof a["shell"] === "string" ? a["shell"] : undefined });
        }
        if (actions.length === 0) {
          ignored.push({ label, reason: "aucune action utilisable" });
          return;
        }
        // EF-02: exact duplicates are merged within one scope only.
        const key = JSON.stringify([event, match ?? "", actions]);
        if (seen.has(key)) return;
        seen.add(key);
        declarations.push({ event, match, matches, actions, id, mandatory, async: d["async"] === true ? true : undefined, scope, file: file ?? scope, fingerprint: fingerprintOf(event, raw), label });
      });
    }
  }
  // SPEC-HOK-012: administrator controls, then user controls; managed hooks are never disabled by the user (EF-01).
  const kept: HookDeclaration[] = [];
  for (const d of declarations) {
    let reason: string | undefined;
    if (controls.managedOnly && d.scope !== "managed") reason = "seuls les crochets gérés sont admis (hooksConfig.managedOnly)"; // EF-02
    else if (controls.disabled?.value && controls.disabled.origin === "managed" && !d.mandatory) reason = "crochets facultatifs désactivés par l'administrateur";
    else if (controls.disabled?.value && controls.disabled.origin !== "managed" && d.scope !== "managed") reason = "crochets désactivés (hooksConfig.disabled)";
    else if (controls.noHooks && d.scope !== "managed") reason = "crochets désactivés pour cette session (--no-hooks)";
    if (reason) ignored.push({ label: d.label, reason });
    else kept.push(d);
  }
  return { declarations: kept, ignored, warnings };
}
