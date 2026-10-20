// Supports: SPEC-OUT-008 (EF-03 environment capture, cancellation), SPEC-AGT-016 (responsive background execution).
import {expect,test} from "bun:test";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {EnvironmentView,PUBLIC_SECRET_VARIABLES} from "../src/config/environment";
import {currentPlatform} from "../src/platform/system";
import {processExists} from "../src/platform/process";
import {CommandSandbox} from "../src/platform/sandbox";
import {ShellRuntime} from "../src/tools/shell-runtime";
import {BackgroundTasks} from "../src/engine/background";
import {startShellTask} from "../src/tools/background-tools";
import {workspace,loadIdentity,testToolFields} from "./helpers/env";
import {POSIX,productEnv,bunCommand} from "./helpers/hooks";

const quote=(value:string)=>"'"+value.replace(/\\/g,"/").replace(/'/g,"'\\''")+"'";
function fixture(){
  if(!POSIX)throw Error("Supported test platforms provide a POSIX shell.");
  const ws=workspace(),prefix=loadIdentity().get("ENV_PREFIX"),view=new EnvironmentView(prefix,productEnv(ws));
  const ready=join(ws.project,"capture-ready"),release=join(ws.project,"capture-release"),expired=join(ws.project,"capture-expired"),pidFile=join(ws.project,"capture.pid"),count=join(ws.project,"capture-count"),witness=join(ws.project,"command-ran");
  const gate=ws.write("project/capture-gate.ts",`import{existsSync,writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(pidFile)},String(process.pid));writeFileSync(${JSON.stringify(ready)},"ready");const end=Date.now()+4000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<end)await Bun.sleep(10);if(!existsSync(${JSON.stringify(release)})){writeFileSync(${JSON.stringify(expired)},"expired");process.exit(19);}`);
  const profile=`printf 'capture\\n' >> ${quote(count)}\nif ${bunCommand(gate)}; then alias delayed_ready='printf CAPTURE_READY'; fi\n`;
  ws.write("home/.bashrc",profile);ws.write("home/.zshrc",profile);
  const shell=new ShellRuntime({platform:currentPlatform(),projectCwd:ws.project,allowedDirectories:[ws.project],childEnv:{...view.childEnvironment({}),BASH_ENV:"",ENV:""},forcedVariables:{},excluded:name=>name.startsWith(prefix)||PUBLIC_SECRET_VARIABLES.includes(name),posix:POSIX,workDir:join(ws.root,"session","shell"),settings:{defaultTimeoutMs:5000,maxTimeoutMs:60000,outputLimit:24000,graceMs:1000,powershellLoadProfile:false}});
  return{ws,shell,ready,release,expired,pidFile,count,witness};
}

test("TECH — shell initialization keeps a real local service responsive and caches the captured aliases once",async()=>{
  const f=fixture(),signal=new AbortController().signal;let requests=0,sent=false,heartbeat:Promise<unknown>|undefined;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){requests++;writeFileSync(f.release,"released by local service");return new Response("capture released");}});
  const pulse=setInterval(()=>{if(existsSync(f.ready)&&!sent){sent=true;heartbeat=fetch(`http://127.0.0.1:${server.port}/`).then(response=>response.text());}},20);
  try{
    const first=await f.shell.runPosix("delayed_ready",5000,signal);
    expect(existsSync(f.ready)).toBe(true);expect(existsSync(f.expired)).toBe(false);expect(first.exitCode).toBe(0);expect(first.output.trim()).toBe("CAPTURE_READY");expect(requests).toBe(1);
    const second=await f.shell.runPosix("delayed_ready",5000,signal);expect(second.output.trim()).toBe("CAPTURE_READY");expect(readFileSync(f.count,"utf8").trim().split("\n")).toHaveLength(1);
  }finally{clearInterval(pulse);writeFileSync(f.release,"cleanup");await f.shell.stopAll();await heartbeat;await server.stop(true);}
},20000);

