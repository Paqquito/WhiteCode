import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runToCompletion } from "../src/platform/process";
import { cli, loadIdentity, ROOT, workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const blueprint = () => JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
const brand = (file: string, ...args: string[]) => runToCompletion(BUN, [join(ROOT, "scripts/identity.ts"), ...args.slice(0, 1), file, ...args.slice(1)], { cwd: ROOT, env: { ...process.env } as Record<string, string>, timeoutMs: 10000 });

test("SPEC-CAD-002/CA-08 — standalone scan finds case, accent and separator variants with the file and position", () => {
  const ws = workspace();
  const identity = blueprint(); identity.compatibility = { forbiddenTerms: ["AncienNom"] };
  const file = ws.write("identity.json", JSON.stringify(identity));
  ws.write("delivery/a.md", "safe\nxx ancien_nom\n");
  ws.write("delivery/sub/b.md", "ANCIEN-NOM and Àncien nom\n");
  ws.write("delivery/positions.md", "\uFEFFé\u0301😀__ancien_nom\r\n");
  const result = brand(file, "scan", join(ws.root, "delivery"));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("ERR-12");
  expect(result.stderr).toContain("a.md:2:4");
  expect(result.stderr).toContain("sub/b.md:1:1");
  expect(result.stderr).toContain("sub/b.md:1:16");
  expect(result.stderr).toContain("positions.md:1:8");
});

test("SPEC-CAD-002/CA-09 — a justified scan exception applies only to its exact file and line", () => {
  const ws = workspace();
  const identity = blueprint(); identity.compatibility = { forbiddenTerms: ["AncienNom"], scanExceptions: [{ terme: "AncienNom", contexte: "a.md:2", justification: "Exemple de migration documenté à cette ligne." }] };
  const file = ws.write("identity.json", JSON.stringify(identity));
  ws.write("delivery/a.md", "safe\nancien_nom\n");
  expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(0);
  ws.write("delivery/a.md", "safe\nancien_nom\nancien_nom\n");
  const result = brand(file, "scan", join(ws.root, "delivery"));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("a.md:3:1");
  expect(result.stderr).not.toContain("a.md:2:1");
  identity.compatibility.scanExceptions[0].justification = "";
  ws.write("identity.json", JSON.stringify(identity));
  expect(brand(file, "scan", join(ws.root, "delivery")).stderr).toContain("ERR-05");
});

for (const language of ["de", "en-GB"]) test("SPEC-CAD-002/CA-19 — render falls back to the default language, warns and leaves its source unchanged", () => {
  const ws = workspace();
  const identity = blueprint(); identity.identity.PRODUCT = { fr: "Pilote Dev", en: "English Brand" };
  const file = ws.write("identity.json", JSON.stringify(identity));
  const source = ws.write("source/readme.md", "# {{PRODUCT}}\n");
  const before = readFileSync(source);
  const result = brand(file, "render", join(ws.root, "source"), join(ws.root, "rendered"), "--language", language);
  expect(result.code).toBe(0);
  expect(readFileSync(join(ws.root, "rendered/readme.md"), "utf8")).toBe("# Pilote Dev\n");
  expect(result.stderr).toContain("ERR-09");
  expect(readFileSync(source)).toEqual(before);
});

test("TECH — a normalized case expansion retains its source line and cannot use another line's exception", () => {
  const ws = workspace();
  const identity = blueprint(); identity.compatibility = { forbiddenTerms: ["SE"], scanExceptions: [{ terme: "SE", contexte: "a.md:2", justification: "Only the second line is allowed." }] };
  const file = ws.write("identity.json", JSON.stringify(identity));
  ws.write("delivery/a.md", "ß\ne");
  const result = brand(file, "scan", join(ws.root, "delivery"));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("a.md:1:1");
  expect(result.stderr).not.toContain("a.md:2:1");
});

for (const bigEndian of [false, true]) for (const prefix of [0, 1]) test("TECH — scan detects normalized UTF-16 strings in binary deliverables at both byte alignments", () => {
  const ws = workspace();
  const identity = blueprint(); identity.compatibility = { forbiddenTerms: ["AncienNom"] };
  const file = ws.write("identity.json", JSON.stringify(identity));
  const bytes = Buffer.from("ÀNCIEN_NOM", "utf16le");
  if (bigEndian) bytes.swap16();
  writeFileSync(ws.write("delivery/program.bin", ""), Buffer.concat([Buffer.alloc(prefix, 255), bytes]));
  const result = brand(file, "scan", join(ws.root, "delivery"));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(`program.bin:1:${prefix + 1}`);
});

test("TECH — rendering refuses nested, occupied and invalid outputs before writing any deliverable", () => {
  const ws = workspace();
  const file = ws.write("identity.json", JSON.stringify(blueprint()));
  const source = ws.write("source/a.md", "# {{PRODUCT}}\n");
  ws.write("occupied/keep.txt", "KEEP");
  expect(brand(file, "render", join(ws.root, "source"), join(ws.root, "occupied")).code).toBe(1);
  expect(readFileSync(join(ws.root, "occupied/keep.txt"), "utf8")).toBe("KEEP");
  expect(brand(file, "render", join(ws.root, "source"), join(ws.root, "source/nested")).code).toBe(1);
  expect(existsSync(join(ws.root, "source/nested"))).toBe(false);
  ws.write("source/b.md", "{{UNKNOWN_VARIABLE}}\n");
  expect(brand(file, "render", join(ws.root, "source"), join(ws.root, "invalid")).code).toBe(2);
  expect(existsSync(join(ws.root, "invalid"))).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("# {{PRODUCT}}\n");
});

test("TECH — binary UTF-16 scanning does not depend on zero bytes or invalid UTF-8", () => {
  const ws = workspace();
  const identity = blueprint(); identity.compatibility = { forbiddenTerms: ["南"] };
  const file = ws.write("identity.json", JSON.stringify(identity));
  writeFileSync(ws.write("delivery/program.bin", ""), Buffer.from("南", "utf16le"));
  const result = brand(file, "scan", join(ws.root, "delivery"));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("program.bin:1:1");
});

for (const caseConflict of [true, false]) test("TECH — rendered file collisions and file/directory conflicts fail before output creation", () => {
  const ws = workspace();
  const file = ws.write("identity.json", JSON.stringify(blueprint()));
  if (caseConflict) {
    ws.write("source/{{PRODUCT_SLUG}}.md", "first");
    ws.write("source/PILOTE-DEV.md", "second");
  } else {
    ws.write("source/{{PRODUCT_SLUG}}", "first");
    ws.write("source/pilote-dev/a.md", "second");
  }
  const result = brand(file, "render", join(ws.root, "source"), join(ws.root, "out"));
  expect(result.code).toBe(1);
  expect(existsSync(join(ws.root, "out"))).toBe(false);
});

test("TECH — canonically equivalent rendered filenames are refused before output creation on every platform", () => {
  const ws = workspace();
  const identity = blueprint(); identity.identity.PRODUCT = "Café";
  const file = ws.write("identity.json", JSON.stringify(identity));
  ws.write("source/{{PRODUCT}}.md", "first");
  ws.write("source/Cafe\u0301.md", "second");
  expect(brand(file, "render", join(ws.root, "source"), join(ws.root, "out")).code).toBe(1);
  expect(existsSync(join(ws.root, "out"))).toBe(false);
});

test("TECH — rendering never traverses a source symlink or junction", () => {
  const ws = workspace();
  const file = ws.write("identity.json", JSON.stringify(blueprint()));
  ws.write("source/a.md", "safe");
  ws.write("outside/secret.md", "STAYS OUTSIDE");
  symlinkSync(join(ws.root, "outside"), join(ws.root, "source/link"), process.platform === "win32" ? "junction" : "dir");
  const result = brand(file, "render", join(ws.root, "source"), join(ws.root, "out"));
  expect(result.code).toBe(1);
  expect(existsSync(join(ws.root, "out"))).toBe(false);
  expect(readFileSync(join(ws.root, "outside/secret.md"), "utf8")).toBe("STAYS OUTSIDE");
});

test("TECH — forbidden terms and exceptions reject malformed declarations rather than silently disabling checks", () => {
  const ws = workspace();
  for (const compatibility of ["malformed", { forbiddenTerms: "AncienNom" }, { forbiddenTerms: ["AncienNom", 1] }, { forbiddenTerms: ["___"] }, { scanExceptions: {} }]) {
    const identity = blueprint(); identity.compatibility = compatibility;
    const file = ws.write("identity.json", JSON.stringify(identity));
    expect(brand(file, "validate").code).toBe(2);
  }
});

test("TECH — nonportable rendered filenames are refused before any output", () => {
  const ws = workspace();
  const identity = blueprint(); identity.identity.PRODUCT = "bad:stream";
  const file = ws.write("identity.json", JSON.stringify(identity));
  ws.write("source/a.md", "safe");
  ws.write("source/{{PRODUCT}}.md", "unsafe");
  expect(brand(file, "render", join(ws.root, "source"), join(ws.root, "out")).code).toBe(1);
  expect(existsSync(join(ws.root, "out"))).toBe(false);
});

test("TECH — long rendered path components are refused before any output", () => {
  const ws = workspace();
  const identity = blueprint(); identity.identity.PRODUCT = "A".repeat(32); identity.identity.PRODUCT_SLUG = "portable-name";
  const file = ws.write("identity.json", JSON.stringify(identity));
  ws.write("source/a.md", "safe");
  ws.write(`source/${"{{PRODUCT}}".repeat(10)}.md`, "too long");
  expect(brand(file, "render", join(ws.root, "source"), join(ws.root, "out")).code).toBe(1);
  expect(existsSync(join(ws.root, "out"))).toBe(false);
});

test("TECH — compressed deliverables are inspected and unsupported or corrupt archives cannot pass the scan", () => {
  const ws = workspace();
  const identity = blueprint(); identity.compatibility = { forbiddenTerms: ["AncienNom"] };
  const file = ws.write("identity.json", JSON.stringify(identity));
  const archive = ws.write("delivery/data.gz", "");
  writeFileSync(archive, gzipSync("ancien_nom"));
  expect(brand(file, "scan", join(ws.root, "delivery")).stderr).toContain("data.gz:1:1");
  writeFileSync(archive, gzipSync(gzipSync("ancien_nom")));
  expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(2);
  writeFileSync(archive, Buffer.from([31, 139, 8, 0]));
  expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(1);
  writeFileSync(archive, gzipSync("safe"));
  ws.write("delivery/unsupported.zip", "not inspected");
  expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(1);
});

test("TECH — compressed scan bounds nesting and expanded content, including archives disguised as other files", () => {
  const ws = workspace();
  const file = ws.write("identity.json", JSON.stringify(blueprint()));
  const archive = ws.write("delivery/data.bin", "");
  let nested = Buffer.from("safe");
  for (let i = 0; i < 5; i++) nested = gzipSync(nested);
  writeFileSync(archive, nested);
  expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(1);
  writeFileSync(archive, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 120)));
  expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(1);
  for (const signature of ["504b0304", "425a68", "fd377a585a00", "28b52ffd", "377abcaf271c", "526172211a07"]) {
    writeFileSync(archive, Buffer.from(signature, "hex"));
    expect(brand(file, "scan", join(ws.root, "delivery")).code).toBe(1);
  }
});

