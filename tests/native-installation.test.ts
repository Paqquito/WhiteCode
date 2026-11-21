import { profiledTest } from "./helpers/profiled-test";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { NativeStore, type Release } from "../src/installation/native-store";
import { InstallationMaintenance, packageAdvice, installationMethod } from "../src/installation/runtime";
import { workspace } from "./helpers/env";
import { systemInfo } from "../src/platform/system";
import { verifyArtifactSignature } from "../src/platform/artifact-signature";
import { cli, loadIdentity } from "./helpers/env";
import { nativeTarget } from "../src/installation/runtime";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY } from "./helpers/interactive";
import { multipleInstallations } from "../src/installation/runtime";
import { delimiter } from "node:path";
import { nativeExecutable, bootstrapNative, launchNative } from "./helpers/native-distribution";
const internalProfileTest = profiledTest(import.meta.path, "internal");

function fixture() {
  const ws=workspace(), bytes=Buffer.from("synthetic executable bytes 39"), hash=createHash('sha256').update(bytes).digest('hex'); let downloads=0;
  const release:Release={version:'0.2.0',notes:'fixture notes',artifact:{url:'https://distribution.invalid/fixture',sha256:hash,size:bytes.length}};
  const network=Object.assign(async()=>{downloads++;return new Response(bytes);},{preconnect:()=>{}}) as typeof fetch;
  const store=new NativeStore({root:join(ws.configHome,'installation'),cli:'fixture-cli',platform:systemInfo().platform,target:'fixture',service:'https://distribution.invalid/',currentVersion:'0.1.0',fetch:network,report:()=>{}});
  return {ws,store,release,downloads:()=>downloads};
}
test("SPEC-INS-001/CA-02 — a falsified fingerprint leaves no installed version or launcher",async()=>{
  const f=fixture(); await expect(f.store.install({...f.release,artifact:{...f.release.artifact,sha256:'0'.repeat(64)}})).rejects.toThrow('empreinte');
  expect(existsSync(f.store.binary(f.release.version))).toBe(false); expect(existsSync(f.store.bin)).toBe(false); expect(readdirSync(f.store.versions)).toEqual([]);
});
test("TECH — concurrent callers share one verified download and one complete version",async()=>{
  const f=fixture(); await Promise.all([f.store.install(f.release),f.store.install(f.release)]); expect(f.downloads()).toBe(1); expect(readFileSync(f.store.binary('0.2.0'))).toEqual(Buffer.from('synthetic executable bytes 39'));
});
test("SPEC-INS-005/CA-02 — SPEC-INS-007/CA-01 — pruning preserves the two newest versions and the kernel-held used version",()=>{
  const f=fixture(); for(const v of ['0.1.0','0.2.0','0.3.0','0.4.0','0.5.0']) { const path=f.store.binary(v); mkdirSync(join(f.store.versions,v),{recursive:true}); writeFileSync(path,'fixture'); writeFileSync(join(f.store.versions,v,'receipt.json'),'{}'); }
  const release=f.store.pin('0.1.0'); try { expect(f.store.prune(2)).toEqual(['0.3.0','0.2.0']); expect(readdirSync(f.store.versions).sort()).toEqual(['0.1.0','0.4.0','0.5.0']); } finally {release();}
  expect(f.store.prune(2)).toEqual(['0.1.0']);
});
test("SPEC-INS-007/CA-02 — maintenance postpones heavy work while the human is active",async()=>{
  const f=fixture(), events:string[]=[]; const m=new InstallationMaintenance({store:f.store,enabled:true,channel:'stable',keep:2,lastInteraction:()=>Date.now(),delayMs:5,idleMs:60000,report:()=>{},log:event=>events.push(event)});
  m.start(); await new Promise(r=>setTimeout(r,30)); await m.close(); expect(events).toContain('deferred'); expect(f.downloads()).toBe(0);
});
test("SPEC-INS-003/CA-01 — package-owned executables receive the Homebrew update command",()=>{
  const f=fixture(); const method=installationMethod('/opt/homebrew/Cellar/fixture-cli/0.1.0/bin/fixture-cli',f.store); expect(method).toBe('homebrew'); expect(packageAdvice(method,'fixture-cli')).toBe('brew upgrade fixture-cli');
});

