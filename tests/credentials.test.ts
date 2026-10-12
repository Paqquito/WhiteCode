// Credential routes use fictitious keys, a local terminal and isolated profiles. No account login or real API request.
import { expect, test } from "bun:test";
import { existsSync, linkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CredentialStore } from "../src/auth/credentials";
import { nativeCredentialVault, VaultUnavailable, type CredentialVault } from "../src/platform/credential-vault";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { runToCompletion } from "../src/platform/process";
import { productEnv } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { currentPlatform } from "../src/platform/system";
import { tryFileLock } from "../src/platform/file-lock";

const valid = { validateCredential: async () => {} };
const fakeKey = "fixture-only-credential-value-4827";
class MemoryVault implements CredentialVault {
  readonly entries = new Map<string, string>();
  read(service: string, account: string) { return this.entries.get(service + "/" + account); }
  write(service: string, account: string, value: string) { this.entries.set(service + "/" + account, value); }
  remove(service: string, account: string) { this.entries.delete(service + "/" + account); }
}
const absent: CredentialVault = { read() { throw new VaultUnavailable(); }, write() { throw new VaultUnavailable(); }, remove() { throw new VaultUnavailable(); } };
const diskText = (root: string): string => readdirSync(root, { withFileTypes: true }).map((entry) => entry.isDirectory() ? diskText(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString("utf8")).join("\n");
async function enterKey(run: ReturnType<typeof interactive>) {
  await run.waitFor((text) => text.includes("Clé d'API (saisie masquée)"));
  run.type(fakeKey);
  expect(run.all().join("\n")).not.toContain(fakeKey);
  run.type(KEY.enter);
}
async function accept(run: ReturnType<typeof interactive>, message: string) {
  await run.waitFor((text) => text.includes(message));
  await sleep(400); run.type("o");
}

test("SPEC-PER-027/CA-01 — SPEC-API-011/CA-02 — a masked login is stored in the vault and reused after restarting", async () => {
  const ws = workspace();
  const vault = currentPlatform() === "windows" ? nativeCredentialVault() : new MemoryVault();
  const extra = { ...valid, credentialVault: vault };
  const login = interactive(["auth", "login"], ws, { extra });
  try {
    await enterKey(login);
    expect((await login.done).code).toBe(0);
    expect(diskText(ws.root)).not.toContain(fakeKey);
    let used: string | undefined;
    const provider = new ScriptedProvider([{ text: "session restarted" }]);
    const result = await cli(["--non-interactive", "Work."], ws, { extra: { ...extra, providerFactory: (options) => { used = options.apiKey; return provider; } } });
    expect(result.code).toBe(0); expect(used).toBe(fakeKey);
    expect(result.stdout + result.stderr).not.toContain(fakeKey);
  } finally {
    const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "auto" });
    await store.clear();
  }
}, 20_000);

test("SPEC-PER-027/CA-02 — unavailable vault: only explicit choice creates a private unencrypted fallback", async () => {
  const ws = workspace();
  const extra = { ...valid, credentialVault: absent };
  const refused = interactive(["auth", "login"], ws, { extra });
  await enterKey(refused);
  await refused.waitFor((text) => text.includes("non chiffré"));
  await sleep(400); refused.type("n");
  expect((await refused.done).code).toBe(2);
  expect(existsSync(join(ws.configHome, "credentials.json"))).toBe(false);
  const accepted = interactive(["auth", "login"], ws, { extra });
  await enterKey(accepted); await accept(accepted, "non chiffré");
  expect((await accepted.done).code).toBe(0);
  const file = join(ws.configHome, "credentials.json");
  expect(readFileSync(file, "utf8")).toContain(fakeKey);
  if (currentPlatform() !== "windows") expect(statSync(file).mode & 0o777).toBe(0o600);
  else {
    const result = runToCompletion("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$acl=[System.IO.File]::GetAccessControl('${file.replace(/'/g, "''")}'); [pscustomobject]@{ protected=$acl.AreAccessRulesProtected; entries=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress`], { cwd: ws.project, env: productEnv(ws), timeoutMs: 5000 });
    expect(result.code).toBe(0);
    const acl = JSON.parse(result.stdout);
    expect(acl.protected).toBe(true); expect(acl.entries).toEqual([acl.current]);
  }
  expect(accepted.all().join("\n")).not.toContain(fakeKey);
}, 20_000);

test("SPEC-PER-027/CA-03 — SPEC-PER-027/CA-05 — managed keychain forbids a user file preference and never offers fallback", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ auth: { credentialStore: "keychain" } }));
  const run = interactive(["auth", "login"], ws, { extra: { ...valid, credentialVault: absent }, userConfig: { auth: { credentialStore: "file" } } });
  await enterKey(run);
  const result = await run.done;
  expect(result.code).toBe(2); expect(result.stderr).toContain("trousseau exigé");
  expect(run.all().join("\n")).not.toContain("Accepter le fichier");
  expect(existsSync(join(ws.configHome, "credentials.json"))).toBe(false);
});

