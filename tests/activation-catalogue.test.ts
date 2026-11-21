// Supports: SPEC-CAD-003 (approved C/D option and profile constraints), SPEC-BLD-002 (real generated macro values).
import {expect,test} from "bun:test";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {resolveBuildOptions,type BuildProfile} from "../src/extension-points/build-options";

const root=resolve(import.meta.dir,".."),environment=Object.fromEntries(["PATH","Path","SystemRoot","TEMP","TMP","PATHEXT","COMSPEC"].flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]!]]));
const commands={"context-files":"context_file_listing","agents-platform":"hosted_agent_management","fix-merge-request":"merge_request_fix","reindex-sessions":"session_metadata_backfill","context-debug":"diagnostics_context_inspection","inspect-tool-call":"diagnostics_tool_call_inspection","show-environment":"diagnostics_environment_inspection","handoff":"session_handoff","report-issue":"feedback_issue_report","getting-started":"onboarding_restart","perf-report":"diagnostics_performance_report","praise":"feedback_positive_report","remote-access-reset":"remote_failure_injection","publish-session":"session_publish","session-summary":"session_summary","version":"diagnostics_session_version","trace":"telemetry_trace_export"} as const;
const removed={...Object.fromEntries(Object.values(commands).map(name=>[name,false])),skill_filler_text:false,skill_session_rescue:false,browser_user_control:false,engine_control_channel:false,config_feature_overrides:false,remote_task_suggestions:false,model_fast_output:false};
function probe(profile:BuildProfile,overrides:Record<string,boolean>={}){
 const copy=mkdtempSync(join(realpathSync.native(tmpdir()),"activation-catalogue-"));
 for(const dir of ["src","scripts","prompts","identity"])cpSync(join(root,dir),join(copy,dir),{recursive:true});
 for(const file of ["package.json","tsconfig.json","bun.lock", "LICENSE", "THIRD_PARTY_NOTICES.txt"])cpSync(join(root,file),join(copy,file));
 symlinkSync(realpathSync(join(root,"node_modules")),join(copy,"node_modules"),process.platform==="win32"?"junction":"dir");
 mkdirSync(join(copy,"tests/fixtures"),{recursive:true});cpSync(join(root,"tests/fixtures/activation-catalogue-probe.ts"),join(copy,"tests/fixtures/activation-catalogue-probe.ts"));
 const source=join(copy,"options.json");writeFileSync(source,JSON.stringify(overrides));
 const generated=spawnSync(process.execPath,["--no-env-file","scripts/generate.ts","--profile",profile,"--build-options",source],{cwd:copy,env:environment,encoding:"utf8",windowsHide:true,timeout:15000});
 if(generated.status!==0)throw Error(generated.stderr||String(generated.error));
 const result=spawnSync(process.execPath,["--no-env-file","tests/fixtures/activation-catalogue-probe.ts"],{cwd:copy,env:environment,encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:1000000});
 if(result.status!==0)throw Error(result.stderr||String(result.error));
 return JSON.parse(result.stdout) as {profile:string;commands:string[];skills:string[];remoteTools:string[];options:string[];help:string;parsed:Record<string,string>;dynamic:{before:{schedule_jitter_ms:number};after:{schedule_jitter_ms:number};overrideReads:number;serviceCalls:number};sharing:{error?:string;effects:string[]};suggestion:{error?:string;effects:string[]}};
}
test("TECH — approved options and internal prerequisites both constrain actual command and skill catalogues across four generated profiles",()=>{
 for(const profile of ["public","internal","development","test"] as const){
  const p=probe(profile);expect(p.profile).toBe(profile);
  for(const command of Object.keys(commands))expect({profile,command,visible:p.commands.includes(command)}).toEqual({profile,command,visible:profile==="internal"});
  for(const skill of ["filler-text","session-rescue"])expect({profile,skill,visible:p.skills.includes(skill)}).toEqual({profile,skill,visible:profile==="internal"});
  for(const name of ["browser","fast-output"])expect(p.commands).toContain(name);expect(p.skills).toContain("browser-control");
  expect(p.dynamic.serviceCalls).toBe(1);expect(p.dynamic.before.schedule_jitter_ms).toBe(["internal","development"].includes(profile)?17:23);expect(p.dynamic.after.schedule_jitter_ms).toBe(["internal","development"].includes(profile)?17:31);
  expect(p.dynamic.overrideReads>0).toBe(["internal","development"].includes(profile));
  expect(p.remoteTools).toContain("start_remote_run");expect(p.remoteTools.includes("suggest_background_merge_request")).toBe(profile==="internal");
  for(const r of [p.sharing,p.suggestion]){if(profile==="internal"){expect(r.effects).toContain("confirm");expect(r.error).toBeUndefined();}else{expect(r.error).toBeDefined();expect(r.effects).toEqual([]);}}
 }
},120000);
test("TECH — removed options disappear from catalogues and help, reject CLI arguments, and leave ordinary dynamic service and cache intact",()=>{
 const p=probe("internal",removed);
 for(const command of [...Object.keys(commands),"browser","fast-output"])expect(p.commands).not.toContain(command);
 for(const skill of ["filler-text","session-rescue","browser-control"])expect(p.skills).not.toContain(skill);
 for(const option of ["browser","control-channel","control-listen","control-connect"]){expect(p.options).not.toContain(option);expect(p.help).not.toContain("--"+option);expect(p.parsed[option]).toContain("Option inconnue");}
 expect(p.dynamic).toMatchObject({before:{schedule_jitter_ms:23},after:{schedule_jitter_ms:31},overrideReads:0,serviceCalls:1});
 for(const r of [p.sharing,p.suggestion]){expect(r.error).toBeDefined();expect(r.effects).toEqual([]);}
 expect(p.remoteTools).toEqual(["start_remote_run"]);
 expect(resolveBuildOptions("internal",removed).config_feature_overrides).toBe(false);
},30000);
