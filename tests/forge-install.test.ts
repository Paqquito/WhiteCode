// Supports: SPEC-CMD-037, SPEC-API-011. Real local TLS/CLI/native Git and masked interactive input.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { installForgeApp, forgeWorkflow, type ForgeInstallUi, type ForgeAppContract } from "../src/integrations/forge-install";
import { Identity } from "../src/identity/identity";
import { parseYaml } from "../src/platform/yaml";
import { Settings } from "../src/config/settings";
import { loadIdentity } from "./helpers/env";
import { forgeInstallFixture } from "./helpers/forge-install";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

type Fixture = Awaited<ReturnType<typeof forgeInstallFixture>>;
const identity = () => { const base = loadIdentity().resolved; return new Identity({ ...base, values: { ...base.values, GIT_FORGE_APP: { value: "company-fixture", origin: "provided" }, PRODUCT_SLUG: { value: "dev-agent", origin: "provided" } } }); };
function options(f: Fixture, ui: Partial<ForgeInstallUi> = {}) {
  const remembered: string[] = [];
  return { cwd: f.ws.project, environment: f.environment, signal: new AbortController().signal, app: "company-fixture", product: "dev-agent", contract: f.contract, program: f.program, fetch: f.fetch, open: () => true, remember: (secret: string) => remembered.push(secret), assertPolicy: () => {}, ui: { repository: async () => "owner/project", flow: async () => "mention" as const, confirm: async () => { await f.fetch(f.origin + "/human/install", { method: "POST" }); return true; }, secret: async () => "fixture-service-" + randomUUID(), ...ui }, remembered };
}
function noPersistedSecret(root: string, secret: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) noPersistedSecret(path, secret);
    else if (entry.isFile()) expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  }
}
function workflowProof(source: string, f: Fixture, mode: string) {
  const yaml = parseYaml(source) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: { agent: { if: string; uses: string; with: { mode: string }; secrets: Record<string, string> } } };
  expect(yaml.jobs.agent.uses).toBe(f.contract.workflow);
  expect(yaml.jobs.agent.with.mode).toBe(mode);
  expect(f.state.secretName).toMatch(/^COMPANY_SERVICE_KEY_[A-F0-9]{32}$/);
  expect(yaml.jobs.agent.secrets).toEqual({ service_token: "${{ secrets." + f.state.secretName + " }}" });
  expect(yaml.permissions).toEqual({ contents: "read", issues: "write", "pull-requests": "write" });
  expect(yaml.on["pull_request_target"]).toBeUndefined(); expect(source).not.toContain("secrets: inherit");
  if (mode === "mention") { expect(Object.keys(yaml.on)).toEqual(["issue_comment"]); expect(yaml.jobs.agent.if).toContain("MEMBER"); expect(yaml.jobs.agent.if).toContain("@company-fixture"); }
  else { expect(Object.keys(yaml.on)).toEqual(["pull_request"]); expect(yaml.jobs.agent.if).toBe("${{ github.event.pull_request.head.repo.full_name == github.repository }}"); }
}

