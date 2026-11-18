// Supports: SPEC-INT-011 (real installed extension, native host, MCP transport and sensitive-action refusal).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserBridge, type BrowserControlInput } from "../src/integrations/browser-bridge";
import { currentPlatform } from "../src/platform/system";
import type { ToolOutcome } from "../src/tools/types";
import { nativeBrowserAvailable, nativeBrowserFixture } from "./helpers/native-browser";
import { testToolFields } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import type { ModelRequest } from "../src/providers/types";
import { nativeBrowserMessages } from "../src/platform/browser-native";
import { endianness } from "node:os";
import { ROOT } from "./helpers/env";

const text = (value: ToolOutcome) => value.content.filter(part => part.type === "text").map(part => part.text).join("\n");
const data = (value: ToolOutcome): any => { expect(value.isError, text(value)).toBe(false); return JSON.parse(text(value).split("\n").slice(1).join("\n")); };
const ref = (page: { text: string }, label: string) => { const line = page.text.split("\n").find(line => line.includes(label)); expect(line).toBeDefined(); return /^\[([^\]]+)\]/.exec(line!)![1]!; };
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 6000) { const deadline = Date.now() + timeoutMs; while (!predicate()) { if (Date.now() > deadline) throw Error(message); await sleep(30); } }

test.skipIf(!nativeBrowserAvailable)("TECH — an installed real extension publishes MCP navigation, reads its actual page and captures its controlled tab", async () => {
  const fixture = await nativeBrowserFixture();
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<h1>Native browser marker</h1><button onclick="this.textContent=\'Changed through native messaging\'">Safe action</button><script>console.log("NATIVE_CONSOLE_MARKER")</script>', { headers: { "content-type": "text/html" } }) });
  const origin = `http://127.0.0.1:${site.port}`;
  let allowed = true;
  const bridge = new BrowserBridge({ configDir: fixture.ws.configHome, slug: fixture.slug, product: "Native Browser Fixture", extensionId: () => fixture.id, permitted: () => allowed, changed: () => {} });
  try {
    await fixture.allow(origin); await bridge.start(); await fixture.reconnect(); await waitFor(() => bridge.connected, "Actual extension native host did not attach.");
    const tool = await bridge.tool(); expect(tool?.name).toBe("cnx_browser_control");
    const context = { ...testToolFields(), platform: currentPlatform(), home: fixture.ws.home, cwd: fixture.ws.project, allowedDirectories: [fixture.ws.project], signal: new AbortController().signal, modelImages: true };
    const call = (input: BrowserControlInput) => tool!.execute(input, context);
    const tab = data(await call({ action: "navigate", url: origin })).id;
    const page = data(await call({ action: "read", tab })); expect(JSON.stringify(page)).toContain("Native browser marker");
    const button = ref(page, "Safe action"); expect(button).toMatch(/^[a-f0-9-]{36}:\d+$/);
    expect((await call({ action: "click", tab, ref: button })).isError).toBe(false);
    expect(text(await call({ action: "read", tab }))).toContain("Changed through native messaging");
    expect(text(await call({ action: "console", tab }))).toContain("NATIVE_CONSOLE_MARKER");
    const preparation = await fixture.prepareCapture(tab), screenshot = await call({ action: "screenshot", tab });
    const captureDiagnostic = screenshot.isError ? JSON.stringify({ preparation, current: await fixture.captureState(tab).catch(error => ({ unavailable: String(error) })) }) : "";
    expect(screenshot.isError, text(screenshot) + captureDiagnostic).toBe(false); const image = screenshot.content.find(part => part.type === "image"); expect(image?.type).toBe("image"); if (image?.type === "image") expect(Buffer.from(image.dataBase64, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await fixture.evaluate(`chrome.tabs.get(${tab}).then(t=>t.groupId>=0)`)).toBe(true);
    allowed = false; expect((await call({ action: "read", tab })).isError).toBe(true); expect(await bridge.tool()).toBeUndefined();
  } finally { await bridge.close(); await fixture.close(); site.stop(true); }
}, 40000);

test.skipIf(!nativeBrowserAvailable)("TECH — an actual minimized browser capture times out without losing its client when the window returns", async () => {
  const fixture=await nativeBrowserFixture(),site=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("<h1>NATIVE_LATE_CAPTURE_64</h1>",{headers:{"content-type":"text/html"}})}),origin=`http://127.0.0.1:${site.port}`;
  const bridge=new BrowserBridge({configDir:fixture.ws.configHome,slug:fixture.slug,product:"Late capture fixture",extensionId:()=>fixture.id,permitted:()=>true,changed:()=>{}});
  try{
    await fixture.allow(origin);await bridge.start();await fixture.reconnect();await waitFor(()=>bridge.connected,"Owned native browser did not connect.");
    const client=bridge.clients[0]!.id,tool=(await bridge.tool())!,context={...testToolFields(),platform:currentPlatform(),home:fixture.ws.home,cwd:fixture.ws.project,allowedDirectories:[fixture.ws.project],signal:new AbortController().signal,modelImages:true};
    const call=(input:BrowserControlInput)=>tool.execute(input,context),tab=data(await call({action:"navigate",url:origin})).id;
    await fixture.evaluate(`chrome.tabs.get(${tab}).then(t=>chrome.windows.update(t.windowId,{state:'minimized'}))`);
    const expired=await call({action:"screenshot",tab});expect(expired.isError).toBe(true);expect(text(expired)).toContain("timed out");
    await fixture.evaluate(`chrome.tabs.get(${tab}).then(async t=>{await chrome.windows.update(t.windowId,{state:'normal',focused:true});await chrome.tabs.update(t.id,{active:true});})`);
    const deadline=Date.now()+6000;while(await fixture.evaluate("busy")){if(Date.now()>deadline)throw Error("Owned browser capture did not return after restoration.");await sleep(30);}
    // The read crosses the same native response stream after the expired capture, without another connection.
    const restored=await call({action:"read",tab});expect(restored.isError,text(restored)).toBe(false);expect(text(restored)).toContain("NATIVE_LATE_CAPTURE_64");expect(bridge.clients.map(item=>item.id)).toEqual([client]);
    const screenshot=await call({action:"screenshot",tab});expect(screenshot.isError,text(screenshot)).toBe(false);expect(screenshot.content.some(part=>part.type==="image")).toBe(true);
  }finally{await bridge.close();await fixture.close();site.stop(true);}
},40000);

