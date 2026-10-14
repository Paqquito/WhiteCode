// Supports: SPEC-OUT-002/CA-03, SPEC-MOT-006/CA-03, SPEC-IHM-010/CA-04, SPEC-INT-018, SPEC-SES-017.
import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { readFileTool } from "../src/tools/read-file";
import { imageInfo } from "../src/tools/image-header";
import { currentPlatform } from "../src/platform/system";
import { cli, testToolFields, workspace } from "./helpers/env";
import { png } from "./helpers/png";
import { prepareImage } from "../src/tools/image-resize";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { ContentStore } from "../src/session/content-store";
import { TranscriptWriter } from "../src/session/transcript";
import { InputHistory } from "../src/interactive/history";

test("TECH — content collection retains every session and history reference, then removes only verified unused blobs", () => {
  const ws = workspace(), sessions = join(ws.configHome, "sessions"), store = new ContentStore(join(ws.configHome, "content")), historyPath = join(ws.configHome, "input-history.jsonl");
  const a = "HISTORY_SHARED_302".padEnd(5000, "a"), b = "SESSION_ONLY_302".padEnd(6000, "b");
  const first = new TranscriptWriter({ sessionsDir: sessions, projectRealPath: ws.project }), second = new TranscriptWriter({ sessionsDir: sessions, projectRealPath: ws.project });
  first.append("user", { content: a }); second.append("user", { content: b }); first.close(); second.close();
  const history = new InputHistory({ path: historyPath, dir: ws.project, scope: "folder", maxEntries: 100, retentionDays: 30, enabled: true, warn: () => {} }); history.add(a);
  expect(store.collect(sessions, historyPath)).toBe(0);
  unlinkSync(first.path); expect(store.collect(sessions, historyPath)).toBe(0);
  unlinkSync(second.path); expect(store.collect(sessions, historyPath)).toBe(1);
  expect(history.entries()[0]?.text).toBe(a);
  history.clear(); expect(store.collect(sessions, historyPath)).toBe(1);
  expect(readdirSync(store.root).filter(name => name.endsWith(".blob"))).toHaveLength(0);
});

test("SPEC-OUT-002/CA-03 — a real 6000 by 4000 PNG is resized with its colour and transparency intact", async () => {
  const ws = workspace(), path = join(ws.project, "large.png"), source = png(6000, 4000);
  writeFileSync(path, source);
  const outcome = await readFileTool.execute({ path }, { ...testToolFields({ modelImages: true }), cwd: ws.project, home: ws.home, platform: currentPlatform(), allowedDirectories: [ws.project], signal: new AbortController().signal });
  expect(outcome.isError).toBe(false);
  const part = outcome.content.find(part => part.type === "image");
  expect(part?.type).toBe("image"); if (!part || part.type !== "image") throw new Error("Missing image");
  const bytes = Buffer.from(part.dataBase64, "base64"), info = imageInfo(bytes)!;
  expect(info.width).toBeLessThan(6000); expect(info.width).toBeLessThanOrEqual(2048);
  expect(Math.abs(info.width / info.height - 1.5)).toBeLessThan(.002);
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) { const size = bytes.readUInt32BE(offset); if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const pixels = inflateSync(Buffer.concat(compressed)), stride = info.width * 4 + 1;
  expect(pixels.length).toBe(stride * info.height);
  for (const y of [0, info.height - 1]) { expect(pixels[y * stride]).toBe(0); expect([...pixels.subarray(y * stride + 1, y * stride + 5)]).toEqual([222, 33, 99, 128]); }
  expect(outcome.content.filter(part => part.type === "text").map(part => part.text).join(" ")).toContain("resized");
}, 15_000);

test("SPEC-SES-017/CA-02 — a stored clipboard image is available to the model after reopening its session", async () => {
  const ws = workspace(), id = "33333333-3333-4333-8333-333333333333", controller = new AbortController(), source = png(32, 16);
  const first = new ScriptedProvider([{ text: "image saved" }]), run = interactive(["--model", "large", "--assign-session-id", id], ws, { provider: first, signal: controller.signal, extra: { readClipboardImage: async () => source } });
  try { await run.idle(); run.type("\u0016"); await run.waitFor(text => text.includes("32 × 16")); run.type(KEY.enter); await run.waitFor(text => text.includes("image saved")); }
  finally { controller.abort(); await run.done; }
  const second = new ScriptedProvider([{ text: "still available" }]);
  const result = await cli(["--non-interactive", `--reopen=${id}`, "Describe it again."], ws, { provider: second });
  if (result.code !== 0) throw new Error(`Reopening failed: ${result.stderr}`);
  expect(result.code).toBe(0);
  const image = second.requests[0]!.history.flatMap(message => message.role === "user" ? message.parts : []).find(part => part.type === "image");
  expect(image?.type).toBe("image"); if (!image || image.type !== "image") throw new Error("Image missing after reopening");
  expect(Buffer.from(image.dataBase64, "base64").equals(source)).toBe(true);
  expect(readdirSync(join(ws.configHome, "content")).filter(name => name.endsWith(".blob"))).toHaveLength(1);
}, 15_000);

