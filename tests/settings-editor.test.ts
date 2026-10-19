import { expect, test } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLanguageService } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import { publishSettingsSchema } from "../scripts/settings-schema";
import { cli, ROOT, workspace } from "./helpers/env";

test("SPEC-CFG-002/CA-04 — an editor loads the published schema through $schema and proposes every catalogue key", async () => {
  const ws = workspace();
  const publication = publishSettingsSchema(ROOT, ws.root, { version: "2.3.4", cli: "atelier" });
  const schemaUrl = pathToFileURL(publication.file).href;
  const canonical = (uri: string) => process.platform === "win32" ? fileURLToPath(uri).toLowerCase() : fileURLToPath(uri);
  const requested: string[] = [];
  const service = getLanguageService({ schemaRequestService: async (uri) => {
    requested.push(uri);
    if (canonical(uri) !== canonical(schemaUrl)) throw new Error("Unexpected schema request.");
    return readFileSync(publication.file, "utf8");
  } });
  const source = `{ "$schema": ${JSON.stringify(schemaUrl)}, "" }`;
  const doc = TextDocument.create("file:///settings.json", "jsonc", 1, source);
  const completion = await service.doComplete(doc, doc.positionAt(source.lastIndexOf('""') + 1), service.parseJSONDocument(doc));
  const keys = new Set(completion?.items.map((item) => item.label));
  const normative = readFileSync(join(ROOT, "docs/parametres.md"), "utf8")
    .split("### 6.1 Catalogue complet")[1]!.split("## 7.")[0]!;
  const catalogueKeys = [...normative.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!);
  expect(catalogueKeys).toHaveLength(492);
  for (const key of catalogueKeys) expect(keys.has(key)).toBe(true);
  expect(requested.map(canonical)).toContain(canonical(schemaUrl));
  expect(completion?.items.find((item) => item.label === "permissions.allowRules")?.documentation).toContain("SPEC-PER-001");
  const nested = `{ "$schema": ${JSON.stringify(schemaUrl)}, "tools": { "shell": { "" } } }`;
  const nestedDoc = TextDocument.create("file:///nested.json", "jsonc", 1, nested);
  const children = await service.doComplete(nestedDoc, nestedDoc.positionAt(nested.lastIndexOf('""') + 1), service.parseJSONDocument(nestedDoc));
  expect(children?.items.map((item) => item.label)).toContain("defaultTimeout");
  const wsSettings = join(ws.root, "settings.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(wsSettings, JSON.stringify({ $schema: schemaUrl, "ui.reducedMotion": true }));
  const validation = await cli(["config", "validate", wsSettings, "--json"], ws);
  expect(validation.code).toBe(0);
});

test("TECH — the editor artifact is versioned, accepts nested and dotted keys, and exposes no unresolved or service defaults", () => {
  const ws = workspace();
  const publication = publishSettingsSchema(ROOT, ws.root, { version: "2.3.4", cli: "atelier" });
  const source = readFileSync(publication.file, "utf8");
  const schema = JSON.parse(source);
  expect(schema.$id).toContain("2.3.4");
  expect(source).not.toMatch(/\{\{[A-Z][A-Z0-9_]*(\|[a-z]+)*\}\}/);
  expect(schema.properties["api.provider"].default).toBeUndefined();
  expect(schema.properties["models.selected"].default).toBeUndefined();
  expect(schema.properties["browser.enabled"]["x-availability"]).toBe("disponible");
  expect(schema.properties["api.baseUrl"]["x-availability"]).toBe("proposé");
  const validate = new Ajv({ strict: false }).compile(schema);
  expect(validate({ $schema: "file:///config.schema.json", permissions: { allowRules: ["read_file"] }, "ui.reducedMotion": true })).toBe(true);
  expect(validate({ tools: { "shell.defaultTimeout": "3 min" } })).toBe(true);
  expect(validate({ "tools.shell": { defaultTimeout: "3 min" } })).toBe(true);
  expect(validate({ "ui.reducedMotion": "wrong" })).toBe(false);
  expect(validate({ unrecognized: true })).toBe(false);
});

test.each(["tools", "tools.shell"])("TECH — the editor completes mixed dotted and nested keys under %s", async (group) => {
  const ws = workspace();
  const publication = publishSettingsSchema(ROOT, ws.root, { version: "2.3.4", cli: "atelier" });
  const service = getLanguageService({ schemaRequestService: async () => readFileSync(publication.file, "utf8") });
  const source = `{ "$schema": ${JSON.stringify(pathToFileURL(publication.file).href)}, ${JSON.stringify(group)}: { "" } }`;
  const doc = TextDocument.create("file:///mixed.json", "jsonc", 1, source);
  const completion = await service.doComplete(doc, doc.positionAt(source.lastIndexOf('""') + 1), service.parseJSONDocument(doc));
  expect(completion?.items.map((item) => item.label)).toContain(group === "tools" ? "shell.defaultTimeout" : "defaultTimeout");
});
