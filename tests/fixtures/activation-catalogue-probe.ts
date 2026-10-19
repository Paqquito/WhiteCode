// Supports: SPEC-BLD-002 (real macro expansion in an isolated generated profile).
import { INTERNAL_COMMANDS } from "../../src/commands/internal";
import { builtinSkills } from "../../src/skills/builtin";
import { OPTIONS } from "../../src/cli/options";
import { helpText } from "../../src/cli/help";
import { parseCommandLine } from "../../src/cli/parser";
import { FeatureFlags } from "../../src/config/feature-flags";
import { CloudWorkflows } from "../../src/remote/workflows";
import { remoteWorkflowTools } from "../../src/remote/tools";
import { BUILD_PROFILE } from "../../src/identity/generated/build-flags";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const profile=String(BUILD_PROFILE);
const cache=join(import.meta.dir,"../../build/probe-flags.json");mkdirSync(join(import.meta.dir,"../../build"),{recursive:true});
writeFileSync(cache,JSON.stringify({values:{scheduled_triggers:false,schedule_jitter_ms:23}}));
let overrideReads=0,serviceCalls=0;
const flags=new FeatureFlags({cache,url:"https://flags.fixture.test/values",compiled:true,version:"fixture",platform:process.platform==="win32"?"windows":process.platform==="darwin"?"macos":"linux",disabled:false,intervalMs:3600000,internal:profile==="internal"||profile==="development",get overrides(){overrideReads++;return '{"scheduled_triggers":true,"schedule_jitter_ms":17}';},fetch:async()=>{serviceCalls++;return Response.json({values:{scheduled_triggers:false,schedule_jitter_ms:31}});}});
const before=flags.snapshot();await flags.refresh();const after=flags.snapshot();flags.close();
const effects:string[]=[];
const cloud=new CloudWorkflows({account:{profile:async()=>{effects.push("profile");return{account:"fixture",organization:{id:"org"}};},request:async()=>{effects.push("request");throw Error("Unexpected remote request");}},sessionUrl:"https://company.fixture.test/sessions/",webUrl:"https://company.fixture.test/",repository:async()=>{effects.push("repository");return{repository:"https://forge.fixture.test/owner/repo.git",branch:"main",commit:"a".repeat(40)};},confirm:async()=>{effects.push("confirm");return false;},select:async()=>undefined,environment:()=>undefined,setEnvironment:()=>{},record:()=>{effects.push("record");},context:()=>{},report:()=>{},open:()=>false,qr:async()=>"",history:()=>{effects.push("history");return[{role:"user",content:"fixture"}];},redact:text=>{effects.push("redact");return text;},refusal:()=>undefined});
const attempt=async(op:()=>Promise<string>)=>{effects.length=0;try{return{value:await op(),effects:[...effects]};}catch(error){return{error:String(error),effects:[...effects]};}};
const sharing=await attempt(()=>cloud.command("share","",new AbortController().signal));
const suggestion=await attempt(()=>cloud.suggest({title:"A bounded fix",reason:"A separate issue",prompt:"Inspect the local fixture"},new AbortController().signal));const remoteTools=remoteWorkflowTools(cloud).map(t=>t.name);await cloud.close();
const parsed=Object.fromEntries(["browser","control-channel","control-listen","control-connect"].map(name=>{try{parseCommandLine(["--"+name+((name==="control-connect")?"=wss://host.fixture.test/":"")]);return[name,"accepted"];}catch(error){return[name,String(error)];}}));
const help=helpText({get:(name:string)=>name,version:"fixture"} as Parameters<typeof helpText>[0]);
console.log(JSON.stringify({profile,commands:INTERNAL_COMMANDS.map(c=>c.name),skills:builtinSkills().map(s=>s.name),options:OPTIONS.map(o=>o.name),help,parsed,dynamic:{before,after,overrideReads,serviceCalls},sharing,suggestion,remoteTools}));
