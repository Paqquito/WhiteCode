// Native fixtures run the real CLI composition and installation store; only HTTPS responses are scripted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, ROOT, loadIdentity } from "./env";
import { productEnv } from "./hooks";
import { bootstrapScript } from "../../src/installation/bootstrap";

let compiled: Promise<{binary:string;bytes:Buffer}> | undefined;
export function nativeExecutable(): Promise<{binary:string;bytes:Buffer}> {
  return compiled ??= (async()=>{
    const ws=workspace(), identity=loadIdentity(), extension=process.platform==='win32'?'.exe':'', binary=join(ws.root,'fixture'+extension);
    const file=ws.write('entry.ts', `
import {readFileSync,appendFileSync} from 'node:fs';
import {runCli} from ${JSON.stringify(join(ROOT,'src/headless/run.ts'))};
import {Identity} from ${JSON.stringify(join(ROOT,'src/identity/identity.ts'))};
import {ModelCatalog} from ${JSON.stringify(join(ROOT,'src/providers/catalog.ts'))};
import {MODEL_CATALOG_DATA} from ${JSON.stringify(join(ROOT,'src/identity/generated/build-data.ts'))};
import {processStreams} from ${JSON.stringify(join(ROOT,'src/platform/io.ts'))};
import {systemInfo} from ${JSON.stringify(join(ROOT,'src/platform/system.ts'))};
import {nativeTarget} from ${JSON.stringify(join(ROOT,'src/installation/runtime.ts'))};
import {createHash} from 'node:crypto';
const identity=new Identity(${JSON.stringify({...identity.resolved,version:'0.2.0'})});
const network=Object.assign(async (input)=>{
 const bytes=readFileSync(process.execPath);
 if (String(input).endsWith('.json')) return Response.json({schemaVersion:1,version:'0.2.0',artifacts:{[nativeTarget(systemInfo())]:{url:'program',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}}});
 if(process.env.NATIVE_DOWNLOAD_LOG) appendFileSync(process.env.NATIVE_DOWNLOAD_LOG,'download\\n');
 await new Promise(r=>setTimeout(r,150)); return new Response(bytes);
},{preconnect:()=>{}});
process.exit(await runCli(process.argv.slice(2),{streams:processStreams(),environment:process.env,cwd:process.cwd(),system:systemInfo(),identity,catalog:new ModelCatalog(MODEL_CATALOG_DATA),installationFetch:network}));
`);
    const build=Bun.spawn([process.execPath,'build',file,'--compile','--outfile',binary],{stdout:'pipe',stderr:'pipe'});
    const output=await Promise.all([new Response(build.stdout).text(),new Response(build.stderr).text(),build.exited]);
    if(output[2]!==0) throw new Error(output[0]+output[1]);
    return {binary,bytes:readFileSync(binary)};
  })();
}

export async function launchNative(path:string,args:string[],ws:ReturnType<typeof workspace>,extra:Record<string,string>={}) {
  const identity=loadIdentity(),env=productEnv(ws,{[identity.get('ENV_PREFIX')+'CONFIG_HOME']:ws.configHome,...extra});
  if(process.platform==='win32') delete env['PSModulePath'];
  const child=Bun.spawn(process.platform==='win32' && path.endsWith('.cmd') ? ['cmd.exe','/d','/c',path,...args] : [path,...args],{cwd:ws.project,env,stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,code};
}

export async function bootstrapNative(ws:ReturnType<typeof workspace>,fixture:{binary:string;bytes:Buffer},manifest:unknown) {
  const identity=loadIdentity();
  if(process.platform==='win32') {
    const script=ws.write('install.ps1',bootstrapScript(identity,'powershell'));
    const wrapper=ws.write('bootstrap.ps1',`$ErrorActionPreference='Stop'\nfunction Invoke-RestMethod { param($Uri,$TimeoutSec,$MaximumRedirection) ConvertFrom-Json -InputObject '${JSON.stringify(manifest).replace(/'/g,"''")}' }\nfunction Invoke-WebRequest { param($Uri,$OutFile,$TimeoutSec,$MaximumRedirection) Copy-Item -LiteralPath '${fixture.binary.replace(/'/g,"''")}' -Destination $OutFile }\n. '${script.replace(/'/g,"''")}'\n`);
    return launchNative(join(process.env['SystemRoot']??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',wrapper],ws);
  }
  const m=manifest as {version:string;artifacts:Record<string,{sha256:string;size:number}>}, artifact=Object.values(m.artifacts)[0]!;
  const index=ws.write('index',`${m.version}\n${artifact.sha256}\n${artifact.size}\n${identity.get('SERVICE_DOWNLOADS').replace(/\/$/,'')}/program\n`),bin=join(ws.root,'network');
  const curl=ws.write('network/curl',`#!/bin/sh\nset -eu\nsource='${fixture.binary.replace(/'/g,"'\\''")}'\nfor arg in "$@"; do case "$arg" in *.txt) source='${index.replace(/'/g,"'\\''")}' ;; esac; done\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then cp "$source" "$2"; exit; fi; shift; done\nexit 1\n`);
  const {chmodSync}=await import('node:fs');chmodSync(curl,0o700);
  return launchNative('/bin/sh',[ws.write('install.sh',bootstrapScript(identity,'sh'))],ws,{PATH:bin+':'+(process.env['PATH']??'/usr/bin:/bin')});
}
