import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ManagedIdentityProvider, identityProviderSecretVariables, type IdentityProviderConfiguration } from "../src/auth/identity-provider";
import { ConnectorOAuth, clientBasic } from "../src/connectors/oauth";
import { ConnectorManager } from "../src/connectors/manager";
import { resolveConnectors } from "../src/connectors/declarations";
import type { CredentialVault } from "../src/platform/credential-vault";
import { networkFetch } from "../src/platform/network";
import { currentPlatform } from "../src/platform/system";
import { EnvironmentView } from "../src/config/environment";
import { Settings } from "../src/config/settings";
import { workspace, cli, loadIdentity, testToolFields } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const tls = workspace(), cert = join(tls.root, "idp-cert.pem"), key = join(tls.root, "idp-key.pem");
const openssl = Bun.which("openssl") ?? (existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
expect(spawnSync(openssl, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } }).status).toBe(0);
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 }), jwk = { ...signing.publicKey.export({ format: "jwk" }), kid: "fixture-idp-key", use: "sig", alg: "RS256" };
const signal = () => new AbortController().signal;
function fixture(allowFallback = false) {
  const ws = workspace(), values = new Map<string, string>(), secrets = new Set<string>(); let now = Date.now(), human = 0, exchanges = 0, refreshes = 0, serial = 0, permitted = true, denied = false, invalidIdentity = "", invalidGrant = "";
  const requests: Array<{ path: string; grant?: string; resource?: string }> = [], codes = new Map<string, { challenge: string; nonce: string; resource: string | null }>(), access = new Map<string, string>();
  const vault: CredentialVault = { read: (_service, account) => values.get(account), write: (_service, account, value) => { values.set(account, value); }, remove: (_service, account) => { values.delete(account); } };
  const jwt = (claims: Record<string, unknown>, typ = "JWT", rawNotBefore?: "-1e999" | "1e999") => { const json = JSON.stringify(claims), payload = rawNotBefore ? json.slice(0, -1) + ',"nbf":' + rawNotBefore + "}" : json; if (rawNotBefore) expect(Number.isFinite(JSON.parse(payload).nbf)).toBe(false); const encoded = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-idp-key", typ })).toString("base64url") + "." + Buffer.from(payload).toString("base64url"); return encoded + "." + sign("RSA-SHA256", Buffer.from(encoded), signing.privateKey).toString("base64url"); };
  const claims = (token: string) => { const [h, p, s] = token.split("."); if (!h || !p || !s || !verify("RSA-SHA256", Buffer.from(`${h}.${p}`), signing.publicKey, Buffer.from(s, "base64url"))) throw new Error("fixture signature mismatch"); return JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>; };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: readFileSync(cert), key: readFileSync(key) }, async fetch(req) {
    const u = new URL(req.url), base = u.origin, issuer = base + "/idp", seconds = Math.floor(now / 1000);
    const metadata = (name: string) => ({ issuer: `${base}/as-${name}`, authorization_endpoint: `${base}/as-${name}/auth`, token_endpoint: `${base}/as-${name}/token`, revocation_endpoint: `${base}/as-${name}/revoke`, code_challenge_methods_supported: ["S256"] });
    if (u.pathname === "/idp/.well-known/openid-configuration") return Response.json({ issuer, authorization_endpoint: issuer + "/auth", token_endpoint: issuer + "/token", revocation_endpoint: issuer + "/revoke", jwks_uri: issuer + "/keys", code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic"] });
    if (u.pathname === "/idp/keys") return Response.json({ keys: [jwk] });
    if (u.pathname.startsWith("/.well-known/oauth-protected-resource/mcp/")) { const name = u.pathname.split("/").at(-1)!; return Response.json({ resource: `${base}/mcp/${name}`, authorization_servers: [`${base}/as-${name}`] }); }
    if (u.pathname.startsWith("/.well-known/oauth-authorization-server/as-")) return Response.json(metadata(u.pathname.split("as-")[1]!));
    if (u.pathname.endsWith("/auth")) {
      human++; const code = "synthetic-code-" + ++serial, callback = new URL(u.searchParams.get("redirect_uri")!);
      if (u.searchParams.get("code_challenge_method") !== "S256") return new Response(null, { status: 400 });
      codes.set(code, { challenge: u.searchParams.get("code_challenge")!, nonce: u.searchParams.get("nonce") ?? "", resource: u.searchParams.get("resource") }); callback.searchParams.set("state", u.searchParams.get("state")!); callback.searchParams.set("code", code); return Response.redirect(callback.href);
    }
    if (u.pathname.startsWith("/mcp/")) {
      const name = u.pathname.split("/").at(-1)!, bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!bearer || access.get(bearer) !== name) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/${name}"` } });
      if (req.method === "GET") return new Response(null, { status: 405 }); if (req.method === "DELETE") return new Response(null, { status: 204 });
      const m = await req.json() as { id?: number; method: string }; if (m.id === undefined) return new Response(null, { status: 202 });
      const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : m.method === "tools/list" ? { tools: [{ name: "lookup", description: "Read the fixture resource", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: `OIDC_VALUE_${name} ${bearer}` }] };
      return Response.json({ jsonrpc: "2.0", id: m.id, result });
    }
    const body = new URLSearchParams(await req.text()), grant = body.get("grant_type") ?? "";
    requests.push({ path: u.pathname, grant, resource: body.get("resource") ?? undefined });
    if (u.pathname.endsWith("/revoke")) return new Response(null, { status: 200 });
    const fail = () => Response.json({ error: "invalid_grant", error_description: "synthetic-secret-error-must-not-escape" }, { status: 400 });
    if (u.pathname === "/idp/token") {
      if (req.headers.get("authorization") !== clientBasic("idp-client", "synthetic-idp-secret")) return fail();
      if (grant.endsWith(":token-exchange")) {
        exchanges++; if (denied) return fail(); const subject = claims(body.get("subject_token")!); if (subject.iss !== issuer || subject.aud !== "idp-client" || body.get("requested_token_type") !== "urn:ietf:params:oauth:token-type:id-jag" || body.get("subject_token_type") !== "urn:ietf:params:oauth:token-type:id_token") return fail();
        const resource = body.get("resource")!, name = resource.split("/").at(-1)!, assertion = jwt({ iss: issuer, sub: invalidGrant === "subject" ? "another-user" : "fixture-user", aud: invalidGrant === "audience" ? issuer : `${base}/as-${name}`, client_id: `client-${name}`, resource, scope: invalidGrant === "scope" ? "read write" : "read", exp: seconds + 300, iat: seconds, jti: "jag-" + ++serial }, "oauth-id-jag+jwt", invalidGrant === "nbf-negative" ? "-1e999" : invalidGrant === "nbf-positive" ? "1e999" : undefined);
        return Response.json({ access_token: assertion, token_type: "N_A", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", expires_in: 300 });
      }
      let nonce = "";
      if (grant === "authorization_code") { const code = codes.get(body.get("code")!); if (!code || createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !== code.challenge || body.has("resource")) return fail(); codes.delete(body.get("code")!); nonce = code.nonce; }
      else if (grant === "refresh_token") { refreshes++; if (body.get("refresh_token") !== "synthetic-idp-refresh" || denied) return fail(); } else return fail();
      let token = jwt({ iss: invalidIdentity === "issuer" ? base + "/wrong" : issuer, aud: invalidIdentity === "audience" ? "wrong-client" : "idp-client", sub: invalidIdentity === "subject" ? "changed-user" : "fixture-user", exp: seconds + 600, iat: seconds, at_hash: invalidIdentity === "at_hash" ? "wrong-access-hash" : createHash("sha256").update("synthetic-idp-access").digest().subarray(0, 16).toString("base64url"), ...(nonce ? { nonce: invalidIdentity === "nonce" ? "wrong-nonce" : nonce } : {}) }, "JWT", invalidIdentity === "nbf-negative" ? "-1e999" : invalidIdentity === "nbf-positive" ? "1e999" : undefined);
      if (invalidIdentity === "signature") { const [h, p, signature] = token.split("."); token = `${h}.${p}.${signature![0] === "a" ? "b" : "a"}${signature!.slice(1)}`; }
      return Response.json({ access_token: "synthetic-idp-access", refresh_token: "synthetic-idp-refresh", id_token: token, token_type: "Bearer", expires_in: 600 });
    }
    if (u.pathname.startsWith("/as-") && u.pathname.endsWith("/token")) {
      const name = u.pathname.split("/")[1]!.slice(3);
      if (grant.endsWith(":jwt-bearer")) { const assertion = claims(body.get("assertion")!); if (req.headers.get("authorization") !== clientBasic(`client-${name}`, "synthetic-as-secret") || assertion.aud !== `${base}/as-${name}` || assertion.client_id !== `client-${name}` || assertion.resource !== `${base}/mcp/${name}`) return fail(); }
      else if (grant === "authorization_code") { const code = codes.get(body.get("code")!); if (!code || createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !== code.challenge || code.resource !== `${base}/mcp/${name}`) return fail(); codes.delete(body.get("code")!); } else return fail();
      const token = `synthetic-resource-${name}-${++serial}`; access.set(token, name); return Response.json({ access_token: token, token_type: "Bearer", expires_in: invalidGrant === "long-access" ? 7200 : 60, resource: `${base}/mcp/${name}`, scope: "read" });
    }
    return new Response(null, { status: 404 });
  } });
  const base = `https://127.0.0.1:${server.port}`, variables = { IDP_CLIENT_SECRET: "synthetic-idp-secret", RESOURCE_CLIENT_SECRET: "synthetic-as-secret" };
  const configuration: IdentityProviderConfiguration = { issuer: base + "/idp", clientId: "idp-client", clientSecret: "${IDP_CLIENT_SECRET}", allowOAuthFallback: allowFallback, connectors: ["alpha", "beta"].map(name => ({ name, resource: `${base}/mcp/${name}`, authorizationServer: `${base}/as-${name}`, clientId: `client-${name}`, clientSecret: "${RESOURCE_CLIENT_SECRET}", scopes: ["read"] })) };
  const network = networkFetch({ extraCa: readFileSync(cert, "utf8"), noProxy: ["*"], caHint: "fixture authority" });
  const remember = (value: string) => { secrets.add(value); }, provider = new ManagedIdentityProvider({ configuration, configDir: ws.configHome, service: loadIdentity().get("KEYCHAIN_SERVICE"), vault, fetch: network, variables, timeoutMs: 5000, now: () => now, permitted: () => permitted, remember });
  const oauth = (name: string, url = `${base}/mcp/${name}`) => new ConnectorOAuth({ name, url, configuration: { clientId: `client-${name}` }, configDir: ws.configHome, service: loadIdentity().get("KEYCHAIN_SERVICE"), vault, fetch: network, timeoutMs: 5000, now: () => now, remember, ...provider.connector(name, url) });
  const authorize = async (address: string) => { const response = await network(address, { redirect: "manual" }); expect(response.status).toBe(302); const returned = new URL(response.headers.get("location")!); expect((await fetch(returned, { proxy: returned.origin, redirect: "error" })).status).toBe(200); return undefined; };
  const ui = { confirm: async () => true, authorize };
  const declarations = Object.fromEntries(["alpha", "beta", "outside"].map(name => [name, { transport: "http", url: `${base}/mcp/${name}`, oauth: { clientId: `client-${name}` } }]));
  const errors: string[] = [], manager = new ConnectorManager({ connectors: resolveConnectors([{ scope: "user", source: "fixture", content: { servers: declarations } }], { connectorsOnly: false, denyList: [], managedServersOnly: false, projectChoice: () => "approved" }).connectors, projectRoot: ws.project, platform: currentPlatform(), variables, environment: () => ({}), connectTimeoutMs: 5000, toolTimeoutMs: 5000, maxParallel: 4, maxReconnects: 0, descriptionMax: 1000, outputInlineLimit: 10000, clientInfo: { name: "fixture", version: "1" }, estimateTokens: text => text.length, store: () => "fixture", report: text => errors.push(text), changed: () => {}, fetch: network, authUi: ui, oauth: (declaration, url) => oauth(declaration.name, url) });
  return { ws, values, vault, base, network, provider, configuration, variables, oauth, authorize, ui, manager, errors, requests, secrets, human: () => human, exchanges: () => exchanges, refreshes: () => refreshes, advance: (ms: number) => { now += ms; }, deny: () => { denied = true; access.clear(); }, policy: () => { permitted = false; }, badIdentity: (mode: string) => { invalidIdentity = mode; }, badGrant: (mode: string) => { invalidGrant = mode; }, stop: async () => { await manager.close(); server.stop(true); } };
}

test("SPEC-MCP-007/CA-01 — one actual OIDC PKCE callback opens two eligible HTTPS MCP connectors", async () => {
  const f = fixture();
  try { f.manager.start(); await f.manager.waitAll(6000); expect(f.manager.status().every(s => s.state === "auth_required")).toBe(true); await f.manager.signIn("alpha", signal()); expect(f.manager.status().filter(s => s.name !== "outside").map(s => [s.state, s.organizationAccess])).toEqual([["connected", true], ["connected", true]]); expect(f.human()).toBe(1); expect(f.exchanges()).toBe(2); for (const name of ["alpha", "beta"]) { const tool = f.manager.tools().find(t => t.name === `cnx_${name}_lookup`)!; expect(JSON.stringify(await tool.execute({} as never, { ...testToolFields(), platform: currentPlatform(), home: f.ws.home, cwd: f.ws.project, allowedDirectories: [f.ws.project], signal: signal() }))).toContain(`OIDC_VALUE_${name}`); } expect(f.requests.filter(r => r.grant?.endsWith(":jwt-bearer"))).toHaveLength(2); expect([...f.values.keys()].filter(key => key.startsWith("identity-provider-"))).toHaveLength(1); }
  finally { await f.stop(); }
}, 15000);
test("SPEC-MCP-007/CA-02 — a non-eligible connector follows its own standard OAuth flow", async () => {
  const f = fixture(); try { f.manager.start(); await f.manager.waitAll(6000); await f.manager.signIn("outside", signal()); expect(f.human()).toBe(1); expect(f.exchanges()).toBe(0); expect(f.manager.status().find(s => s.name === "outside")).toMatchObject({ state: "connected" }); expect(f.manager.status().find(s => s.name === "outside")?.organizationAccess).toBeUndefined(); expect(f.requests.some(r => r.path === "/as-outside/token" && r.grant === "authorization_code")).toBe(true); } finally { await f.stop(); }
}, 15000);
test("TECH — delegated refresh repeats both standard exchanges, renews expired OIDC identity and observes organization revocation", async () => {
  const f = fixture(), a = f.oauth("alpha"); try { await a.signIn(f.ui, signal()); f.advance(61000); expect(await a.authorization(signal())).toStartWith("Bearer synthetic-resource-alpha-"); expect(f.exchanges()).toBe(2); f.advance(601000); await a.authorization(signal()); expect(f.refreshes()).toBe(1); expect(f.human()).toBe(1); f.deny(); await expect(a.authorization(signal(), true)).rejects.toThrow("organisation"); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); expect(f.human()).toBe(1); } finally { await f.stop(); }
});
test("TECH — organization refusal cannot trigger standard OAuth unless the administrator permits fallback", async () => {
  for (const fallback of [false, true]) { const f = fixture(fallback), a = f.oauth("alpha"); try { f.deny(); if (fallback) { await a.signIn(f.ui, signal()); expect(f.human()).toBe(2); expect(a.organizationAccess).toBe(false); } else { await expect(a.signIn(f.ui, signal())).rejects.toThrow("organisation"); expect(f.human()).toBe(1); } expect(f.requests.some(r => r.path === "/as-alpha/token" && r.grant === "authorization_code")).toBe(fallback); } finally { await f.stop(); } }
});
test("TECH — invalid signed identity issuer, audience, nonce or signature never persists credentials or falls back", async () => {
  for (const mode of ["issuer", "audience", "nonce", "signature", "at_hash"]) { const f = fixture(true); try { f.badIdentity(mode); await expect(f.oauth("alpha").signIn(f.ui, signal())).rejects.toThrow(); expect(f.values.size).toBe(0); expect(f.exchanges()).toBe(0); expect(f.human()).toBe(1); } finally { await f.stop(); } }
}, 15000);
test("TECH — a grant for another authorization server and an altered resource URL are rejected before credential use", async () => {
  const f = fixture(true); try { expect(() => f.oauth("alpha", f.base + "/mcp/changed")).toThrow("ressource"); f.badGrant("audience"); await expect(f.oauth("alpha").signIn(f.ui, signal())).rejects.toThrow(); expect(f.requests.some(r => r.path === "/as-alpha/token")).toBe(false); expect(f.human()).toBe(1); } finally { await f.stop(); }
});
test("TECH — a correctly signed delegated grant for another subject is rejected before the resource token exchange", async () => {
  const f = fixture(true); try { f.badGrant("subject"); await expect(f.oauth("alpha").signIn(f.ui, signal())).rejects.toThrow(); expect(f.exchanges()).toBe(1); expect(f.requests.some(r => r.path === "/as-alpha/token")).toBe(false); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); expect(f.human()).toBe(1); } finally { await f.stop(); }
});
test("TECH — genuinely signed identity and delegated JWTs with non-finite raw JSON nbf are rejected without fallback", async () => {
  for (const source of ["identity", "grant"]) for (const mode of ["nbf-negative", "nbf-positive"]) { const f = fixture(true); try { if (source === "identity") f.badIdentity(mode); else f.badGrant(mode); await expect(f.oauth("alpha").signIn(f.ui, signal())).rejects.toThrow(); expect(f.exchanges()).toBe(source === "identity" ? 0 : 1); expect(f.requests.some(r => r.path === "/as-alpha/token")).toBe(false); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); if (source === "identity") expect(f.values.size).toBe(0); expect(f.human()).toBe(1); } finally { await f.stop(); } }
});
test("TECH — current policy revocation blocks a still-valid cached resource token without sending another request", async () => {
  const f = fixture(), a = f.oauth("alpha"); try { await a.signIn(f.ui, signal()); const before = f.requests.length; f.policy(); await expect(a.authorization(signal())).rejects.toThrow("gérée"); expect(f.requests).toHaveLength(before); } finally { await f.stop(); }
});
test("TECH — a signed grant cannot widen managed scopes or keep a long-lived delegated bearer", async () => {
  for (const mode of ["scope", "long-access"]) { const f = fixture(true); try { f.badGrant(mode); await expect(f.oauth("alpha").signIn(f.ui, signal())).rejects.toThrow(); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); if (mode === "scope") expect(f.requests.some(r => r.path === "/as-alpha/token")).toBe(false); expect(f.human()).toBe(1); } finally { await f.stop(); } }
});
test("TECH — identity refresh cannot substitute a different subject or retain a resource grant after refusal", async () => {
  const f = fixture(), a = f.oauth("alpha"); try { await a.signIn(f.ui, signal()); f.advance(601000); f.badIdentity("subject"); await expect(a.authorization(signal())).rejects.toThrow(); expect(f.exchanges()).toBe(1); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); expect(f.human()).toBe(1); } finally { await f.stop(); }
});
test("TECH — a connector logout invalidates delegated authorization still waiting on human consent", async () => {
  const f = fixture(), a = f.oauth("alpha"); let entered = false, consent!: (accepted: boolean) => void;
  try { const pending = a.signIn({ confirm: async () => { entered = true; return new Promise<boolean>(resolve => { consent = resolve; }); }, authorize: f.authorize }, signal()).then(() => "restored", () => "cancelled"); while (!entered) await sleep(1); await a.signOut(signal()); consent(true); expect(await pending).toBe("cancelled"); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); expect(f.requests.some(r => r.path === "/as-alpha/token")).toBe(false); } finally { await f.stop(); }
});
test("TECH — a policy revocation during vault publication removes the just-written delegated grant", async () => {
  const f = fixture(), a = f.oauth("alpha"), write = f.vault.write.bind(f.vault);
  f.vault.write = (service, account, value) => { write(service, account, value); if (account.startsWith("connector-oauth-")) f.policy(); };
  try { await expect(a.signIn(f.ui, signal())).rejects.toThrow("gérée"); expect([...f.values.keys()].filter(k => k.startsWith("connector-oauth-"))).toHaveLength(0); expect(a.organizationAccess).toBe(false); } finally { await f.stop(); }
});
test("TECH — identity-provider settings are managed-only and their secrets cannot be inherited even through explicit child overrides", async () => {
  const f = fixture(); try { const settings = Settings.load({ sources: [{ scope: "user", name: "fixture", text: JSON.stringify({ mcp: { identityProvider: f.configuration } }) }], projectTrusted: true }); expect(settings.get("mcp.identityProvider")).toBeUndefined(); const env = new EnvironmentView("FIXTURE_", f.variables); env.protectVariables(identityProviderSecretVariables(f.configuration)); expect(env.childEnvironment({ IDP_CLIENT_SECRET: "another-secret" }).IDP_CLIENT_SECRET).toBeUndefined(); expect(env.childEnvironment().RESOURCE_CLIENT_SECRET).toBeUndefined(); } finally { await f.stop(); }
});
test("TECH — TLS verification rejects an IdP authority that has not been explicitly trusted", async () => {
  const f = fixture(); try { const untrusted = new ManagedIdentityProvider({ ...f.provider.options, fetch: networkFetch({ noProxy: ["*"], caHint: "fixture authority" }) }), client = new ConnectorOAuth({ ...f.oauth("alpha").options, ...untrusted.connector("alpha", f.base + "/mcp/alpha") }); await expect(client.signIn(f.ui, signal())).rejects.toThrow("Certificat"); expect(f.values.size).toBe(0); expect(f.human()).toBe(0); } finally { await f.stop(); }
});
test("TECH — standalone connector validation reuses delegated vault credentials without launching a model or a new login", async () => {
  const f = fixture(); try { await f.oauth("alpha").signIn(f.ui, signal()); writeFileSync(join(f.ws.managed, "policy.json"), JSON.stringify({ mcp: { identityProvider: f.configuration } })); writeFileSync(join(f.ws.configHome, "connectors.json"), JSON.stringify({ servers: { alpha: { url: f.base + "/mcp/alpha" } } })); const result = await cli(["connector", "validate", "alpha", "--json"], f.ws, { env: { ...f.variables, [loadIdentity().get("ENV_PREFIX") + "EXTRA_CA_CERTS"]: cert }, extra: { credentialVault: f.vault, providerFactory: () => { throw new Error("Model must not start during administration"); } } }); expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ state: "connected", organizationAccess: true, tools: ["cnx_alpha_lookup"] }); expect(f.human()).toBe(1); expect(result.stdout + result.stderr).not.toContain("synthetic-"); } finally { await f.stop(); }
});
test("TECH — the real CLI displays organization access and removes echoed OAuth credentials from model history", async () => {
  const f = fixture(), shutdown = new AbortController();
  writeFileSync(join(f.ws.managed, "policy.json"), JSON.stringify({ mcp: { identityProvider: f.configuration } }));
  writeFileSync(join(f.ws.configHome, "connectors.json"), JSON.stringify({ servers: Object.fromEntries(["alpha", "beta"].map(name => [name, { url: `${f.base}/mcp/${name}` }])) }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "connector_sign_in", input: { server: "alpha" } }] }, { toolCalls: [{ name: "cnx_alpha_lookup", input: {} }, { name: "cnx_beta_lookup", input: {} }] }, { text: "OIDC_CLI_DONE" }]);
  const prefix = loadIdentity().get("ENV_PREFIX"), run = interactive(["--wait-for-mcp"], f.ws, { provider, columns: 2000, rows: 30, signal: shutdown.signal, env: { ...f.variables, [prefix + "NO_BROWSER"]: "1", [prefix + "EXTRA_CA_CERTS"]: cert }, extra: { credentialVault: f.vault }, userConfig: { permissions: { allowRules: ["cnx_alpha", "cnx_beta"] } } });
  try { await run.idle(); run.type("Use both authorized connectors."); run.type(KEY.enter); await run.waitFor(t => t.includes("Autoriser le connecteur " + f.configuration.issuer)); await sleep(380); run.type("o"); await run.waitFor(t => t.includes("Authentification humaine :")); const address = run.all().join("\n").match(/https:\/\/127\.0\.0\.1:\d+\/idp\/auth\?[^\s│]+/)?.[0]; expect(address).toBeDefined(); await f.authorize(address!); await run.waitFor(t => t.includes("OIDC_CLI_DONE")); expect(f.human()).toBe(1); const history = JSON.stringify(provider.requests.map(r => r.history)); expect(history).toContain("OIDC_VALUE_alpha"); expect(history).toContain("OIDC_VALUE_beta"); expect(history).not.toContain("synthetic-resource-"); expect(history).not.toContain("synthetic-idp-secret"); run.type("/connectors"); run.type(KEY.enter); await run.waitFor(t => t.includes("accès via votre organisation")); }
  finally { shutdown.abort(); await run.done; await f.stop(); }
}, 20000);
