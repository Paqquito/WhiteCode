// Implements: SPEC-CAD-002 (§ 5.2 brand tool: validate, resolve, render, scan, show; CA-08, CA-09, CA-19; § 10 exit codes)
// Usage: bun scripts/identity.ts <validate|resolve|show|scan|render> <identity.json> [source] [output] [--language code] [--strict] [--version x.y.z]

import { readFileSync } from "node:fs";
import { resolveIdentityText } from "../src/identity/resolver";
import { Identity } from "../src/identity/identity";
import { renderDirectory, scanDirectory } from "../src/identity/files";

const [operation, file, ...rest] = process.argv.slice(2);
const strict = rest.includes("--strict") || process.env["CI"] === "true";
const versionIndex = rest.indexOf("--version");
const version = versionIndex >= 0 ? rest[versionIndex + 1] ?? "0.0.0" : "0.0.0";

if (!operation || !["validate", "resolve", "render", "scan", "show"].includes(operation) || !file) {
  console.error("Usage : identity <validate|resolve|show|scan|render> <identité> [source] [sortie] [--language langue] [--strict] [--version x.y.z]");
  process.exit(2);
}

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error("[ERR-01] Fichier d'identité introuvable : indiquez son chemin.");
  process.exit(2);
}

try {
  const result = resolveIdentityText(text, { version, strict });
  for (const issue of result.issues) console.error(`[${issue.code}] ${issue.severity === "error" ? "erreur" : "avertissement"} : ${issue.message}`);
  if (!result.identity) process.exit(2);
  const id = result.identity;
  if (operation === "scan" || operation === "render") {
    const source = rest[0];
    if (!source || source.startsWith("--")) { console.error("Dossier source requis."); process.exit(2); }
    const identity = new Identity(id);
    if (operation === "scan") {
      const issues = scanDirectory(source, identity);
      for (const issue of issues) console.error(`[ERR-12] ${issue.file}:${issue.line}:${issue.column} — terme interdit ${issue.term}.`);
      if (issues.length) process.exit(2);
      console.log("Contrôle anti-fuite réussi.");
    } else {
      const output = rest[1];
      if (!output || output.startsWith("--")) { console.error("Dossier de sortie requis."); process.exit(2); }
      const languageIndex = rest.indexOf("--language");
      const language = languageIndex >= 0 ? rest[languageIndex + 1] : id.defaultLanguage;
      if (!language || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) { console.error("Langue invalide."); process.exit(2); }
      const count = renderDirectory(source, output, identity, language);
      for (const warning of identity.warnings) console.error(`[${warning.code}] avertissement : ${warning.message}`);
      console.log(`${count} fichier(s) rendu(s).`);
    }
  } else if (operation === "resolve") {
    console.log(JSON.stringify(id, null, 2));
  } else if (operation === "show") {
    const v = (n: string) => {
      const e = id.values[n]?.value;
      return typeof e === "string" ? e : e?.[id.defaultLanguage] ?? "";
    };
    console.log(`${v("PRODUCT")} — ${v("SOCIETY")}`);
    console.log(`commande : ${v("PRODUCT_CLI")} · préfixe : ${v("ENV_PREFIX")} · empreinte : ${id.hash}`);
  } else {
    console.log("Identité valide.");
  }
  process.exit(0);
} catch (e) {
  console.error(`Erreur d'exécution : ${(e as Error).message}`);
  process.exit((e as Error).message.startsWith("[ERR-") ? 2 : 1);
}
