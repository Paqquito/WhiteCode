// Supports: SPEC-EXT-033 (conditional real-extension detection, mandatory reference and exact tool grants).
import { expect, test } from "bun:test";
import { builtinSkills } from "../src/skills/builtin";
import { BrowserControlReference } from "../src/skills/browser-control";
import { textOutcome, type Tool } from "../src/tools/types";
import { currentPlatform } from "../src/platform/system";
import type { ModelRequest, ToolResultPart } from "../src/providers/types";
import { cli, testToolFields, workspace } from "./helpers/env";
import { interactive } from "./helpers/interactive";
import { nativeBrowserAvailable, nativeBrowserFixture } from "./helpers/native-browser";
import { ScriptedProvider } from "./helpers/scripted-provider";
const results = (request: ModelRequest): ToolResultPart[] => request.history.flatMap(message => message.role === "user" ? message.parts : []).filter(part => part.type === "tool_result");
const text = (part: ToolResultPart) => part.content.filter(part => part.type === "text").map(part => part.text).join("\n");

test.skipIf(!nativeBrowserAvailable)("SPEC-EXT-033/CA-01 — session startup with the real extension makes browser-control available and requires its reference before navigation", async () => {
  const fixture = await nativeBrowserFixture(), controller = new AbortController(); let visits = 0;
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { visits++; return new Response("<h1>REAL_BROWSER_SKILL_PAGE</h1>", { headers: { "content-type": "text/html" } }); } }), origin = `http://127.0.0.1:${site.port}`;
  const provider = new ScriptedProvider([
    request => { expect(JSON.stringify([request.system, request.history])).toContain("browser-control"); expect(request.tools.find(tool => tool.name === "cnx_browser_control")?.description).toContain("load the browser-control reference"); return { toolCalls: [{ name: "cnx_browser_control", input: { action: "navigate", url: origin } }] }; },
    request => { expect(results(request).at(-1)?.isError).toBe(true); expect(text(results(request).at(-1)!)).toContain("Load the product browser-control reference"); expect(visits).toBe(0); return { toolCalls: [{ name: "use_skill", input: { name: "browser-control" } }] }; },
    request => { const reference = text(results(request).at(-1)!); expect(reference).toContain('scope="product"'); expect(reference).toContain("cnx_browser_control"); expect(reference).toContain("Never enter a password"); expect(reference).toContain("Do not bypass anti-bot checks"); return { toolCalls: [{ name: "cnx_browser_control", input: { action: "navigate", url: origin } }] }; },
    request => { const result = results(request).at(-1)!; expect(result.isError).toBe(false); const tab = JSON.parse(text(result).split("\n").slice(1).join("\n")).id; return { toolCalls: [{ name: "cnx_browser_control", input: { action: "read", tab } }] }; },
    request => { expect(text(results(request).at(-1)!)).toContain("REAL_BROWSER_SKILL_PAGE"); return { text: "Real browser reference verified." }; },
    () => ({ toolCalls: [{ name: "use_skill", input: { name: "browser-control" } }] }),
    request => { expect(results(request).at(-1)?.isError).toBe(true); expect(text(results(request).at(-1)!)).toContain("Unknown skill: browser-control"); return { text: "Disconnected skill absent verified." }; },
  ]);
  let run: ReturnType<typeof interactive> | undefined;
  try {
    await fixture.allow(origin); run = interactive(["--browser", "--model", "large", "--allow-rule", "cnx_browser_control"], fixture.ws, { provider, identity: fixture.identity, signal: controller.signal, userConfig: { browser: { extensionId: fixture.id } } });
    await run.idle(); await fixture.reconnect(); await run.waitFor(text => text.includes("Extension navigateur connectée : Chrome"), "startup extension connection"); run.type("Inspect the authorized local browser page.\r"); await run.waitFor(text => text.includes("Real browser reference verified."), "reference then real navigation", 15000); expect(visits).toBeGreaterThan(0);
    run.type("/browser off\r"); await run.waitFor(text => text.includes("Pont navigateur déconnecté pour cette session.")); run.type("Check browser reference availability.\r"); await run.waitFor(text => text.includes("Disconnected skill absent verified."));
  } finally { controller.abort(); await run?.done; await fixture.close(); site.stop(true); }
}, 40000);

