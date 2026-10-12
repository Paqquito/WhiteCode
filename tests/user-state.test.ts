import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readUserState, updateUserState } from "../src/config/trust";
import { currentPlatform, comparablePath } from "../src/platform/system";
import { startChild, runToCompletion } from "../src/platform/process";
import { BUN } from "./helpers/hooks";
import { cli, loadIdentity, ROOT, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { tryFileLock } from "../src/platform/file-lock";
import { interactive, KEY, sleep } from "./helpers/interactive";

test("SPEC-CFG-010/CA-01 — concurrent sessions keep both folder approvals after rereading the locked state", async () => {
  const ws = workspace();
  const file = ws.write("state.json", "{}");
  const worker = ws.write("worker.ts", `import { updateUserState } from ${JSON.stringify(join(ROOT, "src/config/trust.ts"))}; import { currentPlatform } from ${JSON.stringify(join(ROOT, "src/platform/system.ts"))}; for(let n=0;n<100;n++) await updateUserState(process.argv[2]!, {trustedProjects:[process.argv[3]!+"/"+n]}, currentPlatform());`);
  const errors: string[] = [];
  const children = Array.from({ length: 10 }, (_, n) => startChild(BUN, [worker, file, `folder-${n}`], { cwd: ws.root, env: { ...process.env } as Record<string, string>, onData: (c) => errors.push(c.toString()) }));
  try { const codes = await Promise.all(children.map((c) => c.exited)); expect(errors.join("")).toBe(""); expect(codes).toEqual(Array(10).fill(0)); }
  finally { await Promise.all(children.map((c) => c.killTree(100))); }
  const state = readUserState(file);
  expect(state.trustedProjects).toHaveLength(1000);
  for (let n=0;n<10;n++) expect(state.trustedProjects).toContain(`folder-${n}/99`);
}, 120_000);

test("SPEC-CFG-010/CA-02 — truncated user state is preserved, reset and reported at a real startup", async () => {
  const ws = workspace();
  const file = ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, '{"trustedProjects":[');
  const before = readFileSync(file);
  const provider = new ScriptedProvider([{ text: "Finished." }]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("état local");
  expect(result.stderr).toContain("copie conservée");
  const backups = readdirSync(ws.configHome).filter((p) => p.startsWith(basename(file)+".corrupt-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(ws.configHome, backups[0]!))).toEqual(before);
  expect(readUserState(file)).toEqual({});
  expect((await cli(["--non-interactive", "Work."], ws, { provider: new ScriptedProvider([{ text: "Finished." }]) })).stderr).not.toContain("copie conservée");
});

test("SPEC-CFG-010/CA-03 — project reset-choices clears only the current project's approvals without starting the model", async () => {
  const ws = workspace();
  const key = comparablePath(ws.project, currentPlatform());
  const file = ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, JSON.stringify({ trustedProjects: [ws.project], projects: { [key]: { connectors: { servers: {} }, connectorChoices: { docs: { decision: "approved", fingerprint: "fixture" } }, inclusionChoices: ["outside"] }, other: { connectorChoices: { keep: true } } } }));
  const provider = new ScriptedProvider([]);
  const result = await cli(["project", "reset-choices"], ws, { provider });
  expect(result.code).toBe(0);
  expect(provider.requests).toHaveLength(0);
  const state = JSON.parse(readFileSync(file,"utf8"));
  expect(state.projects[key]).toEqual({connectors:{servers:{}}});
  expect(state.projects.other).toEqual({connectorChoices:{keep:true}});
  expect(state.trustedProjects).toEqual([ws.project]);
});

test("TECH — state creation restricts owner access and keeps unrelated fields when merging patches", async () => {
  const ws = workspace(); const file = join(ws.root,"private-state.json");
  await updateUserState(file, {modelNotices:{one:"2026-10-12"}}, currentPlatform());
  await updateUserState(file, {modelNotices:{two:"2026-10-12"},unrestrictedAccepted:true}, currentPlatform());
  expect(readUserState(file).modelNotices).toEqual({one:"2026-10-12",two:"2026-10-12"});
  await updateUserState(file, {projects:{one:{choices:{a:true}}}}, currentPlatform());
  await updateUserState(file, {projects:{one:{choices:{b:true}},two:{enabled:true}}}, currentPlatform());
  expect(readUserState(file).projects).toEqual({one:{choices:{a:true,b:true}},two:{enabled:true}});
  if(currentPlatform()!=="windows") expect(statSync(file).mode&0o777).toBe(0o600);
  else {
    const command = `$ErrorActionPreference='Stop'; $acl=[System.IO.File]::GetAccessControl('${file.replace(/'/g,"''")}'); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid }); if($rules.Count -ne 0 -or !$acl.AreAccessRulesProtected){exit 1}`;
    expect(runToCompletion("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{cwd:ws.root,env:{...process.env} as Record<string,string>,timeoutMs:10000}).code).toBe(0);
  }
});

test("TECH — a killed writer releases its kernel lock so truncated state can recover at startup", async () => {
  const ws = workspace();
  const file = ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, '{"projects":');
  const worker = ws.write("lock-worker.ts", `import {tryFileLock} from ${JSON.stringify(join(ROOT,"src/platform/file-lock.ts"))}; const release=tryFileLock(process.argv[2]!+".lock"); if(!release)process.exit(1); console.log("locked"); setInterval(()=>{},1000);`);
  let ready!: () => void;
  const acquired = new Promise<void>((resolve) => { ready = resolve; });
  const child = startChild(BUN,[worker,file],{cwd:ws.root,env:{...process.env} as Record<string,string>,onData:(chunk)=>{if(chunk.toString().includes("locked"))ready();}});
  try { await Promise.race([acquired,child.exited.then((code)=>{throw new Error(`Lock worker exited ${code}`);}),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Lock worker did not start")),10000))]); }
  finally { await child.killTree(100); await child.exited; }
  const result = await cli(["--non-interactive","Work."],ws,{provider:new ScriptedProvider([{text:"Finished."}])});
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("copie conservée");
  expect(readUserState(file)).toEqual({});
  expect(readdirSync(ws.configHome).filter((name)=>name.startsWith(basename(file)+".corrupt-"))).toHaveLength(1);
},20000);

test("TECH — private state supports long paths and refuses a lock replaced by a directory", async () => {
  const ws = workspace();
  const file = join(ws.root,...Array(7).fill("long-state-folder-".repeat(3)),"state.json");
  await updateUserState(file,{trustedProjects:[ws.project]},currentPlatform());
  expect(readUserState(file).trustedProjects).toEqual([ws.project]);
  const blocked = ws.write("blocked-state.json","{}");
  mkdirSync(blocked+".lock");
  await expect(updateUserState(blocked,{trustedProjects:[ws.project]},currentPlatform())).rejects.toThrow();
  expect(readFileSync(blocked,"utf8")).toBe("{}");
});

test("TECH — a first message entered while startup consent waits for the state lock is processed once", async () => {
  const ws = workspace();
  const file = ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`,"{}");
  const release = tryFileLock(file+".lock");
  expect(release).toBeDefined();
  const abort = new AbortController();
  const provider = new ScriptedProvider([{text:"First message processed."}]);
  const run = interactive(["--approval-mode","unrestricted","--allow-unrestricted-mode"],ws,{provider,signal:abort.signal});
  let held = true;
  try {
    await run.waitFor((text)=>text.includes("Activer ce mode ?"));
    await sleep(400); run.type("o"); run.type(KEY.enter);
    await run.waitFor((text)=>!text.includes("Activer ce mode ?")&&text.includes("Votre message"));
    run.type("Process this first message."); run.type(KEY.enter);
    expect(provider.requests).toHaveLength(0);
    held=false; release!();
    await run.waitFor((text)=>text.includes("First message processed."));
    await run.idle();
    expect(provider.requests).toHaveLength(1);
    expect(readUserState(file).unrestrictedAccepted).toBe(true);
    run.type(KEY.ctrlD); run.type(KEY.ctrlD);
    expect((await run.done).code).toBe(0);
  } finally { if(held)release?.(); abort.abort(); await run.done; }
},15000);

test("TECH — termination after an early startup message prevents that message from starting a turn", async () => {
  const ws = workspace();
  const file = ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`,"{}");
  const release = tryFileLock(file+".lock");
  const abort = new AbortController();
  const provider = new ScriptedProvider([{text:"Must never run."}]);
  const run = interactive(["--approval-mode","unrestricted","--allow-unrestricted-mode"],ws,{provider,signal:abort.signal});
  let held = true;
  try {
    await run.waitFor((text)=>text.includes("Activer ce mode ?"));
    await sleep(400); run.type("o"); run.type(KEY.enter);
    await run.waitFor((text)=>!text.includes("Activer ce mode ?")&&text.includes("Votre message"));
    run.type("Do not process this message after termination."); run.type(KEY.enter);
    abort.abort(); held=false; release!();
    await run.done;
    expect(provider.requests).toHaveLength(0);
    expect(run.all().join("\n")).not.toContain("Must never run.");
  } finally { if(held)release?.(); abort.abort(); await run.done; }
},15000);
