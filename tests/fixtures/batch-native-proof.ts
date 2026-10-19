// Supports: SPEC-EXT-021 CA-02 (real existing skill, plan consent, Git worktrees, failing tests and HTTPS review requests).
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {runCli} from "../../src/headless/run";
import {Identity} from "../../src/identity/identity";
import {RESOLVED_IDENTITY} from "../../src/identity/generated/build-data";
import {ModelCatalog} from "../../src/providers/catalog";
import {systemInfo} from "../../src/platform/system";
import {fakeTerminal} from "../helpers/vterm";
import {ScriptedProvider,type ScriptedResponse} from "../helpers/scripted-provider";
import type {ModelRequest,ModelEvent} from "../../src/providers/types";
const root=process.argv[2]!,bun=process.argv[3]!;
if(!/^\/var\/tmp\/whitecode-native-tests-1mstsgkw\/ext021-proof-[A-Za-z0-9]{6}$/.test(root??"")||!bun)throw Error("Owned private proof root and native runtime required.");
const assert=(v:unknown,text:string)=>{if(!v)throw Error(text);},env={PATH:"/usr/bin:/bin",HOME:join(root,"home"),LANG:"C.UTF-8",TERM:"xterm"};
writeFileSync(join(root,"ownership.json"),JSON.stringify({purpose:"ext021-native-proof"}),{mode:0o600});
for(const name of ["home","config","managed","project","copies","forge","public"])mkdirSync(join(root,name),{mode:0o700});
const project=join(root,"project"),copies=join(root,"copies"),cert=join(root,"public/cert.pem"),key=join(root,"public/key.pem");
const git=(cwd:string,args:string[])=>{const p=Bun.spawnSync(["/usr/bin/git","-c","core.hooksPath=","-c","user.name=Fixture","-c","user.email=fixture@localhost",...args],{cwd,env,stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim();};
const openssl=Bun.spawnSync(["/usr/bin/openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1","-addext","basicConstraints=critical,CA:TRUE","-keyout",key,"-out",cert],{stdout:"ignore",stderr:"pipe"});assert(openssl.exitCode===0,"private fixture TLS certificate");
git(project,["init","-b","main"]);
const units=["alpha","beta","gamma"];
for(const name of units){writeFileSync(join(project,name+".ts"),`export const oldName = ${JSON.stringify(name)};\n`);writeFileSync(join(project,name+".test.ts"),`import{test,expect}from"bun:test";import*as value from"./${name}";test(${JSON.stringify(name+" migration")},()=>expect((value as Record<string,string>)[${JSON.stringify(name==="beta"?"requiredOtherName":"newName")}]).toBe(${JSON.stringify(name)}));\n`);}
git(project,["add","."]);git(project,["commit","-m","Fixture baseline"]);const base=git(project,["rev-parse","HEAD"]),bare=join(root,"forge/repo.git");git(root,["clone","--bare",project,bare]);git(bare,["config","http.receivepack","true"]);
writeFileSync(join(project,"local-note.txt"),"USER_LOCAL_NOTE\n");
const reviews:Array<{id:number;head:string;commit:string;url:string}>=[];let origin="",tlsRequests=0;
const server=Bun.serve({hostname:"127.0.0.1",port:0,tls:{cert:readFileSync(cert),key:readFileSync(key)},maxRequestBodySize:32*1024*1024,async fetch(request){
  const url=new URL(request.url);tlsRequests++;
  if(url.pathname.startsWith("/repo.git/")){
    const bytes=await request.arrayBuffer(),child=Bun.spawn(["/usr/lib/git-core/git-http-backend"],{env:{...env,GIT_PROJECT_ROOT:join(root,"forge"),GIT_HTTP_EXPORT_ALL:"1",REQUEST_METHOD:request.method,PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:request.headers.get("content-type")??"",CONTENT_LENGTH:String(bytes.byteLength),REMOTE_USER:"fixture",SERVER_PROTOCOL:"HTTP/1.1"},stdin:new Uint8Array(bytes),stdout:"pipe",stderr:"pipe"});
    const output=Buffer.from(await new Response(child.stdout).arrayBuffer()),code=await child.exited,at=output.indexOf("\r\n\r\n");assert(code===0&&at>=0,"real smart Git backend");const headers=new Headers();let status=200;
    for(const line of output.subarray(0,at).toString().split("\r\n")){const i=line.indexOf(":");if(i<0)continue;const k=line.slice(0,i),v=line.slice(i+1).trim();if(k.toLowerCase()==="status")status=Number(v.split(" ")[0]);else headers.append(k,v);}return new Response(output.subarray(at+4),{status,headers});
  }
  if(request.method==="POST"&&url.pathname==="/api/requests"){
    const body=await request.json() as any;if(!/^batch\/(alpha|gamma)$/.test(body.head))return Response.json({error:"unpublished or failed unit"},{status:400});
    const commit=git(bare,["rev-parse","--verify","refs/heads/"+body.head]),review={id:reviews.length+1,head:body.head,commit,url:origin+"requests/"+(reviews.length+1)};reviews.push(review);return Response.json(review,{status:201});
  }
  const page=/^\/requests\/(\d+)$/.exec(url.pathname),review=page&&reviews.find(r=>r.id===Number(page[1]));
  if(review)return new Response(`<html><body>Review ${review.id}: ${review.head} at ${review.commit}; base main; open; never merged.</body></html>`,{headers:{"content-type":"text/html"}});
  return new Response("missing",{status:404});
}});origin=`https://127.0.0.1:${server.port}/`;git(project,["remote","add","origin",origin+"repo.git"]);
const forge=join(root,"fixture-forge.ts");writeFileSync(forge,`const [base,head,ca]=process.argv.slice(2);const r=await fetch(base+"api/requests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({head}),tls:{ca:await Bun.file(ca).text()}});const text=await r.text();if(!r.ok)throw Error(text);console.log("REVIEW_CREATED "+text);\n`);
const quoted=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'",tool=(name:string,input:unknown)=>({toolCalls:[{name,input}]}),resultText=(request:ModelRequest)=>{const last=[...request.history].reverse().find(m=>m.role==="user");return last?.role==="user"?last.parts.flatMap(part=>part.type==="tool_result"?part.content.flatMap(content=>content.type==="text"?[content.text]:[]):part.type==="text"?[part.text]:[]).join("\n"):"";};
let mainPhase=0,taskIds:string[]=[],mainSummary="",active=0,peak=0;const agentPhase=new Map<string,number>(),agentUnits=new Map<string,string>(),reports=new Map<string,string>(),providerRequests:ModelRequest[]=[],gitDirectories:string[]=[],reviewPages:Array<{url:string;html:string}>=[];
const planner=new class{
  readonly id="simulated";
  async *stream(request:ModelRequest,signal:AbortSignal):AsyncIterable<ModelEvent>{
    providerRequests.push(structuredClone(request));let response:ScriptedResponse;
    if(request.purpose==="subagent"){
      const id=request.agent!,initial=[...request.history].reverse().find(m=>m.role==="user"&&JSON.stringify(m).includes("BATCH_UNIT=")),unit=agentUnits.get(id)??/BATCH_UNIT=(alpha|beta|gamma)/.exec(JSON.stringify(initial))?.[1];assert(unit,"unit task prompt");agentUnits.set(id,unit!);
      const phase=agentPhase.get(id)??0;agentPhase.set(id,phase+1);const folder=join(copies,unit!);
      if(phase===0){active++;peak=Math.max(peak,active);response=tool("read_file",{path:join(folder,unit+".ts")});}
      else if(phase===1)response=tool("write_file",{path:join(folder,unit+".ts"),content:`export const newName = ${JSON.stringify(unit)};\n`});
      else if(phase===2)response=tool("run_shell",{command:`${quoted(bun)} --no-env-file test ${quoted(join(folder,unit+".test.ts"))}`,description:`Run real targeted test for ${unit}`,timeout:10000});
      else if(phase===3&&unit==="beta"){
        const output=resultText(request);assert(output.includes("1 fail"),"failed unit must follow an actual failed Bun assertion");const text="FAILED beta: targeted test exited with 1 fail; branch and dirty working copy retained for inspection. "+output;reports.set(unit,text);active--;response={text};
      }else if(phase===3){assert(resultText(request).includes("1 pass"),"success needs real passing test");response=tool("run_shell",{command:`git -C ${quoted(folder)} add -- ${quoted(unit+".ts")} && git -C ${quoted(folder)} -c user.name=Fixture -c user.email=fixture@localhost commit -m ${quoted("Migrate "+unit)}`,description:`Commit verified ${unit} migration`});}
      else if(phase===4)response=tool("run_shell",{command:`git -C ${quoted(folder)} push origin ${quoted("batch/"+unit)}`,description:`Push approved ${unit} branch to the private fixture forge`});
      else if(phase===5)response=tool("run_shell",{command:`${quoted(bun)} --no-env-file ${quoted(forge)} ${quoted(origin)} ${quoted("batch/"+unit)} ${quoted(cert)}`,description:`Open ${unit} review on private HTTPS forge`});
      else{const text=resultText(request),marker=/REVIEW_CREATED (\{[^\n]*?\})/.exec(text.replaceAll('\\"','"'));assert(marker,"review must come from the real CLI result: "+text);const record=JSON.parse(marker![1]!),report=`SUCCESS ${unit}: ${record.url} (${record.commit})`;reports.set(unit!,report);active--;response={text:report};}
    }else{
      const phase=mainPhase++;
      if(phase===0){assert(JSON.stringify(request.history).includes("Submit the split with `submit_plan`"),"actual batch skill loaded");response=tool("write_file",{path:join(project,"premature.txt"),content:"must be refused"});}
      else if(phase===1){assert(resultText(request).includes("Planning mode: no modification is allowed"),"planning enforced before plan approval");response=tool("submit_plan",{plan_text:"Three independent units: alpha.ts on batch/alpha, beta.ts on batch/beta, gamma.ts on batch/gamma. Each uses its own worktree, runs its own Bun test, commits and requests permission before push/review. Never merge. Preserve a failed copy. At most two simultaneous agents."});}
      else if(phase===2){assert(resultText(request).includes("The user approved the plan"),"real plan acceptance before Git");response=tool("run_shell",{command:units.map(u=>`git -C ${quoted(project)} worktree add -b ${quoted("batch/"+u)} ${quoted(join(copies,u))} HEAD`).join(" && "),description:"Create three isolated Git working copies after plan approval"});}
      else if(phase===3){assert(units.every(u=>existsSync(join(copies,u,".git"))),"real worktrees created by the product");gitDirectories.push(...units.map(u=>git(join(copies,u),["rev-parse","--absolute-git-dir"])));assert(new Set(gitDirectories).size===3,"Git indexes belong to separate worktrees");response={toolCalls:units.map(u=>({name:"spawn_agent",input:{role:"general",description:`Migrate unit ${u}`,prompt:`BATCH_UNIT=${u}. Working copy ${join(copies,u)}, branch batch/${u}. Change only ${u}.ts from oldName to newName. Read before writing. Run ${u}.test.ts with the native Bun. On success commit, request ordinary permission to push, then create a review on the configured private HTTPS forge. If the test fails, retain the dirty branch and report the actual failing result. Never merge. Use explicit paths or cd in each command.`,detached:true}}))};}
      else if(phase===4){taskIds=[...resultText(request).matchAll(/task (a[0-9]+)/g)].map(m=>m[1]!);taskIds=[...new Set(taskIds)];assert(taskIds.length===3,"three actual detached task ids: "+resultText(request));response={toolCalls:taskIds.map(id=>({name:"background_output",input:{task_id:id,block:true,timeout:30000}}))};}
      else if(phase===5){const observed=resultText(request);assert([...reports.values()].every(r=>observed.includes(r)),"synthesis must follow actual background reports");mainSummary=[...reports.values()].sort().join("\n");response=tool("run_shell",{command:["alpha","gamma"].map(u=>`git -C ${quoted(project)} worktree remove ${quoted(join(copies,u))}`).join(" && "),description:"Remove only successful pushed worktrees; keep failed beta for inspection"});}
      else response={text:"BATCH_SYNTHESIS_FROM_REAL_RESULTS\n"+mainSummary};
    }
    const replay=new ScriptedProvider([response]);yield*replay.stream(request,signal);
  }
};
const model={id:"batch-fixture",provider:"openai_compatible" as const,family:"fixture",label:"Batch fixture",contextWindow:128000,maxOutputTokens:4096,capabilities:{toolCalling:true}};
const identity=new Identity(RESOLVED_IDENTITY),config=join(root,"config");
writeFileSync(join(config,"config.json"),JSON.stringify({api:{provider:"openai_compatible",baseUrl:"http://127.0.0.1:9/v1/"},models:{selected:model.id},agents:{maxParallel:2,progressSummary:{enabled:false}},skills:{batch:{maxAgents:3}},extensions:{autoUpdate:"off"},deepLinks:{registration:"disabled"},integrations:{keepAwake:false},sessions:{autoTitle:false},memory:{automatic:{enabled:false},autoExtraction:{enabled:false},session:{enabled:false}},ui:{reducedMotion:true,maxFramesPerSecond:240},git:{mergeRequestStatus:{enabled:false}}}));
const term=fakeTerminal(160,55),controller=new AbortController(),screen=()=>term.vt.screen().join("\n"),permissionPreviews:string[]=[];let err="",finished=false,approved=false,permissionCount=0,delegatedPermissions=0,pushPermissions=0,lastAnswer=0;
const run=runCli(["--allow-project-trust","--allow-dir",copies,"--model",model.id],{streams:{terminal:term,stdinIsTTY:true,stdoutIsTTY:true,writeOut:()=>{},writeErr:text=>{err+=text;},readAllStdin:async()=>"",stdinLines:async function*(){}},environment:{...env,GIT_SSL_CAINFO:cert,OPENAI_API_KEY:"fixture-unused",[identity.get("ENV_PREFIX")+"CONFIG_HOME"]:config},cwd:project,system:{...systemInfo(),home:env.HOME,tmp:root},identity,catalog:new ModelCatalog({schemaVersion:1,currency:"USD",models:[model]}),managedDir:join(root,"managed"),policyFileProtection:()=>({writable:false}),providerFactory:()=>planner,signal:controller.signal}).finally(()=>{finished=true;});
const wait=async(predicate:()=>boolean,label:string,timeout=15000)=>{const end=Date.now()+timeout;while(!predicate()){if(finished||Date.now()>end)throw Error(label+"\n"+err+"\n"+term.vt.all().join("\n"));await Bun.sleep(20);}};
try{
  await wait(()=>screen().includes("Votre message")||screen().includes("Utiliser cette clé d'environnement"),"initial terminal");
  if(screen().includes("Utiliser cette clé d'environnement")){await Bun.sleep(380);term.type("o");await wait(()=>screen().includes("Votre message"),"terminal after synthetic credential consent");}
  for(const ch of "/batch migrate oldName to newName in alpha beta gamma")term.type(ch);term.type("\r");
  await wait(()=>screen().includes("Que faire de ce plan ?"),"ordinary plan approval");assert(!existsSync(join(project,"premature.txt"))&&readdirSync(copies).length===0,"no modification or worktree before consent");
  await Bun.sleep(380);approved=true;term.type("1");
  const end=Date.now()+90000;
  while(!term.vt.all().join("\n").includes("BATCH_SYNTHESIS_FROM_REAL_RESULTS")){
    if(finished||Date.now()>end)throw Error("batch completion\n"+err+"\n"+term.vt.all().join("\n"));
    const visible=screen();if(visible.includes("Autorisation requise")&&Date.now()-lastAnswer>450){assert(approved,"permissions cannot precede plan approval");await Bun.sleep(380);const actual=screen();permissionPreviews.push(actual);permissionCount++;if(/Demandé par : conversation \d+ — general\b/.test(actual))delegatedPermissions++;if(actual.split("\n").some(line=>line.includes("│ run_shell : Push approved ")))pushPermissions++;term.type("1");lastAnswer=Date.now();}
    await Bun.sleep(30);
  }
  await Bun.sleep(300);term.type("\u0004");term.type("\u0004");const code=await run;assert(code===0,"actual CLI completed: "+err);
  assert(peak===2&&active===0,"real detached agents obey the generic concurrency bound");assert(reports.size===3&&mainSummary.includes("FAILED beta")&&reviews.length===2,"actual partial failure synthesis");
  for(const review of reviews){const page=await fetch(review.url,{tls:{ca:readFileSync(cert,"utf8")}}),html=await page.text();assert(page.ok&&html.includes(review.commit),"consultable real HTTPS review page");reviewPages.push({url:review.url,html});assert(git(bare,["rev-parse",review.head])===review.commit,"review points to the actual pushed branch");assert(git(project,["diff","--name-only",base+".."+review.head])===review.head.split("/")[1]+".ts","successful branch touches its own unit only");}
  assert(git(project,["rev-parse","HEAD"])===base&&git(bare,["rev-parse","main"])===base,"no automatic merge or original HEAD mutation");
  assert(units.every(u=>readFileSync(join(project,u+".ts"),"utf8").includes("oldName"))&&readFileSync(join(project,"local-note.txt"),"utf8")==="USER_LOCAL_NOTE\n","original source and dirty note untouched");
  assert(!existsSync(join(copies,"alpha"))&&!existsSync(join(copies,"gamma"))&&existsSync(join(copies,"beta")),"successful worktrees removed, failed worktree preserved");
  assert(git(join(copies,"beta"),["status","--porcelain"]).includes("beta.ts")&&git(bare,["branch","--list","batch/beta"])==="","failed unit was never pushed");
  writeFileSync(join(root,"permission-evidence.json"),JSON.stringify({permissionCount,delegatedPermissions,pushPermissions,previews:permissionPreviews},null,2));
  assert(permissionCount>=8&&delegatedPermissions>=4&&pushPermissions>=2,"ordinary labelled permission dialogs and push consent actually traversed: "+JSON.stringify({permissionCount,delegatedPermissions,pushPermissions}));
  console.log(JSON.stringify({approvedPlan:true,planningEnforced:true,realWorktrees:true,gitDirectories,realTargetedFailure:true,independentSuccesses:2,reviewUrls:reviews.map(r=>r.url),reviews,reviewPages,consultableHttpsReviews:true,summary:mainSummary,originalPreserved:true,noMerge:true,failedCopyKept:true,peakAgents:peak,permissionCount,delegatedPermissions,pushPermissions,tlsRequests}));
}finally{controller.abort();await run;await server.stop(true);}
