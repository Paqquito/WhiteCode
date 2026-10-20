// Test rendezvous: observe an actual native process before testing its output or stop.
import {existsSync} from "node:fs";
import type {ScriptedProvider} from "./scripted-provider";

export async function waitForNativeFile(path:string,signal:AbortSignal):Promise<void>{
  const until=Date.now()+15000;
  while(!existsSync(path)){
    signal.throwIfAborted();
    if(Date.now()>=until)throw Error(`Native process did not reach its rendezvous: ${path}`);
    await new Promise<void>(resolve=>setTimeout(resolve,10));
  }
}

/** The next model request already carries the task id; wait before asking for its native output. */
export function afterNativeStart(provider:ScriptedProvider,path:string):void{
  const stream=provider.stream.bind(provider);
  provider.stream=async function*(request,signal){
    if(provider.requests.length===1)await waitForNativeFile(path,signal);
    yield* stream(request,signal);
  };
}
