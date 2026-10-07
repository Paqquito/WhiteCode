// Implements: SPEC-CAD-002 (§ 5.2 brand tool: validate, resolve, show; § 10 exit codes 2 = invalid identity, 1 = runtime error)
// Usage: bun scripts/identity.ts <validate|resolve|show> <identity.json> [--strict] [--version x.y.z]

import { readFileSync } from "node:fs";
import { resolveIdentityText } from "../src/identity/resolver";

const [operation, file, ...rest] = process.argv.slice(2);
const strict = rest.includes("--strict") || process.env["CI"] === "true";
const versionIndex = rest.indexOf("--version");
const version = versionIndex >= 0 ? rest[versionIndex + 1] ?? "0.0.0" : "0.0.0";

if (!operation || !["validate", "resolve", "show"].includes(operation) || !file) {
  console.error("Usage : identity <validate|resolve|show> <fichier d'identité> [--strict] [--version x.y.z]");
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
  if (operation === "resolve") {
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
  process.exit(1);
}
