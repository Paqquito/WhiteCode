// Supports: SPEC-BLD-002/003 (real generated macros and callable feature boundaries).
import {mkdirSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {INTERNAL_COMMANDS} from "../../src/commands/internal";
import {builtinSkills} from "../../src/skills/builtin";
import {OPTIONS} from "../../src/cli/options";
import {FAMILY_CATALOG} from "../../src/cli/families";
import {SETUP_CHOICES,createInstructionsRequest} from "../../src/commands/create-instructions";
import {gitPrompt} from "../../src/commands/git-prompt";
import {CloudWorkflows} from "../../src/remote/workflows";
import {SessionRelay} from "../../src/remote/session-relay";
import {MergeSubscriptions} from "../../src/remote/merge-subscriptions";
import {subscriptionTool} from "../../src/remote/subscription-tool";
import {proposeTestSkill,proposeWebVerifiers} from "../../src/skills/generate";
import {SkillImprovements} from "../../src/skills/improvements";
import {SettingsSync} from "../../src/config/settings-sync";
import {ContextExplanations,EXPLAIN_CONTEXT_SYSTEM} from "../../src/engine/context-explanation";
import {BUILD_PROFILE} from "../../src/identity/generated/build-flags";
import {tryFileLock} from "../../src/platform/file-lock";
import {currentPlatform} from "../../src/platform/system";

const directory=join(process.cwd(),"build/canonical-proof");mkdirSync(directory,{recursive:true});
writeFileSync(join(directory,"package.json"),JSON.stringify({scripts:{test:"fixture-test"},dependencies:{react:"fixture",express:"fixture"}}));
const signal=new AbortController().signal,effects:string[]=[];
const owner=async()=>{effects.push("profile");return{account:"member",organization:{id:"org"}};};
async function attempt(action:()=>unknown|Promise<unknown>){effects.length=0;try{return{value:await action(),effects:[...effects]};}catch(error){return{error:String(error),effects:[...effects]};}}
const cloud=new CloudWorkflows({account:{profile:owner,request:async(_service,path)=>{effects.push(path);return{status:"completed",approved:true,revision:"r1",plan:"approved plan witness"};}},sessionUrl:"https://sessions.fixture.test/",webUrl:"https://web.fixture.test/",repository:async()=>{effects.push("repository");return{repository:"https://forge.fixture.test/repo.git",branch:"main",commit:"a".repeat(40)};},confirm:async()=>{effects.push("confirm");return false;},select:async()=>undefined,environment:()=>undefined,setEnvironment:()=>{},record:()=>{},context:()=>{effects.push("context");},report:()=>{},open:()=>{effects.push("open");return true;},qr:async()=>"",history:()=>[],redact:text=>text,refusal:()=>undefined});
const configure=await attempt(()=>cloud.command("configure-remote","",signal));
const plan=await attempt(()=>cloud.command("deep-plan","Inspect local fixture",signal));
await cloud.restore([{event:"remote_task",id:"plan-one",kind:"plan",account:"member",organizationId:"org",status:"running",url:"https://sessions.fixture.test/plan-one"}],signal);
const restoredPlan=cloud.tasks.map(task=>task.kind);await cloud.close();

const relay=new SessionRelay({account:{profile:owner,request:async()=>({id:"relay-one",url:"https://web.fixture.test/local/one",trustedDevice:true})},webUrl:"https://web.fixture.test/",mirror:false,history:()=>[],inject:()=>true,report:()=>{effects.push("report");},trace:()=>{effects.push("trace");},redact:text=>text,refusal:()=>undefined,intervalMs:3600000});
await relay.attach("",signal);const kick=await attempt(()=>{relay.kick("disconnect");return relay.state;});await relay.close();
const git=gitPrompt({publish:false,attribution:"Fixture attribution",footer:"Fixture footer",branchPrefix:"fixture/",discreet:true,privateNames:[],redact:text=>text,git:"git",cwd:directory,environment:{}});
let skillReads=0;const generated=proposeTestSkill(directory,()=>{skillReads++;return false;});
const verifiers=proposeWebVerifiers(directory,()=>false).map(skill=>skill.name);
let analyses=0,presentations=0;
const improvement=new SkillImprovements({every:()=>1,analyze:async()=>{analyses++;return JSON.stringify({skill:"fixture",reason:"Local evidence",content:"Improved fixture"});},allowed:()=>true,present:()=>{presentations++;}});
await improvement.turn();
const subscriptions=new MergeSubscriptions({account:{profile:owner,request:async()=>{effects.push("request");return{};}},repository:async()=>"https://forge.fixture.test/repo.git",record:()=>{},deliver:()=>{},report:()=>{},redact:text=>text,active:()=>true,intervalMs:3600000});
const subscription=await attempt(()=>subscriptions.command("",signal));
const tool=await attempt(()=>subscriptionTool(subscriptions).description({platform:currentPlatform(),home:directory}));await subscriptions.close();

async function synchronize(operation:"push"|"pull"){
 const file=join(directory,operation+".json");writeFileSync(file,'{"ui":{"theme":"dark"}}');
 const before=readFileSync(file,"utf8"),sync=new SettingsSync({file,include:["ui.theme"],redact:text=>text,account:{profile:owner,request:async(_service,_path,body)=>{effects.push(body===undefined?"get":"put");return{revision:body===undefined?"0":"1",values:{"ui.theme":"light"}};}}});
 const result=await attempt(async()=>{if(operation==="push")return await sync.push(signal);const backup=await sync.pull(signal);const pulled=readFileSync(file,"utf8");sync.restore(backup);return{pulled,restored:readFileSync(file,"utf8")===before,backup:existsSync(backup)};});
 const lockFile=file+".sync-lock",release=existsSync(lockFile)?tryFileLock(lockFile):undefined,lock=existsSync(lockFile)&&release===undefined;release?.();
 return{...result,unchanged:readFileSync(file,"utf8")===before,state:existsSync(file+".sync-state.json"),lock};
}
const push=await synchronize("push"),pull=await synchronize("pull");
let redactions=0,samples=0;
const explanation=new ContextExplanations(text=>{redactions++;return text;});
explanation.capture({conversationId:"fixture",system:[{text:"Actual context witness"}],history:[]} as unknown as Parameters<ContextExplanations["capture"]>[0])("Answer witness");
const explained=await explanation.explain(1,async()=>{samples++;return '[{"id":"c1","reason":"Observed instruction"}]';});
const names={instructionsFile:"GUIDE.md",localInstructionsFile:"GUIDE.local.md",projectDir:".fixture",projectSettings:".fixture/settings.json",localSettings:".fixture/local.json"};
console.log(JSON.stringify({profile:BUILD_PROFILE,commands:INTERNAL_COMMANDS.map(command=>command.name),skills:builtinSkills().map(skill=>skill.name),options:OPTIONS.map(option=>option.name),config:FAMILY_CATALOG.find(family=>family.name==="config")!.operations.filter(op=>op.delivered).map(op=>op.name),configure,plan,restoredPlan,kick,gitPrompt:git.prompt,generator:{skill:generated!==undefined,reads:skillReads,verifiers},refinement:{analyses,presentations},subscription,tool,push,pull,explanation:{redactions,samples,system:EXPLAIN_CONTEXT_SYSTEM,explained},init:{choices:SETUP_CHOICES.map(choice=>choice.id),guided:createInstructionsRequest(names,true,["skills"]),first:createInstructionsRequest(names,false,[])}}));