test.skipIf(!nativeBrowserAvailable)("TECH — two actual browser profiles require selection and disconnect never silently selects the other profile", async () => {
  const first = await nativeBrowserFixture(); let second: Awaited<ReturnType<typeof nativeBrowserFixture>> | undefined;
  const bridge = new BrowserBridge({ configDir: first.ws.configHome, slug: first.slug, product: "Native Browser Fixture", extensionId: () => first.id, permitted: () => true, changed: () => {} });
  try {
    await bridge.start(); await first.reconnect(); await waitFor(() => bridge.connected, "First real browser did not connect."); const firstClient = bridge.clients[0]!.id;
    second = await nativeBrowserFixture(first); expect(second.id).toBe(first.id); await second.reconnect(); await waitFor(() => bridge.clients.length === 2, "Second real browser did not connect."); expect(bridge.connected).toBe(false); expect(await bridge.tool()).toBeUndefined();
    // Supports: SPEC-INT-011 (forced host exit needs the existing 5 s lease plus its 2 s sweep), gap E-324.
    bridge.select(firstClient); expect(bridge.connected).toBe(true); expect((await bridge.tool())?.name).toBe("cnx_browser_control"); await first.close(); await waitFor(() => bridge.clients.length === 1, "Selected real browser did not detach.", 8000); expect(bridge.connected).toBe(false); expect(await bridge.tool()).toBeUndefined();
    bridge.select(bridge.clients[0]!.id); expect(bridge.connected).toBe(true);
    const child = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "tests/fixtures/browser-bridge-child.ts"), first.ws.configHome, first.slug, first.id], { cwd: first.ws.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect(err).toBe(""); expect(code).toBe(0); expect(out.trim()).toBe("Native profile ownership refused."); expect(bridge.connected).toBe(true);
  } finally { await bridge.close(); await second?.close(); await first.close(); }
}, 40000);