test("SPEC-API-011/CA-01 — first interactive environment key shows only its last four characters and remembers its fingerprint", async () => {
  const ws = workspace();
  const options = { provider: new ScriptedProvider([]), env: { ANTHROPIC_API_KEY: fakeKey }, userConfig: { api: { provider: "anthropic" } }, extra: { ...valid, credentialVault: new MemoryVault() } };
  const run = interactive(["--model", "vendor-always"], ws, options);
  await accept(run, "4827"); await run.idle();
  expect(run.all().join("\n")).not.toContain(fakeKey);
  run.type(KEY.ctrlD); run.type(KEY.ctrlD); expect((await run.done).code).toBe(0);
  expect(diskText(ws.configHome)).not.toContain(fakeKey);
  const again = interactive(["--model", "vendor-always"], ws, options);
  await again.idle(); expect(again.all().join("\n")).not.toContain("Utiliser cette clé");
  again.type(KEY.ctrlD); again.type(KEY.ctrlD); expect((await again.done).code).toBe(0);
}, 20_000);

test("SPEC-CMD-040/CA-01 — slash logout confirms removal of product credentials while a separate archive entry remains", async () => {
  const ws = workspace();
  const vault = new MemoryVault();
  const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "auto" });
  await store.save("provider:openai_compatible", fakeKey);
  vault.write(loadIdentity().get("KEYCHAIN_SERVICE"), "separate-archive-key", "fixture-archive-value");
  const run = interactive([], ws, { provider: new ScriptedProvider([]), extra: { ...valid, credentialVault: vault } });
  await run.idle(); run.type("/logout"); run.type(KEY.enter);
  await accept(run, "Supprimer les identifiants");
  expect((await run.done).code).toBe(0);
  expect(await store.get("provider:openai_compatible")).toBeUndefined();
  expect(vault.read(loadIdentity().get("KEYCHAIN_SERVICE"), "separate-archive-key")).toBe("fixture-archive-value");
}, 20_000);

test("TECH — credentials never fall back after a vault write failure, automated login has no secret argument", async () => {
  const ws = workspace();
  const vault = new MemoryVault();
  vault.write = () => { throw new Error("storage failure"); };
  const run = interactive(["auth", "login"], ws, { extra: { ...valid, credentialVault: vault } });
  await enterKey(run); expect((await run.done).code).toBe(2);
  expect(existsSync(join(ws.configHome, "credentials.json"))).toBe(false);
  const result = await cli(["auth", "login", fakeKey], workspace(), { extra: { ...valid, credentialVault: absent } });
  expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain(fakeKey);
});

test("TECH — a locked vault does not read, write or erase an existing fallback", async () => {
  const ws = workspace();
  ws.write("home/config/credentials.json", JSON.stringify({ "provider:test": fakeKey }));
  const locked: CredentialVault = { read() { throw new VaultUnavailable(true); }, write() { throw new VaultUnavailable(true); }, remove() { throw new VaultUnavailable(true); } };
  const store = new CredentialStore({ service: "fixture", configDir: ws.configHome, preference: "auto", vault: locked });
  let consent = 0;
  await expect(store.get("provider:test")).rejects.toThrow("verrouillé");
  await expect(store.save("provider:test", fakeKey, async () => { consent++; return true; })).rejects.toThrow("verrouillé");
  await expect(store.clear()).rejects.toThrow("verrouillé");
  expect(consent).toBe(0); expect(readFileSync(join(ws.configHome, "credentials.json"), "utf8")).toContain(fakeKey);
});

test("TECH — a managed vault requirement added during fallback consent prevents the file write", async () => {
  const ws = workspace();
  const run = interactive(["auth", "login"], ws, { extra: { ...valid, credentialVault: absent } });
  await enterKey(run); await run.waitFor((text) => text.includes("Accepter le fichier"));
  ws.write("managed/policy.json", JSON.stringify({ auth: { credentialStore: "keychain" } }));
  await sleep(400); run.type("o");
  expect((await run.done).code).toBe(2);
  expect(existsSync(join(ws.configHome, "credentials.json"))).toBe(false);
});

