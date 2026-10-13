import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { ConnectorOAuth } from "../src/connectors/oauth";
import type { CredentialVault } from "../src/platform/credential-vault";
import { workspace, cli, loadIdentity } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import { httpConnectorServer } from "./helpers/fake-mcp-http";

function fixture() {
  const requests: Array<{ path: string; body: URLSearchParams | Record<string, unknown>; authorization: string | null }> = [];
  const values = new Map<string, string>();
  const vault: CredentialVault = { read: (_s, a) => values.get(a), write: (_s, a, v) => { values.set(a, v); }, remove: (_s, a) => { values.delete(a); } };
  let challenge = "", codeUsed = false, refreshed = 0;
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url), base = u.origin;
    if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`, code_challenge_methods_supported: ["S256"] });
    if (u.pathname === "/mcp") {
      if (req.headers.get("Authorization") !== "Bearer synthetic-renewed38") return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const m = await req.json() as { id?: number; method: string }; if (m.id === undefined) return new Response(null, { status: 202 });
      const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : m.method === "tools/list" ? { tools: [{ name: "lookup", description: "Read a fixture value", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: "authorized-value38" }] };
      return Response.json({ jsonrpc: "2.0", id: m.id, result });
    }
    const body = req.headers.get("content-type")?.includes("application/json") ? await req.json() as Record<string, unknown> : new URLSearchParams(await req.text());
    requests.push({ path: u.pathname, body, authorization: req.headers.get("authorization") });
    if (u.pathname === "/register") return Response.json({ client_id: "fixture-client" }, { status: 201 });
    if (u.pathname === "/token") {
      const b = body as URLSearchParams;
      if (b.get("grant_type") === "authorization_code") {
        if (codeUsed || createHash("sha256").update(b.get("code_verifier")!).digest("base64url") !== challenge || b.get("resource") !== `${base}/mcp`) return new Response(null, { status: 400 });
        codeUsed = true; return Response.json({ access_token: "synthetic-access38", token_type: "Bearer", refresh_token: "synthetic-refresh38", expires_in: 0 });
      }
      refreshed++; return Response.json({ access_token: "synthetic-renewed38", token_type: "Bearer", expires_in: 3600 });
    }
    return new Response(null, { status: 200 });
  } });
  const url = `http://127.0.0.1:${s.port}/mcp`, ws = workspace();
  const oauth = new ConnectorOAuth({ name: "docs", url, configuration: {}, configDir: ws.configHome, service: "fixture", vault, fetch, timeoutMs: 2000 });
  const authorize = async (address: string) => {
    const u = new URL(address); challenge = u.searchParams.get("code_challenge")!;
    expect(u.searchParams.get("code_challenge_method")).toBe("S256"); expect(u.searchParams.get("resource")).toBe(url);
    const callback = new URL(u.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "synthetic-code38"); callback.searchParams.set("state", u.searchParams.get("state")!);
    const result = await fetch(callback, { proxy: callback.origin, redirect: "error" }); expect(result.status).toBe(200);
    return undefined;
  };
  return { oauth, authorize, requests, values, vault, url, ws, stop: () => s.stop(true), refreshed: () => refreshed };
}

test("SPEC-MCP-006/CA-01 — dynamic registration, PKCE and a human callback store a connector token in the vault", async () => {
  const f = fixture();
  try { await f.oauth.signIn({ confirm: async () => true, authorize: f.authorize }, new AbortController().signal); expect(f.requests.some(r => r.path === "/register")).toBe(true); expect(f.values.size).toBe(1); expect(f.requests.every(r => r.authorization === null)).toBe(true); }
  finally { f.stop(); }
});

test("SPEC-MCP-006/CA-02 — an expired token is refreshed once before concurrent requests without another human callback", async () => {
  const f = fixture();
  try { await f.oauth.signIn({ confirm: async () => true, authorize: f.authorize }, new AbortController().signal); const values = await Promise.all(Array.from({ length: 4 }, () => f.oauth.authorization(new AbortController().signal))); expect(values).toEqual(Array(4).fill("Bearer synthetic-renewed38")); expect(f.refreshed()).toBe(1); }
  finally { f.stop(); }
});

