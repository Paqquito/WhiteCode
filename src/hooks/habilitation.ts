// Implements: SPEC-PER-001 (§ 5.3 point c habilitation of an `approval_needed` hook, RG-06, § 11 `permissions.decisionHooks`, CA-26 to CA-28, CA-31),
//             SPEC-HOK-010 (§ 5.2 `approval_needed`, CA-08, CA-10)
// Which `approval_needed` hooks may answer a request in place of a person: those named by their qualified identity
// (scope, declaration file, identifier, fingerprint) in `permissions.decisionHooks`, declared outside the project,
// and whose actions designate no file of the project.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HookDeclaration, HookSnapshot } from "./config";

export interface QualifiedIdentity {
  readonly scope: string;
  readonly file: string;
  readonly id: string;
  readonly fingerprint: string;
}

const ELIGIBLE_SCOPES = new Set(["user", "managed"]);

/** Package managers and task runners whose commands run a script defined by the project. */
const PROJECT_RUNNERS: ReadonlyArray<{ readonly program: RegExp; readonly sub?: RegExp }> = [
  { program: /^(npm|pnpm)$/, sub: /^(run|run-script|test|start|stop|restart|exec|x|t|tst)$/ },
  { program: /^(npx|pnpx|bunx|yarn|make|gmake|just|task|rake|gradlew?|mvnw?|ant)$/ },
  { program: /^bun$/, sub: /^(?!(?:[A-Za-z]:)?[\\/])/ }, // `bun <script>` runs a script of the project unless it names an absolute path
  { program: /^(deno)$/, sub: /^(task|run)$/ },
  { program: /^(composer|poetry|pipenv|uv|hatch|pdm|cargo|dotnet|go)$/, sub: /^(run|test|exec|x)$/ },
];

/** Words of a command line, quotes removed; enough to find paths and programs (not a shell parser). */
function words(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|[^\s;&|()<>`]+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "")).filter((w) => w !== "");
}

function inside(dir: string, path: string): boolean {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Why the command designates a file of the project, or undefined (CA-31). */
export function projectFileOf(command: string, projectDirs: readonly string[]): string | undefined {
  if (/PROJECT_DIR/.test(command)) return "la commande désigne le dossier du projet";
  const all = words(command);
  // Program: after `env`-style assignments and the `&` call operator of PowerShell.
  const start = all.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== "&" && w !== "env");
  const program = (all[start] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  const sub = all[start + 1] ?? "";
  for (const r of PROJECT_RUNNERS) if (r.program.test(program) && (r.sub === undefined || r.sub.test(sub))) return `la commande lance un script défini par le projet (${program}${r.sub ? ` ${sub}` : ""})`;
  for (const w of all) {
    if (/^\.\.?([\\/]|$)/.test(w)) return `chemin relatif au dossier de travail : ${w}`;
    if (w.startsWith("-") || w.includes("://") || w.startsWith("$")) continue; // options, URLs, variables
    for (const dir of projectDirs) {
      const p = isAbsolute(w) ? w : resolve(dir, w);
      if (isAbsolute(w) ? inside(dir, p) : /[\\/]/.test(w) || existsSync(p)) return `fichier du projet : ${w}`;
    }
  }
  return undefined;
}

function identityOf(d: HookDeclaration): QualifiedIdentity {
  return { scope: d.scope, file: d.file, id: d.id ?? "", fingerprint: d.fingerprint };
}

/**
 * The habilitated declarations of `snapshot`, with a warning for each entry of `permissions.decisionHooks` that has no
 * effect: incomplete, outside the user and managed scopes (CA-10), naming no declaration or a modified one (CA-28),
 * or whose hook designates a file of the project (CA-31). A hook of another scope or location with the same identifier
 * never matches (CA-08, CA-26).
 */
export function habilitate(snapshot: HookSnapshot, entries: readonly unknown[], projectDirs: readonly string[]): HookSnapshot {
  const habilitated = new Set<HookDeclaration>();
  const warnings: string[] = [];
  const candidates = snapshot.declarations.filter((d) => d.event === "approval_needed");
  for (const raw of entries) {
    const e = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof QualifiedIdentity, unknown>>;
    const shown = JSON.stringify(raw);
    const fields = { scope: e.scope, file: e.file, id: e.id, fingerprint: e.fingerprint };
    const known = (["scope", "file", "id", "fingerprint"] as const).filter((k) => typeof fields[k] === "string");
    if (typeof e.scope === "string" && !ELIGIBLE_SCOPES.has(e.scope)) {
      warnings.push(`permissions.decisionHooks : ${shown} ignorée : seul un crochet déclaré hors du projet (portée utilisateur ou gérée) peut être habilité.`);
      continue;
    }
    const same = candidates.filter((d) => known.every((k) => k === "fingerprint" || identityOf(d)[k] === fields[k]));
    if (known.length < 4) {
      const hint = same.length === 1 ? ` ; identité du crochet correspondant : ${JSON.stringify(identityOf(same[0]!))}` : "";
      warnings.push(`permissions.decisionHooks : ${shown} ignorée : identité incomplète (portée, fichier, identifiant et empreinte attendus)${hint}.`);
      continue;
    }
    const match = same.find((d) => d.scope === e.scope && d.file === e.file && d.id === e.id);
    if (!match) {
      warnings.push(`permissions.decisionHooks : ${shown} sans effet : aucun crochet approval_needed ne porte cette identité.`);
      continue;
    }
    if (match.fingerprint !== e.fingerprint) {
      warnings.push(`permissions.decisionHooks : le crochet ${match.label} a été modifié depuis son habilitation ; il ne décide plus (empreinte actuelle : ${match.fingerprint}).`);
      continue;
    }
    const why = match.actions.map((a) => (a.type === "command" ? projectFileOf(a.command, projectDirs) : undefined)).find((w) => w !== undefined);
    if (why) {
      warnings.push(`permissions.decisionHooks : le crochet ${match.label} ne peut pas être habilité : ${why}.`);
      continue;
    }
    habilitated.add(match);
  }
  return { ...snapshot, habilitated, warnings: [...snapshot.warnings, ...warnings] };
}