test("TECH — slash login keeps typed and pasted credentials out of drafts, history and transcripts", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const provider = new ScriptedProvider([]);
  const run = interactive([], ws, { provider, extra: { ...valid, credentialVault: vault } });
  await run.idle(); run.type("/login"); run.type(KEY.enter);
  await run.waitFor((text) => text.includes("saisie masquée"));
  run.paste(fakeKey); await sleep(50); run.type(KEY.enter);
  expect((await run.done).code).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(diskText(ws.root)).not.toContain(fakeKey);
  expect(run.all().join("\n")).not.toContain(fakeKey);
  const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, preference: "auto", vault });
  expect(await store.get("provider:openai_compatible")).toBe(fakeKey);
});

test("TECH — migration merges both stores without dropping distinct accounts, corruption never echoes credential bytes", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const common = { service: "fixture-migration", configDir: ws.configHome, vault };
  const preferred = new CredentialStore({ ...common, preference: "auto" });
  const fallback = new CredentialStore({ ...common, preference: "file" });
  await preferred.save("provider:first", "fixture-first");
  await fallback.save("provider:second", "fixture-second", async () => true);
  expect(await preferred.get("provider:second")).toBe("fixture-second");
  expect(await preferred.get("provider:first")).toBe("fixture-first");
  expect(existsSync(join(ws.configHome, "credentials.json"))).toBe(false);
  await fallback.save("provider:third", "fixture-third", async () => true);
  await preferred.save("provider:first", "fixture-first-updated");
  expect(await preferred.get("provider:third")).toBe("fixture-third");
  expect(await preferred.get("provider:second")).toBe("fixture-second");
  const account = [...vault.entries.keys()][0]!;
  vault.entries.set(account, fakeKey + " invalid JSON");
  try { await preferred.get("provider:first"); throw new Error("Expected corruption refusal"); }
  catch (error) { expect((error as Error).message).toContain("invalide"); expect((error as Error).message).not.toContain(fakeKey); }
});

test("TECH — a new profile has a stable vault account after creation and case normalization", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const configDir = currentPlatform() === "windows" ? join(ws.root, "NewProfile").toLowerCase() : join(ws.root, "NewProfile");
  const options = { service: "fixture-path", configDir, vault, preference: "auto" as const };
  await new CredentialStore(options).save("provider:test", fakeKey);
  const reopened = new CredentialStore(options);
  expect(await reopened.get("provider:test")).toBe(fakeKey);
  await reopened.clear(); expect(vault.entries.size).toBe(0);
});

test("TECH — deployment hiding applies to initial slash logout and administrative logout", async () => {
  for (const argv of [["/logout"], ["auth", "logout"]]) {
    const ws = workspace(), vault = new MemoryVault();
    const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "auto" });
    await store.save("provider:test", fakeKey);
    const run = interactive(argv, ws, { env: { [loadIdentity().get("ENV_PREFIX") + "HIDE_SIGN_OUT"]: "true" }, extra: { ...valid, credentialVault: vault } });
    expect((await run.done).code).toBe(2);
    expect(run.all().join("\n")).not.toContain("Supprimer les identifiants");
    expect(await store.get("provider:test")).toBe(fakeKey);
  }
});

test("TECH — abort after logout approval cancels a mutation waiting for the store lock", async () => {
  const ws = workspace(), vault = new MemoryVault(), controller = new AbortController();
  const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "auto" });
  await store.save("provider:test", fakeKey);
  const release = tryFileLock(join(ws.configHome, "credentials.json.lock")); expect(release).toBeDefined();
  const run = interactive(["auth", "logout"], ws, { signal: controller.signal, extra: { ...valid, credentialVault: vault } });
  try {
    await accept(run, "Supprimer les identifiants"); await sleep(50); controller.abort();
    expect((await run.done).code).toBe(2);
    expect(await store.get("provider:test")).toBe(fakeKey);
  } finally { release?.(); }
});

test("TECH — credentials are excluded from reads, searches, attachments and hard-link aliases", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "file" });
  await store.save("provider:openai_compatible", fakeKey, async () => true);
  const file = join(ws.configHome, "credentials.json"), alias = join(ws.configHome, "ordinary.txt");
  linkSync(file, alias);
  const provider = new ScriptedProvider([{ toolCalls: [
    { name: "read_file", input: { path: file } }, { name: "read_file", input: { path: alias } },
    { name: "search_content", input: { pattern: "fixture-only", path: ws.configHome, mode: "lines" } },
  ] }, { text: "finished" }]);
  const result = await cli(["--non-interactive", "--approval-mode", "no_prompt", `Inspect @${file} @${alias}`], ws, { provider, userConfig: { auth: { credentialStore: "file" }, engine: { nonInteractive: { persistSession: true } } }, extra: { cwd: ws.configHome, credentialVault: vault } });
  expect(result.code).toBe(0); expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests).includes(fakeKey)).toBe(false);
  expect(result.stdout + result.stderr).not.toContain(fakeKey);
  const ordinary = readdirSync(ws.configHome, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => diskText(join(ws.configHome, e.name))).join("\n");
  expect(ordinary).not.toContain(fakeKey);
});

