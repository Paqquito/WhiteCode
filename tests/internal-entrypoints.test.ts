// Supports: SPEC-BLD-002/003, SPEC-CMD-079/081/087/089/091 (cumulative local profile and build guards).
import {expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {activationProfile} from "./helpers/activation-profile";

test("TECH — internal module entry points refuse public, development and individually removed internal capabilities before any input access",()=>{
 const off={hosted_agent_management:false,merge_request_fix:false,diagnostics_context_inspection:false,diagnostics_environment_inspection:false,session_handoff:false};
 for(const profile of ["public","development","internal"] as const){const f=activationProfile(profile,profile==="internal"?off:{}),result=spawnSync(process.execPath,["--no-env-file",join(f.root,"tests/fixtures/internal-entrypoints-probe.ts")],{cwd:f.root,env:f.environment,encoding:"utf8",windowsHide:true,timeout:15000});if(result.status!==0)throw Error(result.stderr||String(result.error));const rows=JSON.parse(result.stdout) as Array<{name:string;reads:number;error?:string;accepted?:boolean}>;expect(rows.map(row=>row.name)).toEqual(["agents","fix","context","environment","handoff"]);for(const row of rows){expect(row.error).toContain("indisponible dans ce profil");expect(row.reads).toBe(0);expect(row.accepted).toBeUndefined();}}
},90000);

test("TECH — removing the persistent assistant hides its command and CLI family while retaining ordinary session and job workers",()=>{
 for(const enabled of [true,false]){const f=activationProfile("internal",{mode_assistant_persistent:enabled}),result=spawnSync(process.execPath,["--no-env-file",join(f.root,"tests/fixtures/internal-entrypoints-probe.ts"),"catalogue"],{cwd:f.root,env:f.environment,encoding:"utf8",windowsHide:true,timeout:15000});if(result.status!==0)throw Error(result.stderr||String(result.error));const data=JSON.parse(result.stdout) as {commands:string[];families:string[]};expect(data.commands.includes("resident-agent")).toBe(enabled);expect(data.families.includes("resident-agent")).toBe(enabled);for(const family of ["direct-server","background-session","session-runner","job-runner","job"])expect(data.families).toContain(family);expect(data.commands).toContain("background-tasks");}
},60000);
