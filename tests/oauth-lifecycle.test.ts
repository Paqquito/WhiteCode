import { expect, test } from "bun:test";
import { ConnectorOAuth, OAuthGenerationChanged } from "../src/connectors/oauth";
import { workspace } from "./helpers/env";
import type { CredentialVault } from "../src/platform/credential-vault";
function setup(sameAccess = false) {
  const ws = workspace(), values = new Map<string, string>(); let count = 0, refreshes = 0;
  const vault: CredentialVault = { read: (_service, key) => values.get(key), write: (_service, key, value) => { values.set(key, value); }, remove: (_service, key) => { values.delete(key); } };
  const options = { name: "fixture-account", url: "https://account.example.test/api", credentialNamespace: "company-account" as const, configDir: ws.configHome, service: "fixture", vault, timeoutMs: 10000, configuration: { clientId: "fixture-client" }, explicitMetadata: { issuer: "https://account.example.test", authorization_endpoint: "https://account.example.test/auth", token_endpoint: "https://account.example.test/token" }, fetch: (async (_input, init) => { if (new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); } return Response.json({ access_token: "fixture-opaque-" + (sameAccess ? 1 : ++count), token_type: "Bearer", refresh_token: "fixture-refresh", expires_in: 3600 }); }) as typeof fetch };
  const oauth = new ConnectorOAuth(options), signal = new AbortController().signal;
  const callback = (address: string) => { const url = new URL(address), returned = new URL(url.searchParams.get("redirect_uri")!); returned.searchParams.set("code", "fixture-code"); returned.searchParams.set("state", url.searchParams.get("state")!); return returned.href; };
  const login = (client = oauth) => client.signIn({ confirm: async () => true, authorize: async address => callback(address) }, signal);
  return { oauth, values, options, login, callback, signal, refreshes: () => refreshes };
}
test("TECH — generation checks prevent consumer account substitution and stale-login cleanup", async () => {
  const b = setup(), old = await b.login(), second = new ConnectorOAuth(b.options), fresh = await b.login(second);
  expect(fresh).not.toBe(old); await expect(b.oauth.authorize(b.signal, { expectedGeneration: old })).rejects.toBeInstanceOf(OAuthGenerationChanged);
  expect(await b.oauth.signOut(b.signal, old)).toBe(false); expect((await second.info())?.generation).toBe(fresh); expect(b.values.size).toBe(1);
});
test("TECH — logout also invalidates a login whose human consent is still pending", async () => {
  const b = setup(); let consent!: (value: boolean) => void, asked = false;
  const pending = b.oauth.signIn({ confirm: async () => { asked = true; return new Promise<boolean>(resolve => { consent = resolve; }); }, authorize: async address => b.callback(address) }, b.signal);
  const outcome = pending.then(() => "restored", () => "cancelled"); while (!asked) await new Promise(resolve => setTimeout(resolve, 1)); await b.oauth.signOut(b.signal); consent(true);
  expect(await outcome).toBe("cancelled"); expect(b.values.size).toBe(0);
});
test("TECH — simultaneous unauthorized responses coalesce even when the server renews the same opaque bearer", async () => {
  const b = setup(true); await b.login(); const before = (await b.oauth.authorize(b.signal))!, second = new ConnectorOAuth(b.options);
  const results = await Promise.all([b.oauth.authorize(b.signal, { force: true, rejected: before.authorization, rejectedVersion: before.version }), second.authorize(b.signal, { force: true, rejected: before.authorization, rejectedVersion: before.version })]);
  expect(b.refreshes()).toBe(1); expect(results[0]!.authorization).toBe(before.authorization); expect(results[0]!.version).not.toBe(before.version); expect(results[1]!.version).toBe(results[0]!.version); expect(results[0]!.generation).toBe(before.generation);
});
