// Implements: SPEC-CMD-020 (§ 5.1, § 5.3, EF-01, EF-02, RG-01, § 10, CA-01)
// Supports: SPEC-OBS-015 (checks of the environment), gap E-116
// The checks shared by `/diagnose` and `diagnostic validate|repair`: each finding has a status, a place and, when it can
// be corrected, a correction applied only once accepted.

import { accessSync, constants } from "node:fs";
import { readValueInSettingsFile, setValueInSettingsFile } from "../config/settings-writer";
import { Settings, type ConfigIssue } from "../config/settings";
import type { Scope } from "../config/settings-schema";
import type { PlatformName } from "../platform/system";
import { buildKeymap } from "../interactive/keymap";
import { maskSecrets } from "../shared/secrets";

export type FindingStatus = "ok" | "warning" | "error";

export interface Finding {
  readonly status: FindingStatus;
  readonly area: string;
  readonly message: string;
  /** File, key or line concerned. */
  readonly location?: string;
  readonly fix?: { readonly description: string; readonly apply?: () => void };
}

export interface DiagnosticInputs {
  /** The settings files, by scope (the options and the environment are left out). */
  readonly sources: ReadonlyArray<{ readonly scope: Scope; readonly name: string; readonly text: string | undefined }>;
  readonly keybindings: Readonly<Record<string, unknown>>;
  readonly executables: ReadonlyArray<{ readonly name: string; readonly path: string | undefined; readonly purpose: string }>;
  readonly writable: ReadonlyArray<{ readonly path: string; readonly purpose: string }>;
  readonly platform: PlatformName;
}

/** One problem of a settings file, with the correction proposed (CA-01). */
function settingsFinding(source: DiagnosticInputs["sources"][number], issue: ConfigIssue, platform: PlatformName): Finding {
  const managed = source.scope === "managed";
  const status: FindingStatus = issue.kind === "unknown-key" || issue.kind === "untrusted" ? "warning" : "error";
  if (issue.kind === "invalid-json") {
    const line = issue.message.match(/ligne (\d+)/)?.[1];
    return { status, area: "Configuration", message: issue.message, location: `${source.name}${line ? `:${line}` : ""}`, fix: { description: `corriger la syntaxe JSON${line ? ` à la ligne ${line}` : ""} : le fichier est ignoré tant qu'il est invalide` } };
  }
  const key = issue.key;
  const location = key ? `${source.name}, clé ${key}` : source.name;
  if (!key) return { status, area: "Configuration", message: issue.message, location };
  const near = issue.kind === "unknown-key" ? issue.message.match(/vouliez-vous dire `([^`]+)`/)?.[1] : undefined;
  const description = near ? `renommer \`${key}\` en \`${near}\`` : `retirer \`${key}\` (la valeur par défaut s'appliquera)`;
  if (managed) return { status, area: "Configuration", message: issue.message, location, fix: { description: `${description}, par l'administrateur` } };
  const path = key.split(".");
  const apply = near
    ? () => {
        const value = readValueInSettingsFile(source.name, path);
        setValueInSettingsFile(source.name, near.split("."), value, platform);
        setValueInSettingsFile(source.name, path, undefined, platform);
      }
    : () => setValueInSettingsFile(source.name, path, undefined, platform);
  return { status, area: "Configuration", message: issue.message, location, fix: { description, apply } };
}

/** § 5.3 steps 1 and 2: the checks, classified. Nothing is changed here (EF-01). */
export async function runDiagnostics(i: DiagnosticInputs, extra: readonly Finding[] = []): Promise<Finding[]> {
  const checks: Array<() => Finding[]> = [
    () =>
      i.sources.flatMap((s) => {
        if (s.text === undefined) return [];
        const issues = Settings.load({ sources: [{ scope: s.scope, name: s.name, text: s.text }], projectTrusted: true }).issues;
        return issues.length === 0 ? [{ status: "ok" as const, area: "Configuration", message: "fichier valide", location: s.name }] : issues.map((x) => settingsFinding(s, x, i.platform));
      }),
    () => {
      const warnings = buildKeymap(i.keybindings, { strictConflicts: false }).warnings;
      return warnings.length === 0 ? [{ status: "ok" as const, area: "Raccourcis", message: "associations valides" }] : warnings.map((w) => ({ status: "warning" as const, area: "Raccourcis", message: w, location: "ui.keybindings.bindings" }));
    },
    () => i.executables.map((e) => (e.path ? { status: "ok" as const, area: "Outils", message: `${e.name} trouvé (${e.purpose})`, location: e.path } : { status: "warning" as const, area: "Outils", message: `${e.name} introuvable : ${e.purpose} indisponible ou dégradé.` })),
    () =>
      i.writable.map((w) => {
        try {
          accessSync(w.path, constants.W_OK);
          return { status: "ok" as const, area: "Dossiers", message: `${w.purpose} accessible en écriture`, location: w.path };
        } catch {
          return { status: "error" as const, area: "Dossiers", message: `${w.purpose} non accessible en écriture.`, location: w.path };
        }
      }),
  ];
  // Step 1: the checks run side by side.
  const found = await Promise.all(checks.map(async (check) => check()));
  return [...found.flat(), ...extra];
}

const SYMBOL: Record<FindingStatus, string> = { ok: "✓", warning: "⚠", error: "✗" };

/** § 10, EF-02, RG-01: a list by status, as plain text that can be copied for the support, without any secret. */
export function renderDiagnostics(findings: readonly Finding[], title: string): string[] {
  const order: FindingStatus[] = ["error", "warning", "ok"];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const lines = [title];
  for (const f of sorted) {
    lines.push(maskSecrets(`${SYMBOL[f.status]} ${f.area} : ${f.message}${f.location ? ` — ${f.location}` : ""}`));
    if (f.fix) lines.push(`    correction proposée : ${f.fix.description}${f.fix.apply ? "" : " (manuelle)"}`);
  }
  const count = (s: FindingStatus) => findings.filter((f) => f.status === s).length;
  lines.push(`Résumé : ${count("ok")} correct${count("ok") > 1 ? "s" : ""}, ${count("warning")} avertissement${count("warning") > 1 ? "s" : ""}, ${count("error")} erreur${count("error") > 1 ? "s" : ""}.`);
  return lines;
}
