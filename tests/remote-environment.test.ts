import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { RemoteEnvironment } from "../src/remote/environment";
import type { WsClientHandlers } from "../src/platform/websocket";
import { ResidentSupervisor, readResidentEndpoint } from "../src/services/supervisor";
import { processExists } from "../src/platform/process";
import { workspace, cli } from "./helpers/env";
import { productEnv } from "./helpers/hooks";

async function until(predicate: () => boolean) { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw Error("Environment test deadline."); await Bun.sleep(20); } }
function fixture(maxConcurrent = 4) {
  const ws = workspace(), messages: Record<string, unknown>[] = [], requests: string[] = [], vault = new Map<string, string>();
  const owner = { account: "fixture@example.test", organizationId: "org" }, device = "device_" + "D".repeat(48), channel = "environment_" + "E".repeat(48);
  let binding = "login-generation-1", trusted = true, eligible = true, handlers: WsClientHandlers | undefined;
  const child = ws.write("worker.ts", 'console.log(JSON.stringify({type:"session"}));for await(const line of console){const m=JSON.parse(line);if(m.type==="user")console.log(JSON.stringify({type:"turn_started"}));}');
  const supervisor = new ResidentSupervisor({ root: ws.configHome, maxConcurrent, waitMs: 1000, assertPolicy: () => {}, program: () => ({ file: process.execPath, args: ["--no-env-file", child] }), environment: () => productEnv(ws), wasAccepted: () => false, history: () => [], notify: async () => {} });
  const environment = new RemoteEnvironment({ initialBinding: createHash("sha256").update(binding).digest("hex"), root: ws.project, name: "Fixture", capacity: 1, serviceUrl: "https://service.example.test/sessions/", webUrl: "https://web.example.test/", intervalMs: 40, assertPolicy: () => {}, report: () => {}, redact: value => value,
    account: { profile: async () => ({ account: owner.account, organization: { id: owner.organizationId } }), sessionBinding: async () => binding, trustedDeviceRequest: async path => {
      requests.push(path); return path.endsWith("register") && !path.endsWith("unregister") ? { id: "env-1", account: owner.account, organizationId: owner.organizationId, eligible, trustedDevice: trusted, url: "https://web.example.test/environments/env-1", channel: { url: "wss://service.example.test/sessions/environments/env-1/channel", token: channel, expiresAt: Date.now() + 60000 }, device: { id: "device-1", token: device, expiresAt: Date.now() + 60000, owner, service: "https://service.example.test/sessions/" } } : {}; } },
    vault: { read: (_service, key) => vault.get(key), write: (_service, key, value) => { vault.set(key, value); }, remove: (_service, key) => { vault.delete(key); } }, vaultService: "fixture-vault",
    workers: { create: (...args) => supervisor.createRemote(...args), list: binding => supervisor.remoteWorkers(binding) },
    connect: (_url, headers, callbacks) => { expect(headers.Authorization).toBe("Environment " + channel); expect(headers["X-Trusted-Device"]).toBe(device); handlers = callbacks; queueMicrotask(() => callbacks.onOpen({ send: text => messages.push(JSON.parse(text)), close: () => callbacks.onClose(), remoteAddress: "service.example.test" })); return { close: () => callbacks.onClose() }; },
  });
  let seq = 0;
  return { ws, environment, supervisor, requests, vault, messages, secrets: [device, channel], eligible: (value: boolean) => { eligible = value; }, trusted: (value: boolean) => { trusted = value; }, changeAccount: () => { binding = "login-generation-2"; },
    send: (value: Record<string, unknown>) => handlers!.onMessage(JSON.stringify({ seq: ++seq, account: owner.account, organizationId: owner.organizationId, environment: "env-1", ...value })),
    replay: (value: Record<string, unknown>) => handlers!.onMessage(JSON.stringify({ seq, account: owner.account, organizationId: owner.organizationId, environment: "env-1", ...value })),
  };
}

test("TECH — remote-access requires a company account before starting any resident process", async () => {
  const ws = workspace(), result = await cli(["remote-access", "start"], ws);
  expect(result.code).toBe(2); expect(result.stderr).toContain("compte"); expect(readResidentEndpoint(ws.configHome)).toBeUndefined();
});

