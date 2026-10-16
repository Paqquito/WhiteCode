// Implements: SPEC-OBS-017 (selected terminal cells to SVG and native PNG rasterization), gap E-231.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserExecutable, openBrowserPipe } from "../platform/browser-pipe";
import type { Cell } from "./text";
import type { Color } from "./style";

const xml = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[value]!);
const standard = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5", "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"];
function color(value: Color | undefined, fallback: string): string {
  if (!value) return fallback;
  if ("rgb" in value) return "#" + value.rgb.map(component => Math.max(0, Math.min(255, Math.round(component))).toString(16).padStart(2, "0")).join("");
  return standard[value.ansi % 16] ?? fallback;
}
export function terminalSvg(lines: readonly (readonly Cell[])[], columns: number): { svg: string; width: number; height: number } {
  if (!Number.isInteger(columns) || columns < 1 || columns > 400 || lines.length > 398) throw Error("Zone trop grande pour un export image (400 colonnes, 398 lignes au maximum).");
  const width = columns * 10 + 20, height = Math.max(1, lines.length) * 20 + 20, parts: string[] = [];
  const background = color(lines[0]?.[0]?.style?.bg, "#101820");
  for (let row = 0; row < lines.length; row++) {
    const cells = lines[row]!;
    for (let col = 0; col < Math.min(columns, cells.length); col++) {
      const cell = cells[col]!; if (cell.w === 0) continue;
      const style = cell.style ?? {}, foreground = color(style.fg, "#ebf0f5"), back = color(style.bg, background);
      const fg = style.inverse ? back : foreground, bg = style.inverse ? foreground : back;
      const x = 10 + col * 10, y = 10 + row * 20;
      if (bg !== background) parts.push(`<rect x="${x}" y="${y}" width="${cell.w * 10}" height="20" fill="${bg}"/>`);
      if (cell.ch.trim()) parts.push(`<text x="${x}" y="${y + 15}" fill="${fg}"${style.bold ? ' font-weight="bold"' : ""}${style.italic ? ' font-style="italic"' : ""}${style.dim ? ' opacity="0.65"' : ""}${style.underline || style.strike ? ` text-decoration="${[style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ")}"` : ""}>${xml(cell.ch)}</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${background}"/><g font-family="monospace" font-size="16" xml:space="preserve">${parts.join("")}</g></svg>`;
  if (Buffer.byteLength(svg) > 8 * 1024 * 1024) throw Error("Zone trop volumineuse pour un export image.");
  return { svg, width, height };
}
export async function exportTerminalImage(options: { lines: readonly (readonly Cell[])[]; columns: number; cwd: string; environment: Readonly<Record<string, string>>; format: "png" | "svg"; executable?: string | null; assertAllowed: () => void }): Promise<{ path: string; fallback: boolean }> {
  options.assertAllowed();
  const document = terminalSvg(options.lines, options.columns), name = "conversation-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const executable = options.executable === null ? undefined : options.executable ?? browserExecutable(options.environment);
  let png: Buffer | undefined;
  if (options.format === "png" && executable) {
    const browser = openBrowserPipe({ executable, headless: true, env: options.environment, event: () => {} });
    try {
      const target = await browser.send("Target.createTarget", { url: "about:blank" });
      const attached = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }), session = attached.sessionId as string;
      await browser.send("Page.enable", {}, session);
      await browser.send("Network.enable", {}, session);
      await browser.send("Network.setBlockedURLs", { urls: ["*"] }, session);
      await browser.send("Emulation.setDeviceMetricsOverride", { width: document.width, height: document.height, deviceScaleFactor: 1, mobile: false }, session);
      const frame = await browser.send("Page.getFrameTree", {}, session);
      await browser.send("Page.setDocumentContent", { frameId: frame.frameTree.frame.id, html: '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="margin:0">' + document.svg + "</body>" }, session);
      const captured = await browser.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: document.width, height: document.height, scale: 1 }, captureBeyondViewport: true }, session);
      const bytes = Buffer.from(captured.data, "base64");
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(16) !== document.width || bytes.readUInt32BE(20) !== document.height) throw Error("Image PNG incohérente.");
      png = bytes;
    } catch { /* The SVG remains available when the native rasterizer cannot complete. */ }
    finally { await browser.close(); }
  }
  const path = join(options.cwd, name + (png ? ".png" : ".svg"));
  options.assertAllowed();
  writeFileSync(path, png ?? document.svg, { flag: "wx", mode: 0o600 });
  return { path, fallback: options.format === "png" && !png };
}
