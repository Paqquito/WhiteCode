import { expect, test } from "bun:test";
import { sshHost, shellQuote, parseProbe } from "../src/ssh/transport";
import { startSshRelay, sshRelayProvider } from "../src/ssh/relay";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { cli, testModel, workspace } from "./helpers/env";
import { startDirectServer } from "../src/direct/server";
import { connectNetworkWebSocket } from "../src/platform/socket-network";
import type { WsPeer } from "../src/platform/websocket";

test("TECH — the SSH family alone displays help without composing a provider or probing a host", async () => {
  const provider = new ScriptedProvider([]);
  const result = await cli(["ssh-session"], workspace(), {provider,userConfig:null});
  expect(result.code).toBe(0);expect(result.stdout).toContain("ssh-session <opération>");expect(provider.requests).toHaveLength(0);
});

test("TECH — SSH refuses coordination with the canonical session diagnostic before probing or authentication", async () => {
  const provider = new ScriptedProvider([]);
  const result = await cli(["ssh-session", "connect", "localhost", "--orchestrator"], workspace(), { provider });
  expect(result.code).toBe(2); expect(result.stderr).toContain("moteur de session ne dispose pas de la capacité de coordination"); expect(provider.requests).toHaveLength(0);
});

test("TECH — SSH targets cannot inject options and remote paths are shell quoted", () => {
  for (const value of ["-oProxyCommand=bad", "host\ncommand", "user@host extra", "$(command)", ""]) expect(() => sshHost(value)).toThrow();
  expect(sshHost("developer@host-alias")).toBe("developer@host-alias");
  expect(shellQuote("/home/a'b/project $x")).toBe("'/home/a'\\''b/project $x'");
  expect(parseProbe("Linux\nx86_64\n/home/developer\n")).toEqual({ arch: "x64", home: "/home/developer" });
  expect(() => parseProbe("Darwin\narm64\n/home/developer\n")).toThrow();
});

test("TECH — an SSH worker session cap rejects a second authenticated client", async () => {
  const server = startDirectServer({ root: workspace().project, listen: { kind: "tcp", hostname: "127.0.0.1", port: 0 }, maxSessions: 1, token: "session-only", version: "0.1.0", maxFrameBytes: 65536, keepAliveMs: 10000, resumeWindowMs: 0, allowedOrigins: [], refusal: () => undefined, notice: () => {}, runSession: async session => { await new Promise<void>(resolve => session.signal.addEventListener("abort", () => resolve(), { once: true })); return 0; } });
  let first: { close(): void } | undefined, second: { close(): void } | undefined;
  try {
    await new Promise<void>(resolve => { first = connectNetworkWebSocket(server.url, { authorization: "Bearer session-only" }, { onOpen: () => resolve(), onMessage: () => {}, onClose: () => {} }, { noProxy: [], caHint: "Fixture" }); });
    let opened = false;
    await new Promise<void>(resolve => { second = connectNetworkWebSocket(server.url, { authorization: "Bearer session-only" }, { onOpen: (peer: WsPeer) => { opened = true; peer.close(); }, onMessage: () => {}, onClose: () => resolve() }, { noProxy: [], caHint: "Fixture" }); });
    expect(opened).toBe(false); expect(server.sessionCount).toBe(1);
  } finally { first?.close(); second?.close(); await server.stop(); }
}, 10000);

test("TECH — the SSH relay rejects unauthenticated requests and pins the configured model", async () => {
  const provider = new ScriptedProvider([{ text: "Authenticated on the local machine · é🐈 LOCAL_PROVIDER_SECRET" }]), model = testModel("medium");
  const relay = await startSshRelay({ provider, model, token: "ephemeral-session-transport", redact: text => text.replaceAll("LOCAL_PROVIDER_SECRET", "[redacted]") });
  try {
    expect((await fetch(relay.url, { method: "POST", body: "{}" })).status).toBe(403); expect(provider.requests).toHaveLength(0);
    const proxy = sshRelayProvider(relay.url, "ephemeral-session-transport");
    const events = [];
    for await (const event of proxy.stream({ model: { ...model, id: "injected-model" }, system: [], tools: [], history: [{ role: "user", parts: [{ type: "text", text: "Question" }] }], maxOutputTokens: 100, thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false } }, new AbortController().signal)) events.push(event);
    expect(provider.requests[0]!.model.id).toBe(model.id); expect(JSON.stringify(events)).toContain("Authenticated on the local machine · é🐈"); expect(JSON.stringify(events)).not.toContain("LOCAL_PROVIDER_SECRET");
  } finally { await relay.close(); }
});