test("TECH — environment registration gates real workers, deduplicates creation and joins an idempotent stop without token disclosure", async () => {
  const f = fixture(), id = randomUUID();
  try {
    await f.supervisor.start(); await f.environment.start(new AbortController().signal);
    f.send({ type: "create", id, prompt: "Wait for the authenticated user." });
    await until(() => f.environment.state.sessions[0]?.status === "running");
    const pid = f.environment.state.sessions[0]!.pid!; expect(processExists(pid)).toBe(true);
    f.replay({ type: "create", id, prompt: "Must not create again." });
    await until(() => f.messages.some(message => message["duplicate"] === true));
    expect(f.environment.state.sessions).toHaveLength(1); expect(f.environment.state.sessions[0]!.pid).toBe(pid);
    f.send({ type: "create", id: randomUUID(), prompt: "Beyond capacity." });
    await until(() => f.messages.some(message => message["status"] === "capacity"));
    expect(f.environment.state.sessions).toHaveLength(1);
    for (const secret of f.secrets) expect(JSON.stringify(f.environment.state) + JSON.stringify(f.messages)).not.toContain(secret);
    expect([...f.vault.values()]).toHaveLength(1);
    const first = f.environment.close(), second = f.environment.close(); expect(first).toBe(second); await first;
    expect(processExists(pid)).toBe(false); expect(f.requests.filter(path => path.endsWith("/unregister"))).toHaveLength(1);
  } finally { await f.environment.close(); await f.supervisor.close(); }
}, 12000);

test("TECH — an untrusted device never opens a channel or creates a worker", async () => {
  const f = fixture(); f.trusted(false);
  try { await expect(f.environment.start(new AbortController().signal)).rejects.toThrow("appareil"); expect(f.environment.state.sessions).toHaveLength(0); expect(f.vault.size).toBe(0); }
  finally { await f.environment.close(); await f.supervisor.close(); }
});

test("TECH — an account rotation between client validation and first registration is rejected before exposure", async () => {
  const f = fixture(); f.changeAccount();
  try {
    await expect(f.environment.start(new AbortController().signal)).rejects.toThrow("Compte");
    expect(f.requests).toHaveLength(0); expect(f.vault.size).toBe(0); expect(f.environment.state.active).toBe(false);
  } finally { await f.environment.close(); await f.supervisor.close(); }
});

test("TECH — service eligibility is mandatory even for a trusted device", async () => {
  const f = fixture(); f.eligible(false);
  try { await expect(f.environment.start(new AbortController().signal)).rejects.toThrow("éligible"); expect(f.environment.state.active).toBe(false); expect(f.vault.size).toBe(0); }
  finally { await f.environment.close(); await f.supervisor.close(); }
});

test("TECH — an expired stored device proof is removed so the next explicit registration can recover", async () => {
  const f = fixture(); let retry: RemoteEnvironment | undefined, recovered: RemoteEnvironment | undefined;
  try {
    await f.environment.start(new AbortController().signal); await f.environment.close();
    const [key, value] = [...f.vault.entries()][0]!; f.vault.set(key, JSON.stringify({ ...JSON.parse(value), expiresAt: Date.now() - 1 }));
    retry = new RemoteEnvironment(f.environment.options);
    await expect(retry.start(new AbortController().signal)).rejects.toThrow("supprimée"); expect(f.vault.size).toBe(0);
    recovered = new RemoteEnvironment(f.environment.options); await recovered.start(new AbortController().signal); expect(recovered.state.active).toBe(true);
  } finally { await f.environment.close(); await retry?.close(); await recovered?.close(); await f.supervisor.close(); }
});

test("TECH — replacing the account generation revokes all owned workers", async () => {
  const f = fixture();
  try {
    await f.supervisor.start(); await f.environment.start(new AbortController().signal);
    f.send({ type: "create", id: randomUUID(), prompt: "Wait." }); await until(() => !!f.environment.state.sessions[0]?.pid);
    const pid = f.environment.state.sessions[0]!.pid!; f.changeAccount();
    await until(() => !f.environment.state.active); await f.environment.close(); expect(processExists(pid)).toBe(false);
  } finally { await f.environment.close(); await f.supervisor.close(); }
}, 12000);

test("TECH — an assignment cannot select a directory outside the registered root", async () => {
  const f = fixture();
  try {
    await f.supervisor.start(); await f.environment.start(new AbortController().signal);
    f.send({ type: "create", id: randomUUID(), prompt: "Escape.", directory: ".." });
    await until(() => !f.environment.state.active); expect(f.environment.state.sessions).toHaveLength(0);
    expect(existsSync(f.ws.project)).toBe(true);
  } finally { await f.environment.close(); await f.supervisor.close(); }
});

test("TECH — another resident workload consuming global capacity refuses only the new assignment", async () => {
  const f = fixture(1);
  try {
    await f.supervisor.start(); const other = f.supervisor.createRemote(randomUUID(), f.ws.project, "Wait.", "b".repeat(64));
    await f.environment.start(new AbortController().signal);
    f.send({ type: "create", id: randomUUID(), prompt: "Global capacity is already consumed." });
    await until(() => f.messages.some(message => message["status"] === "capacity"));
    expect(f.environment.state.active).toBe(true); expect(f.environment.state.sessions).toHaveLength(0); expect(processExists(other.pid!)).toBe(true);
  } finally { await f.environment.close(); await f.supervisor.close(); }
});
