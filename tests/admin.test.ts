// Providers (openai adapter, managed provider, capability matrix) and administration sub-commands (SPEC-API-001, SPEC-API-006, SPEC-CFG-002, SPEC-MOD-012).
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FAMILY_CATALOG } from "../src/cli/families";
import { Identity } from "../src/identity/identity";
import { resolveIdentityText } from "../src/identity/resolver";
import { effectiveCapabilities } from "../src/providers/adapters";
import { capabilitiesOf, isResolveFailure } from "../src/providers/catalog";
import { cli, loadCatalog, ROOT, workspace, type Workspace } from "./helpers/env";
import { startFakeOpenAI, type FakeChatServer } from "./helpers/fake-openai-server";
import { ScriptedProvider } from "./helpers/scripted-provider";

let server: FakeChatServer | undefined;
afterEach(() => server?.stop());

/** Every file under the workspace, to prove that an operation had no effect. */
const snapshot = (ws: Workspace) => readdirSync(ws.root, { recursive: true }).map(String).sort();

describe("SPEC-API-001 providers", () => {
  test("SPEC-API-001/CA-01 — provider openai with OPENAI_API_KEY: tool calls work as with the reference provider", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "OPENAI-WORD\n");
    server = startFakeOpenAI([{ toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: file }) }] }, { text: "The word is OPENAI-WORD." }]);
    const r = await cli(["--non-interactive", "--model", "test-openai", "x"], ws, {
      userConfig: { api: { provider: "openai", baseUrl: null } },
      env: { OPENAI_API_KEY: "sk-test-openai", OPENAI_BASE_URL: server.baseURL },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("The word is OPENAI-WORD.\n");
    expect(server.requests[0]!.headers["authorization"]).toBe("Bearer sk-test-openai");
    expect(JSON.stringify(server.requests[1]!.body["messages"])).toContain("OPENAI-WORD");
    // ERR-02: without key, an explicit stop at start-up.
    const noKey = await cli(["--non-interactive", "--model", "test-openai", "x"], workspace(), { userConfig: { api: { provider: "openai", baseUrl: null } } });
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toContain("Configuration du fournisseur incomplète : OPENAI_API_KEY");
  });

  test("SPEC-API-001/CA-02 — openai_compatible towards a local server: the requests go to the configured URL", async () => {
    server = startFakeOpenAI([{ text: "local" }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { api: { baseUrl: server.baseURL } } });
    expect(r.stdout).toBe("local\n");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.path).toBe("/v1/chat/completions");
  });

  test("SPEC-API-001/CA-03 — a model without thinking and thinking enabled by the user: announced as unavailable, without error", async () => {
    const r = await cli(["--non-interactive", "x"], workspace(), { provider: new ScriptedProvider([{ text: "fine" }]), userConfig: { thinking: { enabled: true } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("fine\n");
    expect(r.stderr).toContain("la réflexion n'est pas disponible pour le modèle test-medium");
    // Without an explicit choice, nothing is said.
    const quiet = await cli(["--non-interactive", "x"], workspace(), { provider: new ScriptedProvider([{ text: "fine" }]) });
    expect(quiet.stderr).not.toContain("réflexion");
  });

  test("SPEC-API-001/CA-04 — a provider imposed by the administrator: the imposed value applies whatever the user sets", async () => {
    server = startFakeOpenAI([{ text: "from the imposed provider" }]);
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ api: { provider: "openai_compatible", baseUrl: server.baseURL } }));
    const r = await cli(["--non-interactive", "x"], ws, { userConfig: { api: { provider: "anthropic" } }, env: { PILOTE_DEV_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "never-used" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("from the imposed provider\n");
    expect(server.requests).toHaveLength(1);
  });

  test("TECH — SPEC-API-001/EF-02, FA-01 — a capability the adapter cannot carry is degraded with a documented effect", () => {
    const entry = loadCatalog().find("openai", "test-openai")!;
    const { capabilities, degradations } = effectiveCapabilities(capabilitiesOf(entry), "openai");
    expect(capabilities.contextEditing).toBe(false);
    expect(capabilities.images).toBe(true);
    expect(degradations).toEqual(["pas d'effacement côté service : micro-compaction locale ou compaction complète"]);
  });
});

describe("SPEC-API-006 catalogue", () => {
  test("SPEC-API-006/CA-01 — --model large with the bedrock provider: the Bedrock identifier of the large tier is used (resolution)", () => {
    const raw = JSON.parse(readFileSync(join(ROOT, "identity/test-omega.identity.json"), "utf8"));
    raw.models.MODEL_LARGE = { label: "Large", ids: { bedrock: "omega-large-on-bedrock", anthropic: "omega-large-on-anthropic" } };
    const result = resolveIdentityText(JSON.stringify(raw), { version: "0.1.0" });
    const identity = new Identity(result.identity!);
    const r = loadCatalog().resolve("large", "bedrock", identity, { unknownContextWindow: 128_000 });
    expect(isResolveFailure(r)).toBe(false);
    expect(r).toMatchObject({ id: "omega-large-on-bedrock", provider: "bedrock", tier: "MODEL_LARGE", label: "Large" });
  });

  test("SPEC-API-006/CA-03 — model list: tiers, labels and capabilities are listed", async () => {
    const r = await cli(["model", "list"], workspace());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Fournisseur : openai_compatible");
    expect(r.stdout).toMatch(/large\s+Étendu\s+→ test-large/);
    expect(r.stdout).toMatch(/small\s+Rapide\s+→ test-small/);
    expect(r.stdout).toContain("test-large (openai_compatible) — Test large, famille");
    expect(r.stdout).toContain("appels d'outils");
    expect(r.stdout).toContain("4/20 USD par million de jetons");
    expect(r.stdout).not.toContain("vendor-always"); // another provider
  });

  test("SPEC-API-006/CA-04 — a full identifier absent from the catalogue and a cap: refused, the cap is not neutralised", async () => {
    const provider = new ScriptedProvider([{ text: "never" }]);
    const r = await cli(["--non-interactive", "--model", "some-unknown-model", "--max-cost", "1", "x"], workspace(), { provider });
    expect(r.code).toBe(2);
    expect(provider.requests).toHaveLength(0);
  });

  test("SPEC-API-006/CA-05 — a catalogue model in structured output: its model family is in the entry", async () => {
    const r = await cli(["model", "show", "large", "--json"], workspace());
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ id: "test-large", provider: "openai_compatible", family: expect.any(String), contextWindow: 200000, pricing: { currency: "USD", inputPerMTok: 4 } });
    const list = JSON.parse((await cli(["model", "list", "--json"], workspace())).stdout);
    expect(list.models.every((m: { family?: string }) => typeof m.family === "string")).toBe(true);
    const missing = await cli(["model", "show", "nope"], workspace());
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Modèle introuvable : nope.");
  });
});

