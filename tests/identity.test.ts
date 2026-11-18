import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveIdentity, resolveIdentityText } from "../src/identity/resolver";
import { renderTemplate } from "../src/identity/template";
import { cli, loadIdentity, ROOT, workspace } from "./helpers/env";

const MINIMAL = {
  schemaVersion: 1,
  defaultLanguage: "fr",
  identity: { SOCIETY: "Acme", SOCIETY_DOMAIN: "acme.example", PRODUCT: "FreeCode" },
  models: { MODEL_MEDIUM: { label: "Standard", ids: { anthropic: "model-id" } } },
  services: { SERVICE_DOCS: "https://docs.acme.example/freecode", SERVICE_DOWNLOADS: "https://downloads.acme.example/freecode" },
  visual: { BRAND_COLOR_PRIMARY: "#3355FF" },
};

const clone = <T>(v: T): T => structuredClone(v);
const value = (r: ReturnType<typeof resolveIdentity>, name: string) => {
  const v = r.identity?.values[name]?.value;
  return typeof v === "string" ? v : v?.[r.identity!.defaultLanguage];
};

describe("SPEC-CAD-002 identity", () => {
  test("desktop catalogues and native modules contribute to the validated identity", () => {
    const catalog = { repository: "https://git.example/team/catalog.git", ref: "v1.0" };
    const desktop = { modules: ["sample"], extensionCatalogs: [catalog] };
    const resolve = (options: unknown) => resolveIdentity({ ...MINIMAL, desktop: options }, { version: "1" });
    expect(resolve(desktop).identity?.desktop).toEqual(desktop);
    expect(resolve(desktop).identity?.hash).not.toBe(resolve({}).identity?.hash);
    for (const invalid of [{ modules: ["../sample"] }, { modules: ["x", "x"] }, { extra: true },
      { extensionCatalogs: [{ ...catalog, repository: "file:///tmp/project" }] },
      { extensionCatalogs: [{ ...catalog, ref: "-x" }] }]) {
      expect(resolve(invalid).issues).toContainEqual(expect.objectContaining({ path: "$.desktop", severity: "error" }));
    }
  });
  test("SPEC-CAD-002/CA-01 — a file with only the primary variables validates and every derived variable is set", () => {
    const r = resolveIdentity(clone(MINIMAL), { version: "1.0.0" });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    for (const name of ["SOCIETY_SLUG", "PRODUCT_SLUG", "PRODUCT_CLI", "PRODUCT_BUNDLE_ID", "CONFIG_DIR", "PROJECT_DIR", "INSTRUCTIONS_FILE", "ENV_PREFIX", "URL_SCHEME", "USER_AGENT", "HTTP_HEADER_PREFIX", "TELEMETRY_EVENT_PREFIX", "GIT_COAUTHOR_EMAIL", "BRAND_COLOR_ACCENT", "IDENTITY_STATEMENT", "NATIVE_HOST_NAME"]) {
      expect(value(r, name)).toBeTruthy();
    }
    expect(r.identity!.modelDefault).toBe("MODEL_MEDIUM");
    expect(r.identity!.modelBackground).toBe("MODEL_MEDIUM");
  });

  test("SPEC-CAD-002/CA-02 — derivations of a two-word product name", () => {
    const data = clone(MINIMAL);
    data.identity.PRODUCT = "Free Code";
    const r = resolveIdentity(data, { version: "1.0.0" });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(value(r, "PRODUCT_SLUG")).toBe("free-code");
    expect(value(r, "ENV_PREFIX")).toBe("FREE_CODE_");
    expect(value(r, "INSTRUCTIONS_FILE")).toBe("free-code.instructions.md");
  });

  test("E-028 — NATIVE_HOST_NAME derivation satisfies its constraint for a hyphenated slug", () => {
    const data = clone(MINIMAL);
    data.identity.PRODUCT = "Free Code";
    expect(value(resolveIdentity(data, { version: "1.0.0" }), "NATIVE_HOST_NAME")).toMatch(/^[a-z0-9_.]+$/);
  });

  test("SPEC-CAD-002/CA-03 — an explicitly provided PRODUCT_CLI is kept", () => {
    const data = clone(MINIMAL) as Record<string, any>;
    data.identity.PRODUCT_CLI = "fcode";
    expect(value(resolveIdentity(data, { version: "1.0.0" }), "PRODUCT_CLI")).toBe("fcode");
  });

  test("SPEC-CAD-002/CA-04 — SOCIETY missing: ERR-04 lists it and the brand tool exits with code 2", async () => {
    const data = clone(MINIMAL) as Record<string, any>;
    delete data.identity.SOCIETY;
    const r = resolveIdentity(data, { version: "1.0.0" });
    const err = r.issues.find((i) => i.code === "ERR-04");
    expect(err?.message).toContain("SOCIETY");
    const ws = workspace();
    const file = join(ws.root, "id.json");
    writeFileSync(file, JSON.stringify(data));
    const proc = Bun.spawn([process.execPath, join(ROOT, "scripts/identity.ts"), "validate", file], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("ERR-04");
  });

  test("SPEC-CAD-002/CA-05 — a circular reference is reported with its cycle", () => {
    const data = clone(MINIMAL) as Record<string, any>;
    data.identity.SOCIETY_LEGAL = "{{PRODUCT_TAGLINE}}";
    data.identity.PRODUCT_TAGLINE = "{{SOCIETY_LEGAL}}";
    const r = resolveIdentity(data, { version: "1.0.0" });
    const cycle = r.issues.find((i) => i.code === "ERR-08");
    expect(r.identity).toBeUndefined();
    expect(cycle?.message).toMatch(/SOCIETY_LEGAL → PRODUCT_TAGLINE → SOCIETY_LEGAL|PRODUCT_TAGLINE → SOCIETY_LEGAL → PRODUCT_TAGLINE/);
  });

  test("SPEC-CAD-002/CA-06 — transforms apply and the escape sequence yields a literal variable", () => {
    const out = renderTemplate("{{PRODUCT|upper}} / \\{{PRODUCT}}", { lookup: (n) => (n === "PRODUCT" ? "FreeCode" : undefined) });
    expect(out).toBe("FREECODE / {{PRODUCT}}");
  });

  test("SPEC-CAD-002/CA-15 — ENV_PREFIX equal to a public provider prefix is rejected (RG-05)", () => {
    const data = clone(MINIMAL) as Record<string, any>;
    data.identifiers = { ENV_PREFIX: "ANTHROPIC_" };
    const r = resolveIdentity(data, { version: "1.0.0" });
    expect(r.identity).toBeUndefined();
    expect(r.issues.some((i) => i.message.includes("ENV_PREFIX"))).toBe(true);
  });

  test("SPEC-CAD-002/CA-17 — a secret-looking key fails with ERR-17", () => {
    const data = clone(MINIMAL) as Record<string, any>;
    data.services.apiKey = "abc";
    const r = resolveIdentity(data, { version: "1.0.0" });
    expect(r.identity).toBeUndefined();
    expect(r.issues[0]?.code).toBe("ERR-17");
  });

  test("SPEC-CAD-002/CA-18 — resolving the same file twice yields the same fingerprint", () => {
    const text = JSON.stringify(MINIMAL);
    const a = resolveIdentityText(text, { version: "1.0.0" }).identity!;
    const b = resolveIdentityText(text, { version: "1.0.0" }).identity!;
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("SPEC-CAD-002/CA-20 — the version output shows product, version and society, for two identities", async () => {
    for (const file of ["identity/dev.identity.json", "identity/test-omega.identity.json"]) {
      const identity = loadIdentity(file);
      const r = await cli(["--version"], workspace(), { identity });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${identity.get("PRODUCT")} 0.1.0 — ${identity.get("SOCIETY")}\n`);
    }
  });

  test("TECH — invalid JSON reports line and column (ERR-02)", () => {
    const r = resolveIdentityText('{\n  "schemaVersion": 1,\n  oops\n}', { version: "1" });
    expect(r.issues[0]?.code).toBe("ERR-02");
    expect(r.issues[0]?.message).toContain("ligne 3");
  });
});

describe("SPEC-CAD-002 runtime catalogue", () => {
  test("SPEC-CAD-002/CA-13 — managed services win over environment overrides in actual help and diagnostics", async () => {
    const ws = workspace(), identity = loadIdentity();
    ws.write("managed/policy.json", JSON.stringify({ identity: { services: { SERVICE_DOCS: "https://managed-docs.example/help" } } }));
    const env = { [`${identity.get("ENV_PREFIX")}SERVICE_DOCS`]: "https://environment-docs.example/help" };
    const help = await cli(["--help"], ws, { identity, env });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("https://managed-docs.example/help");
    expect(help.stdout).not.toContain("https://environment-docs.example/help");
    const diagnostic = await cli(["diagnostic", "validate"], ws, { identity: loadIdentity(), env });
    expect(diagnostic.stdout).toContain("SERVICE_DOCS : paramètre géré");
  });

  test("TECH — user identity services cannot replace distribution or managed services", async () => {
    const identity = loadIdentity();
    const result = await cli(["--non-interactive", "/diagnose"], workspace(), { identity, userConfig: { identity: { services: { SERVICE_DOCS: "https://user-docs.example/help" } } } });
    expect(result.stderr).toContain("`identity.services` n'est pas autorisé");
    expect(identity.get("SERVICE_DOCS")).not.toContain("user-docs.example");
  });

  test("TECH — an invalid mandatory managed service blocks the agent before a model call", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ policy: { requiredKeys: ["identity.services"] }, identity: { services: { SERVICE_DOCS: "http://remote-docs.example/help" } } }));
    const result = await cli(["--non-interactive", "x"], ws);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("identity.services");
  });
  test("TECH — the runtime catalogue agrees with the build-time catalogue on overridable variables", async () => {
    const { VARIABLES } = await import("../src/identity/catalog");
    const { OVERRIDABLE_VARIABLES } = await import("../src/identity/runtime-catalog");
    expect([...OVERRIDABLE_VARIABLES].sort()).toEqual(VARIABLES.filter((v) => v.overridable).map((v) => v.name).sort());
  });

  test("TECH — overrides: an https service URL from the environment applies, a non-overridable variable is reported (ERR-13)", () => {
    const id = loadIdentity();
    id.applyOverrides({ SERVICE_DOCS: "https://docs.other.example", PRODUCT: "Autre", SERVICE_STATUS: "http://evil.example" });
    expect(id.get("SERVICE_DOCS")).toBe("https://docs.other.example");
    expect(id.get("PRODUCT")).not.toBe("Autre");
    expect(id.warnings.map((w) => w.code).sort()).toEqual(["ERR-13", "ERR-14"]);
  });
});

describe("E-036 Windows paths in derivations", () => {
  test("E-036 — managed Windows folder and registry key are resolved (a backslash before a variable is not the escape)", () => {
    const r = resolveIdentity(clone(MINIMAL), { version: "1.0.0" });
    expect(value(r, "MANAGED_DIR_WINDOWS")).toBe("C:\\ProgramData\\FreeCode");
    expect(value(r, "MANAGED_REGISTRY_KEY")).toBe("SOFTWARE\\Policies\\Acme\\FreeCode");
    expect(renderTemplate("a\\\\{{PRODUCT}} b\\{{PRODUCT}}", { lookup: () => "X" })).toBe("a\\X b{{PRODUCT}}");
  });

  test("E-036 — a value still holding a variable after resolution is rejected", () => {
    const data = clone(MINIMAL) as Record<string, any>;
    data.identity.PRODUCT_TAGLINE = "\\{{PRODUCT}}";
    const r = resolveIdentity(data, { version: "1.0.0" });
    expect(r.identity).toBeUndefined();
    expect(r.issues.some((i) => i.code === "ERR-06" && i.path === "PRODUCT_TAGLINE")).toBe(true);
  });
});