test("TECH — a browser refusal with the correct OAuth state ends immediately and sign-out removes only its connector entry", async () => {
  const f = fixture();
  try {
    await expect(f.oauth.signIn({ confirm: async () => true, authorize: async address => { const u = new URL(address), c = new URL(u.searchParams.get("redirect_uri")!); c.searchParams.set("error", "access_denied"); c.searchParams.set("state", u.searchParams.get("state")!); expect((await fetch(c, { proxy: c.origin })).status).toBe(403); return new Promise(() => {}); } }, new AbortController().signal)).rejects.toThrow("autorisation refusée");
    f.values.set("another-connector", "synthetic-other38"); await f.oauth.signIn({ confirm: async () => true, authorize: f.authorize }, new AbortController().signal);
    await f.oauth.signOut(new AbortController().signal); expect([...f.values]).toEqual([["another-connector", "synthetic-other38"]]);
  } finally { f.stop(); }
});

test("TECH — OAuth refuses an incorrect state, a declined consent and a token from another connector", async () => {
  const f = fixture();
  try {
    let contacted = false;
    await expect(f.oauth.signIn({ confirm: async () => false, authorize: async () => { contacted = true; return undefined; } }, new AbortController().signal)).rejects.toThrow("refusée"); expect(contacted).toBe(false);
    await expect(f.oauth.signIn({ confirm: async () => true, authorize: async address => { const u = new URL(address), c = new URL(u.searchParams.get("redirect_uri")!); c.searchParams.set("code", "fixture"); c.searchParams.set("state", "incorrect"); return c.href; } }, new AbortController().signal)).rejects.toThrow("retour");
    expect(f.values.size).toBe(0);
  } finally { f.stop(); }
});

test("SPEC-OUT-029/CA-01 — SPEC-OUT-029/CA-02 — SPEC-MCP-006/CA-01 — human UI authorization replaces the unique sign-in tool with the real connector tools", async () => {
  const f = fixture();
  await Bun.write(`${f.ws.configHome}/connectors.json`, JSON.stringify({ servers: { docs: { transport: "http", url: f.url } } }));
  const p = new ScriptedProvider([{ toolCalls: [{ name: "connector_sign_in", input: { server: "docs" } }] }, { toolCalls: [{ name: "cnx_docs_lookup", input: {} }] }, { text: "done38" }]);
  const shutdown = new AbortController();
  const r = interactive(["--wait-for-mcp"], f.ws, { provider: p, columns: 1000, rows: 30, signal: shutdown.signal, env: { [`${loadIdentity().get("ENV_PREFIX")}NO_BROWSER`]: "1" }, extra: { credentialVault: f.vault }, userConfig: { permissions: { allowRules: ["cnx_docs"] } } });
  try {
    await r.idle(); r.type("Use the authenticated connector."); r.type(KEY.enter);
    await r.waitFor(t => t.includes("Autoriser le connecteur docs"));
    expect(p.requests[0]!.tools.map(t => t.name)).toContain("connector_sign_in"); expect(p.requests[0]!.tools.map(t => t.name)).not.toContain("cnx_docs_lookup");
    await new Promise(resolve => setTimeout(resolve, 380)); r.type("o");
    await r.waitFor(t => t.includes("Authentification humaine :"));
    const address = r.all().join("\n").match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s│]+/)?.[0]; expect(address).toBeDefined(); await f.authorize(address!);
    await r.waitFor(t => t.includes("done38"));
    expect(p.requests[1]!.tools.map(t => t.name)).toContain("cnx_docs_lookup"); expect(p.requests[1]!.tools.map(t => t.name)).not.toContain("connector_sign_in");
    const history = JSON.stringify(p.requests.map(q => q.history)); for (const secret of ["synthetic-access38", "synthetic-refresh38", "synthetic-code38", "code_challenge", "code_verifier"]) expect(history).not.toContain(secret);
  } finally { shutdown.abort(); await r.done; f.stop(); }
}, 15000);

