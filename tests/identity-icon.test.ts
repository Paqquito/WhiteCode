// Supports: SPEC-CAD-002 (EF-04 resources relative to the identity file, ERR-10, § 6.3.8 ICON with its neutral default).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIdentityText } from "../src/identity/resolver";
import { DEFAULT_ICON_SVG, loadIcon } from "../src/identity/resources";
import { ROOT } from "./helpers/env";

const source = () => JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
const png = (width: number, height: number) => {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8); data.write("IHDR", 12, "latin1"); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
};
function brand(icon?: string, files: Record<string, string | Buffer> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "brand-icon-")), input = source();
  if (icon !== undefined) input.visual.ICON = icon;
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), content); }
  const file = join(dir, "brand.identity.json"); writeFileSync(file, JSON.stringify(input));
  return { dir, file, result: resolveIdentityText(JSON.stringify(input), { version: "0.1.0", strict: true }) };
}

test("TECH — SPEC-CAD-002 § 6.3.8: without ICON the neutral default is a plain black square", () => {
  const { file, result } = brand();
  const loaded = loadIcon(result.identity!, file);
  expect(loaded.issues).toEqual([]);
  expect(loaded.icon).toMatchObject({ format: "svg", source: null });
  expect(loaded.icon!.data.toString("utf8")).toBe(DEFAULT_ICON_SVG);
  expect(DEFAULT_ICON_SVG).toContain('fill="#000000"');
});

test("TECH — SPEC-CAD-002 EF-04: ICON is read relative to the identity file, as SVG or PNG of at least 512 px", () => {
  const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n';
  const vector = brand("assets/icon.svg", { "assets/icon.svg": svg });
  expect(loadIcon(vector.result.identity!, vector.file).icon).toMatchObject({ format: "svg", source: expect.stringContaining("icon.svg") });
  const raster = brand("assets/icon.png", { "assets/icon.png": png(512, 1024) });
  expect(loadIcon(raster.result.identity!, raster.file).icon?.format).toBe("png");
});

test("TECH — SPEC-CAD-002 ERR-10: a missing, too small or malformed icon stops validation", () => {
  const cases = [
    brand("assets/missing.svg"),
    brand("assets/small.png", { "assets/small.png": png(256, 256) }),
    brand("assets/fake.png", { "assets/fake.png": "not a png" }),
    brand("assets/fake.svg", { "assets/fake.svg": "<html></html>" }),
    brand("assets/empty.svg", { "assets/empty.svg": "" }),
  ];
  for (const { file, result } of cases) {
    const loaded = loadIcon(result.identity!, file);
    expect(loaded.icon).toBeUndefined();
    expect(loaded.issues.map(issue => issue.code)).toEqual(["ERR-10"]);
    expect(loaded.issues[0]!.message).toContain("Ressource `ICON` introuvable ou format non pris en charge");
  }
});

test("TECH — SPEC-CAD-002 EF-04: ICON must be a relative path inside the identity folder, ending in .svg or .png", () => {
  for (const icon of ["../outside.svg", "assets/../../outside.svg", "/abs/icon.svg", "C:/abs/icon.svg", "assets/icon.gif"]) {
    const { result } = brand(icon);
    expect(result.identity).toBeUndefined();
    expect(result.issues.some(issue => issue.code === "ERR-05" && issue.path === "ICON")).toBe(true);
  }
});

test("TECH — SPEC-CAD-002 ERR-10: the brand tool refuses an identity whose icon is missing", () => {
  const { file } = brand("assets/missing.svg");
  const run = Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "scripts/identity.ts"), "validate", file], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(2);
  expect(run.stderr.toString()).toContain("[ERR-10]");
  const ok = brand();
  expect(Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "scripts/identity.ts"), "validate", ok.file], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
});