test("SPEC-CMD-037/CA-01 — an administered repository receives the vault secret and a real pushed workflow request through the masked wizard", async () => {
  const f = await forgeInstallFixture(), controller = new AbortController(), secret = "fixture-vault-" + randomUUID();
  const run = interactive([], f.ws, { identity: identity(), provider: new ScriptedProvider([]), signal: controller.signal, rows: 45, columns: 125, env: f.environment, userConfig: { git: { forgeApp: f.contract, mergeRequestStatus: { enabled: false } } }, extra: { forgeProgram: f.program, companyFetch: f.fetch, openServiceUrl: url => { expect(url).toBe(f.origin + "/apps/company-fixture/installations/new"); return true; } } });
  try {
    await run.idle(); run.type("/install-forge-app" + KEY.enter);
    await run.waitFor(t => t.includes("Dépôt de l’application de forge")); await sleep(380); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Type de flux de l’application de forge")); await sleep(380); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Installer l’application company-fixture pour owner/project")); await sleep(380); run.type("o");
    await run.waitFor(t => t.includes("Installez vous-même l’application"));
    const page = await f.fetch(f.origin + "/apps/company-fixture/installations/new"); expect(await page.text()).toContain("Install on owner/project");
    await f.fetch(f.origin + "/human/install", { method: "POST" }); await sleep(380); run.type("o");
    await run.waitFor(t => t.includes("Secret de service dédié"), "masked secret dialog", 20000);
    run.type(secret);
    expect(run.all().join("\n")).not.toContain(secret); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Demande de fusion ouverte et vérifiée"), "native Git push and forge request", 30000);
    expect(f.state.secret).toBe(secret); expect(f.state.secretAttempts).toBe(1);
    const pr = await f.fetch(f.origin + "/owner/project/pull/1"); expect(pr.status).toBe(200);
    const detail = await pr.json() as { workflow: string; state: string };
    expect(detail.state).toBe("OPEN"); workflowProof(detail.workflow, f, "mention");
    expect(f.run(["rev-parse", "main"], f.bare)).toBe(f.base);
    expect(f.run(["branch", "--show-current"])).toBe("main"); expect(f.run(["status", "--porcelain"])).toBe("");
    expect(f.state.requests).toContain("POST /owner/project.git/git-receive-pack");
    expect(f.state.requests).toContain("POST /owner/project.git/git-upload-pack");
    expect(f.state.requests.some(request => /merge/.test(request))).toBe(false);
    expect(f.state.invocations.some(row => row.args.includes(secret))).toBe(false);
    expect(f.state.invocations.filter(row => row.args[0] === "secret" && row.args[1] === "set").map(row => row.args)).toEqual([["secret", "set", f.state.secretName, "--repo", new URL(f.origin).host + "/owner/project", "--app", "actions"]]);
    expect(run.all().some(screen => screen.includes(f.state.secretName))).toBe(true);
    expect(f.run(["cat-file", "--batch-all-objects", "--batch"], f.bare)).not.toContain(secret);
    expect(f.state.authorizations.some(value => value.startsWith("Basic "))).toBe(true);
    expect(f.state.checkAuthorization).toBe("");
    expect(f.state.invocations.filter(row => row.args.slice(0, 3).join(" ") === "auth git-credential get").length).toBeGreaterThan(0);
    expect(f.state.body).not.toContain(secret); expect(f.state.body).not.toContain("Co-Authored-By");
    run.type("/exit" + KEY.enter); const result = await run.done; expect(result.code).toBe(0);
    expect(result.stdout + result.stderr + run.all().join("\n") + JSON.stringify(f.state.invocations)).not.toContain(secret);
    noPersistedSecret(f.ws.root, secret);
  } finally { controller.abort(); if (!run.finished()) await run.done; f.close(); }
}, 60000);

test("TECH — forge installation review mode pins the real company contract and never merges the request", async () => {
  const f = await forgeInstallFixture();
  try { const o = options(f, { flow: async () => "review" }); expect(await installForgeApp(o)).toContain("ouverte et vérifiée"); workflowProof(f.run(["show", f.state.branch + ":.github/workflows/dev-agent-agent.yml"], f.bare), f, "review"); expect(f.run(["rev-parse", "main"], f.bare)).toBe(f.base); noPersistedSecret(f.ws.root, o.remembered[0]!); }
  finally { f.close(); }
}, 30000);

test("TECH — forge wizard refuses nonadministrators before opening the page or requesting a secret", async () => {
  const f = await forgeInstallFixture(); let opened = false, requested = false;
  try { f.state.admin = false; const o = options(f, { secret: async () => { requested = true; return "unused"; } }); o.open = () => { opened = true; return true; }; await expect(installForgeApp(o)).rejects.toThrow("Droits d’administration"); expect(opened).toBe(false); expect(requested).toBe(false); expect(f.state.secretAttempts).toBe(0); expect(f.state.pr).toBeUndefined(); expect(f.run(["branch", "--list"], f.bare)).toBe("* main"); }
  finally { f.close(); }
}, 20000);