test("TECH — linked fallback credentials cannot be migrated, replaced or removed while aliases would expose them", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const common = { service: "fixture-hardlinks", configDir: ws.configHome, vault };
  const fallback = new CredentialStore({ ...common, preference: "file" });
  await fallback.save("provider:test", fakeKey, async () => true);
  const file = join(ws.configHome, "credentials.json"), alias = join(ws.configHome, "alias.txt");
  linkSync(file, alias);
  const preferred = new CredentialStore({ ...common, preference: "auto" });
  await expect(preferred.get("provider:test")).rejects.toThrow("liens supplémentaires");
  await expect(preferred.save("provider:other", "new-fixture")).rejects.toThrow("liens supplémentaires");
  await expect(fallback.save("provider:test", "new-fixture", async () => true)).rejects.toThrow("liens supplémentaires");
  await expect(preferred.clear()).rejects.toThrow("liens supplémentaires");
  expect(vault.entries.size).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(readFileSync(alias, "utf8"));
});

test("TECH — an active opaque provider credential returned by a shell never enters the model context or transcript", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "file" });
  await store.save("provider:openai_compatible", fakeKey, async () => true);
  const file = join(ws.configHome, "credentials.json");
  const command = currentPlatform() === "windows" ? `Get-Content -LiteralPath '${file}'` : `cat '${file}'`;
  const provider = new ScriptedProvider([{ toolCalls: [{ name: currentPlatform() === "windows" ? "run_powershell" : "run_shell", input: { command } }] }, { text: "finished" }]);
  const result = await cli(["--non-interactive", "--approval-mode", "no_prompt", "Inspect."], ws, { provider, userConfig: { auth: { credentialStore: "file" }, engine: { nonInteractive: { persistSession: true } } }, extra: { cwd: ws.configHome, credentialVault: vault } });
  expect(result.code).toBe(0); expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests)).not.toContain(fakeKey);
  const content = readdirSync(ws.configHome, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => diskText(join(ws.configHome, e.name))).join("\n");
  expect(content).not.toContain(fakeKey);
});

test("TECH — first input following environment consent survives a locked state write, a paste cannot consent", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "received" }]);
  const file = join(ws.configHome, basename(loadIdentity().get("USER_STATE_FILE")));
  // Start first: state recovery itself takes this lock before displaying the consent.
  const run = interactive(["--model", "vendor-always"], ws, { provider, env: { ANTHROPIC_API_KEY: fakeKey }, userConfig: { api: { provider: "anthropic" } }, extra: { credentialVault: new MemoryVault() } });
  // Like processTerminal, a subscription resumes stdin and its cleanup pauses it.
  let paused = false;
  const subscribe = run.term.onInput.bind(run.term);
  run.term.onInput = (listener) => { paused = false; const stop = subscribe((chunk) => { if (!paused) listener(chunk); }); return () => { stop(); paused = true; }; };
  await run.waitFor((text) => text.includes("4827"));
  const release = tryFileLock(file + ".lock"); expect(release).toBeDefined();
  try {
    await sleep(400); run.raw("o\r"); await sleep(50);
    expect(provider.requests).toHaveLength(0); expect(run.finished()).toBe(false);
    run.type("o"); run.type("First message"); run.type(KEY.enter);
    await sleep(50); expect(provider.requests).toHaveLength(0);
  } finally { release?.(); }
  await run.waitFor((text) => text.includes("received"));
  expect(paused).toBe(false);
  expect(JSON.stringify(provider.requests[0]?.history)).toContain("First message");
  run.type(KEY.ctrlD); run.type(KEY.ctrlD); expect((await run.done).code).toBe(0);
}, 20_000);

