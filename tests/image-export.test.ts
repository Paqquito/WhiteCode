// Supports: SPEC-OBS-017/CA-01 (real message actions and native PNG rasterization), gap E-231.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { exportTerminalImage, terminalSvg } from "../src/ui/image-export";
import { spansToLines } from "../src/ui/text";
import { workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { imageInfo } from "../src/tools/image-header";
import { browserExecutable, openBrowserPipe } from "../src/platform/browser-pipe";

test("TECH — image SVG preserves colours and text styles while escaping markup and refusing excessive zones", () => {
  const cells = spansToLines([{ text: '<script> & "text"', style: { fg: { rgb: [255, 0, 0] }, bg: { rgb: [0, 0, 0] }, bold: true, italic: true, underline: true } }]);
  const image = terminalSvg(cells, 60);
  expect(image.svg).toContain('fill="#ff0000"');
  expect(image.svg).toContain('font-weight="bold"');
  expect(image.svg).toContain('font-style="italic"');
  expect(image.svg).toContain('text-decoration="underline"');
  expect(image.svg).not.toContain("<script>");
  expect(() => terminalSvg(Array.from({ length: 399 }, () => cells[0]!), 60)).toThrow("Zone trop grande");
});

test("TECH — an absent rasterizer saves an explicit SVG fallback and rechecks authority before writing", async () => {
  const ws = workspace(), options = { lines: spansToLines([{ text: "Safe export" }]), columns: 60, cwd: ws.project, environment: productEnv(ws), format: "png" as const, executable: null, assertAllowed: () => {} };
  const result = await exportTerminalImage(options);
  expect(result.fallback).toBe(true); expect(result.path).toEndWith(".svg");
  const before = readdirSync(ws.project);
  await expect(exportTerminalImage({ ...options, assertAllowed: () => { throw Error("Policy revoked"); } })).rejects.toThrow("Policy revoked");
  expect(readdirSync(ws.project)).toEqual(before);
  let checks = 0;
  await expect(exportTerminalImage({ ...options, assertAllowed: () => { if (++checks === 2) throw Error("Policy revoked before save"); } })).rejects.toThrow("Policy revoked before save");
  expect(checks).toBe(2); expect(readdirSync(ws.project)).toEqual(before);
});

test("SPEC-OBS-017/CA-01 — exporting the selected coloured response from its actions produces a real PNG with its styling and excludes other messages", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "**Selected reply**\n```ts\nconst amount = 17;\n```" }]);
  const run = interactive([], ws, { signal: controller.signal, provider });
  const waitFile = async (extension: string) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const file = readdirSync(ws.project).find(name => name.startsWith("conversation-") && name.endsWith(extension));
      if (file) return file;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error("No exported " + extension + " file\n" + run.screen().join("\n"));
  };
  try {
    await run.idle(); run.type("OUTSIDE_SELECTED_ZONE"); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Selected reply")); await run.idle();
    run.type("\u001bt"); run.type("s"); run.type("a");
    expect(run.screen().join("\n")).toContain("Exporter en PNG"); run.type("p");
    const png = await waitFile(".png"), bytes = readFileSync(ws.project + "/" + png);
    expect(imageInfo(bytes)).toMatchObject({ width: 1020, mediaType: "image/png" });
    run.type("a"); run.type("v"); const svg = readFileSync(ws.project + "/" + await waitFile(".svg"), "utf8");
    expect(svg).toContain('font-weight="bold"');
    expect(svg).toMatch(/fill="#[a-f0-9]{6}"/);
    const content = Array.from(svg.matchAll(/<text[^>]*>(.*?)<\/text>/g), match => match[1]).join("");
    expect(content).toContain("Selectedreply");
    expect(content).not.toContain("OUTSIDE_SELECTED_ZONE");
    const colors = [...new Set(Array.from(svg.matchAll(/fill="(#[a-f0-9]{6})"/g), match => match[1]!))];
    expect(colors.length).toBeGreaterThan(2);
    // Decode the saved PNG in a fresh native decoder and check actual foreground pixels against the SVG palette.
    const environment = productEnv(ws), executable = browserExecutable(environment);
    if (!executable) throw Error("Native image decoder unavailable");
    const decoder = openBrowserPipe({ executable, headless: true, env: environment, event: () => {} });
    try {
      const target = await decoder.send("Target.createTarget", { url: "about:blank" });
      const attached = await decoder.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const expression = `(async()=>{const image=new Image();image.src=${JSON.stringify("data:image/png;base64," + bytes.toString("base64"))};await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext("2d");context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;const colors=${JSON.stringify(colors)};const counts=colors.map(()=>0);for(let i=0;i<pixels.length;i+=4){const color="#"+[pixels[i],pixels[i+1],pixels[i+2]].map(v=>v.toString(16).padStart(2,"0")).join("");const index=colors.indexOf(color);if(index>=0)counts[index]++;}return counts;})()`;
      const decoded = await decoder.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, attached.sessionId);
      expect(decoded.exceptionDetails).toBeUndefined();
      const counts = decoded.result.value as number[];
      expect(counts[0]).toBeGreaterThan(0);
      expect(counts.slice(1).filter(count => count > 0).length).toBeGreaterThan(1);
    } finally { await decoder.close(); }
    expect(svg).not.toContain("<script");
    run.type(KEY.escape); run.type(KEY.escape); await run.idle(); run.type(KEY.ctrlD); run.type(KEY.ctrlD);
    expect((await run.done).code).toBe(0);
  } finally { controller.abort(); await run.done; }
}, 30000);