test("TECH — a managed sandbox exit veto at the initialization handoff prevents command launch",async()=>{
  const f=fixture();let enabled=false;
  const sandbox=new CommandSandbox(()=>({enabled,autoAllow:false,allowOutside:false,excludedCommands:[],files:{writable:[f.ws.project],hidden:[],readDenied:()=>false,writeDenied:()=>false},network:{authorize:async()=>false,allowsPrivate:()=>false,violation:()=>{}}}));
  const shell=new ShellRuntime({...f.shell.options,sandbox});
  const signal=new AbortController().signal;writeFileSync(f.release,"profile ready before policy handoff");
  try{
    const capture=shell.snapshot(signal),command=shell.runPosix(`printf SHOULD_NOT_RUN > ${quote(f.witness)}`,5000,signal,undefined,true).then(()=>undefined,error=>error);
    await capture.then(()=>{enabled=true;});const error=await command;
    expect(existsSync(f.witness)).toBe(false);expect(enabled).toBe(true);expect(String(error)).toContain("Sandbox exit is forbidden by managed policy");
  }finally{writeFileSync(f.release,"cleanup");await shell.stopAll();await f.shell.stopAll();}
},20000);

test("TECH — abort and session cleanup join an initializing shell and never launch the requested command",async()=>{
  for(const kind of["abort","stopAll"]as const){
    const f=fixture(),controller=new AbortController();let interrupted=false,stopping:Promise<void>|undefined;
    const pulse=setInterval(()=>{if(existsSync(f.ready)&&!interrupted){interrupted=true;if(kind==="abort")controller.abort();else stopping=f.shell.stopAll();}},20);
    try{
      const result=await f.shell.runPosix(`printf SHOULD_NOT_RUN > ${quote(f.witness)}`,5000,controller.signal);await stopping;
      expect(result.interrupted).toBe(true);expect(result.exitCode).toBeNull();
      expect(interrupted).toBe(true);expect(existsSync(f.expired)).toBe(false);expect(existsSync(f.witness)).toBe(false);expect(f.shell.running).toBe(false);
      const pid=Number(readFileSync(f.pidFile,"utf8"));expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);expect(processExists(pid)).toBe(false);
      writeFileSync(f.release,"retry after interrupted initialization");
      const retry=await f.shell.runPosix("delayed_ready",5000,new AbortController().signal);expect(retry.exitCode).toBe(0);expect(retry.output.trim()).toBe("CAPTURE_READY");expect(readFileSync(f.count,"utf8").trim().split("\n")).toHaveLength(2);
    }finally{clearInterval(pulse);writeFileSync(f.release,"cleanup");await f.shell.stopAll();}
  }
},30000);

test("TECH — oversized stdout or stderr from shell initialization is killed, bounded and cached as unavailable",async()=>{
  for(const channel of["stdout","stderr"]as const){
    const f=fixture(),warnings:string[]=[];
    const burst=f.ws.write("project/capture-burst.ts",`import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(f.pidFile)},String(process.pid));process.${channel}.write("x".repeat(1048577));await Bun.sleep(4000);writeFileSync(${JSON.stringify(f.expired)},"expired");`);
    const profile=`printf 'capture\\n' >> ${quote(f.count)}\n${bunCommand(burst)}\n`;
    f.ws.write("home/.bashrc",profile);f.ws.write("home/.zshrc",profile);
    const shell=new ShellRuntime({...f.shell.options,warn:message=>warnings.push(message)});
    try{
      const result=await shell.runPosix("printf CAPTURE_FALLBACK",5000,new AbortController().signal);expect(result.exitCode).toBe(0);expect(result.output.trim()).toBe("CAPTURE_FALLBACK");expect(warnings).toHaveLength(1);expect(existsSync(f.expired)).toBe(false);expect(existsSync(join(shell.options.workDir,"shell-snapshot.sh"))).toBe(false);
      expect(processExists(Number(readFileSync(f.pidFile,"utf8")))).toBe(false);
      await shell.runPosix("printf SECOND_CALL",5000,new AbortController().signal);expect(warnings).toHaveLength(1);expect(readFileSync(f.count,"utf8").trim().split("\n")).toHaveLength(1);
    }finally{await shell.stopAll();await f.shell.stopAll();}
  }
},30000);

