// Supports: SPEC-API-029, SPEC-PLA-002 (service-owned credentials and scheduling).
import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HostedService, type HostedPrincipal } from "../src/hosted/service";
import { startHostedHttp } from "../src/platform/hosted-http";
import { workspace } from "./helpers/env";

const personal = "fixture-personal-key-0197", organization = "fixture-organization-key-0734";
const member: HostedPrincipal = { account: "alice", organizationId: "team", administrator: false };
async function fixture() {
  const ws = workspace(), seen: string[] = [];
  let now = Date.UTC(2026, 9, 16, 8, 59), memberAvailable = true, blocked: Promise<void> | undefined;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push(request.headers.get("authorization") ?? "");
    await request.json();
    await blocked;
    return Response.json({ choices: [{ message: { content: "remote receipt" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const service = new HostedService({ directory: join(ws.root, "service"), encryptionKey: randomBytes(32), now: () => now,
    publicBaseUrl: "https://service.example.test/", workerToken: "fixture-worker-token-" + "a".repeat(32),
    authenticate: async authorization => authorization === "Bearer alice" ? member : authorization === "Bearer admin" ? { ...member, administrator: true } : authorization === "Bearer bob" ? { ...member, account: "bob", organizationId: "other" } : undefined,
    providers: [{ id: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1/`, model: { id: "fixture-model", provider: "openai_compatible", family: "fixture", label: "Fixture", contextWindow: 16000, maxOutputTokens: 256, capabilities: { toolCalling: true }, pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 1, cacheWritePerMTok: 1, effectiveDate: "2026-10-16", source: "Fictitious test price" } } }],
    environments: [{ id: "default", provider: "fixture", tools: ["read_file", "run_shell"], connectors: [] }], currency: "USD",
    repositoryAccessible: async repository => repository === "https://forge.example.test/team/repo.git",
    resolvePrincipal: async (account, organizationId) => account === "bob" && organizationId === "other" ? { ...member, account, organizationId } : memberAvailable && account === member.account && organizationId === member.organizationId ? member : undefined,
  });
  const http = await startHostedHttp(request => service.handle(request));
  const call = async (path: string, body?: unknown, token = "alice") => {
    const response = await fetch(http.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const deposit = (secret = personal, owner = "personal", token = "alice") => call("console/keys/deposit", { provider: "fixture", label: "Test", secret, owner }, token);
  const input = { repository: "https://forge.example.test/team/repo.git", branch: "main", commit: "a".repeat(40), prompt: "Report readiness", environment: "default" };
  return { ws, service, url: http.url, seen, call, deposit, input, block: () => { let release!: () => void; blocked = new Promise<void>(resolve => release = resolve); return () => { blocked = undefined; release(); }; }, membership: (available: boolean) => memberAvailable = available, now: (value: number) => now = value, close: async () => { await service.close(); await http.close(); provider.stop(true); } };
}

test("SPEC-API-029/CA-02 — a real service proxy injects a personal key and returns only its safe label", async () => {
  const f = await fixture();
  try {
    const key = await f.deposit(); expect(key.status).toBe(200); expect(JSON.stringify(key.body)).not.toContain(personal);
    const created = await f.call("sessions/create", { ...f.input, idempotencyKey: "create-one" }); expect(created.status).toBe(201);
    const work = await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32)); expect(work.status).toBe(200);
    const result = await f.call(`work/${created.body.id}/v1/chat/completions`, { model: "fixture-model", messages: [{ role: "user", content: "Hello" }], max_tokens: 32 }, work.body.lease);
    expect(result.status).toBe(200); expect(f.seen.at(-1)).toBe("Bearer " + personal);
    expect(JSON.stringify([created.body, work.body, result.body])).not.toContain(personal);
    expect(readFileSync(join(f.ws.root, "service/state.json"), "utf8")).not.toContain(personal);
    expect((await f.call("sessions/create", { ...f.input, idempotencyKey: "other-user" }, "bob")).status).toBe(409);
  } finally { await f.close(); }
});

test("SPEC-API-029/CA-03 — an imposed organization key overrides the member personal key and reports that choice", async () => {
  const f = await fixture();
  try {
    await f.deposit(); await f.deposit(organization, "organization", "admin");
    expect((await f.call("console/organization", { enforcedKey: true }, "admin")).status).toBe(200);
    const created = await f.call("sessions/create", { ...f.input, idempotencyKey: "org-one" });
    expect(created.body.notice).toContain("ERR-04"); expect(created.body.key.lastFour).toBe("0734");
    const work = await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32));
    await f.call(`work/${created.body.id}/v1/chat/completions`, { model: "fixture-model", messages: [], max_tokens: 2 }, work.body.lease);
    expect(f.seen.at(-1)).toBe("Bearer " + organization);
    expect((await f.call("console/organization", { enforcedKey: false })).status).toBe(403);
  } finally { await f.close(); }
});

test("SPEC-API-029/CA-04 — revocation stops the active run durably and prevents new runs using the key", async () => {
  const f = await fixture();
  try {
    const key = await f.deposit(), run = await f.call("sessions/create", { ...f.input, idempotencyKey: "revoke-one" });
    const work = await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32));
    expect((await f.call("console/keys/revoke", { id: key.body.id })).status).toBe(200);
    expect((await f.call(`sessions/${run.body.id}/status`)).body.status).toBe("stopped");
    expect((await f.call(`work/${run.body.id}/v1/chat/completions`, { model: "fixture-model", messages: [] }, work.body.lease)).status).toBe(409);
    expect((await f.call("sessions/create", { ...f.input, idempotencyKey: "revoke-two" })).body.error).toContain("ERR-01");
    expect(readFileSync(join(f.ws.root, "service/state.json"), "utf8")).not.toContain("ciphertext");
  } finally { await f.close(); }
});

test("SPEC-PLA-002/CA-02 — immediate execution creates a session before the next scheduled deadline", async () => {
  const f = await fixture();
  try {
    await f.deposit();
    const trigger = await f.call("triggers/create", { ...f.input, idempotencyKey: "trigger-now", name: "Daily", cron: "0 9 * * *", timeZone: "UTC" });
    expect(trigger.status).toBe(201);
    const result = await f.call("triggers/run", { id: trigger.body.id });
    expect(result.status).toBe(201); expect(result.body.url).toStartWith("https://service.example.test/sessions/");
    expect((await f.call("triggers/get", { id: trigger.body.id })).body.history[0].sessionId).toBe(result.body.id);
  } finally { await f.close(); }
});

test("SPEC-PLA-002/CA-03 — a due trigger without a delegated key records ERR-01 and creates no session", async () => {
  const f = await fixture();
  try {
    const trigger = await f.call("triggers/create", { ...f.input, idempotencyKey: "without-key", cron: "0 9 * * *", timeZone: "UTC" });
    f.now(Date.UTC(2026, 9, 16, 9)); await f.service.tick();
    const current = await f.call("triggers/get", { id: trigger.body.id });
    expect(current.body.history[0].reason).toContain("ERR-01"); expect(current.body.history[0].sessionId).toBeUndefined();
    expect((await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32))).body.work).toBeNull();
  } finally { await f.close(); }
});

test("SPEC-API-029/CA-05 — revocation after trigger creation is resolved again at the due time", async () => {
  const f = await fixture();
  try {
    const key = await f.deposit(), trigger = await f.call("triggers/create", { ...f.input, idempotencyKey: "revoked-trigger", cron: "0 9 * * *", timeZone: "UTC" });
    await f.call("console/keys/revoke", { id: key.body.id });
    f.now(Date.UTC(2026, 9, 16, 9)); await f.service.tick();
    const current = await f.call("triggers/get", { id: trigger.body.id }); expect(current.body.history[0].reason).toContain("ERR-01");
    expect((await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32))).body.work).toBeNull();
  } finally { await f.close(); }
});

test("TECH — leaving the organization invalidates a queued session and never grants a worker lease", async () => {
  const f = await fixture();
  try {
    await f.deposit(organization, "organization", "admin");
    const created = await f.call("sessions/create", { ...f.input, idempotencyKey: "departed-member" });
    expect(created.status).toBe(201); f.membership(false);
    const next = await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32));
    expect(next.body.work).toBeNull();
    expect((await f.call(`sessions/${created.body.id}/status`)).body.status).toBe("stopped");
    expect(f.seen).toHaveLength(1);
  } finally { await f.close(); }
});

test("TECH — an autumn clock change does not execute the same daily wall time twice", async () => {
  const f = await fixture();
  try {
    f.now(Date.UTC(2026, 9, 25, 0, 29));
    const trigger = await f.call("triggers/create", { ...f.input, idempotencyKey: "seasonal", cron: "30 2 * * *", timeZone: "Europe/Paris" });
    expect(trigger.status).toBe(201);
    f.now(Date.UTC(2026, 9, 25, 0, 30)); await f.service.tick();
    f.now(Date.UTC(2026, 9, 25, 1, 30)); await f.service.tick();
    expect((await f.call("triggers/get", { id: trigger.body.id })).body.history).toHaveLength(1);
  } finally { await f.close(); }
});

test("TECH — simultaneous duplicate creations allocate one session and durable replay rejects a changed body", async () => {
  const f = await fixture();
  try {
    const key = await f.deposit(), input = { ...f.input, idempotencyKey: "concurrent" };
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.call("sessions/create", input)));
    expect(responses.filter(response => response.status === 201)).toHaveLength(1);
    expect(responses.every(response => [200, 201, 409].includes(response.status))).toBe(true);
    const id = responses.find(response => response.status === 201)!.body.id;
    expect((await f.call("sessions/create", input)).body.id).toBe(id);
    expect((await f.call("sessions/create", { ...input, prompt: "Another task" })).status).toBe(409);
    expect((await f.call("console/keys/usage", { id: key.body.id })).body.items).toHaveLength(1);
  } finally { await f.close(); }
});

test("TECH — service SSE emits ordered transitions and resumes after the supplied cursor without leaking another owner's session", async () => {
  const f = await fixture();
  try {
    await f.deposit(); const created = await f.call("sessions/create", { ...f.input, idempotencyKey: "events" });
    const response = await fetch(f.url + `sessions/${created.body.id}/events?after=0`, { headers: { authorization: "Bearer alice" }, signal: AbortSignal.timeout(5000) });
    const text = response.text();
    const work = await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32));
    await f.call(`work/${created.body.id}/result`, { code: 0, result: "Completed receipt" }, work.body.lease);
    const events = (await text).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(events.map(event => [event.seq, event.type])).toEqual([[1, "queued"], [2, "started"], [3, "completed"]]);
    const resumed = await fetch(f.url + `sessions/${created.body.id}/events?after=2`, { headers: { authorization: "Bearer alice" } });
    expect(await resumed.text()).toContain('"seq":3');
    expect((await fetch(f.url + `sessions/${created.body.id}/events?after=0`, { headers: { authorization: "Bearer bob" } })).status).toBe(404);
  } finally { await f.close(); }
});

test("TECH — encrypted service state survives restart, authenticates its separate key and retains creation identity", async () => {
  const f = await fixture(); let next: HostedService | undefined;
  try {
    await f.deposit(); const input = { ...f.input, idempotencyKey: "restart" }, created = await f.call("sessions/create", input);
    await f.service.close();
    expect(() => new HostedService({ ...f.service.options, encryptionKey: randomBytes(32) })).toThrow();
    next = new HostedService(f.service.options);
    const response = await next.handle(new Request(f.url + "sessions/create", { method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" }, body: JSON.stringify(input) }));
    expect(response.status).toBe(200); const replay = await response.json() as any;
    expect(replay.id).toBe(created.body.id); expect(replay.status).toBe("stopped");
    expect(readFileSync(join(f.ws.root, "service/state.json"), "utf8")).not.toContain(personal);
  } finally { await next?.close(); await f.close(); }
});
test("TECH — organization identifiers cannot replace the policy dictionary prototype or lose an enforced policy on restart", async () => {
  const f = await fixture(), owner = { account: "alice", organizationId: "__proto__", administrator: true }, options = { ...f.service.options, directory: join(f.ws.root, "prototype-policy"), authenticate: async () => owner, resolvePrincipal: async () => owner };
  let service = new HostedService(options);
  try {
    const changed = await service.handle(new Request(f.url + "console/organization", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enforcedKey: true, managedMaxCost: 5 }) })); expect(changed.status).toBe(200);
    await service.close(); service = new HostedService(options);
    const status = await service.handle(new Request(f.url + "sessions/key-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: f.input.repository }) }));
    expect(await status.json()).toMatchObject({ managedLimit: 5 });
  } finally { await service.close(); await f.close(); }
});
test("TECH — a personal key remains owned and revocable by its user after an organization change", async () => {
  const f = await fixture(); let organizationId = "team";
  const owner = () => ({ ...member, organizationId }), service = new HostedService({ ...f.service.options, directory: join(f.ws.root, "personal-owner"), authenticate: async () => owner(), resolvePrincipal: async () => owner() });
  const call = async (path: string, body: unknown) => { const response = await service.handle(new Request(f.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() as any }; };
  try {
    const key = await call("console/keys/deposit", { provider: "fixture", label: "Personal", owner: "personal", secret: personal }); expect(key.status).toBe(200);
    organizationId = "second-organization";
    expect((await call("sessions/create", { ...f.input, idempotencyKey: "changed-organization" })).status).toBe(201);
    expect((await call("console/keys/revoke", { id: key.body.id })).status).toBe(200);
  } finally { await service.close(); await f.close(); }
});
test("TECH — revoking a key cancels an already received provider HTTP request and completes its service handler", async () => {
  const f = await fixture(); let release = () => {};
  try {
    const key = await f.deposit(), run = await f.call("sessions/create", { ...f.input, idempotencyKey: "blocked-http" }), work = await f.call("workers/next", {}, "fixture-worker-token-" + "a".repeat(32));
    release = f.block();
    const request = f.call(`work/${run.body.id}/v1/chat/completions`, { model: "fixture-model", messages: [], max_tokens: 2 }, work.body.lease);
    const deadline = Date.now() + 2000;
    while (f.seen.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(f.seen).toHaveLength(2);
    expect((await f.call("console/keys/revoke", { id: key.body.id })).status).toBe(200);
    expect((await request).status).toBe(409);
    expect((await f.call(`sessions/${run.body.id}/status`)).body.status).toBe("stopped");
  } finally { release(); await f.close(); }
});