function distribution(ws:ReturnType<typeof workspace>) {
  const identity=loadIdentity(), bytes=Buffer.from('fixture CLI binary 39'), hash=createHash('sha256').update(bytes).digest('hex'), target=nativeTarget(systemInfo()); let downloaded=0;
  const network=Object.assign(async(input:string|URL|Request)=>{const address=new URL(input instanceof Request?input.url:input.toString()); if(address.pathname.endsWith('.json')) return Response.json({schemaVersion:1,version:'0.2.0',notes:'Release fixture 39',artifacts:{[target]:{url:'program',sha256:hash,size:bytes.length}}}); downloaded++;return new Response(bytes);},{preconnect:()=>{}}) as typeof fetch;
  const root=join(ws.configHome,'installation'), old=join(root,'versions','0.1.0',identity.get('PRODUCT_CLI')+(systemInfo().platform==='windows'?'.exe':''));
  return { network, downloaded:()=>downloaded, old, root, slug:identity.get('PRODUCT_CLI') };
}
test("SPEC-INS-004/CA-01 — standalone installation update installs the checked artifact and reports both versions",async()=>{
  const ws=workspace(),d=distribution(ws);const r=await cli(['installation','update','--json'],ws,{extra:{installationFetch:d.network}});expect(r.code).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({before:'0.1.0',after:'0.2.0',installed:true});expect(d.downloaded()).toBe(1);expect(existsSync(join(d.root,'versions','0.2.0',d.slug+(systemInfo().platform==='windows'?'.exe':'')))).toBe(true);
});
test("SPEC-INS-004/CA-02 — standalone --check reads the manifest without a download or installation write",async()=>{
  const ws=workspace(),d=distribution(ws);const r=await cli(['installation','update','--check','--json'],ws,{extra:{installationFetch:d.network}});expect(r.code).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({before:'0.1.0',after:'0.1.0',available:'0.2.0',installed:false});expect(d.downloaded()).toBe(0);expect(existsSync(d.root)).toBe(false);
});
test("SPEC-INS-002/CA-02 — a managed minimum blocks startup before any provider call and suggests installation update",async()=>{
  const ws=workspace(),p=new ScriptedProvider([{text:'must not run'}]);ws.write('managed/policy.json',JSON.stringify({updates:{minimumAllowedVersion:'0.2.0'}}));const r=await cli(['--non-interactive','x'],ws,{provider:p});expect(r.code).not.toBe(0);expect(r.stderr).toContain('installation update');expect(p.requests).toHaveLength(0);
});
test("SPEC-CMD-035/CA-01 — migrating a package-owned session installs native files and gives PATH and removal instructions",async()=>{
  const ws=workspace(),d=distribution(ws),p=new ScriptedProvider([]);const r=await cli(['--non-interactive','/native-install'],ws,{provider:p,extra:{installationFetch:d.network,installationExecutable:'/opt/homebrew/Cellar/'+d.slug+'/0.1.0/bin/'+d.slug}});expect(r.code).toBe(0);expect(r.stdout).toContain('Version native 0.2.0 installée');expect(r.stdout).toContain('PATH');expect(r.stdout).toContain('gestionnaire');expect(p.requests).toHaveLength(0);expect(d.downloaded()).toBe(1);
});
{
  const test = internalProfileTest;
test("SPEC-INS-002/CA-01 — SPEC-CMD-108/CA-01 — native startup prepares an update and version shows both without replacing the running session",async()=>{
  const ws=workspace(),d=distribution(ws), fixture=await nativeExecutable(),hash=createHash('sha256').update(fixture.bytes).digest('hex');
  const network=Object.assign(async(input:unknown)=>String(input).endsWith('.json')?Response.json({schemaVersion:1,version:'0.2.0',artifacts:{[nativeTarget(systemInfo())]:{url:'program',sha256:hash,size:fixture.bytes.length}}}):new Response(fixture.bytes),{preconnect:()=>{}}) as typeof fetch;
  mkdirSync(join(d.root,'versions','0.1.0'),{recursive:true});writeFileSync(d.old,'old fixture');const shutdown=new AbortController(); const p=new ScriptedProvider([{text:'running old session'}]);
  const r=interactive([],ws,{provider:p,signal:shutdown.signal,extra:{installationFetch:network,installationExecutable:d.old,installationMaintenanceDelayMs:5,installationMaintenanceIdleMs:0}});
  try {await r.idle();await r.waitFor(t=>t.includes('Mise à jour 0.2.0 prête'));expect(readFileSync(d.old,'utf8')).toBe('old fixture');expect(JSON.parse(readFileSync(join(d.root,'active.json'),'utf8')).version).toBe('0.2.0');r.type('/version'+KEY.enter);await r.waitFor(t=>t.includes('Mise à jour téléchargée : 0.2.0'));expect(r.all().join('\n')).toContain('Version en cours : '+loadIdentity().get('PRODUCT')+' 0.1.0');expect(p.requests).toHaveLength(0);r.type('Use the original session.');r.type(KEY.enter);await r.waitFor(t=>t.includes('running old session'));expect(p.requests).toHaveLength(1);}
  finally {shutdown.abort();await r.done;}
  const next=await launchNative(join(d.root,'bin',d.slug+(systemInfo().platform==='windows'?'.cmd':'')),['--version'],ws);expect(next.code).toBe(0);expect(next.stdout).toContain('0.2.0');
},30000);
}