test("TECH — native messaging rejects truncated, oversized, invalid UTF-8 and non-object frames without interpreting them", async () => {
  const header = (size: number) => { const value = Buffer.alloc(4); if (endianness() === "LE") value.writeUInt32LE(size); else value.writeUInt32BE(size); return value; };
  const collect = async (bytes: Buffer) => { const values = []; for await (const value of nativeBrowserMessages((async function* () { yield bytes; })())) values.push(value); return values; };
  const frame = Buffer.from('{"type":"hello","version":1}'); expect(await collect(Buffer.concat([header(frame.length), frame]))).toEqual([{ type: "hello", version: 1 }]);
  await expect(collect(header(1048577))).rejects.toThrow("frame size"); await expect(collect(Buffer.concat([header(3), Buffer.from("{}")]))).rejects.toThrow("Truncated"); await expect(collect(Buffer.concat([header(2), Buffer.from([255, 255])]))).rejects.toThrow(); await expect(collect(Buffer.concat([header(2), Buffer.from("[]")]))).rejects.toThrow("message");
});

test("TECH — the actual native-host entry point refuses a different extension origin before exposing any local channel", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "src/main.ts"), "--browser-native-host", ROOT, "fixture.browser", "a".repeat(32), "chrome-extension://" + "b".repeat(32) + "/"], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect(code).toBe(1); expect(out).toBe(""); expect(err).toBe("");
});

test.skipIf(!nativeBrowserAvailable)("SPEC-INT-011/CA-01 — /browser exposes navigation from the installed extension to a live CLI conversation and removes it on disconnect", async () => {
  const fixture = await nativeBrowserFixture(), controller = new AbortController();
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<h1>REAL_CLI_BROWSER_PAGE</h1>", { headers: { "content-type": "text/html" } }) }), origin = `http://127.0.0.1:${site.port}`;
  const lastResult = (request: ModelRequest) => request.history.flatMap(message => message.role === "user" ? message.parts : []).filter(part => part.type === "tool_result").at(-1)!;
  let tab = 0, captureDiagnostic: unknown;
  const provider = new ScriptedProvider([
    request => { expect(request.tools.map(tool => tool.name)).toContain("cnx_browser_control"); return { toolCalls: [{ name: "use_skill", input: { name: "browser-control" } }] }; },
    () => ({ toolCalls: [{ name: "cnx_browser_control", input: { action: "navigate", url: origin } }] }),
    request => { const previous = lastResult(request); expect(previous.isError).toBe(false); tab = data(previous).id; return { toolCalls: [{ name: "cnx_browser_control", input: { action: "read", tab } }] }; },
    request => { expect(text(lastResult(request))).toContain("REAL_CLI_BROWSER_PAGE"); return { toolCalls: [{ name: "cnx_browser_control", input: { action: "screenshot", tab } }] }; },
    request => { expect(lastResult(request).content.some(part => part.type === "image"), JSON.stringify(captureDiagnostic)).toBe(true); return { text: "Native browser CLI verified." }; },
    request => { expect(request.tools.map(tool => tool.name)).not.toContain("cnx_browser_control"); return { text: "Browser disconnected verified." }; },
  ]);
  const stream = provider.stream.bind(provider);
  provider.stream = async function* (request, signal) {
    if (provider.requests.length === 3) captureDiagnostic = { preparation: await fixture.prepareCapture(tab) };
    if (provider.requests.length === 4) captureDiagnostic = { preparation: captureDiagnostic, current: await fixture.captureState(tab).catch(error => ({ unavailable: String(error) })) };
    yield* stream(request, signal);
  };
  let run: ReturnType<typeof interactive> | undefined;
  try {
    await fixture.allow(origin);
    run = interactive(["--model", "large", "--allow-rule", "cnx_browser_control"], fixture.ws, { provider, identity: fixture.identity, signal: controller.signal, userConfig: { browser: { extensionId: fixture.id } } });
    await run.idle(); run.type("/browser\r"); await run.waitFor(text => text.includes("Autorisez chaque origine exacte"), "browser activation"); await fixture.reconnect(); await run.waitFor(text => text.includes("Extension navigateur connectée : Chrome"), "real browser connection");
    run.type("Inspect the authorized local page.\r"); await run.waitFor(text => text.includes("Native browser CLI verified."), "real browser model tool flow", 15000);
    run.type("/browser off\r"); await run.waitFor(text => text.includes("Pont navigateur déconnecté pour cette session."), "browser disconnection"); run.type("Check available tools.\r"); await run.waitFor(text => text.includes("Browser disconnected verified.")); expect(provider.requests).toHaveLength(6);
  } finally { controller.abort(); await run?.done; await fixture.close(); site.stop(true); }
}, 40000);

