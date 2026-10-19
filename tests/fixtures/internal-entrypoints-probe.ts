// Supports: SPEC-CMD-079/081/087/089/091 (direct entry point refusal before access).
import {agentsPlatform} from "../../src/agents/platform";
import {fixMergeRequest} from "../../src/commands/fix-merge-request";
import {contextReport,environmentReport} from "../../src/commands/context-diagnostics";
import {handoff} from "../../src/remote/handoff";
import {INTERNAL_COMMANDS} from "../../src/commands/internal";
import {FAMILY_CATALOG} from "../../src/cli/families";
if(process.argv[2]==="catalogue"){
 console.log(JSON.stringify({commands:INTERNAL_COMMANDS.map(command=>command.name),families:FAMILY_CATALOG.map(family=>family.name)}));
}else{
let reads=0;
const trap=new Proxy({}, {get(){reads++;throw Error("Unexpected access before refusal");}});
const operations=[
 ["agents",()=>agentsPlatform("",trap as Parameters<typeof agentsPlatform>[1])],
 ["fix",()=>fixMergeRequest("",trap as Parameters<typeof fixMergeRequest>[1])],
 ["context",()=>contextReport(trap as Parameters<typeof contextReport>[0])],
 ["environment",()=>environmentReport(trap as Parameters<typeof environmentReport>[0],"FIXTURE_")],
 ["handoff",()=>handoff(trap as Parameters<typeof handoff>[0],new AbortController().signal)],
] as const;
const results=[];
for(const [name,operation] of operations){reads=0;try{await operation();results.push({name,reads,accepted:true});}catch(error){results.push({name,reads,error:String(error)});}}
console.log(JSON.stringify(results));
}