describe("SPEC-CFG-002 config validate", () => {
  test("SPEC-CFG-002/CA-03 — config validate on a file: errors listed, non-zero exit code when there are some", async () => {
    const ws = workspace();
    const bad = ws.write("bad.json", JSON.stringify({ engine: { toolConcurrency: "many" }, tools: { find: { maxResults: 10 } } }));
    const r = await cli(["config", "validate", bad], ws);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("erreur");
    expect(r.stdout).toContain("engine.toolConcurrency");
    const good = ws.write("good.json", JSON.stringify({ tools: { find: { maxResults: 10 } } }));
    const ok = await cli(["config", "validate", good, "--json"], ws);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ valid: true, files: [{ path: good, scope: "user", exists: true, issues: [] }] });
  });
});

describe("SPEC-MOD-012 sub-command families", () => {
  test("SPEC-MOD-012/CA-01 — a known family without operation: its help is shown and the code is 0", async () => {
    const r = await cli(["config"], workspace());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pilote-dev config <opération>");
    expect(r.stdout).toContain("validate [<fichier>]");
  });

  test("SPEC-MOD-012/CA-02 — an inventory operation with structured output: the standard output holds only the document", async () => {
    const r = await cli(["model", "list", "--json"], workspace());
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(Object.keys(doc).sort()).toEqual(["currency", "models", "provider", "tiers"]);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("SPEC-MOD-012/CA-05 — a misspelled family: a suggestion is proposed", async () => {
    const r = await cli(["confg", "validate"], workspace());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Commande inconnue : confg. Vouliez-vous dire config ?");
  });

  test("SPEC-MOD-012/CA-07 — every family of the catalogue invoked alone: its help, without any effect", async () => {
    for (const family of FAMILY_CATALOG) {
      const ws = workspace();
      const before = snapshot(ws);
      const provider = new ScriptedProvider([]);
      const r = await cli([family.name], ws, { provider, userConfig: null });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`pilote-dev ${family.name} <opération>`);
      expect(provider.requests).toHaveLength(0);
      expect(snapshot(ws)).toEqual(before.concat().sort());
    }
  });

  test("SPEC-MOD-012/CA-08 — an operation unknown to the catalogue: not executed, close names are suggested", async () => {
    const r = await cli(["model", "lst"], workspace());
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Commande inconnue : model lst. Vouliez-vous dire model list");
    const option = await cli(["model", "list", "--frobnicate"], workspace());
    expect(option.code).toBe(2);
    expect(option.stderr).toContain("Option inconnue : --frobnicate.");
  });

  test("SPEC-MOD-012/CA-12 — a family without operation (connector): its help is shown, no operation is executed", async () => {
    const ws = workspace();
    const before = snapshot(ws);
    const r = await cli(["connector"], ws, { userConfig: null });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Opérations :");
    expect(r.stdout).toContain("list");
    expect(snapshot(ws)).toEqual(before);
    const undelivered = await cli(["connector", "import", "fixture"], ws);
    expect(undelivered.code).toBe(2);
    expect(undelivered.stderr).toContain("Opération non disponible dans cette version : connector import.");
  });
});