test("TECH — session cleanup at the initialization handoff prevents a late command from starting",async()=>{
  const f=fixture(),signal=new AbortController().signal;let busyAtHandoff=false,stopped=false;
  writeFileSync(f.release,"ready without a blocked profile");
  try{
    const capture=f.shell.snapshot(signal);
    const command=f.shell.runPosix(`printf SHOULD_NOT_RUN > ${quote(f.witness)}`,5000,signal);
    await capture.then(async()=>{busyAtHandoff=f.shell.running;stopped=true;await f.shell.stopAll();});
    expect((await command).interrupted).toBe(true);expect(existsSync(f.witness)).toBe(false);expect(busyAtHandoff).toBe(true);expect(stopped).toBe(true);expect(f.shell.running).toBe(false);
    const retry=await f.shell.runPosix("delayed_ready",5000,signal);expect(retry.output.trim()).toBe("CAPTURE_READY");expect(readFileSync(f.count,"utf8").trim().split("\n")).toHaveLength(1);
  }finally{writeFileSync(f.release,"cleanup");await f.shell.stopAll();}
},20000);

test("TECH — cancelling one shell capture waiter preserves the shared native initialization of another command",async()=>{
  const f=fixture(),owner=new AbortController();let sent=false,first:ReturnType<ShellRuntime["runPosix"]>|undefined,second:ReturnType<ShellRuntime["runPosix"]>|undefined;
  const pulse=setInterval(()=>{if(existsSync(f.ready)&&!sent){sent=true;owner.abort();}},20);
  try{
    first=f.shell.runPosix(`printf SHOULD_NOT_RUN > ${quote(f.witness)}`,5000,owner.signal);
    second=f.shell.runPosix("delayed_ready",5000,new AbortController().signal);
    // Observe rejection too, so a broken first caller cannot leave the second unhandled.
    const outcome=Promise.allSettled([first,second]);
    const until=Date.now()+10000;while(!sent&&Date.now()<until)await Bun.sleep(10);expect(sent).toBe(true);
    expect((await first).interrupted).toBe(true);
    expect(processExists(Number(readFileSync(f.pidFile,"utf8")))).toBe(true);
    expect(existsSync(f.witness)).toBe(false);
    writeFileSync(f.release,"other waiter still owns initialization");
    const result=await second;expect(result.exitCode).toBe(0);expect(result.output.trim()).toBe("CAPTURE_READY");
    expect(readFileSync(f.count,"utf8").trim().split("\n")).toHaveLength(1);expect(existsSync(f.expired)).toBe(false);await outcome;
  }finally{clearInterval(pulse);writeFileSync(f.release,"cleanup");await f.shell.stopAll();await Promise.allSettled([first,second]);}
},20000);

test("TECH — stopping a background task during native shell initialization records stopped rather than failed",async()=>{
  const f=fixture(),background=new BackgroundTasks({dir:join(f.ws.root,"tasks"),maxOutputBytes:4096,monitorMaxLinesPerMinute:100,monitorWindowMs:100});
  const context={...testToolFields(),platform:currentPlatform(),home:f.ws.home,cwd:f.ws.project,allowedDirectories:[f.ws.project],signal:new AbortController().signal,shell:f.shell,background};
  const id=startShellTask(context,"shell",`printf SHOULD_NOT_RUN > ${quote(f.witness)}`,"initializing task",5000,false);
  try{
    const until=Date.now()+10000;while(!existsSync(f.ready)&&Date.now()<until)await Bun.sleep(10);expect(existsSync(f.ready)).toBe(true);
    await background.stop(id);expect(background.get(id)?.status).toBe("stopped");expect(background.get(id)?.exitCode).toBeNull();
    expect(existsSync(f.witness)).toBe(false);expect(existsSync(f.expired)).toBe(false);expect(processExists(Number(readFileSync(f.pidFile,"utf8")))).toBe(false);expect(f.shell.running).toBe(false);
  }finally{writeFileSync(f.release,"cleanup");await background.stopAll();await f.shell.stopAll();}
},20000);