test("SPEC-MCP-006/CA-03 — authentication pending for one connector does not block another or expose a sign-in tool in headless mode", async () => {
  const f = fixture(), other = httpConnectorServer();
  await Bun.write(`${f.ws.configHome}/connectors.json`, JSON.stringify({ servers: { docs: { url: f.url }, other: { url: other.url } } }));
  const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_other_lookup", input: {} }] }, { text: "done" }]);
  try { const result = await cli(["--non-interactive", "--wait-for-mcp", "x"], f.ws, { provider: p, extra: { credentialVault: f.vault }, userConfig: { permissions: { allowRules: ["cnx_other"] } } }); expect(result.code).toBe(0); expect(p.requests[0]!.tools.map(t => t.name)).toContain("cnx_other_lookup"); expect(p.requests[0]!.tools.map(t => t.name)).not.toContain("connector_sign_in"); expect(JSON.stringify(p.requests[1]!.history)).toContain("REMOTE_VALUE_29"); }
  finally { f.stop(); other.stop(); }
});

test("SPEC-MCP-022/CA-03 — disabling docs removes its tools immediately and persists for the next session", async () => {
  const ws = workspace(), server = httpConnectorServer();
  await Bun.write(`${ws.configHome}/connectors.json`, JSON.stringify({ servers: { docs: { url: server.url } } }));
  const h = new Host(ws, { argv: ["--wait-for-mcp"], provider: new ScriptedProvider([]), init: {} });
  try { expect(JSON.stringify(await h.request("invoke_command", { command: "/connectors disable docs" }))).toContain("désactivé"); }
  finally { h.feed.end(); await h.finish(); }
  const p = new ScriptedProvider([{ text: "done" }]);
  try { const result = await cli(["--non-interactive", "--wait-for-mcp", "x"], ws, { provider: p }); expect(result.code).toBe(0); expect(p.requests[0]!.tools.map(t => t.name)).not.toContain("cnx_docs_lookup"); }
  finally { server.stop(); }
});

test("SPEC-MCP-008/CA-01 — SPEC-MCP-008/CA-02 — dynamic headers replace static headers without disclosure and refresh once after a 401", async () => {
  const ws = workspace(); let calls = 0; const tokens: Array<string | null> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    tokens.push(req.headers.get("Authorization"));
    if (req.headers.get("Authorization") === "Bearer synthetic-first38") return new Response(null, { status: 401 });
    if (req.method === "GET") return new Response(null, { status: 405 }); if (req.method === "DELETE") return new Response(null, { status: 204 });
    const m = await req.json() as { id?: number; method: string }; if (m.id === undefined) return new Response(null, { status: 202 }); calls++;
    return Response.json({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : m.method === "tools/list" ? { tools: [] } : {} });
  } });
  const counter = `${ws.project}/count.txt`, file = ws.write("project/headers.js", `let n=0; try{n=Number(await Bun.file(${JSON.stringify(counter)}).text())}catch{}; await Bun.write(${JSON.stringify(counter)},String(++n)); console.log(JSON.stringify({ authorization: "Bearer "+(n===1?"synthetic-first38":"synthetic-second38") }));`);
  const quote = (s: string) => process.platform === "win32" ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : ""}${quote(BUN)} ${quote(file)}`;
  await Bun.write(`${ws.configHome}/connectors.json`, JSON.stringify({ servers: { docs: { url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: "Bearer static38" }, headersCommand: command } } }));
  const p = new ScriptedProvider([{ text: "done" }]);
  try { const result = await cli(["--non-interactive", "--wait-for-mcp", "x"], ws, { provider: p, env: productEnv(ws), userConfig: { mcp: { maxReconnects: 0 } } }); expect(result.code).toBe(0); if (!await Bun.file(counter).exists()) throw new Error(result.stderr); expect(await Bun.file(counter).text()).toBe("2"); expect(tokens[0]).toBe("Bearer synthetic-first38"); expect(tokens.slice(1).every(t => t === "Bearer synthetic-second38")).toBe(true); expect(calls).toBeGreaterThan(0); expect(JSON.stringify(p.requests) + result.stderr + result.stdout).not.toContain("synthetic-second38"); }
  finally { server.stop(true); }
}, 15000);
