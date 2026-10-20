// Supports: SPEC-INT-011 (real MV3 extension, native messaging registration and current-user browser process).
import { expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { writeBrowserExtension } from "../../src/integrations/browser-extension";
import { installBrowserHost } from "../../src/platform/browser-native";
import { Identity } from "../../src/identity/identity";
import { workspace, loadIdentity, ROOT, type Workspace } from "./env";
import { sleep } from "./interactive";
export const nativeBrowserAvailable = process.platform === "win32" && existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe");
export async function nativeBrowserFixture(shared?: { ws: Workspace; slug: string; extension: string }) {
  const ws = shared?.ws ?? workspace(), slug = shared?.slug ?? "browser-fixture-" + crypto.randomUUID(), extension = shared?.extension ?? writeBrowserExtension(ws.configHome, slug, "Native Browser Fixture");
  const child = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--force-renderer-accessibility", "--lang=en-US", "--enable-unsafe-extension-debugging", "--remote-debugging-pipe", "--user-data-dir=" + join(ws.root, "browser-profile-" + crypto.randomUUID()), "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--window-size=900,700", "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>(); let buffer = Buffer.alloc(0), serial = 0, closed = false;
  const failure = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Fixture browser process closed.")); } pending.clear(); };
  child.on("error", failure); child.on("exit", failure); child.stderr!.on("data", () => {});
  const input = child.stdio[3] as Writable, output = child.stdio[4] as Readable; input.on("error", failure); output.on("error", failure);
  output.on("data", (bytes: Buffer) => { buffer = Buffer.concat([buffer, bytes]); if (buffer.length > 8 * 1024 * 1024) { failure(); return; } for (;;) { const end = buffer.indexOf(0); if (end < 0) break; const value = JSON.parse(buffer.subarray(0, end).toString()); buffer = buffer.subarray(end + 1); const item = pending.get(value.id); if (!item) continue; pending.delete(value.id); clearTimeout(item.timer); if (value.error) item.reject(Error(String(value.error.message))); else item.resolve(value.result ?? {}); } });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, any>>((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error("Fixture browser operation timed out: " + method)); }, 10000); pending.set(id, { resolve, reject, timer }); input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });
  let installation: ReturnType<typeof installBrowserHost> | undefined;
  const close = async () => { if (closed) return; closed = true; failure(); if (child.pid && child.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); input.destroy(); output.destroy(); installation?.removeNewRegistrations(); };
  try {
    const loaded = await send("Extensions.loadUnpacked", { path: extension }); expect(loaded.id).toMatch(/^[a-p]{32}$/); const id = String(loaded.id), installed = await send("Extensions.getExtensions"); expect(installed.extensions).toHaveLength(1); expect(installed.extensions[0]).toMatchObject({ id, enabled: true, path: extension });
    installation = installBrowserHost(ws.configHome, slug, id);
    let worker: Record<string, any> | undefined; for (let i = 0; i < 100 && !worker; i++) { const targets = await send("Target.getTargets"); worker = targets.targetInfos.find((target: Record<string, any>) => target.type === "service_worker" && String(target.url).startsWith(`chrome-extension://${id}/`)); if (!worker) await sleep(30); } if (!worker) throw Error("Fixture extension worker not started.");
    const workerSession = String((await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId);
    const evaluate = async (expression: string) => { const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, workerSession); if (value.exceptionDetails) throw Error("Fixture extension expression failed."); return value.result?.value; };
    const page = await send("Target.createTarget", { url: `chrome-extension://${id}/settings.html` }), pageSession = String((await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId);
    const pageEvaluate = async (expression: string) => { const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, pageSession); if (value.exceptionDetails) throw Error("Fixture extension settings expression failed."); return value.result?.value; };
    for (let i = 0; i < 100; i++) { if (await pageEvaluate("!!document.querySelector('#connect')")) break; await sleep(30); }
    const clickSetting = async (selector: "#allow" | "#remove" | "#connect") => { const box = await pageEvaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, pageSession); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, pageSession); };
    const allow = async (origin: string) => { if (new URL(origin).hostname !== "127.0.0.1") throw Error("Native fixture can grant only its loopback site."); await pageEvaluate("document.querySelector('#origin').value=" + JSON.stringify(origin)); await clickSetting("#allow");
      const script = readFileSync(join(ROOT, "tests/fixtures/browser-permission-uia.ps1"), "utf8"), program = "& {" + script + "} -BrowserProcess " + child.pid;
      const native = Bun.spawn(["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], { cwd: ws.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([new Response(native.stdout).text(), new Response(native.stderr).text(), native.exited]); if (code !== 0) throw Error("Owned native permission dialog refused: " + stderr.slice(-500)); expect(JSON.parse(stdout)).toMatchObject({ invoked: "Allow", process: child.pid, origin: "127.0.0.1" });
      for (let i = 0; i < 100; i++) { if (await evaluate(`chrome.storage.local.get('allowedOrigins').then(s=>s.allowedOrigins?.includes(${JSON.stringify(origin)})===true)`)) break; await sleep(30); } expect(await evaluate(`chrome.permissions.contains({origins:[${JSON.stringify(origin + "/*")} ]})`)).toBe(true); expect(await evaluate(`chrome.storage.local.get('allowedOrigins').then(s=>s.allowedOrigins?.includes(${JSON.stringify(origin)})===true)`)).toBe(true);
      // The owned fixture needs a drawable window; a hidden/minimized surface can stall native capture.
      await pageEvaluate("chrome.windows.getCurrent().then(w=>chrome.windows.update(w.id,{state:'normal',focused:true}))");
      expect(await pageEvaluate("chrome.windows.getCurrent().then(w=>w.state)")).toBe("normal");
    };
    const captureState = async (tab: number) => { if (!Number.isSafeInteger(tab) || tab < 1) throw Error("Invalid owned fixture tab."); return evaluate(`chrome.tabs.get(${tab}).then(async t=>{const w=await chrome.windows.get(t.windowId);return{active:t.active,status:t.status,windowState:w.state,focused:w.focused,nativeConnected:port!==undefined,busy}})`); };
    const prepareCapture = async (tab: number) => {
      const before = await captureState(tab);
      // Only this fixture's profile is reachable. Keep the controlled tab in the background.
      await evaluate(`chrome.tabs.get(${tab}).then(t=>chrome.windows.update(t.windowId,{${before.windowState === "minimized" ? "state:'normal'," : ""}focused:true}))`);
      const after = await captureState(tab); expect(["normal", "maximized", "fullscreen"]).toContain(after.windowState); expect(after.focused).toBe(true);
      return { before, after };
    };
    const previous = loadIdentity().resolved, identity = new Identity({ ...previous, values: { ...previous.values, PRODUCT_SLUG: { value: slug, origin: "provided" }, SERVICE_BROWSER_EXTENSION: { value: "https://extensions.fixture.test/" + id, origin: "provided" } } });
    return { ws, slug, id, identity, extension, send, evaluate, pageEvaluate, allow, captureState, prepareCapture, reconnect: () => clickSetting("#connect"), remove: async (origin: string) => { await pageEvaluate("document.querySelector('#origin').value=" + JSON.stringify(origin)); await clickSetting("#remove"); for (let i = 0; i < 100; i++) { if (await evaluate(`chrome.storage.local.get('allowedOrigins').then(s=>!s.allowedOrigins?.includes(${JSON.stringify(origin)}))`)) return; await sleep(30); } throw Error("Site permission was not removed."); }, close };
  } catch (error) { await close(); throw error; }
}
