// Executes real CLI composition in isolated generated copies; no caller profile is regenerated.
import {expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {writeFileSync} from "node:fs";
import {activationProfile} from "./helpers/activation-profile";
const off = Object.fromEntries(["mode_assistant_persistent", "remote_environment_setup", "remote_deep_plan", "browser_embedded", "local_session_messaging", "merge_request_subscriptions", "contribution_attribution", "deep_links", "user_file_delivery", "process_monitor", "output_review", "return_summary", "memory_team_shared", "memory_initial_state", "skill_generator", "skill_refinement", "skill_ai_app_building", "shell_syntax_analysis_shadow", "ui_native_clipboard_image", "ui_year_in_review", "ui_attempt_stats", "ui_dictation", "settings_sync_upload", "settings_sync_download", "project_init_v2", "cache_reset_command", "explain_context_command", "output_file_persistence", "performance_tracing", "diagnostics_slow_ops", "update_prerelease_channel", "memory_consolidation"].map(name => [name, false]));
function run(mode: string, overrides: Record<string,boolean>) {
  const f=activationProfile("internal",overrides),r=spawnSync(process.execPath,["--no-env-file","tests/fixtures/activation-thirty-one-probe.ts",mode],{cwd:f.root,env:f.environment,encoding:"utf8",windowsHide:true,timeout:25000,maxBuffer:2000000});
  const proof={mode,overrides,code:r.status,stdout:r.stdout,stderr:r.stderr};writeFileSync(join(f.root,"proof-canonical-"+mode+".json"),JSON.stringify(proof,null,2));
  if(r.status!==0)throw Error(JSON.stringify(proof));
  return JSON.parse(r.stdout) as {results:Record<string,{code:number;requests:number;vaultReads:number;vaultWrites:number;archives:boolean}>;result:{code:number;stderr:string};requests:Array<{agent?:string;tools:string[]}>};
}
test("TECH — canonical options absent from the build reject explicit settings and variables before model or persistent effects",()=>{
  const p=run("canonical",off);expect(p.results.ordinary?.code).toBe(0);expect(p.results.ordinary?.requests).toBe(1);
  for(const name of ["local-messaging","recap","refinement","guided","output-files","explain","attribution","shadow","performance-trace","slow-ops","assistant-worker","team-memory","dictation","year-review","sync-upload"]){const r=p.results[name]!;expect({name,code:r.code,requests:r.requests}).toEqual({name,code:2,requests:0});expect(r.vaultReads).toBe(0);expect(r.vaultWrites).toBe(0);expect(r.archives).toBe(false);}
},30000);
test("TECH — omitting the visible consolidation option preserves actual automatic consolidation at session closure",()=>{
  const p=run("automatic-consolidation",off);expect(p.result.code).toBe(0);expect(p.result.stderr).toContain("Consolidation de la mémoire");expect(p.requests.filter(request=>request.agent==="internal-memory-consolidation")).toHaveLength(1);expect(p.requests[0]!.tools).not.toContain("consolidate_memory");
},30000);
test("TECH — persistent assistant retains message_user when the separate brief-mode build option is omitted",()=>{
  const p=run("assistant-message",{mode_brief:false});expect(p.result.code).toBe(0);expect(p.requests).toHaveLength(1);expect(p.requests[0]!.tools).toContain("message_user");
},30000);