test.skipIf(!nativeBrowserAvailable)("SPEC-INT-011/CA-02 — a payment action is refused on a real page before any payment request or DOM effect", async () => {
  const fixture = await nativeBrowserFixture(); let payments = 0;
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => { if (request.method === "POST") payments++; return new Response('<h1>Native protected actions</h1><button onclick="document.querySelector(\'h1\').textContent=\'PAID\';fetch(\'/purchase\',{method:\'POST\'})">Pay now</button><input type="password" aria-label="Password"><a href="/file" download>Export file</a>', { headers: { "content-type": "text/html" } }); } });
  const origin = `http://127.0.0.1:${site.port}`, bridge = new BrowserBridge({ configDir: fixture.ws.configHome, slug: fixture.slug, product: "Native Browser Fixture", extensionId: () => fixture.id, permitted: () => true, changed: () => {} });
  try {
    await fixture.allow(origin); await bridge.start(); await fixture.reconnect(); await waitFor(() => bridge.connected, "Actual extension native host did not attach."); const tool = (await bridge.tool())!;
    const context = { ...testToolFields(), platform: currentPlatform(), home: fixture.ws.home, cwd: fixture.ws.project, allowedDirectories: [fixture.ws.project], signal: new AbortController().signal, modelImages: true }, call = (input: BrowserControlInput) => tool.execute(input, context);
    const tab = data(await call({ action: "navigate", url: origin })).id, page = data(await call({ action: "read", tab }));
    const pay = ref(page, "Pay now"), password = ref(page, "Password"), download = ref(page, "Export file");
    for (const input of [{ action: "click", tab, ref: pay }, { action: "type", tab, ref: password, text: "ordinary words" }, { action: "click", tab, ref: download }] as BrowserControlInput[]) { const refused = await call(input); expect(refused.isError).toBe(true); expect(text(refused)).toMatch(/sensitive|refused/i); }
    expect(payments).toBe(0); expect(text(await call({ action: "read", tab }))).toContain("Native protected actions"); expect(text(await call({ action: "read", tab }))).not.toContain("PAID");
    expect((await call({ action: "navigate", url: "http://127.0.0.1:9/" })).isError).toBe(true);
    await fixture.remove(origin); expect((await call({ action: "read", tab })).isError).toBe(true);
    const endpoint = JSON.parse(readFileSync(join(fixture.ws.configHome, "browser", "endpoint.json"), "utf8"));
    const denied = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, { method: "POST", body: "{}" }); expect(denied.status).toBe(403);
    const crossOrigin = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, { method: "POST", headers: { Authorization: "Bearer " + endpoint.token, Origin: origin }, body: "{}" }); expect(crossOrigin.status).toBe(403);
    await fixture.close(); await waitFor(() => !bridge.connected, "Disconnected browser remained published."); expect(await bridge.tool()).toBeUndefined();
  } finally { await bridge.close(); await fixture.close(); site.stop(true); }
}, 40000);
