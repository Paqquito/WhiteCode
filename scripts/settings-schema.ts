// Implements: SPEC-CFG-002 (CA-04, EF-01 published editor schema).
// Supports: SPEC-CAD-002 (distribution identity and unresolved-variable control), gap E-130.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "../src/config/settings-schema";

type Schema = Record<string, unknown> & { properties?: Record<string, Schema> };
interface CatalogueEntry { key: string; type: string; defaultText: string; scopes: string[]; scopeText: string; owner: string; ambiguous: boolean }

function catalogue(text: string): CatalogueEntry[] {
  const rows: CatalogueEntry[] = [];
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/).filter((line) => /^\| `/.test(line))) {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
    const key = /^`([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)`$/.exec(cells[0] ?? "")?.[1];
    const owner = /SPEC-[A-Z]{3}-\d{3}/.exec(cells[4] ?? "")?.[0];
    const scopes = (cells[3] ?? "").match(/\b[UPLGC]\b/g) ?? [];
    if (cells.length !== 5 || !key || !owner || !cells[3] || keys.has(key)) throw new Error(`Ligne de catalogue invalide : ${cells[0] ?? "vide"}.`);
    keys.add(key);
    rows.push({ key, type: cells[1]!, defaultText: cells[2]!, scopes, scopeText: cells[3]!, owner, ambiguous: cells[1]!.endsWith("\\") });
  }
  if (rows.length === 0) throw new Error("Catalogue normatif vide.");
  return rows;
}

function genericType(text: string): Schema {
  if (text.startsWith("Booléen")) return { type: "boolean" };
  if (text.startsWith("Liste")) return { type: "array", items: {} };
  if (text.startsWith("Entier")) return { type: "integer" };
  if (/^(Nombre|Décimal|Montant)/.test(text)) return { type: "number" };
  if (/^(Durée|Taille)/.test(text)) return { type: ["number", "string"] };
  if (/^(Objet|Association)/.test(text)) return { type: "object" };
  const values = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  if (values.length > 1 && !text.includes("ou famille")) return { type: "string", enum: values };
  return { type: "string" };
}

// Contextual defaults remain descriptive. They must never become guessed values or unresolved build variables.
function publicText(text: string): string {
  return text.replace(/\{\{([A-Z][A-Z0-9_]*(?:\|[a-z]+)*)\}\}/g, (_, name: string) => `valeur de distribution (${name})`);
}

function literalDefault(text: string): unknown {
  if (text === "Vrai") return true;
  if (text === "Faux") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return /^`([^`]+)`$/.exec(text)?.[1];
}

export function publishSettingsSchema(root: string, directory: string, identity: { version: string; cli: string }): { file: string } {
  const rows = catalogue(readFileSync(join(root, "docs/parametres.md"), "utf8"));
  const runtime = new Map(SETTINGS.map((definition) => [definition.key, definition]));
  const properties: Record<string, Schema> = { $schema: { type: "string", description: "Adresse du schéma utilisé par l'éditeur." } };
  const insert = (parent: Record<string, Schema>, parts: string[], leaf: Schema): void => {
    // The runtime flattener accepts every partition of dotted and nested segments.
    for (let length = 1; length <= parts.length; length++) {
      const name = parts.slice(0, length).join(".");
      if (length === parts.length) parent[name] = leaf;
      else {
        const node = parent[name] ??= { type: "object", additionalProperties: false, properties: {} };
        if (!node.properties) throw new Error(`Collision entre paramètre et groupe : ${parts.join(".")}.`);
        insert(node.properties, parts.slice(length), leaf);
      }
    }
  };
  const add = (key: string, leaf: Schema) => insert(properties, key.split("."), leaf);
  for (const row of rows) {
    const definition = runtime.get(row.key);
    const schema: Schema = definition ? JSON.parse(JSON.stringify(definition.schema)) : genericType(row.type);
    const contextualDefault = row.key === "api.provider" || row.key === "models.selected";
    const defaultText = contextualDefault ? "Choix explicite ou identité de distribution, sans valeur de service imposée." : publicText(row.defaultText);
    Object.assign(schema, {
      title: row.key,
      description: `Paramètre ${row.key}. Type : ${publicText(row.type)}. Défaut : ${defaultText}. Portées : ${row.scopeText}. Référence : ${row.owner}. ${definition ? "Clé reconnue par le validateur de cette version." : "Catalogue normatif ; clé non encore reconnue par le validateur de cette version."}`,
      "x-scopes": row.scopes, "x-scopeDescription": row.scopeText, "x-owner": row.owner, "x-defaultDescription": defaultText,
      "x-availability": definition ? "disponible" : "catalogue",
    });
    // A runtime default is a completion hint only when it equals an unambiguous normative literal.
    if (definition?.default !== undefined && definition.default === literalDefault(row.defaultText) && !contextualDefault && !row.ambiguous) schema.default = definition.default;
    if (row.ambiguous) schema["x-catalogueNote"] = "Type et défaut ambigus dans le tableau normatif ; aucune valeur par défaut proposée (E-130).";
    add(row.key, schema);
  }
  for (const definition of SETTINGS.filter((definition) => !rows.some((row) => row.key === definition.key))) {
    add(definition.key, {
      ...JSON.parse(JSON.stringify(definition.schema)),
      title: definition.key, description: `Paramètre proposé par un écart de développement. Référence : ${definition.owner}.`,
      "x-owner": definition.owner, "x-scopes": definition.scopes, "x-availability": "proposé",
      ...(definition.default !== undefined ? { default: definition.default } : {}),
    });
  }
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `urn:${identity.cli}:settings:${identity.version}`,
    title: `Paramètres — ${identity.cli} ${identity.version}`,
    description: "Catalogue des paramètres pour les éditeurs. Les portées et la validation partielle restent contrôlées par le produit.",
    type: "object", additionalProperties: false, properties,
  };
  const file = join(directory, "config.schema.json");
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  return { file };
}