test("SPEC-INS-006/CA-01 — a reserved test version is refused without contacting a distribution service",async()=>{
  const ws=workspace(),d=distribution(ws);const r=await cli(['installation','update','--version','999999.0.1'],ws,{extra:{installationFetch:d.network}});expect(r.code).not.toBe(0);expect(r.stderr).toContain('réservée');expect(d.downloaded()).toBe(0);expect(existsSync(d.root)).toBe(false);
});
test("SPEC-INS-003/CA-02 — SPEC-OBS-015/CA-01 — two actual PATH installations produce an error with remediation in diagnostic",async()=>{
  const ws=workspace(),d=distribution(ws),one=join(ws.root,'one'),two=join(ws.root,'two'),name=d.slug+(systemInfo().platform==='windows'?'.exe':'');mkdirSync(one);mkdirSync(two);writeFileSync(join(one,name),'first');writeFileSync(join(two,name),'second');const path=[one,two].join(delimiter);expect(multipleInstallations(path,d.slug,systemInfo().platform)).toHaveLength(2);const r=await cli(['diagnostic','validate','--json'],ws,{env:{PATH:path}});expect(r.code).toBe(1);const finding=JSON.parse(r.stdout).findings.find((f:{area:string})=>f.area==='Installation');expect(finding.status).toBe('error');expect(finding.message).toContain('Installations multiples');expect(finding.message).toContain('gardez une seule méthode');
});

test("SPEC-INS-008/CA-01 — failed first-start reachability gives proxy guidance and permits the configured welcome",async()=>{
  const ws=workspace(),stop=new AbortController(),network=Object.assign(async()=>{throw new Error('fixture connection failed');},{preconnect:()=>{}}) as typeof fetch;
  const r=interactive([],ws,{provider:new ScriptedProvider([]),signal:stop.signal,extra:{preflightFetch:network}});
  try {await r.idle();expect(r.screen().join('\n')).toContain('Votre message');}
  finally {stop.abort();await r.done;}
  expect((await r.done).stderr).toContain('HTTP_PROXY, HTTPS_PROXY et NO_PROXY');
});
test("SPEC-INS-008/CA-02 — a successful first-start probe sends no credentials and continues to the welcome",async()=>{
  const ws=workspace(),stop=new AbortController(),calls:Array<RequestInit|undefined>=[],network=Object.assign(async(_input:unknown,init?:RequestInit)=>{calls.push(init);return new Response(null,{status:204});},{preconnect:()=>{}}) as typeof fetch;
  const r=interactive([],ws,{provider:new ScriptedProvider([]),signal:stop.signal,extra:{preflightFetch:network}});
  try {await r.idle();expect(r.screen().join('\n')).toContain('Votre message');expect(calls).toHaveLength(1);expect(calls[0]?.method).toBe('HEAD');expect(calls[0]?.headers).toBeUndefined();}
  finally {stop.abort();await r.done;}
  expect((await r.done).stderr).toContain('Vérification réussie');
});

test("SPEC-INS-001/CA-01 — the platform bootstrap exposes a standalone command whose version answers",async()=>{
  const ws=workspace(),fixture=await nativeExecutable(),d=distribution(ws),manifest={schemaVersion:1,version:'0.2.0',artifacts:{[nativeTarget(systemInfo())]:{url:'program',sha256:createHash('sha256').update(fixture.bytes).digest('hex'),size:fixture.bytes.length}}};
  const installed=await bootstrapNative(ws,fixture,manifest);expect(installed.stderr).toBe('');expect(installed.code).toBe(0);
  const command=join(d.root,'bin',d.slug+(systemInfo().platform==='windows'?'.cmd':''));expect(existsSync(command)).toBe(true);
  const version=await launchNative(command,['--version'],ws);expect(version.code).toBe(0);expect(version.stdout).toContain('0.2.0');
},30000);

