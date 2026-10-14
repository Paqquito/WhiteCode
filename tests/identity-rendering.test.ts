// Supports: SPEC-CAD-002 (model-tier labels in standalone rendering), gap E-162.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDirectory } from "../src/identity/files";
import { workspace, loadIdentity } from "./helpers/env";

test("TECH — standalone Markdown rendering resolves a model-tier label without exposing a provider identifier", () => {
  const ws = workspace(), identity = loadIdentity(); ws.write("templates/model.md", "# {{MODEL_SMALL}}\n");
  expect(renderDirectory(join(ws.root, "templates"), join(ws.root, "rendered"), identity, "fr")).toBe(1);
  expect(readFileSync(join(ws.root, "rendered", "model.md"), "utf8")).toBe("# " + identity.tierLabel("MODEL_SMALL", "fr") + "\n");
  expect(readFileSync(join(ws.root, "templates", "model.md"), "utf8")).toBe("# {{MODEL_SMALL}}\n");
});