test("TECH — forge wizard requires actual installation verification bound to the selected repository", async () => {
  const f = await forgeInstallFixture(); let requested = false;
  try { const o = options(f, { confirm: async () => true, secret: async () => { requested = true; return "unused"; } }); await expect(installForgeApp(o)).rejects.toThrow("non vérifiée"); f.state.installed = true; f.state.wrongInstallation = true; await expect(installForgeApp(o)).rejects.toThrow("non vérifiée"); expect(requested).toBe(false); expect(f.state.secretAttempts).toBe(0); expect(f.state.pr).toBeUndefined(); }
  finally { f.close(); }
}, 20000);

test("TECH — a refused vault deposit cannot echo the secret and stops before branch or request creation", async () => {
  const f = await forgeInstallFixture(), secret = "refused-vault-" + randomUUID();
  try { f.state.secretRefused = true; const o = options(f, { secret: async () => secret }); let error = ""; try { await installForgeApp(o); } catch (cause) { error = String(cause); } expect(error).toContain("Secret non créé"); expect(error).not.toContain(secret); expect(o.remembered).toEqual([secret]); expect(f.state.secretAttempts).toBe(1); expect(f.state.secret).toBe(""); expect(f.state.pr).toBeUndefined(); expect(f.run(["branch", "--list"], f.bare)).toBe("* main"); noPersistedSecret(f.ws.root, secret); }
  finally { f.close(); }
}, 30000);

test("TECH — cancelling the dedicated masked credential leaves neither vault secret nor pushed branch", async () => {
  const f = await forgeInstallFixture();
  try { const o = options(f, { secret: async () => undefined }); expect(await installForgeApp(o)).toContain("annulée"); expect(f.state.secretAttempts).toBe(0); expect(f.state.pr).toBeUndefined(); expect(f.run(["branch", "--list"], f.bare)).toBe("* main"); }
  finally { f.close(); }
}, 30000);

test("TECH — a missing or mutable company workflow contract is rejected without invoking the forge", async () => {
  const f = await forgeInstallFixture();
  try { const o = options(f); await expect(installForgeApp({ ...o, contract: undefined })).rejects.toThrow("git.forgeApp"); await expect(installForgeApp({ ...o, contract: { ...f.contract, workflow: f.contract.workflow.replace(/@[a-f0-9]{40}$/, "@main") } })).rejects.toThrow("commit complet"); expect(f.state.invocations).toEqual([]); }
  finally { f.close(); }
}, 15000);

test("TECH — a reserved generated secret prefix is rejected before the forge and credential wizard", async () => {
  const f = await forgeInstallFixture();
  try {
    const o = options(f, { repository: async () => undefined });
    await expect(installForgeApp({ ...o, contract: { ...f.contract, secretName: "GITHUB" } })).rejects.toThrow("Contrat de flux");
    expect(f.state.invocations).toEqual([]);
  } finally { f.close(); }
}, 15000);

test("TECH — revocation before the vault command blocks credential forwarding and remote writes", async () => {
  const f = await forgeInstallFixture(); let revoked = false;
  try { const o = options(f, { secret: async () => { revoked = true; return "revoked-" + randomUUID(); } }); o.assertPolicy = () => { if (revoked) throw Error("Policy revoked"); }; await expect(installForgeApp(o)).rejects.toThrow("Secret non créé"); expect(f.state.secretAttempts).toBe(0); expect(f.state.pr).toBeUndefined(); }
  finally { f.close(); }
}, 30000);

test("TECH — workflow generation passes mention text as an expression without shell interpolation", () => {
  const result = forgeWorkflow("company-fixture", { workflow: "company/deployment/.github/workflows/agent.yml@" + "a".repeat(40), installationCheckUrl: "https://company.fixture/verify", secretName: "COMPANY_SERVICE_KEY", secretInput: "service_token" }, "mention");
  expect(result).not.toContain("run:"); expect(result).not.toContain("comment.body }}"); expect(result).toContain("contains(github.event.comment.body, '@company-fixture')");
});

