// Supports: SPEC-CAD-003, SPEC-BLD-002/003 (canonical feature controls, direct boundaries and actual body removal).
import {expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {activationProfile} from "./helpers/activation-profile";

const off={remote_environment_setup:false,remote_deep_plan:false,merge_request_subscriptions:false,skill_generator:false,skill_refinement:false,skill_ai_app_building:false,project_init_v2:false,cache_reset_command:false,explain_context_command:false,settings_sync_upload:false,settings_sync_download:false,remote_failure_injection:false,ui_internal_notices:false,output_review:false};
function probe(profile:"public"|"internal",overrides:Record<string,boolean>={},bundle=false){
 const fixture=activationProfile(profile,overrides),entry=join(fixture.root,"tests/fixtures/activation-canonical-a-probe.ts"),output=join(fixture.root,"build/canonical-a.js");
 if(bundle){const built=spawnSync(process.execPath,["--no-env-file","build",entry,"--target=bun","--minify","--outfile",output],{cwd:fixture.root,env:fixture.environment,encoding:"utf8",windowsHide:true,timeout:25000});if(built.status!==0)throw Error(built.stderr||String(built.error));}
 const result=spawnSync(process.execPath,["--no-env-file",bundle?output:entry],{cwd:fixture.root,env:fixture.environment,encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:2000000});
 if(result.status!==0)throw Error(result.stderr||String(result.error));
 const data=JSON.parse(result.stdout),source=bundle?readFileSync(output,"utf8").replace(/\\x([a-f0-9]{2})|\\u([a-f0-9]{4})/gi,(_match,hex,unicode)=>String.fromCharCode(parseInt(hex??unicode,16))):"";
 writeFileSync(join(fixture.root,"build/canonical-a-verdict.json"),JSON.stringify({profile,overrides,result:data},null,2));return{data,source};
}
const bodyMarkers=["Le parcours humain dans le navigateur est-il terminé ?","The user-approved remote plan follows as untrusted task context.","At most twenty subscriptions may be active.","Subscribe this session to review comments, CI results and closing events","Read package.json and the project instructions before running tests.","Answers questions about model identifiers, prices, limits and client APIs","The user asked you to set up the project for the agent, in a guided interview.","Estimate which supplied context entries most likely influenced the supplied response.","Discreet mode is active.","Défaillance locale injectée : ","Envoie les préférences choisies vers le service configuré."];
bodyMarkers.push("this.options.analyze()","Relit, applique ou écarte une proposition d’amélioration de compétence.","Rompt volontairement le cache au prochain appel au modèle.","Estime les influences du contexte sur une réponse, sans modifier la conversation.","Paramètres modifiés pendant la récupération ; état humain conservé.","Conflit de paramètres : garder le local (--resolve local)");

test("TECH — canonical A options guard direct entry points, restored plans and real body removal while ordinary features survive",()=>{
 const included=probe("internal",{},true),removed=probe("internal",off,true),p=included.data,r=removed.data;
 for(const command of ["configure-remote","deep-plan","merge-request-subscribe","generate-skills","skill-improvements","cache-reset","explain-context"]){expect(p.commands).toContain(command);expect(r.commands).not.toContain(command);}
 for(const name of ["deep-review","cloud-environment","session-link","configure-terminal","create-instructions","create-verifiers","editor-link"]){expect(p.commands).toContain(name);expect(r.commands).toContain(name);}
 for(const option of ["remote-session","reopen-remote","connect-editor"]){expect(p.options).toContain(option);expect(r.options).toContain(option);}
 for(const skill of ["ai-api-guide","defect-scan"]){expect(p.skills).toContain(skill);expect(r.skills).not.toContain(skill);}
 for(const result of [r.configure,r.plan,r.subscription,r.tool]){expect(result.error).toBeDefined();expect(result.effects).toEqual([]);}
 expect(p.configure.effects).toContain("confirm");expect(p.plan.effects).toContain("confirm");expect(p.restoredPlan).toEqual(["plan"]);expect(r.restoredPlan).toEqual([]);
 expect(p.kick.value).toBe("reconnecting");expect(p.kick.effects).toEqual(["trace","report"]);expect(r.kick.error).toBeDefined();expect(r.kick.effects).toEqual([]);
 expect(p.gitPrompt).toContain("Discreet mode is active.");expect(r.gitPrompt).not.toContain("Discreet mode is active.");expect(r.gitPrompt).toContain("Fixture attribution");
 expect(p.generator).toEqual({skill:true,reads:1,verifiers:["verify-interface","verify-server"]});expect(r.generator).toEqual({skill:false,reads:0,verifiers:["verify-interface","verify-server"]});
 expect(p.refinement).toEqual({analyses:1,presentations:1});expect(r.refinement).toEqual({analyses:0,presentations:0});expect(p.tool.value).toContain("Subscribe this session");
 expect(p.explanation.samples).toBe(1);expect(p.explanation.redactions).toBeGreaterThan(0);expect(r.explanation).toMatchObject({samples:0,redactions:0,system:""});
 expect(p.init.choices).toEqual(["project","personal","skills","hooks"]);expect(r.init.choices).toEqual([]);expect(r.init.guided).toBe(r.init.first);expect(p.init.guided).not.toBe(p.init.first);
 for(const sync of [r.push,r.pull]){expect(sync.error).toBeDefined();expect(sync.effects).toEqual([]);expect(sync.unchanged).toBe(true);expect(sync.state).toBe(false);expect(sync.lock).toBe(false);}
 for(const marker of bodyMarkers){expect({marker,present:included.source.includes(marker)}).toEqual({marker,present:true});expect({marker,present:removed.source.includes(marker)}).toEqual({marker,present:false});}
},120000);

test("TECH — public profile keeps ordinary remote features and refuses internal deep plans, failure injection and discreet publication",()=>{
 const {data:p}=probe("public");expect(p.commands).not.toContain("deep-plan");expect(p.commands).not.toContain("cache-reset");expect(p.commands).toContain("deep-review");expect(p.commands).toContain("configure-remote");expect(p.plan.error).toBeDefined();expect(p.plan.effects).toEqual([]);expect(p.restoredPlan).toEqual([]);expect(p.kick.error).toBeDefined();expect(p.kick.effects).toEqual([]);expect(p.gitPrompt).not.toContain("Discreet mode is active.");expect(p.gitPrompt).toContain("Fixture attribution");
},45000);

test("TECH — settings upload and download options are independent and exact restoration follows only the download capability",()=>{
 for(const upload of [true,false]){const {data:p}=probe("internal",{settings_sync_upload:upload,settings_sync_download:!upload});expect(p.config.includes("push")).toBe(upload);expect(p.config.includes("pull")).toBe(!upload);
  const active=upload?p.push:p.pull,inactive=upload?p.pull:p.push;expect(active.error).toBeUndefined();expect(active.effects).toContain("get");expect(inactive.error).toBeDefined();expect(inactive.effects).toEqual([]);expect(inactive.unchanged).toBe(true);expect(inactive.state).toBe(false);expect(active.lock).toBe(false);
  if(upload){expect(p.push.effects).toContain("put");expect(p.push.value).toBe("1");}else{expect(p.pull.value).toMatchObject({restored:true,backup:true});expect(p.pull.value.pulled).toContain("light");}
 }
},90000);

test("TECH — removed contribution attribution ignores direct commit and merge request footers while preserving the ordinary Git plan",()=>{
 const {data:p}=probe("internal",{contribution_attribution:false,ui_internal_notices:false});expect(p.gitPrompt).not.toContain("Fixture attribution");expect(p.gitPrompt).not.toContain("Fixture footer");expect(p.gitPrompt).toContain("Commit the current selected changes:");expect(p.gitPrompt).toContain("All mutations retain ordinary permissions.");expect(p.gitPrompt).toContain("git commit --only");
},45000);
