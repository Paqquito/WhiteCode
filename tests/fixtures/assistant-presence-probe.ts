// Private loopback service and one ephemeral background process; no real credentials or model.
import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {defaultAssistantDirectory,installAssistant} from "../../src/services/install";
import {runResidentAdmin} from "../../src/services/admin";
import {ResidentSupervisor,readResidentEndpoint} from "../../src/services/supervisor";
import {residentFetch} from "../../src/platform/resident-process";
import {EnvironmentView} from "../../src/config/environment";
import {systemInfo,currentPlatform} from "../../src/platform/system";
import {workspace,loadIdentity,loadCatalog,captureStreams,trustedPolicyFile} from "../helpers/env";
import type {AdminDependencies} from "../../src/admin/subcommands";
const ws=workspace(),identity=loadIdentity(),streams=captureStreams(),prefix=identity.get("ENV_PREFIX");
let installReads=0,identityReads=0,policyCalls=0,vaultCalls=0;
let installError="",directoryError="";
try{installAssistant({get directory():string{installReads++;throw Error("Unexpected installation access");},project:ws.project,projectDirectory:identity.get("PROJECT_DIR"),settingsFile:join(ws.configHome,"config.json"),platform:currentPlatform()});}catch(error){installError=String(error);}
try{defaultAssistantDirectory(ws.home,"fixture");}catch(error){directoryError=String(error);}
const deps:AdminDependencies={streams,get identity(){identityReads++;return identity;},catalog:loadCatalog(),env:new EnvironmentView(prefix,{[prefix+"CONFIG_HOME"]:ws.configHome}),cwd:ws.project,system:{...systemInfo(),home:ws.home},managedDir:ws.managed,policyFileProtection:trustedPolicyFile,assertPolicy:()=>{policyCalls++;},credentialVault:{read:()=>{vaultCalls++;return undefined;},write:()=>{vaultCalls++;},remove:()=>{vaultCalls++;}}};
const admin=await runResidentAdmin(deps,{family:"resident-agent",operation:"attach",args:[],options:new Map()});
const adminEffects={identityReads,policyCalls,vaultCalls,code:admin,stderr:streams.err.join(""),settings:existsSync(join(ws.configHome,"config.json"))};
ws.write("home/config/config.json",JSON.stringify({daemon:{workers:["assistant"]}}));
const explicitStart=await runResidentAdmin(deps,{family:"service",operation:"start",args:[],options:new Map([["foreground",true]])});
const configuredEffects={code:explicitStart,vaultCalls,endpoint:readResidentEndpoint(ws.configHome)!==undefined,assistantDirectory:existsSync(join(ws.home,"fixture-assistant")),stderr:streams.err.join("")};
const saved={id:crypto.randomUUID(),kind:"assistant",cwd:ws.project,createdAt:Date.now(),mode:"ask",status:"idle",summary:"Saved assistant",restarts:0,pending:[{id:crypto.randomUUID(),text:"Keep this accepted event."}]};
const registry=ws.write("home/config/background-sessions/registry.json",JSON.stringify({schemaVersion:1,workers:[saved]}));
const original=readFileSync(registry,"utf8"),launched:string[]=[];
const service=new ResidentSupervisor({root:ws.configHome,maxConcurrent:4,waitMs:1000,assertPolicy:()=>{},program:record=>{launched.push(record.kind);return{file:process.execPath,args:["--no-env-file","-e",'console.log(JSON.stringify({type:"session"}));await Bun.stdin.text();']};},environment:()=>({HOME:ws.home,USERPROFILE:ws.home,...Object.fromEntries(["PATH","Path","SystemRoot","COMSPEC","PATHEXT"].flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]!]]))}),wasAccepted:()=>false,history:()=>[],notify:async()=>{}});
let observations:Record<string,unknown>={};
try{
  await service.start();const endpoint=readResidentEndpoint(ws.configHome)!;
  const request=(path:string,body:unknown)=>residentFetch(endpoint.port,endpoint.token,path,body,AbortSignal.timeout(3000));
  const initial=await(await request("/state",undefined)).json() as {workers:Array<{id:string;status:string;queued:number;pid?:number}>};
  const before=readFileSync(registry,"utf8"),assistant=await request("/workers",{kind:"assistant",cwd:ws.project}),message=await request("/workers/"+saved.id+"/message",{text:"Do not accept this event."}),attach=await request("/workers/"+saved.id+"/attach",{});
  const afterRefusal=readFileSync(registry,"utf8"),background=await request("/workers",{kind:"background",cwd:ws.project}),backgroundBody=await background.json() as {pid?:number;kind?:string};
  const final=JSON.parse(readFileSync(registry,"utf8")) as {workers:Array<typeof saved>};
  observations={initial,assistant:assistant.status,message:message.status,attach:attach.status,registryUnchanged:before===afterRefusal&&original===before,background:background.status,backgroundBody,launched:[...launched],preserved:final.workers.find(worker=>worker.id===saved.id)?.pending};
}finally{await service.close();}
console.log(JSON.stringify({installReads,installError,directoryError,admin:adminEffects,configured:configuredEffects,...observations}));
