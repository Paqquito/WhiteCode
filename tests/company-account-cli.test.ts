// Implements: SPEC-API-023, SPEC-API-028 (provider isolation and actual administration routes).
import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { configuredCompanyAccount } from "../src/auth/company-runtime";
import { credentialStore } from "../src/auth/commands";
import type { CredentialVault } from "../src/platform/credential-vault";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { Identity } from "../src/identity/identity";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync,readFileSync } from "node:fs";
function setup() {
  const ws = workspace(), originalIdentity = loadIdentity(), entries = new Map<string,string>();
  const services = { SERVICE_CONSOLE:"https://account.example.test/console/",SERVICE_WEB_APP: "https://account.example.test/", SERVICE_OAUTH_AUTHORIZE: "https://account.example.test/authorize", SERVICE_OAUTH_TOKEN: "https://account.example.test/token", OAUTH_CLIENT_ID: "fixture-client" };
  const identity = new Identity({ ...originalIdentity.resolved, values: { ...originalIdentity.resolved.values, ...Object.fromEntries(Object.entries(services).map(([name,value])=>[name,{value,origin:"provided" as const}])) } });
  const vault: CredentialVault = { read: (_service,key) => entries.get(key), write: (_service,key,value) => { entries.set(key,value); }, remove: (_service,key) => { entries.delete(key); } };
  let available = true,revision="0",values:Record<string,unknown>={};const requests: string[] = [],sent:Array<{url:string;body:unknown}>=[];
  const fact="---\nname: Convention\ndescription: Shared convention\ntype: project\n---\nUse integration tests.\n";
  const network = (async (input,init) => { const url=new URL(String(input));requests.push(url.href); if (!available) throw new Error("fixture unavailable");
    if(init?.body&&url.pathname!=="/token")sent.push({url:url.href,body:JSON.parse(String(init.body))});
    if(url.pathname.endsWith("/metrics/preferences"))return Response.json({organizationId:"org",eligible:true,optOut:false});
    if(url.pathname.endsWith("/metrics/batches"))return Response.json({accepted:true});
    if(url.pathname.endsWith("/settings/snapshot")){if(init?.body){const body=JSON.parse(String(init.body));values=body.values;revision=String(Number(revision)+1);}return Response.json({revision,values});}
    if(url.pathname.endsWith("/memory/snapshot"))return Response.json({organizationId:"org",repository:url.searchParams.get("repository"),entries:[{file:"fact.md",content:fact,sha256:createHash("sha256").update(fact).digest("hex"),revision:"1"}]});
    return url.pathname==="/token" ? Response.json({ token_type:"Bearer", access_token:"fixture-company-only", refresh_token:"fixture-refresh-only", expires_in:3600 }) : Response.json({ account:"member@example.test",organization:{id:"org",name:"Organisation"},roles:["member"] }); }) as typeof fetch;
  const settings = Settings.load({ sources: [], projectTrusted: false }), account = configuredCompanyAccount(identity, ws.configHome, () => settings, vault, network)!;
  const login = () => account.signIn({ confirm: async () => true, authorize: async address => { const url = new URL(address), callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state",url.searchParams.get("state")!); callback.searchParams.set("code","fixture-code"); return callback.href; } },new AbortController().signal);
  return { ws,identity,vault,entries,network,settings,account,login,requests,sent,fact,offline: () => { available = false; } };
}
test("SPEC-API-023/CA-01 — auth show reports the connected method, account, organization and expiry as text and JSON", async () => {
  const b = setup(); await b.login(); const extra = { credentialVault:b.vault, companyFetch:b.network };
  const shown = await cli(["auth","show"],b.ws,{identity:b.identity,extra}); expect(shown.code).toBe(0); expect(shown.stdout).toContain("Méthode : compte de la société"); expect(shown.stdout).toContain("member@example.test"); expect(shown.stdout).toContain("Organisation"); expect(shown.stdout).toContain("Expiration :");
  const json = await cli(["auth","show","--json"],b.ws,{identity:b.identity,extra}); expect(JSON.parse(json.stdout).profile.organization.id).toBe("org"); expect(shown.stdout+json.stdout).not.toContain("fixture-company-only");
});
test("TECH — administrative account login receives the actual loopback callback after human terminal consent",async()=>{
 const b=setup(),run=interactive(["auth","login","--company"],b.ws,{identity:b.identity,columns:1000,env:{[b.identity.get("ENV_PREFIX")+"NO_BROWSER"]:"1"},extra:{credentialVault:b.vault,companyFetch:b.network}});await run.waitFor(text=>text.includes("Connecter le compte de la société"));await sleep(380);run.type("o");await run.waitFor(text=>text.includes("Authentification humaine :"));const address=run.all().join("\n").match(/https:\/\/account\.example\.test\/authorize\?[^\s│]+/)?.[0];expect(address).toBeDefined();const url=new URL(address!),callback=new URL(url.searchParams.get("redirect_uri")!);callback.searchParams.set("state",url.searchParams.get("state")!);callback.searchParams.set("code","fixture-code");const response=await fetch(callback,{proxy:callback.origin,keepalive:false});expect(response.status).toBe(200);expect((await run.done).code).toBe(0);expect((await b.account.profile())?.account).toBe("member@example.test");
},15000);
test("TECH — the real session exports an organization aggregate batch through its configured account client",async()=>{
 const b=setup();await b.login();const provider=new ScriptedProvider([{delayMs:100,text:"metric source must stay private"}]);const result=await cli(["--non-interactive","Work"],b.ws,{identity:b.identity,provider,extra:{credentialVault:b.vault,companyFetch:b.network}});expect(result.code).toBe(0);const batches=b.sent.filter(row=>row.url.endsWith("/metrics/batches"));expect(batches).toHaveLength(1);expect(JSON.stringify(batches)).toContain("input_tokens");expect(JSON.stringify(batches)).not.toContain("metric source");
});
test("TECH — real config push and pull preserve private values and provide a restorable backup",async()=>{
 const b=setup();await b.login();const extra={credentialVault:b.vault,companyFetch:b.network},base={identity:b.identity,extra};const push=await cli(["config","push"],b.ws,{...base,userConfig:{ui:{theme:"dark"},environment:{variables:{PRIVATE:"private-sync-value"}}}});expect(push.code).toBe(0);expect(JSON.stringify(b.sent)).not.toContain("private-sync-value");expect(JSON.stringify(b.sent)).toContain("ui.theme");const pull=await cli(["config","pull"],b.ws,{...base,userConfig:null});expect(pull.code).toBe(0);const backup=JSON.parse(pull.stdout.slice(pull.stdout.indexOf('"')).trim());expect(existsSync(backup)).toBe(true);expect(readFileSync(backup,"utf8")).toContain("private-sync-value");expect((await cli(["config","pull","--restore",backup],b.ws,{...base,userConfig:null})).code).toBe(0);
});
test("TECH — a real repository session exposes authenticated team memory and downloads its convention",async()=>{
 const b=setup();expect(spawnSync("git",["init","-q"],{cwd:b.ws.project}).status).toBe(0);expect(spawnSync("git",["remote","add","origin","https://forge.example.test/org/repository.git"],{cwd:b.ws.project}).status).toBe(0);await b.login();const provider=new ScriptedProvider([request=>{expect(request.tools.map(tool=>tool.name)).toContain("team_memory");return{toolCalls:[{name:"team_memory",input:{action:"read",file:"fact.md"}}]};},request=>{expect(JSON.stringify(request.history)).toContain("Use integration tests");return{text:"convention received"};}]);const result=await cli(["--non-interactive","Work"],b.ws,{identity:b.identity,provider,extra:{credentialVault:b.vault,companyFetch:b.network}});expect(result.code).toBe(0);expect(b.requests.some(url=>url.includes("/memory/snapshot?repository="))).toBe(true);
});
test("SPEC-API-023/CA-03 — an unavailable company profile never conditions a real provider-key request", async () => {
  const b=setup(); await b.login(); b.offline(); let key: string|undefined; const provider=new ScriptedProvider([{text:"Provider request completed"}]);
  const result=await cli(["--non-interactive","Work"],b.ws,{identity:b.identity,env:{OPENAI_API_KEY:"fixture-model-only"},extra:{credentialVault:b.vault,companyFetch:b.network,providerFactory:options=>{key=options.apiKey; return provider;}}});
  expect(result.code).toBe(0); expect(key).toBe("fixture-model-only"); expect(result.stdout).toContain("Provider request completed"); expect(b.requests.every(url=>url.startsWith("https://account.example.test/"))).toBe(true);
});
test("SPEC-API-028/CA-06 — the provider receives its own key while company tokens stay in their separate vault entry", async () => {
  const b=setup(); await b.login(); let key: string|undefined; const provider=new ScriptedProvider([{text:"isolated"}]);
  const result=await cli(["--non-interactive","Work"],b.ws,{identity:b.identity,env:{OPENAI_API_KEY:"fixture-model-only"},extra:{credentialVault:b.vault,companyFetch:b.network,providerFactory:options=>{key=options.apiKey; expect(JSON.stringify(options)).not.toContain("fixture-company-only"); return provider;}}});
  expect(result.code).toBe(0); expect(key).toBe("fixture-model-only"); expect(b.entries.size).toBe(1); expect(result.stdout+result.stderr).not.toContain("fixture-company-only");
});
test("SPEC-API-028/CA-07 — confirmed account logout clears company tokens while a stored model key remains usable", async () => {
  const b=setup(); await b.login(); const store=credentialStore(b.identity,b.ws.configHome,b.settings,b.vault); await store.save("provider:openai_compatible","fixture-model-only");
  const run=interactive(["auth","logout","--company"],b.ws,{identity:b.identity,env:{[b.identity.get("ENV_PREFIX")+"NO_BROWSER"]:"1"},extra:{credentialVault:b.vault,companyFetch:b.network}});
  await run.waitFor(text=>text.includes("Déconnecter le compte")); await sleep(380); run.type("o"); expect((await run.done).code).toBe(0); expect(await b.account.profile()).toBeUndefined(); expect([...b.entries.keys()].some(key=>key.startsWith("company-account-"))).toBe(false); expect(await store.get("provider:openai_compatible")).toBe("fixture-model-only");
  let selected:string|undefined; const result=await cli(["--non-interactive","Work"],b.ws,{identity:b.identity,extra:{credentialVault:b.vault,companyFetch:b.network,providerFactory:options=>{selected=options.apiKey;return new ScriptedProvider([{text:"still usable"}]);}}}); expect(result.code).toBe(0); expect(selected).toBe("fixture-model-only");
});
