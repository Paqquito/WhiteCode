// Supports: SPEC-INT-011 (correlated late results and client ownership on the real loopback transport).
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {BrowserBridge} from "../src/integrations/browser-bridge";
import {currentPlatform} from "../src/platform/system";
import {installBrowserHost} from "../src/platform/browser-native";
import {residentFetch} from "../src/platform/resident-process";
import {testToolFields,workspace} from "./helpers/env";

test.skipIf(process.platform!=="win32")("TECH — only a valid late response from its original browser client is ignored once after expiry",async()=>{
  const ws=workspace(),extension="a".repeat(32),slug="late-browser-"+crypto.randomUUID(),registration=installBrowserHost(ws.configHome,slug,extension),bridge=new BrowserBridge({configDir:ws.configHome,slug,product:"Late response fixture",extensionId:()=>extension,permitted:()=>true,changed:()=>{}});
  const beats:Promise<unknown>[]=[],heartbeatErrors:unknown[]=[];let pulse:ReturnType<typeof setInterval>|undefined;
  try{
    await bridge.start();const endpoint=JSON.parse(readFileSync(join(ws.configHome,"browser/endpoint.json"),"utf8"));
    const post=(path:string,body:unknown)=>residentFetch(endpoint.port,endpoint.token,path,body,AbortSignal.timeout(5000));
    const first=await(await post("/browser/attach",{browser:"Chrome",extensionId:extension})).json() as {client:string},tool=(await bridge.tool())!;
    const context={...testToolFields(),platform:currentPlatform(),home:ws.home,cwd:ws.project,allowedDirectories:[ws.project],signal:new AbortController().signal,modelImages:true};
    const request=tool.execute({action:"read",tab:1},context);
    let command:{id:string}|undefined;const deadline=Date.now()+6000;
    while(!command){const data=await(await post("/browser/poll",{client:first.client})).json() as {command?:{id:string}};command=data.command;if(Date.now()>deadline)throw Error("Browser command was not dispatched");}
    // Keep the actual native lease alive while this dispatched action reaches its unchanged deadline.
    pulse=setInterval(()=>beats.push(post("/browser/poll",{client:first.client}).then(r=>{if(!r.ok)throw Error("Browser lease pulse failed");return r.body?.cancel();}).catch(error=>{heartbeatErrors.push(error);})),200);
    const expired=await request;clearInterval(pulse);await Promise.all(beats);expect(heartbeatErrors).toEqual([]);expect(expired.isError).toBe(true);
    const other=await(await post("/browser/attach",{browser:"Edge",extensionId:extension})).json() as {client:string};bridge.select(first.client);
    expect((await post("/browser/result",{client:other.client,id:command.id,result:{text:"wrong client"}})).ok).toBe(false);
    expect((await post("/browser/result",{client:first.client,id:command.id,result:12})).ok).toBe(false);
    const late=await post("/browser/result",{client:first.client,id:command.id,result:{text:"late discarded result"}});
    expect(late.status).toBe(200);expect(await late.json()).toMatchObject({received:true,ignored:true});expect(bridge.connected).toBe(true);
    expect((await post("/browser/result",{client:first.client,id:command.id,result:{text:"duplicate"}})).ok).toBe(false);
    expect((await post("/browser/result",{client:first.client,id:crypto.randomUUID(),result:{text:"unknown"}})).ok).toBe(false);
  }finally{clearInterval(pulse);await Promise.all(beats);await bridge.close();registration.removeNewRegistrations();}
},20000);
