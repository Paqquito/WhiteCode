// Supports: SPEC-CAD-002 (model-tier labels and strict rendering of the original corpus), gaps E-162, E-230.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { renderDirectory } from "../src/identity/files";
import { workspace, loadIdentity, ROOT } from "./helpers/env";
import { VARIABLES } from "../src/identity/catalog";
import { Identity } from "../src/identity/identity";
import { resolveIdentityText } from "../src/identity/resolver";

test("TECH — standalone Markdown rendering resolves a model-tier label without exposing a provider identifier", () => {
  const ws = workspace(), identity = loadIdentity(); ws.write("templates/model.md", "# {{MODEL_SMALL}}\n");
  expect(renderDirectory(join(ws.root, "templates"), join(ws.root, "rendered"), identity, "fr")).toBe(1);
  expect(readFileSync(join(ws.root, "rendered", "model.md"), "utf8")).toBe("# " + identity.tierLabel("MODEL_SMALL", "fr") + "\n");
  expect(readFileSync(join(ws.root, "templates", "model.md"), "utf8")).toBe("# {{MODEL_SMALL}}\n");
});

test("TECH — default and background tier references render their localized labels including runtime overrides", () => {
  for (const overridden of [false, true]) {
    const ws = workspace(), identity = loadIdentity();
    if (overridden) identity.applyOverrides({ MODEL_DEFAULT: "MODEL_SMALL", MODEL_BACKGROUND: "MODEL_LARGE" });
    const template = "{{MODEL_DEFAULT}}|{{MODEL_BACKGROUND|upper}}\n";
    ws.write("templates/references.md", template);
    expect(renderDirectory(join(ws.root, "templates"), join(ws.root, "rendered"), identity, "fr")).toBe(1);
    expect(readFileSync(join(ws.root, "rendered/references.md"), "utf8")).toBe(identity.tierLabel(identity.modelDefault, "fr") + "|" + identity.tierLabel(identity.modelBackground, "fr")!.toUpperCase() + "\n");
    expect(readFileSync(join(ws.root, "templates/references.md"), "utf8")).toBe(template);
  }
});

test("SPEC-CAD-002/CA-07 — the actual specification corpus renders strictly with a complete documentary identity and every source fingerprint stays unchanged", () => {
  const ws = workspace(), input = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const base = loadIdentity();
  for (const variable of VARIABLES) if (variable.kind === "optional" && !base.has(variable.name)) {
    (input[variable.section] ??= {})[variable.name] = variable.type === "modelTier" ? { label: "Documentation " + variable.name } : variable.type === "url" ? "https://documentation.example.test/" + variable.name.toLowerCase() : variable.type === "color" ? "#336699" : variable.type === "email" ? "documentation@example.test" : variable.type === "path" ? "/documentation" : variable.type === "filename" || variable.type === "resource" ? "documentation.svg" : variable.type === "tierRef" ? "MODEL_MEDIUM" : "documentation";
  }
  const resolved = resolveIdentityText(JSON.stringify(input), { version: base.version, strict: true });
  expect(resolved.issues.filter(issue => issue.severity === "error")).toEqual([]);
  const files: string[] = [];
  const visit = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) visit(path); else if (entry.isFile()) files.push(path); } };
  visit(join(ROOT, "specs"));
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = files.map(hash);
  expect(renderDirectory(join(ROOT, "specs"), join(ws.root, "rendered-specs"), new Identity(resolved.identity!), "fr")).toBe(files.length);
  expect(files.map(hash)).toEqual(before);
  expect(readFileSync(join(ws.root, "rendered-specs/00-cadre/SPEC-CAD-002-configuration-marque-blanche.md"), "utf8")).not.toContain("{{MODEL_DEFAULT}}");
}, 30000);