test("TECH — an incompatible immutable deployment contract stops before installation and secret entry", async () => {
  const f = await forgeInstallFixture(); let opened = false;
  try { f.state.extraRequiredInput = true; const o = options(f); o.open = () => { opened = true; return true; }; await expect(installForgeApp(o)).rejects.toThrow("entrées non prises en charge"); expect(opened).toBe(false); expect(f.state.secretAttempts).toBe(0); }
  finally { f.close(); }
}, 20000);

test("TECH — cancellation stops the owned forge CLI process before any authentication side effect", async () => {
  const f = await forgeInstallFixture(), controller = new AbortController();
  try {
    f.state.authDelay = true;
    const pending = installForgeApp({ ...options(f), signal: controller.signal }).then(() => "success", error => String(error));
    const deadline = Date.now() + 10000;
    while (!f.state.invocations.length && Date.now() < deadline) await sleep(10);
    expect(f.state.invocations).toHaveLength(1); const pid = f.state.invocations[0]!.pid;
    expect(pid).not.toBe(process.pid); controller.abort();
    expect(await pending).toContain("interrompue");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.state.secretAttempts).toBe(0); expect(f.state.pr).toBeUndefined();
  } finally { controller.abort(); f.close(); }
}, 15000);

test("TECH — the company installation verifier must present a trusted TLS certificate", async () => {
  const f = await forgeInstallFixture();
  try { await expect(installForgeApp({ ...options(f), fetch: undefined })).rejects.toThrow(); expect(f.state.secretAttempts).toBe(0); expect(f.state.pr).toBeUndefined(); }
  finally { f.close(); }
}, 20000);

test("TECH — an existing prefix secret is preserved and a new installation receives its own name", async () => {
  const f = await forgeInstallFixture(); let asked = false;
  try { f.state.secrets.set(f.contract.secretName, "preexisting-fixture-key"); expect(await installForgeApp(options(f, { secret: async () => { asked = true; return "new-key"; } }))).toContain("ouverte et vérifiée"); expect(asked).toBe(true); expect(f.state.secretAttempts).toBe(1); expect(f.state.secrets.get(f.contract.secretName)).toBe("preexisting-fixture-key"); expect(f.state.secretName).not.toBe(f.contract.secretName); expect(f.state.secrets.get(f.state.secretName)).toBe("new-key"); }
  finally { f.close(); }
}, 30000);

test("TECH — forge deployment and installation verification contracts cannot be supplied by project or local settings", () => {
  const contract = { workflow: "company/deployment/.github/workflows/agent.yml@" + "b".repeat(40), installationCheckUrl: "https://company.fixture/verify", secretName: "COMPANY_SERVICE_KEY", secretInput: "service_token" };
  const text = JSON.stringify({ git: { forgeApp: contract } });
  const project = Settings.load({ projectTrusted: true, sources: [{ scope: "project", name: "fixture project", text }, { scope: "local", name: "fixture local", text }] });
  expect(project.get("git.forgeApp")).toBeUndefined(); expect(project.issues.filter(issue => issue.key === "git.forgeApp")).toHaveLength(2);
  const user = Settings.load({ projectTrusted: true, sources: [{ scope: "user", name: "fixture user", text }] });
  expect(user.get<ForgeAppContract>("git.forgeApp")).toEqual(contract);
});

test("TECH — invalid installation JSON and malformed configuration never echo their source in diagnostics", async () => {
  const f = await forgeInstallFixture();
  try {
    f.state.malformedVerification = true; let diagnostic = "";
    try { await installForgeApp(options(f)); } catch (error) { diagnostic = String(error); }
    expect(diagnostic).toContain("vérification de société invalide"); expect(diagnostic).not.toContain("untrusted-response-marker");
    try { await installForgeApp({ ...options(f), contract: { ...f.contract, installationCheckUrl: "private-configuration-marker" } }); } catch (error) { diagnostic = String(error); }
    expect(diagnostic).toContain("HTTPS invalide"); expect(diagnostic).not.toContain("private-configuration-marker"); expect(f.state.secretAttempts).toBe(0);
  } finally { f.close(); }
}, 20000);