test.skipIf(!nativeBrowserAvailable)("TECH — loading the browser reference never overrides a deny rule against the actual connected native tool", async () => {
  const fixture = await nativeBrowserFixture(), controller = new AbortController(); let visits = 0;
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { visits++; return new Response("<h1>Denied native page</h1>", { headers: { "content-type": "text/html" } }); } }), origin = `http://127.0.0.1:${site.port}`;
  const provider = new ScriptedProvider([
    () => ({ toolCalls: [{ name: "use_skill", input: { name: "browser-control" } }] }),
    request => { expect(results(request).at(-1)?.isError).toBe(false); expect(request.tools.map(tool => tool.name)).not.toContain("cnx_browser_control"); return { toolCalls: [{ name: "cnx_browser_control", input: { action: "navigate", url: origin } }] }; },
    request => { expect(results(request).at(-1)?.isError).toBe(true); expect(visits).toBe(0); return { text: "Native deny rule verified." }; },
  ]);
  let run: ReturnType<typeof interactive> | undefined;
  try {
    await fixture.allow(origin); run = interactive(["--browser", "--deny-rule", "cnx_browser_control"], fixture.ws, { provider, identity: fixture.identity, signal: controller.signal, userConfig: { browser: { extensionId: fixture.id } } });
    await run.idle(); await fixture.reconnect(); await run.waitFor(text => text.includes("Extension navigateur connectée : Chrome")); run.type("Inspect the authorized local page.\r"); await run.waitFor(text => text.includes("Native deny rule verified."), "deny remains authoritative", 10000); expect(visits).toBe(0);
  } finally { controller.abort(); await run?.done; await fixture.close(); site.stop(true); }
}, 30000);

test("TECH — browser-control is absent without a detected extension and cannot grant any tool", async () => {
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "browser-control" } }] }, request => { expect(request.tools.map(tool => tool.name)).not.toContain("cnx_browser_control"); expect(results(request).at(-1)?.isError).toBe(true); expect(text(results(request).at(-1)!)).toContain("Unknown skill: browser-control"); return { text: "Absent extension verified." }; }]);
  const result = await cli(["--non-interactive", "Check browser reference."], workspace(), { provider }); expect(result.code).toBe(0); expect(result.stdout).toContain("Absent extension verified.");
});

test("TECH — the browser reference grants exactly its connector and remains isolated per caller, context epoch and connection", async () => {
  const reference = builtinSkills().find(skill => skill.name === "browser-control")!; expect(reference.tools).toEqual(["cnx_browser_control"]);
  let epoch = 1, calls = 0; const access = new BrowserControlReference(() => epoch), tool: Tool = { name: "cnx_browser_control", description: () => "Actual tool", inputSchema: { type: "object" }, flags: () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: true }), isEnabled: () => true, ruleSubject: () => ({ kind: "name", name: "browser" }), summary: () => "Browser", execute: async () => { calls++; return textOutcome("Actual action"); } }, guarded = access.protect(tool), ws = workspace();
  const context = { ...testToolFields(), cwd: ws.project, allowedDirectories: [ws.project], signal: new AbortController().signal, platform: currentPlatform(), home: ws.home };
  expect((await guarded.execute({}, context)).isError).toBe(true); access.activate({ ...reference, scope: "user" }); expect(guarded.validate?.({}, context)).toContain("replaced reference"); expect(calls).toBe(0);
  access.activate(reference); expect(guarded.validate?.({}, context)).toBeUndefined(); expect((await guarded.execute({}, context)).isError).toBe(false); expect((await guarded.execute({}, { ...context, agentName: "separate-agent" })).isError).toBe(true);
  access.activate(reference, "separate-agent"); expect((await guarded.execute({}, { ...context, agentName: "separate-agent" })).isError).toBe(false); epoch++; expect((await guarded.execute({}, context)).isError).toBe(true); access.activate(reference); access.invalidate(); expect((await guarded.execute({}, context)).isError).toBe(true); expect(calls).toBe(2); expect(guarded.flags({})).toEqual(tool.flags({})); expect(guarded.ruleSubject({}, context)).toEqual(tool.ruleSubject({}, context));
});
