// Supports: SPEC-INT-015 (actual Win32 application, real global shortcut and production CLI approval).
import { expect, test } from "bun:test";
import { dlopen } from "bun:ffi";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { ComputerControl, sessionScreenshot, type ComputerAccess } from "../src/integrations/computer-control";
import { openComputerDriver } from "../src/platform/computer-control";
import { TranscriptWriter } from "../src/session/transcript";
import { ContentStore } from "../src/session/content-store";
import { Settings } from "../src/config/settings";
import { buildFlag } from "../src/extension-points/build-flags";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ROOT, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const signal = () => new AbortController().signal;
async function fixture() {
  const child = spawn(process.execPath, ["--no-env-file", join(ROOT, "tests/fixtures/computer-window.ts")], { cwd: ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", serial = 0, errors = "", ready!: (value: { window: string; pid: number; title: string }) => void, rejectReady!: (error: Error) => void;
  const pending = new Map<number, (value: Record<string, unknown>) => void>(), opened = new Promise<{ window: string; pid: number; title: string }>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  child.stderr.on("data", part => { errors += String(part); }); child.on("error", rejectReady); child.on("exit", code => rejectReady(Error(`Native fixture exited: ${code}: ${errors}`)));
  child.stdout.setEncoding("utf8"); child.stdout.on("data", part => { buffer += part; for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (value.ready) ready(value); else { pending.get(value.id)?.(value); pending.delete(value.id); } } });
  const timeout = setTimeout(() => rejectReady(Error("Native window startup timed out.")), 10000); let target; try { target = await opened; } finally { clearTimeout(timeout); }
  const call = (action = "state", extra: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error("Native fixture response timed out.")); }, 3000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ id, action, ...extra }) + "\n"); });
  return { ...target, call, close: async () => { child.stdin.end(); await Promise.race([new Promise<void>(resolve => child.once("close", () => resolve())), sleep(1000)]); if (child.exitCode === null) child.kill(); } };
}
test.skipIf(process.platform !== "win32")("SPEC-INT-015/CA-01 — a model click displays application authorization before changing a real native control", async () => {
  expect(buildFlag("computer_control")).toBe(true); const f = await fixture(), ws = workspace(), abort = new AbortController();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "cnx_computer_control", input: { action: "click", window: f.window, x: 50, y: 30 } }] }, { text: "NATIVE_CLICK_DONE" }]);
  const run = interactive(["--model", "large"], ws, { provider, signal: abort.signal, columns: 160, userConfig: { integrations: { computerControl: { enabled: true } }, permissions: { allowRules: ["cnx_computer_control"] } } });
  try {
    await run.idle(); run.type("Click the fixture control."); run.type(KEY.enter); await run.waitFor(text => text.includes("Autoriser le pilotage de l’application")); expect((await f.call()).checked).toBe(0); expect(run.all().join("\n")).toContain(f.title);
    await sleep(380); run.type(KEY.down); run.type(KEY.down); run.type(KEY.enter); await run.waitFor(text => text.includes("NATIVE_CLICK_DONE"));
    // Supports: SPEC-INT-015 (a scripted continuation cannot establish that its preceding real action succeeded), gap E-336.
    const results = provider.requests.flatMap(request => request.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []));
    const parts = results.flatMap(result => [...result.content]), diagnostic = JSON.stringify(parts.filter(part => part.type === "text"));
    expect(results.length > 0 && results.every(result => !result.isError), diagnostic).toBe(true);
    expect((await f.call()).checked, diagnostic).toBe(1); expect(run.all().join("\n")).toContain("Ctrl+Alt+Pause");
    const image = parts.find(part => part.type === "image"); expect(image?.type).toBe("image"); if (image?.type === "image") expect(Buffer.from(image.dataBase64, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  finally { abort.abort(); await run.done; await f.close(); }
}, 20000);
test.skipIf(process.platform !== "win32")("SPEC-INT-015/CA-02 — the actual global stop shortcut cancels an in-flight native action in less than one second", async () => {
  const f = await fixture(), reports: string[] = [], control = new ComputerControl({ enabled: () => true, deniedApps: () => [], approve: async () => "full", report: message => reports.push(message) });
  try { const pending = control.run({ action: "type", window: f.window, text: "a".repeat(500) }, signal(), true); let entered = false; for (let i = 0; i < 100; i++) { if (String((await f.call()).text).length > 0) { entered = true; break; } await sleep(10); } expect(entered).toBe(true); const started = performance.now(); expect((await f.call("hotkey")).sent).toBe(6); const result = await pending; expect(performance.now() - started).toBeLessThan(1000); expect(control.stopped).toBe(true); expect(result).toMatchObject({ isError: true, errorKind: "interrupted" }); const before = String((await f.call()).text); expect(before.length).toBeGreaterThan(0); expect(before.length).toBeLessThan(500); await sleep(150); expect((await f.call()).text).toBe(before); expect((await control.run({ action: "click", window: f.window, x: 50, y: 30 }, signal())).isError).toBe(true); expect((await f.call()).checked).toBe(0); expect(reports.some(message => message.includes("arrêt d’urgence"))).toBe(true); }
  finally { control.close(); await f.close(); }
}, 15000);
test.skipIf(process.platform !== "win32")("TECH — actual window capture is bounded to its client area and persists neither directly nor through compaction content storage", async () => {
  const f = await fixture(), driver = openComputerDriver(() => {}), ws = workspace();
  try { const target = driver.inspect(f.window), png = Buffer.from(await driver.capture(target, signal())); expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); expect(png.readUInt32BE(16)).toBe(target.width); expect(png.readUInt32BE(20)).toBe(target.height); const chunks: Buffer[] = []; for (let offset = 8; offset < png.length;) { const length = png.readUInt32BE(offset); if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12; } expect(inflateSync(Buffer.concat(chunks)).some(byte => byte > 0)).toBe(true); const image = sessionScreenshot(png), writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project }); writer.append("tool_result", { callId: "native", isError: false, content: [image] }); writer.append("tool_result", { callId: "forked", isError: false, content: [structuredClone(image)] }); writer.append("compaction", { retained: [{ role: "user", parts: [{ type: "tool_result", callId: "native", isError: false, content: [image] }] }] }); writer.close(); expect(readFileSync(writer.path, "utf8")).not.toContain(image.dataBase64); const encoded = new ContentStore(join(ws.configHome, "images"), 1).encode([image]); expect(JSON.stringify(encoded)).not.toContain(image.dataBase64); expect(JSON.stringify(encoded)).toContain("screenshot omitted"); }
  finally { driver.close(); await f.close(); }
}, 20000);
test.skipIf(process.platform !== "win32")("TECH — native control refuses denied applications, a changed authorization target and insufficient access", async () => {
  const f = await fixture();
  try { for (const level of [undefined, "read"] as const) { const control = new ComputerControl({ enabled: () => true, deniedApps: () => [], approve: async () => level as ComputerAccess | undefined, report: () => {} }); try { expect((await control.run({ action: "click", window: f.window, x: 50, y: 30 }, signal())).isError).toBe(true); expect((await f.call()).checked).toBe(0); } finally { control.close(); } }
    let requested = false; const denied = new ComputerControl({ enabled: () => true, deniedApps: () => ["Owned Native Control Fixture"], approve: async () => { requested = true; return "full"; }, report: () => {} }); try { expect((await denied.run({ action: "capture", window: f.window }, signal(), true)).isError).toBe(true); expect(requested).toBe(false); } finally { denied.close(); }
    const changed = new ComputerControl({ enabled: () => true, deniedApps: () => [], approve: async () => { await f.call("rename", { title: "Changed Native Fixture" }); return "click"; }, report: () => {} }); try { expect((await changed.run({ action: "click", window: f.window, x: 50, y: 30 }, signal())).isError).toBe(true); expect((await f.call()).checked).toBe(0); } finally { changed.close(); }
  } finally { await f.close(); }
});
test.skipIf(process.platform !== "win32")("TECH — the real emergency shortcut cancels the native capture helper without publishing an image", async () => {
  const f = await fixture(), control = new ComputerControl({ enabled: () => true, deniedApps: () => [], approve: async () => "read", report: () => {} });
  const keyboard = dlopen("user32.dll", { SendInput: { args: ["u32", "buffer", "i32"], returns: "u32" }, SendMessageTimeoutW: { args: ["u64", "u32", "u64", "u64", "u32", "u32", "buffer"], returns: "u64" } });
  const keys = [[0x11, 0], [0x12, 0], [0x13, 0], [0x13, 2], [0x12, 2], [0x11, 2]], events = Buffer.alloc(keys.length * 40);
  keys.forEach(([key, flags], i) => { events.writeUInt32LE(1, i * 40); events.writeUInt16LE(key!, i * 40 + 8); events.writeUInt32LE(flags!, i * 40 + 12); });
  // Supports: SPEC-INT-015 (the keyboard must remain independent of a blocked captured application), gap E-334.
  try {
    expect((await f.call("block")).blocking).toBe(1500);
    const pending = control.run({ action: "capture", window: f.window }, signal(), true); await sleep(100);
    expect(Number(keyboard.symbols.SendMessageTimeoutW(BigInt(f.window), 0, 0n, 0n, 2, 25, Buffer.alloc(8)))).toBe(0);
    const started = performance.now(); expect(keyboard.symbols.SendInput(keys.length, events, 40)).toBe(6);
    const result = await pending; expect(performance.now() - started).toBeLessThan(1000); expect(result.errorKind).toBe("interrupted"); expect(result.content.some(part => part.type === "image")).toBe(false);
  } finally { keyboard.close(); control.close(); await f.close(); }
});
test.skipIf(process.platform !== "win32")("TECH — live managed application denial stops already approved native text input", async () => {
  const f = await fixture(); let denied: string[] = []; const control = new ComputerControl({ enabled: () => true, deniedApps: () => denied, approve: async () => "full", report: () => {} });
  try { const pending = control.run({ action: "type", window: f.window, text: "a".repeat(500) }, signal()); let entered = false; for (let i = 0; i < 100; i++) { if (String((await f.call()).text).length > 0) { entered = true; break; } await sleep(10); } expect(entered).toBe(true); denied = [f.title]; const result = await pending; expect(result.errorKind).toBe("permission_denied"); const before = String((await f.call()).text); expect(before.length).toBeLessThan(500); await sleep(100); expect((await f.call()).text).toBe(before); }
  finally { control.close(); await f.close(); }
});
test.skipIf(process.platform !== "win32")("TECH — native control fails closed when another actual process owns its emergency shortcut", async () => {
  const f = await fixture(); try { expect((await f.call("reserve_hotkey")).registered).toBe(1); expect(() => openComputerDriver(() => {})).toThrow("emergency shortcut"); expect((await f.call()).checked).toBe(0); } finally { await f.close(); }
});
test("TECH — project configuration cannot enable computer control or redefine managed application denials", () => {
  const settings = Settings.load({ sources: [{ scope: "project", name: "fixture", text: JSON.stringify({ integrations: { computerControl: { enabled: true, deniedApps: [] } } }) }], projectTrusted: true }); expect(settings.get<boolean>("integrations.computerControl.enabled")).toBe(false); expect(settings.get<string[]>("integrations.computerControl.deniedApps")).toContain("password");
});
