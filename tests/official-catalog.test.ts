import { expect, test } from "bun:test";
import { Identity } from "../src/identity/identity";
import { resolveIdentityText } from "../src/identity/resolver";
import { readFileSync } from "node:fs";
import { cli, loadIdentity, ROOT, workspace } from "./helpers/env";
import { join } from "node:path";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { cachedCatalog, refreshCatalog } from "../src/extensions/catalog";
import { productEnv } from "./helpers/hooks";
function identity() {
  const input = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8")); input.services.SERVICE_MARKETPLACE = "https://catalog.fixture.invalid/catalog.git";
  const result = resolveIdentityText(JSON.stringify(input), { version: "0.1.0" }); if (!result.identity) throw new Error(JSON.stringify(result.issues)); return new Identity(result.identity);
}
test("SPEC-EXT-005/CA-01 — the extensions command exposes the identity catalogue without adding or storing it", async () => {
  const ws = workspace(), id = identity();
  const result = await cli(["--non-interactive", "/extensions"], ws, { identity: id, provider: new ScriptedProvider([]) });
  expect(result.code).toBe(0); expect(result.stdout).toContain(id.get("PRODUCT_SLUG") + "-official"); expect(result.stdout).toContain("officiel"); expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).not.toContain("-official");
  ws.write("managed/policy.json", JSON.stringify({ extensions: { strictCatalogs: [] } }));
  const excluded = await cli(["--non-interactive", "/extensions catalogues"], ws, { identity: id, provider: new ScriptedProvider([]) });
  expect(excluded.stdout).not.toContain(id.get("PRODUCT_SLUG") + "-official");
});
test("TECH — reserving the official name does not promote an older cache from another source", async () => {
  const ws = workspace(), id = identity(), name = id.get("PRODUCT_SLUG") + "-official";
  ws.write(`home/config/catalogs/${name}/catalog.json`, JSON.stringify({ name, extensions: [{ name: "UNTRUSTED_PREEXISTING", source: "entry" }] }));
  const result = await cli(["--non-interactive", "/extensions catalogues"], ws, { identity: id, provider: new ScriptedProvider([]), userConfig: { extensions: { catalogs: { [name]: { source: "old-user-source" } } } } });
  expect(result.code).toBe(0); expect(result.stdout).toContain("cache absent"); expect(result.stdout).not.toContain("UNTRUSTED_PREEXISTING");
  const source = ws.write("source/catalog.json", JSON.stringify({ name, extensions: [] })).replace(/[\\/]catalog.json$/, ""), registration = { source, requireOrigin: true as const };
  expect(refreshCatalog(ws.configHome, name, registration, ws.project, { env: productEnv(ws), timeoutMs: 5000 }).error).toBeUndefined();
  expect(cachedCatalog(ws.configHome, name, registration)).toBeDefined();
  expect(cachedCatalog(ws.configHome, name, { ...registration, source: id.get("SERVICE_MARKETPLACE") })).toBeUndefined();
});
test("SPEC-EXT-005/CA-02 — the official name is refused for both an explicit alias and the source catalogue name", async () => {
  const ws = workspace(), name = loadIdentity().get("PRODUCT_SLUG") + "-official";
  const file = ws.write("catalog/catalog.json", JSON.stringify({ name, extensions: [] })); const folder = file.replace(/[\\/]catalog.json$/, "");
  const implicit = await cli(["catalog", "add", folder], ws); expect(implicit.code).not.toBe(0); expect(implicit.stderr).toContain("réservé");
  const explicit = await cli(["catalog", "add", folder, "--name", name], ws); expect(explicit.code).not.toBe(0); expect(explicit.stderr).toContain("réservé");
  expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).not.toContain(name);
});