test("TECH — automated control on a TTY never opens environment authentication consent", async () => {
  const ws = workspace();
  const run = interactive(["--request-format", "jsonl", "--result-format", "jsonl", "--model", "vendor-always"], ws, { provider: new ScriptedProvider([]), env: { ANTHROPIC_API_KEY: fakeKey }, userConfig: { api: { provider: "anthropic" }, engine: { control: { enabled: true } } }, extra: { credentialVault: new MemoryVault() } });
  const result = await run.done;
  expect(result.code).toBe(130); expect(run.all().join("\n")).not.toContain("Utiliser cette clé"); // EOF ends the empty control session.
  const slash = interactive(["--request-format", "jsonl", "--result-format", "jsonl", "/login"], workspace(), { provider: new ScriptedProvider([]), userConfig: { engine: { control: { enabled: true } } }, extra: { ...valid, credentialVault: new MemoryVault() } });
  expect((await slash.done).code).toBe(130); expect(slash.all().join("\n")).not.toContain("saisie masquée");
});

test("TECH — short environment credentials are fully masked and missing TLS files remain configuration errors", async () => {
  const run = interactive(["--model", "vendor-always"], workspace(), { provider: new ScriptedProvider([]), env: { ANTHROPIC_API_KEY: "ABCD" }, userConfig: { api: { provider: "anthropic" } }, extra: { credentialVault: new MemoryVault() } });
  await run.waitFor((text) => text.includes("Derniers caractères"));
  expect(run.all().join("\n")).not.toContain("ABCD");
  run.type(KEY.ctrlD); expect((await run.done).code).toBe(2);
  const ws = workspace();
  const result = await cli(["--non-interactive", "Work."], ws, { provider: new ScriptedProvider([]), env: { [loadIdentity().get("ENV_PREFIX") + "EXTRA_CA_CERTS"]: join(ws.root, "absent.pem") }, extra: { credentialVault: new MemoryVault() } });
  expect(result.code).toBe(2); expect(result.stderr).toContain("Fichier illisible"); expect(result.stderr).not.toContain("Erreur interne");
});

test("TECH — an automated read preserves an explicitly accepted fallback until interactive migration", async () => {
  const ws = workspace(), vault = new MemoryVault();
  const common = { service: "fixture-auto", configDir: ws.configHome, vault };
  await new CredentialStore({ ...common, preference: "file" }).save("provider:test", fakeKey, async () => true);
  vault.write = () => { throw new Error("No automated prompt allowed"); };
  const store = new CredentialStore({ ...common, preference: "auto", migrate: false });
  expect(await store.get("provider:test")).toBe(fakeKey);
  expect(existsSync(join(ws.configHome, "credentials.json"))).toBe(true);
  expect(await new CredentialStore({ ...common, preference: "keychain", migrate: false }).get("provider:test")).toBeUndefined();
  expect(await new CredentialStore({ ...common, preference: "keychain" }).get("provider:test")).toBeUndefined();
  // A corrupt stale fallback cannot prevent using a valid credential in the preferred vault.
  const fresh = new MemoryVault();
  const available = { ...common, vault: fresh };
  await new CredentialStore({ ...available, preference: "auto" }).save("provider:test", fakeKey);
  ws.write("home/config/credentials.json", "invalid fixture JSON");
  expect(await new CredentialStore({ ...available, preference: "keychain" }).get("provider:test")).toBe(fakeKey);
  expect(await new CredentialStore({ ...available, preference: "auto" }).get("provider:test")).toBe(fakeKey);
});

test("TECH — login validates through the real adapter and a rejected key never replaces the previous credential", async () => {
  const ws = workspace(), vault = new MemoryVault(), requests: string[] = [];
  let status = 200;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    requests.push(req.headers.get("authorization") ?? "");
    return Response.json(status === 200 ? { object: "list", data: [] } : { error: { message: fakeKey, type: "invalid_api_key" } }, { status });
  } });
  try {
    const options = { userConfig: { api: { baseUrl: `http://127.0.0.1:${server.port}/v1` } }, extra: { credentialVault: vault } };
    const success = interactive(["auth", "login"], ws, options);
    await enterKey(success); expect((await success.done).code).toBe(0); expect(requests).toEqual(["Bearer " + fakeKey]);
    status = 401;
    const refused = interactive(["auth", "login"], ws, options);
    await refused.waitFor((text) => text.includes("saisie masquée")); refused.type("rejected-fixture-key"); refused.type(KEY.enter);
    const result = await refused.done; expect(result.code).toBe(2); expect(result.stderr).toContain("refusée par le fournisseur");
    expect(result.stdout + result.stderr + refused.all().join("\n")).not.toContain(fakeKey);
    const store = new CredentialStore({ service: loadIdentity().get("KEYCHAIN_SERVICE"), configDir: ws.configHome, vault, preference: "auto" });
    expect(await store.get("provider:openai_compatible")).toBe(fakeKey);
  } finally { server.stop(true); }
});
