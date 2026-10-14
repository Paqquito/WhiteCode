import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../src/memory/store";
import { MemoryRecall } from "../src/memory/recall";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY } from "./helpers/interactive";
import { Identity } from "../src/identity/identity";
import { SessionObserver } from "../src/observability/session";

test("SPEC-OBS-006/CA-01 — ten candidate memories and two retained emit only their shape", async () => {
  const ws = workspace(), store = new MemoryStore(join(ws.configHome, "memory"), { indexFile: "INDEX.md", maxLines: 200, maxBytes: 32000, redact: value => value });
  mkdirSync(store.root, { recursive: true }); for (let i = 0; i < 10; i++) writeFileSync(join(store.root, `memory-${i}.md`), `---\nname: PRIVATE_TITLE_${i}\ndescription: PRIVATE_DESCRIPTION_${i}\ntype: project\n---\nPRIVATE_CONTENT_${i}\n`);
  const events: unknown[] = [], recall = new MemoryRecall({ store, maxItems: 2, staleAfterDays: 30, sample: async () => '["memory-0.md","memory-1.md"]', shape: value => events.push(value) });
  expect(await recall.recall("request", new AbortController().signal)).toHaveLength(2); expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ available: 10, selected: 2 }); expect(JSON.stringify(events)).not.toMatch(/PRIVATE|memory-|filename|content|description/);
});
test("SPEC-INT-014/CA-02 — a Markdown heading is sent byte for byte and never transformed into a channel mention", async () => {
  const p = new ScriptedProvider([{ text: "ok" }]), message = "# Titre\nUne ligne intacte"; await cli(["--non-interactive", message], workspace(), { provider: p });
  const first = p.requests[0]?.history.find(entry => entry.role === "user"); expect(first?.role === "user" && first.parts).toContainEqual({ type: "text", text: message });
});
test("SPEC-API-028/CA-05 — a valid API key without any company login completes a real local SDK request", async () => {
  let authorization = "", calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "HEAD") return new Response("OK");
    authorization = request.headers.get("authorization") ?? ""; calls++; const body = await request.json() as { model: string };
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "clé indépendante" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try { const result = await cli(["--non-interactive", "bonjour"], workspace(), { userConfig: { api: { baseUrl: `http://127.0.0.1:${server.port}/v1` } }, env: { OPENAI_API_KEY: "fixture-only-independent-key" } }); expect(result.code).toBe(0); expect(result.stdout).toContain("clé indépendante"); expect(calls).toBe(1); expect(authorization).toBe("Bearer fixture-only-independent-key"); }
  finally { server.stop(true); }
});
async function unavailableMerch(configured: boolean) {
  const original = loadIdentity(), identity = new Identity({ ...original.resolved, values: { ...original.resolved.values, ...(configured ? { SERVICE_MERCH: { value: "https://shop.fixture.invalid", origin: "provided" as const } } : {}) } });
  let opened = 0; const run = interactive([], workspace(), { identity, userConfig: { ui: { merch: { enabled: false } } }, provider: new ScriptedProvider([]), extra: { openServiceUrl: () => { opened++; return true; } } }); await run.idle(); run.type("/merch"); run.type(KEY.enter); await run.waitFor(text => /inconnue/i.test(text)); expect(opened).toBe(0); run.type(KEY.ctrlD); run.type(KEY.ctrlD); expect((await run.done).code).toBe(0);
}
test("SPEC-CMD-043/CA-01 — a missing shop service leaves the command unknown and opens no page", () => unavailableMerch(false));
test("SPEC-CMD-043/CA-02 — an explicitly disabled shop remains unknown even with a configured service", () => unavailableMerch(true));
test("TECH — memory shape exports closed metadata only and product refusal prevents every export", async () => {
  for (const enabled of [true, false]) {
    const packets: string[] = [], ws = workspace();
    const observer = new SessionObserver({ slug: "fixture", eventPrefix: "fixture.", version: "1", configDir: ws.configHome, platform: "test", persist: false, sessionId: () => "session", entrypoint: "non-interactive", productEnabled: () => enabled, otelEnabled: () => false, errorEnabled: () => false, includePrompts: false, includeSessionId: false, environment: () => undefined, productUrl: "https://telemetry.fixture.invalid/events", fetch: (async (_input, init) => { packets.push(String(init?.body)); return new Response("{}"); }) as typeof fetch, warn: () => {}, console: () => {}, diagnosticRetentionDays: 1, secrets: [] });
    observer.memoryRecall({ available: 10, selected: 2, ageDays: 30 }); observer.memoryWrite(); await observer.close();
    if (!enabled) expect(packets).toEqual([]);
    else { const events = packets.flatMap(packet => JSON.parse(packet).events); const memory = events.filter(event => event.name.endsWith("memory_recall")); expect(memory).toHaveLength(1); expect(memory[0].attributes).toEqual({ available: 10, selected: 2, age_days: 30, scope: "project" }); expect(events.some(event => event.name.endsWith("memory_write"))).toBe(true); }
  }
});
