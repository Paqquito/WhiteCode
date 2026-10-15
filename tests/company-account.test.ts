import { expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CompanyAccount } from "../src/auth/company-account";
import type { CredentialVault } from "../src/platform/credential-vault";
import { workspace } from "./helpers/env";
function setup() {
  const ws = workspace(), values = new Map<string, string>(); let now = 1000, refreshes = 0, tokenId = 1, organization = "org-a", role = "member";
  const vault: CredentialVault = { read: (_service, key) => values.get(key), write: (_service, key, value) => { values.set(key, value); }, remove: (_service, key) => { values.delete(key); } };
  const requests: Array<{ url: string; headers: Headers; body?: string }> = [];
  const network = (async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers); requests.push({ url, headers, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url === "https://account.example.test/token") { const body = new URLSearchParams(String(init?.body)); if (body.get("grant_type") === "refresh_token") { refreshes++; tokenId++; await new Promise(resolve => setTimeout(resolve, 20)); } else { expect(body.get("code_verifier")!.length).toBeGreaterThan(30); expect(body.get("code")).toBe("fixture-code"); }
      return Response.json({ token_type: "Bearer", access_token: `fixture-access-${tokenId}`, refresh_token: "fixture-refresh", expires_in: 60 }); }
    if (url.endsWith("/profile")) return Response.json({ account: "member@example.test", organization: { id: organization, name: organization.toUpperCase() }, roles: [role], offer: "must-be-discarded" });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const options = { configDir: ws.configHome, vault, keychainService: "fixture-company", authorizeUrl: "https://account.example.test/authorize", tokenUrl: "https://account.example.test/token", clientId: "fixture-client", services: { account: "https://account.example.test/api", settings: "https://settings.example.test/api" }, fetch: network, now: () => now };
  const account = new CompanyAccount(options);
  const login = async (target = account) => target.signIn({ confirm: async () => true, authorize: async address => { const url = new URL(address); expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(url.searchParams.get("scope")).toBe("openid profile organization"); const callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "fixture-code"); return callback.href; } }, new AbortController().signal);
  return { ws, account, options, requests, values, login, setNow: (value: number) => { now = value; }, refreshes: () => refreshes, changeOrganization: (value: string) => { organization = value; }, changeRole: (value: string) => { role = value; } };
}
test("SPEC-API-028/CA-01 — company login uses PKCE, stores tokens only in the vault and exposes no offer", async () => {
  const b = setup(), profile = await b.login(); expect(profile.account).toBe("member@example.test"); expect(profile.organization.id).toBe("org-a"); expect(JSON.stringify(profile)).not.toContain("offer"); expect([...b.values.keys()][0]).toStartWith("company-account-");
  const cache = readFileSync(join(b.ws.configHome, "company-profile.json"), "utf8"); expect(cache).not.toContain("fixture-access"); expect(cache).not.toContain("fixture-refresh"); expect(cache).not.toContain("offer");
});
test("SPEC-API-028/CA-02 — an expired account token refreshes automatically for a configured consumer", async () => {
  const b = setup(); await b.login(); b.setNow(90000); await b.account.request("settings", "read", undefined, new AbortController().signal); expect(b.refreshes()).toBe(1); expect(b.requests.at(-1)!.headers.get("authorization")).toBe("Bearer fixture-access-2");
});
test("SPEC-API-028/CA-03 — two profile clients sharing a vault perform one concurrent expiry refresh", async () => {
  const b = setup(); await b.login(); b.setNow(90000); const second = new CompanyAccount(b.options);
  await Promise.all([b.account.request("settings", "read", undefined, new AbortController().signal), second.request("settings", "read", undefined, new AbortController().signal)]); expect(b.refreshes()).toBe(1);
});
test("SPEC-API-028/CA-04 — the human can paste the callback code and state without opening a browser", async () => {
  const b = setup(); await b.login(); expect((await b.account.profile())?.account).toBe("member@example.test");
});
test("SPEC-API-023/CA-02 — refreshing a changed organization and role replaces the nonsecret profile", async () => {
  const b = setup(); await b.login(); b.changeOrganization("org-b"); b.changeRole("reviewer"); await b.account.refreshProfile(new AbortController().signal); const profile = await b.account.profile(); expect(profile?.organization.id).toBe("org-b"); expect(profile?.roles).toEqual(["reviewer"]);
});
test("SPEC-API-012/CA-01 — a forced organization mismatch removes account credentials and names the expected organization", async () => {
  const b = setup(), restricted = new CompanyAccount({ ...b.options, forceOrganization: () => "required-org" });
  await expect(b.login(restricted)).rejects.toThrow("required-org"); expect(b.values.size).toBe(0); expect(readdirSync(b.ws.configHome)).not.toContain("company-profile.json");
});
test("TECH — hostile redirects, unknown consumers and non-HTTPS company endpoints receive no account token", async () => {
  const b = setup(); await b.login(); const count = b.requests.length;
  await expect(b.account.request("settings", "https://third-party.example.test/api", undefined, new AbortController().signal)).rejects.toThrow(); await expect(b.account.request("settings", "../outside", undefined, new AbortController().signal)).rejects.toThrow(); await expect(b.account.request("events", "read", undefined, new AbortController().signal)).rejects.toThrow(); expect(b.requests).toHaveLength(count);
  expect(() => new CompanyAccount({ ...b.options, tokenUrl: "http://account.example.test/token" })).toThrow("HTTPS");
});
test("TECH — logout invalidates a browser login that is still waiting for its callback", async () => {
  const b = setup(); let address = "", finish!: (value: string) => void;
  const login = b.account.signIn({ confirm: async () => true, authorize: async value => { address = value; return new Promise<string>(resolve => { finish = resolve; }); } }, new AbortController().signal);
  const caught = login.catch(() => undefined); while (!address) await new Promise(resolve => setTimeout(resolve, 1));
  await b.account.signOut(new AbortController().signal); expect(b.values.size).toBe(0);
  const url = new URL(address), callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "fixture-code"); finish(callback.href);
  await caught; expect(b.values.size).toBe(0); expect(await b.account.profile()).toBeUndefined();
});
test("TECH — cancelling one consumer does not cancel another waiting on the same expiry renewal", async () => {
  const b = setup(); await b.login(); b.setNow(90000); const first = new AbortController(), second = new AbortController();
  const one = b.account.request("settings", "read", undefined, first.signal).then(() => "done", () => "cancelled"), two = b.account.request("settings", "read", undefined, second.signal);
  while (b.refreshes() === 0) await new Promise(resolve => setTimeout(resolve, 1)); first.abort();
  expect(await one).toBe("cancelled"); expect(await two).toEqual({ ok: true }); expect(b.refreshes()).toBe(1);
});
test("TECH — malformed or outdated OAuth metadata never prevents local logout or a new login", async () => {
  const b = setup(); await b.login(); const changed = new CompanyAccount({ ...b.options, tokenUrl: "https://account.example.test/new-token" });
  await changed.signOut(new AbortController().signal); expect(b.values.size).toBe(0); await b.login(); expect(b.values.size).toBe(1);
});
test("TECH — explicit account logout removes a malformed profile cache without parsing it", async () => {
  const b = setup(); await b.login(); const file = join(b.ws.configHome, "company-profile.json"); writeFileSync(file, "{broken");
  await b.account.signOut(new AbortController().signal); expect(b.values.size).toBe(0); expect(existsSync(file)).toBe(false);
});
test("TECH — failed identity validation clears new credentials and the previous account cache", async () => {
  const b = setup(); await b.login(); const network = (async (input, init) => String(input).endsWith("/profile") ? Response.json({ error: true }, { status: 503 }) : b.options.fetch(input, init)) as typeof fetch;
  const changed = new CompanyAccount({ ...b.options, fetch: network }); await expect(b.login(changed)).rejects.toThrow(); expect(b.values.size).toBe(0); expect(await changed.profile()).toBeUndefined();
});
test("TECH — existing credentials outside a newly forced organization cannot reach another consumer", async () => {
  const b = setup(); await b.login(); const restricted = new CompanyAccount({ ...b.options, forceOrganization: () => "required-org" }), count = b.requests.filter(request => request.url.includes("settings.example")).length;
  await expect(restricted.request("settings", "read", undefined, new AbortController().signal)).rejects.toThrow("required-org"); expect(b.values.size).toBe(0); expect(b.requests.filter(request => request.url.includes("settings.example"))).toHaveLength(count);
});
test("TECH — a multi-request consumer pins its account and organization before sending any private payload",async()=>{
 const b=setup();await b.login();b.changeOrganization("org-b");await b.account.refreshProfile(new AbortController().signal);const count=b.requests.filter(request=>request.url.includes("settings.example")).length;
 await expect(b.account.request("settings","snapshot",{values:{"ui.theme":"dark"}},new AbortController().signal,{organizationId:"org-a",account:"member@example.test"})).rejects.toThrow("modifiés");expect(b.requests.filter(request=>request.url.includes("settings.example"))).toHaveLength(count);
});
test("TECH — a profile request rejected once during login refreshes without leaving an unvalidated credential", async () => {
  const b = setup(); let refused = false;
  const network = (async (input, init) => { if (String(input).endsWith("/profile") && !refused) { refused = true; return Response.json({ error: "expired" }, { status: 401 }); } return b.options.fetch(input, init); }) as typeof fetch;
  const account = new CompanyAccount({ ...b.options, fetch: network }); await b.login(account); expect(b.refreshes()).toBe(1); expect((await account.profile())?.account).toBe("member@example.test"); expect(b.values.size).toBe(1);
});
