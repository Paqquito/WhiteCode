import {expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {writeFileSync} from "node:fs";
import {activationProfile} from "./helpers/activation-profile";
test("TECH — omitted persistent assistant refuses installation, legacy admin, API creation and replay while a real background worker remains available",()=>{
  const f=activationProfile("public",{mode_assistant_persistent:false}),r=spawnSync(process.execPath,["--no-env-file","tests/fixtures/assistant-presence-probe.ts"],{cwd:f.root,env:f.environment,encoding:"utf8",windowsHide:true,timeout:20000,maxBuffer:2000000});
  writeFileSync(join(f.root,"proof-assistant-presence.json"),JSON.stringify({code:r.status,stdout:r.stdout,stderr:r.stderr},null,2));if(r.status!==0)throw Error(r.stderr+r.stdout);
  const p=JSON.parse(r.stdout);expect(p.installReads).toBe(0);expect(p.installError).toContain("absent de cette distribution");expect(p.directoryError).toContain("absent de cette distribution");
  expect(p.admin).toMatchObject({identityReads:0,policyCalls:0,vaultCalls:0,code:2,settings:false});expect(p.admin.stderr).toContain("absent de cette distribution");
  expect(p.configured).toMatchObject({code:2,vaultCalls:0,endpoint:false,assistantDirectory:false});expect(p.configured.stderr).toContain("explicitement configuré mais absent");
  expect(p.initial.workers).toHaveLength(1);expect(p.initial.workers[0]).toMatchObject({status:"stopped",queued:1});expect(p.initial.workers[0].pid).toBeUndefined();
  expect(p.assistant).toBe(400);expect(p.message).toBe(400);expect(p.attach).toBe(400);expect(p.registryUnchanged).toBe(true);expect(p.preserved).toHaveLength(1);expect(p.preserved[0].text).toBe("Keep this accepted event.");
  expect(p.background).toBe(200);expect(p.backgroundBody.kind).toBe("background");expect(p.backgroundBody.pid).toBeGreaterThan(0);expect(p.launched).toEqual(["background"]);
},30000);