test("SPEC-SES-017/CA-01 — the same ten-thousand-character paste in two sessions occupies one immutable blob", async () => {
  const ws = workspace(), content = "PASTE_CONTENT_402".padEnd(10_000, "x");
  for (const id of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) {
    const provider = new ScriptedProvider([{ text: "paste received" }]), controller = new AbortController();
    const run = interactive(["--assign-session-id", id], ws, { provider, signal: controller.signal });
    try { await run.idle(); run.paste(content); run.type(KEY.enter); await run.waitFor(text => text.includes("paste received")); expect(JSON.stringify(provider.requests[0]!.history)).toContain(content); }
    finally { controller.abort(); await run.done; }
  }
  const store = join(ws.configHome, "content"), files = readdirSync(store).filter(name => name.endsWith(".blob"));
  expect(files).toHaveLength(1); expect(readFileSync(join(store, files[0]!)).toString("utf8")).toBe(content);
  const history = readFileSync(join(ws.configHome, "input-history.jsonl"), "utf8");
  expect(history).not.toContain(content); expect(history).toContain("$contentRef");
}, 15_000);

test("TECH — PNG filters preserve their pixels and corrupted checksums or cancellation refuse preparation", async () => {
  for (const filter of [1, 2, 3, 4]) {
    const image = await prepareImage(png(2050, 6, [222, 33, 99, 128], filter));
    const bytes = image.bytes, compressed: Buffer[] = [];
    for (let offset = 8; offset < bytes.length;) { const size = bytes.readUInt32BE(offset); if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
    const decoded = inflateSync(Buffer.concat(compressed));
    expect([...decoded.subarray(1, 5)]).toEqual([222, 33, 99, 128]);
    expect([...decoded.subarray(decoded.length - 4)]).toEqual([222, 33, 99, 128]);
  }
  const corrupt = png(2050, 1); corrupt[29] = corrupt[29]! ^ 1;
  await expect(prepareImage(corrupt)).rejects.toThrow("checksum");
  await expect(prepareImage(png(2050, 1), AbortSignal.abort())).rejects.toThrow();
});

test("SPEC-INT-018/CA-01 — SPEC-IHM-010/CA-04 — SPEC-MOT-006/CA-03 — image paste shows its dimensions and bytes without sending, then sends a resized image", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "image received" }]), controller = new AbortController();
  const source = png(2400, 1200), run = interactive(["--model", "large"], ws, { provider, signal: controller.signal, extra: { readClipboardImage: async () => source } });
  try {
    await run.idle(); run.type("\u0016");
    await run.waitFor(text => text.includes("2048") && text.includes("1024") && text.includes("octets"), "clipboard image preview", 1500);
    expect(provider.requests).toHaveLength(0);
    run.type("Describe the image."); run.type(KEY.enter);
    await run.waitFor(text => text.includes("image received"));
    const parts = provider.requests[0]!.history.flatMap(message => message.role === "user" ? message.parts : []), part = parts.find(part => part.type === "image");
    expect(part?.type).toBe("image"); if (!part || part.type !== "image") throw new Error("Missing clipboard image");
    expect(imageInfo(Buffer.from(part.dataBase64, "base64"))).toMatchObject({ width: 2048, height: 1024 });
    expect(JSON.stringify(parts)).toContain("Describe the image.");
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("TECH — content collection refuses a reference file with a second physical name and preserves unreferenced blobs", () => {
  const ws = workspace(), store = new ContentStore(join(ws.configHome, "content"));
  const encoded = store.publish("long text ".repeat(1000), value => value) as { $contentRef: string };
  const history = ws.write("home/config/input-history.jsonl", "{}\n"), second = join(ws.root, "foreign-history.jsonl");
  const sessions = join(ws.configHome, "sessions"); mkdirSync(sessions, { recursive: true }); linkSync(history, second);
  expect(() => store.collect(sessions, history)).toThrow("Invalid reference file");
  expect(existsSync(join(store.root, encoded.$contentRef + ".blob"))).toBe(true);
  unlinkSync(second); expect(store.collect(sessions, history)).toBe(1);
});