test("SPEC-INS-005/CA-01 — two separate CLI processes install one complete version without competing downloads",async()=>{
  const ws=workspace(),fixture=await nativeExecutable(),log=join(ws.root,'downloads.log'),d=distribution(ws);
  const runs=await Promise.all([launchNative(fixture.binary,['installation','update','--json'],ws,{NATIVE_DOWNLOAD_LOG:log}),launchNative(fixture.binary,['installation','update','--json'],ws,{NATIVE_DOWNLOAD_LOG:log})]);
  for(const r of runs){expect(r.stderr).toBe('');expect(r.code).toBe(0);expect(JSON.parse(r.stdout).after).toBe('0.2.0');}
  expect(readFileSync(log,'utf8').trim().split('\n')).toHaveLength(1);expect(createHash('sha256').update(readFileSync(join(d.root,'versions','0.2.0',d.slug+(systemInfo().platform==='windows'?'.exe':'')))).digest('hex')).toBe(createHash('sha256').update(fixture.bytes).digest('hex'));
},30000);

test.skipIf(process.platform !== "win32")("TECH — the platform verifier accepts the signed Windows PowerShell executable", async () => {
  const systemRoot = process.env["SystemRoot"]!;
  const signed = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await expect(verifyArtifactSignature(signed, "windows", systemRoot)).resolves.toBeUndefined();
}, 20000);

test("TECH — native installation rejects linked version directories, foreign origins and unsigned required signatures",async()=>{
  const f=fixture();await expect(f.store.install({...f.release,artifact:{...f.release.artifact,url:'https://other.invalid/file'}})).rejects.toThrow('origine');
  if(systemInfo().platform!=='linux') await expect(f.store.install({...f.release,artifact:{...f.release.artifact,signature:'platform'}})).rejects.toThrow('Signature');
  const installed=await f.store.install(f.release);expect(existsSync(installed.path)).toBe(true);
  await f.store.install(f.release,true);expect(f.downloads()).toBe(systemInfo().platform==='linux'?2:3);
  const linked=fixture(),outside=join(linked.ws.root,'outside');mkdirSync(outside);mkdirSync(linked.store.versions,{recursive:true});writeFileSync(join(outside,linked.store.o.cli+(systemInfo().platform==='windows'?'.exe':'')),'synthetic executable bytes 39');symlinkSync(outside,join(linked.store.versions,'0.2.0'),systemInfo().platform==='windows'?'junction':'dir');
  await expect(linked.store.install(linked.release)).rejects.toThrow('lié');expect(linked.downloads()).toBe(0);
},20000);

test("SPEC-INS-002/CA-02 — published minimum still blocks native startup when automatic updates are disabled",async()=>{
  const ws=workspace(),d=distribution(ws),p=new ScriptedProvider([]);mkdirSync(join(d.root,'versions','0.1.0'),{recursive:true});writeFileSync(d.old,'old fixture');
  const network=Object.assign(async()=>Response.json({schemaVersion:1,version:'0.2.0',minimumAllowedVersion:'0.2.0',artifacts:{[nativeTarget(systemInfo())]:{url:'program',sha256:'0'.repeat(64),size:1}}}),{preconnect:()=>{}}) as typeof fetch;
  const r=await cli(['--non-interactive','x'],ws,{provider:p,userConfig:{updates:{automatic:{enabled:false}}},extra:{installationExecutable:d.old,installationFetch:network}});expect(r.code).not.toBe(0);expect(r.stderr).toContain('installation update');expect(p.requests).toHaveLength(0);
});

test("TECH — the highest published minimum survives an offline restart and a lower later publication",async()=>{
  const f=fixture();await f.store.rememberMinimum({...f.release,minimumAllowedVersion:'0.2.0'});await f.store.rememberMinimum({...f.release,minimumAllowedVersion:'0.1.0'});
  const restarted=new NativeStore({...f.store.o,fetch:Object.assign(async()=>{throw new Error('offline');},{preconnect:()=>{}}) as typeof fetch});expect(restarted.minimum()).toBe('0.2.0');expect(()=>restarted.assertCurrent()).toThrow('installation update');expect(f.downloads()).toBe(0);
});
