// Supports: SPEC-CMD-091 CA-01 (two real repositories, HTTPS smart Git, hosted worker and actual product process).
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, linkSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { HostedService } from "../../src/hosted/service";
import { HostedWorker } from "../../src/hosted/worker";
import { HandoffGit } from "../../src/remote/handoff-git";
import { handoff } from "../../src/remote/handoff";
import { Identity } from "../../src/identity/identity";
import { RESOLVED_IDENTITY } from "../../src/identity/generated/build-data";
import { configuredCompanyAccount } from "../../src/auth/company-runtime";
import { Settings } from "../../src/config/settings";
import { runCli } from "../../src/headless/run";
import { ModelCatalog } from "../../src/providers/catalog";
import { systemInfo } from "../../src/platform/system";
const [mode,root]=process.argv.slice(2),environment={PATH:"/usr/bin:/bin",HOME:"/nonexistent",LANG:"C.UTF-8",TERM:"xterm"};
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
if(mode==="worker"){
  const raw=JSON.parse(readFileSync(root!,"utf8"));
  const worker=new HostedWorker({...raw,environment:{...environment,NODE_EXTRA_CA_CERTS:raw.ca,GIT_SSL_CAINFO:raw.ca},report:message=>console.error(message)});
  await worker.poll(AbortSignal.timeout(60000));console.log("WORKER_COMPLETE");
}else if(mode==="harness"){
  if(root!=="/opt"||process.getuid?.()!==0)throw Error("Private mounted proof root required.");
  const write=(name:string,text:string)=>writeFileSync(join(root,name),text,{mode:0o600});
  const git=(cwd:string,args:string[])=>{const r=Bun.spawnSync(["/usr/bin/git","-c","core.hooksPath=","-c","safe.directory="+cwd,...args],{cwd,env:{...environment,GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@localhost",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@localhost"},stdout:"pipe",stderr:"pipe"});if(r.exitCode)throw Error(r.stderr.toString());return r.stdout.toString().trim();};
  for(const name of ["local","forge","public","broker","worker"])mkdirSync(join(root,name),{mode:0o700});chmodSync(join(root,"public"),0o755);
  const cert=join(root,"public/cert.pem"),key=join(root,"public/key.pem");
  const openssl=Bun.spawnSync(["/usr/bin/openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1","-addext","basicConstraints=critical,CA:TRUE","-keyout",key,"-out",cert],{stdout:"ignore",stderr:"pipe"});assert(openssl.exitCode===0,"private fixture CA");chmodSync(cert,0o644);
  const local=join(root,"local"),bare=join(root,"forge/repo.git");git(local,["init","-b","main"]);
  write("local/tracked.txt","base\n");write("local/deleted.txt","kept\n");write("local/.gitignore","ignored/\n");
  git(local,["add","."]);git(local,["commit","-m","Fixture base"]);git(root,["clone","--bare",local,bare]);git(bare,["config","http.receivepack","true"]);
  const base=git(local,["rev-parse","HEAD"]),accountToken="fixture-account-"+"x".repeat(40),workerToken="fixture-worker-"+"y".repeat(40);
  let service:HostedService,denyCreate=false,denyPush=false,cancelPush:AbortController|undefined;const providerBodies:any[]=[];
  const network=((url:any,init:any)=>fetch(url,{...init,tls:{ca:readFileSync(cert,"utf8")}})) as typeof fetch;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,tls:{cert:readFileSync(cert),key:readFileSync(key)},maxRequestBodySize:32*1024*1024,async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/token")return Response.json({token_type:"Bearer",access_token:accountToken,refresh_token:"fixture-refresh-"+"f".repeat(40),expires_in:3600});
    if(url.pathname==="/api/account/profile")return Response.json({account:"member",organization:{id:"org",name:"Fixture"},roles:["member"]});
    if(url.pathname.startsWith("/repo.git/")){
      if(cancelPush&&url.pathname.endsWith("/git-receive-pack")){cancelPush.abort();await Bun.sleep(100);return new Response("cancelled fixture",{status:503});}
      if(denyPush&&(url.pathname.endsWith("git-receive-pack")||url.search.includes("git-receive-pack")))return new Response("unavailable",{status:503});
      const bytes=await request.arrayBuffer();const backend=Bun.spawn(["/usr/lib/git-core/git-http-backend"],{env:{...environment,GIT_PROJECT_ROOT:join(root,"forge"),GIT_HTTP_EXPORT_ALL:"1",REQUEST_METHOD:request.method,PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:request.headers.get("content-type")??"",CONTENT_LENGTH:String(bytes.byteLength),REMOTE_USER:"fixture",SERVER_PROTOCOL:"HTTP/1.1"},stdin:new Uint8Array(bytes),stdout:"pipe",stderr:"pipe"});
      const [output,code]=await Promise.all([new Response(backend.stdout).arrayBuffer(),backend.exited]);const body=Buffer.from(output),at=body.indexOf("\r\n\r\n");assert(code===0&&at>=0,"smart Git backend");
      const headers=new Headers();let status=200;for(const line of body.subarray(0,at).toString().split("\r\n")){const n=line.indexOf(":");if(n<0)continue;const name=line.slice(0,n),value=line.slice(n+1).trim();if(name.toLowerCase()==="status")status=Number(value.split(" ")[0]);else headers.append(name,value);}
      return new Response(body.subarray(at+4),{status,headers});
    }
    if(url.pathname==="/provider/v1/chat/completions"){
      const body=await request.json() as any;if(!body.stream)return Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:1,completion_tokens:1}});
      providerBodies.push(body);return new Response("data: "+JSON.stringify({choices:[{delta:{role:"assistant",content:"Transferred session resumed."},finish_reason:"stop"}]})+"\n\ndata: "+JSON.stringify({choices:[],usage:{prompt_tokens:12,completion_tokens:4}})+"\n\ndata: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
    }
    if(denyCreate&&url.pathname==="/sessions/handoff")return Response.json({error:"fixture interruption"},{status:503});
    return service.handle(request);
  }});
  const url=`https://127.0.0.1:${server.port}/`,repository=url+"repo.git";
  git(local,["remote","add","origin",repository]);
  const model={id:"handoff-fixture",provider:"openai_compatible" as const,family:"fixture",label:"Handoff fixture",contextWindow:32768,maxOutputTokens:2048,capabilities:{toolCalling:true},pricing:{inputPerMTok:1,outputPerMTok:2,cacheReadPerMTok:1,cacheWritePerMTok:1,effectiveDate:"2026-10-19",source:"Fictitious test price"}};
  service=new HostedService({directory:join(root,"broker"),encryptionKey:randomBytes(32),publicBaseUrl:url,workerToken,currency:"USD",providers:[{id:"fixture",baseUrl:url+"provider/v1/",model}],environments:[{id:"second",provider:"fixture",tools:[],connectors:[]}],authenticate:async auth=>auth==="Bearer "+accountToken?{account:"member",organizationId:"org",administrator:false}:undefined,repositoryAccessible:async value=>value===repository,fetch:network});
  const request=async(path:string,body:unknown,signal=AbortSignal.timeout(10000))=>{const r=await network(url+path,{method:body===undefined?"GET":"POST",headers:{authorization:"Bearer "+accountToken,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});const value=await r.json();if(!r.ok)throw Error("Fixture HTTP "+r.status);return value;};
  await request("console/keys/deposit",{provider:"fixture",label:"Synthetic",owner:"personal",secret:"fixture-provider-"+"z".repeat(40)});
  const account:any={profile:async()=>({account:"member",organization:{id:"org"}}),sessionBinding:async()=>"fixture-binding",request:(_service:string,path:string,body:unknown,signal:AbortSignal)=>request("sessions/"+path,body,signal)};
  const messages=[{role:"user",parts:[{type:"text",text:"FIRST_ORIGINAL_MESSAGE"}]},{role:"assistant",text:"ORIGINAL_ASSISTANT",toolCalls:[],native:{provider:"openai_compatible",content:{role:"assistant",content:"ORIGINAL_ASSISTANT"}}},{role:"user",parts:[{type:"text",text:"LAST_ORIGINAL_MESSAGE"}]}];
  const engine=()=>new HandoffGit({git:"/usr/bin/git",cwd:local,environment:{...environment,GIT_SSL_CAINFO:cert}});
  const options=(confirm:boolean)=>({account,git:engine(),environment:"second",webUrl:url,history:()=>messages,redact:(v:string)=>v,confirm:async()=>confirm,assertPolicy:()=>{},report:()=>{},pollMs:25});
  const dirty=()=>{write("local/tracked.txt","staged\n");git(local,["add","tracked.txt"]);write("local/tracked.txt","unstaged\n");write("local/new.txt","untracked exact\n");git(local,["rm","deleted.txt"]);mkdirSync(join(local,"ignored"),{recursive:true});write("local/ignored/kept.txt","never transferred\n");};dirty();
  const fingerprint=()=>JSON.stringify({status:git(local,["status","--porcelain=v1","--untracked-files=all"]),index:git(local,["write-tree"]),diff:git(local,["diff","--binary"]),head:git(local,["rev-parse","HEAD"]),untracked:readFileSync(join(local,"new.txt"),"utf8"),ignored:readFileSync(join(local,"ignored/kept.txt"),"utf8")});
  const before=fingerprint();const refused=await handoff(options(false),AbortSignal.timeout(15000));assert(!refused.transferred&&fingerprint()===before,"consent refusal preserves exact dirty state");
  linkSync(join(local,"tracked.txt"),join(local,"linked.txt"));let hardlink=false;try{await handoff(options(true),AbortSignal.timeout(15000));}catch{hardlink=true;}unlinkSync(join(local,"linked.txt"));assert(hardlink&&fingerprint()===before,"hard-linked files never enter the transfer");
  symlinkSync("/etc/passwd",join(local,"linked.txt"));let symlink=false;try{await handoff(options(true),AbortSignal.timeout(15000));}catch{symlink=true;}assert(symlink&&lstatSync(join(local,"linked.txt")).isSymbolicLink(),"symlink never followed or extracted");unlinkSync(join(local,"linked.txt"));assert(fingerprint()===before,"symlink refusal preserves originals");
  git(local,["update-index","--assume-unchanged","tracked.txt"]);let flagged=false;try{await handoff(options(true),AbortSignal.timeout(15000));}catch{flagged=true;}git(local,["update-index","--no-assume-unchanged","tracked.txt"]);assert(flagged&&fingerprint()===before,"hidden index changes explicitly refused without loss");
  denyPush=true;let pushFailed=false;try{await handoff(options(true),AbortSignal.timeout(15000));}catch{pushFailed=true;}denyPush=false;assert(pushFailed&&fingerprint()===before,"failed real HTTPS push restores exact index/worktree/untracked");
  cancelPush=new AbortController();let cancelled=false;try{await handoff(options(true),cancelPush.signal);}catch{cancelled=true;}cancelPush=undefined;assert(cancelled&&fingerprint()===before,"cancellation of a real Git HTTPS child preserves exact local state");
  denyCreate=true;let createFailed=false;try{await handoff(options(true),AbortSignal.timeout(15000));}catch{createFailed=true;}denyCreate=false;assert(createFailed&&fingerprint()===before,"failed service creation restores dirty state");
  // Protected names are refused without being read, and an apparent symlink is never extracted at the receiver.
  write("local/credentials.json","opaque fixture not sent");let excluded=false;try{await handoff(options(true),AbortSignal.timeout(15000));}catch{excluded=true;}assert(excluded&&readFileSync(join(local,"credentials.json"),"utf8")==="opaque fixture not sent","excluded file kept local");
  const unlink=Bun.spawnSync(["/usr/bin/rm","--",join(local,"credentials.json")]);assert(unlink.exitCode===0,"remove owned fixture");assert(fingerprint()===before,"exclusion refusal restores all ordinary changes");
  const workerConfiguration=join(root,"worker.json"),prefix=new Identity(RESOLVED_IDENTITY).get("ENV_PREFIX");
  write("worker.json",JSON.stringify({root:join(root,"worker"),serviceUrl:url,workerToken,prefix,productBinary:join(root,"bin/product"),ca:cert,pollMs:25,isolation:{firstUid:800000,lastUid:800020}}));
  let worker:ReturnType<typeof Bun.spawn<"ignore","pipe","pipe">>|undefined;
  // Drive the real /handoff command through its ordinary authenticated control/consent flow.
  const clientConfig=join(root,"client-config"),clientHome=join(root,"client-home"),managed=join(root,"managed");for(const p of [clientConfig,clientHome,managed])mkdirSync(p,{mode:0o700});
  const services={SERVICE_REMOTE_SESSIONS:url+"sessions/",SERVICE_WEB_APP:url,SERVICE_OAUTH_AUTHORIZE:url+"authorize",SERVICE_OAUTH_TOKEN:url+"token",OAUTH_CLIENT_ID:"fixture-client"};
  const remotePolicy="{}";writeFileSync(join(managed,"policy.json"),remotePolicy);
  const identity=new Identity({...RESOLVED_IDENTITY,policyAnchor:{organizationId:"org",policySha256:createHash("sha256").update(remotePolicy).digest("hex"),perimeter:"remote"},values:{...RESOLVED_IDENTITY.values,...Object.fromEntries(Object.entries(services).map(([name,value])=>[name,{value,origin:"provided" as const}]))}}),entries=new Map<string,string>(),vault={read:(_s:string,k:string)=>entries.get(k),write:(_s:string,k:string,v:string)=>{entries.set(k,v);},remove:(_s:string,k:string)=>{entries.delete(k);}};
  const settings=Settings.load({sources:[],projectTrusted:false}),company=configuredCompanyAccount(identity,clientConfig,()=>settings,vault,network)!;
  await company.signIn({confirm:async()=>true,authorize:async address=>{const auth=new URL(address),callback=new URL(auth.searchParams.get("redirect_uri")!);callback.searchParams.set("state",auth.searchParams.get("state")!);callback.searchParams.set("code","fixture-code");return callback.href;}},AbortSignal.timeout(10000));
  writeFileSync(join(clientConfig,"config.json"),JSON.stringify({api:{provider:"openai_compatible",baseUrl:url+"provider/v1/"},models:{selected:model.id,extraCatalog:[model]},remote:{defaultEnvironment:"second"},engine:{control:{allowEscalation:true}},extensions:{autoUpdate:"off"},deepLinks:{registration:"disabled"},integrations:{keepAwake:false},sessions:{autoTitle:false},memory:{automatic:{enabled:false},autoExtraction:{enabled:false},session:{enabled:false}}}));
  const history=join(clientConfig,"source-history.json");writeFileSync(history,JSON.stringify(messages),{mode:0o600});
  let wake:(()=>void)|undefined,ended=false,partial="",clientOutput="",clientError="",confirmed=false,revokeInConsent=false;const feed:string[]=[];
  const send=(value:unknown)=>{feed.push(JSON.stringify(value));wake?.();};
  async function* lines(){for(;;){if(feed.length){yield feed.shift()!;continue;}if(ended)return;await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;}}
  const streams={stdinIsTTY:false,stdoutIsTTY:false,readAllStdin:async()=>"",stdinLines:lines,writeErr:(text:string)=>{clientError+=text;},writeOut:(text:string)=>{clientOutput+=text;partial+=text;let at:number;while((at=partial.indexOf("\n"))>=0){const line=partial.slice(0,at);partial=partial.slice(at+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.type==="control_request"&&message.request==="confirm_escalation"){confirmed=true;if(revokeInConsent)writeFileSync(join(managed,"policy.json"),'{"permissions":{"denyRules":["write_file"]}}');send({type:"control_response",id:message.id,ok:true,result:{decision:"confirm",escalationId:message.params.escalationId}});}}}};
  const startControl=(signal:AbortSignal)=>runCli(["--non-interactive","--control-channel","--request-format","jsonl","--result-format","jsonl","--handoff-history-file",history,"--model",model.id],{streams,environment:{...environment,GIT_SSL_CAINFO:cert,[prefix+"CONFIG_HOME"]:clientConfig,OPENAI_API_KEY:"fixture-unused-local"},cwd:local,system:{...systemInfo(),home:clientHome,tmp:root},identity,catalog:new ModelCatalog({schemaVersion:1,currency:"USD",models:[model]}),managedDir:managed,credentialVault:vault,companyFetch:network,policyFileProtection:()=>({writable:false}),providerFactory:()=>({id:"openai_compatible",async *stream(){throw Error("Local model must not be invoked during handoff");}}),signal});
  const active=startControl(AbortSignal.timeout(45000));
  send({type:"control_init",protocolVersion:"1.0",demands:["approval_request","confirm_escalation","notify"],decisionAuthority:true});send({type:"control_request",id:"handoff-command",request:"invoke_command",params:{command:"/handoff"}});
  // Wait for the actual queued transfer rather than starting an empty poll.
  for(let end=Date.now()+15000;Date.now()<end;){const text=readFileSync(join(root,"broker/state.json"),"utf8");if(JSON.parse(text).sessions.some((s:any)=>s.status==="queued"))break;await Bun.sleep(20);}
  worker=Bun.spawn([join(root,"bin/bun"),"--no-env-file",join(root,"bin/proof.js"),"worker",workerConfiguration],{env:{...environment,NODE_EXTRA_CA_CERTS:cert},stdout:"pipe",stderr:"pipe"});
  try{
    const clientCode=await active;ended=true;wake?.();assert(clientCode===0&&confirmed&&(clientOutput+clientError).includes("Reprise distante confirmée"),"real /handoff command and consent: "+clientError+clientOutput);
    const [stdout,stderr,code]=await Promise.all([new Response(worker.stdout).text(),new Response(worker.stderr).text(),worker.exited]);assert(code===0&&stdout.includes("WORKER_COMPLETE"),"actual isolated worker: "+stderr);
    const sessions=JSON.parse(readFileSync(join(root,"broker/state.json"),"utf8")).sessions,session=sessions.at(-1);assert(session.status==="completed"&&session.input.environment==="second"&&session.workerStopped,"remote completion and selected environment");
    const received=join(root,"worker",readdirSync(join(root,"worker")).find(n=>n.startsWith("session-"))!,"repository");
    assert(git(received,["rev-parse","HEAD"])===base&&git(received,["symbolic-ref","--short","HEAD"])==="main","restored original branch and commit");
    const original=JSON.parse(before);assert(git(received,["status","--porcelain=v1","--untracked-files=all"])===original.status&&git(received,["write-tree"])===original.index&&git(received,["diff","--binary"])===original.diff,"exact staged/unstaged/deletion state in second repository");
    assert(readFileSync(join(received,"new.txt"),"utf8")==="untracked exact\n"&&!existsSync(join(received,"ignored")),"untracked restored and ignored contents absent");
    assert(providerBodies.length===1&&JSON.stringify(providerBodies[0].messages).includes("FIRST_ORIGINAL_MESSAGE")&&JSON.stringify(providerBodies[0].messages).includes("ORIGINAL_ASSISTANT")&&JSON.stringify(providerBodies[0].messages).includes("LAST_ORIGINAL_MESSAGE"),"actual product consumed complete history");
    assert(git(local,["status","--porcelain=v1","--untracked-files=all"])===""&&existsSync(join(local,"ignored/kept.txt")),"source changes set aside without touching ignored files");
    const saved=new HandoffGit({git:"/usr/bin/git",cwd:local,environment:{...environment,GIT_SSL_CAINFO:cert}});await saved.run(["stash","apply","--index",session.input.handoff.state.transferBranch.replace("handoff/","refs/session-handoff/")],AbortSignal.timeout(10000));assert(fingerprint()===before,"retained named recovery ref restores original source exactly");
    const queuedBefore=JSON.parse(readFileSync(join(root,"broker/state.json"),"utf8")).sessions.length;
    ended=false;partial="";clientOutput="";clientError="";confirmed=false;revokeInConsent=true;feed.length=0;
    const negativeStop=new AbortController(),negative=startControl(AbortSignal.any([negativeStop.signal,AbortSignal.timeout(20000)]));
    send({type:"control_init",protocolVersion:"1.0",demands:["approval_request","confirm_escalation","notify"],decisionAuthority:true});send({type:"control_request",id:"revoked-handoff",request:"invoke_command",params:{command:"/handoff"}});
    for(let end=Date.now()+10000;Date.now()<end;){if((clientOutput+clientError).includes("Politique obligatoire distante")||JSON.parse(readFileSync(join(root,"broker/state.json"),"utf8")).sessions.length>queuedBefore)break;await Bun.sleep(20);}
    const remoteRefused=(clientOutput+clientError).includes("Politique obligatoire distante");ended=true;wake?.();negativeStop.abort();await negative;
    assert(confirmed&&remoteRefused&&JSON.parse(readFileSync(join(root,"broker/state.json"),"utf8")).sessions.length===queuedBefore&&fingerprint()===before,"the actual handoff rechecks remote-only policy after consent before capture, publication or activation");
    writeFileSync(join(managed,"policy.json"),remotePolicy);revokeInConsent=false;
    const changedBranch=new HandoffGit({git:"/usr/bin/git",cwd:local,environment:{...environment,GIT_SSL_CAINFO:cert}});
    try {
      await changedBranch.inspect(AbortSignal.timeout(10000));await changedBranch.capture(AbortSignal.timeout(10000));git(local,["checkout","-b","human-switched"]);
      let refused=false;try{await changedBranch.recover(AbortSignal.timeout(10000));}catch{refused=true;}
      assert(refused&&git(local,["symbolic-ref","--short","HEAD"])==="human-switched"&&git(local,["status","--porcelain=v1","--untracked-files=all"])==="","handoff recovery must preserve another clean branch and require manual recovery");
      git(local,["checkout","main"]);await changedBranch.recover(AbortSignal.timeout(10000));assert(fingerprint()===before,"the original branch retains exact recoverability");
    } finally {changedBranch.close();}
    console.log(JSON.stringify({realCommand:true,ordinaryConsent:true,consentRefused:true,specialIndexRefused:true,linkedFilesRefused:true,pushCancelledSafely:true,pushFailedSafely:true,serviceFailedSafely:true,excludedSafely:true,realHttpsGit:true,remoteRestored:true,historyConsumed:true,environment:"second",localRecoverable:true,otherCleanBranchPreserved:true,remotePolicyRevokedDuringConsent:true,workerStopped:true,sourceHead:base,destinationHead:git(received,["rev-parse","HEAD"])}));
  }finally{worker?.kill();await worker?.exited;await service.close();await server.stop(true);}
}