test("TECH — REGRESSION-64 — simultaneous installations use distinct vault names and workflows without replacing an existing prefix secret",async()=>{
  const f=await forgeInstallFixture();
  try{
    f.state.secrets.set(f.contract.secretName,"existing-prefix-fixture");
    const first="first-fixture-"+randomUUID(),second="second-fixture-"+randomUUID(),shown:string[]=[];
    const settings=(secret:string)=>options(f,{confirm:async message=>{shown.push(message);await f.fetch(f.origin+"/human/install",{method:"POST"});return true;},secret:async()=>secret});
    const results=await Promise.all([installForgeApp(settings(first)),installForgeApp(settings(second))]);
    expect(results.every(result=>result.includes("ouverte et vérifiée"))).toBe(true);
    expect(f.state.secrets.size).toBe(3);expect(f.state.secrets.get(f.contract.secretName)).toBe("existing-prefix-fixture");
    const created=[...f.state.secrets].filter(([name])=>name!==f.contract.secretName);expect(new Set(created.map(([name])=>name)).size).toBe(2);
    expect(created.map(([,value])=>value).sort()).toEqual([first,second].sort());
    for(const[name]of created){expect(name).toMatch(/^COMPANY_SERVICE_KEY_[A-F0-9]{32}$/);expect(shown.some(message=>message.includes(name))).toBe(true);}
    for(const pr of f.state.prs){const workflow=f.run(["show",pr.headRefName+":.github/workflows/dev-agent-agent.yml"],f.bare);expect(created.filter(([name])=>workflow.includes("secrets."+name+" }}"))).toHaveLength(1);}
    expect(f.state.secretAttempts).toBe(2);expect(f.run(["rev-parse","main"],f.bare)).toBe(f.base);
  }finally{f.close();}
},40000);

test("TECH — REGRESSION-64 — a concrete name created during secret entry is refused before the setter",async()=>{
  const f=await forgeInstallFixture();let name="";
  try{
    const o=options(f,{secret:async message=>{name=/ : ([A-Z_][A-Z0-9_]*)\./.exec(message)![1]!;f.state.secrets.set(name,"concurrent-admin-fixture");return"new-fixture-"+randomUUID();}});
    await expect(installForgeApp(o)).rejects.toThrow("existe déjà");expect(f.state.secretAttempts).toBe(0);expect(f.state.secrets.get(name)).toBe("concurrent-admin-fixture");expect(f.state.pr).toBeUndefined();
  }finally{f.close();}
},20000);

test("TECH — REGRESSION-64 — private Git ignores global URL rewrites and headers while preserving only author and CA trust",async()=>{
  const f=await forgeInstallFixture();
  try{
    appendFileSync(join(f.home,".gitconfig"),`\n[url "https://127.0.0.1:1/"]\n insteadOf = ${f.origin}/\n[http]\n extraHeader = X-Unexpected: inherited-fixture\n`);
    const result=await installForgeApp(options(f));expect(result).toContain("ouverte et vérifiée");
    expect(f.state.requests).toContain("POST /owner/project.git/git-receive-pack");expect(f.state.gitExtraHeaders.every(value=>value==="")).toBe(true);
    expect(f.run(["show","-s","--format=%an <%ae>",f.state.branch],f.bare)).toBe("Fixture Human <fixture@example.invalid>");
    expect(f.state.invocations.some(row=>row.args.slice(0,3).join(" ")==="auth git-credential get")).toBe(true);
  }finally{f.close();}
},30000);

test("TECH — REGRESSION-64 — cancellation after accepted consent blocks browser opening immediately",async()=>{
  const f=await forgeInstallFixture(),controller=new AbortController();let opened=0,confirms=0;
  try{
    const o=options(f,{confirm:async()=>{if(++confirms===1){controller.abort();return true;}return false;}});o.open=()=>{opened++;return true;};
    await installForgeApp({...o,signal:controller.signal}).catch(()=>{});expect(opened).toBe(0);expect(f.state.secretAttempts).toBe(0);expect(f.state.pr).toBeUndefined();
  }finally{controller.abort();f.close();}
},15000);