test("SPEC-CAD-002/CA-12 — SERVICE_DOCS override reaches launch help and both diagnostics with its source", async () => {
  const ws = workspace();
  const env = productEnv(ws, { [`${loadIdentity().get("ENV_PREFIX")}SERVICE_DOCS`]: "https://docs.example.invalid/custom" });
  expect((await cli(["--help"], ws, { env })).stdout).toContain("https://docs.example.invalid/custom");
  for (const args of [["--non-interactive", "/diagnose"], ["diagnostic", "validate"]]) {
    const provider = new ScriptedProvider([]);
    const result = await cli(args, ws, { env, provider });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("SERVICE_DOCS : variable d'environnement");
    expect(provider.requests).toHaveLength(0);
  }
});

test("SPEC-CAD-002/CA-14 — a PRODUCT runtime override is ignored and ERR-13 appears in diagnostics", async () => {
  const ws = workspace();
  const env = productEnv(ws, { [`${loadIdentity().get("ENV_PREFIX")}PRODUCT`]: "Ignored Brand" });
  expect((await cli(["--help"], ws, { env })).stdout).toContain(loadIdentity().get("PRODUCT"));
  for (const args of [["--non-interactive", "/diagnose"], ["diagnostic", "validate"]]) {
    const result = await cli(args, ws, { env, provider: new ScriptedProvider([]) });
    expect(result.stdout).toContain("ERR-13");
    expect(result.stdout).not.toContain("Ignored Brand");
  }
});
