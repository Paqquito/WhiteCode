// Implements: SPEC-MOD-014 (bounded SSE fallback, incomplete-event replay and cursor validation).
// Supports: gap E-176.
export async function* remoteEvents(response:Response,signal:AbortSignal):AsyncGenerator<unknown>{
 if(!response.ok||!response.body||!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")){await response.body?.cancel();throw new Error("Flux distant indisponible.");}
 const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});let buffer="",data:string[]=[],id:string|undefined,size=0;const abort=()=>{void reader.cancel();};signal.addEventListener("abort",abort,{once:true});
 try{for(;;){signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();buffer+=chunk.done?decoder.decode():decoder.decode(chunk.value,{stream:true});if(Buffer.byteLength(buffer)>262144)throw new Error("Trame distante trop volumineuse.");
   for(;;){const match=/\r\n|\r|\n/.exec(buffer);if(!match||!chunk.done&&match.index===buffer.length-1&&match[0]==="\r")break;const line=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);size+=Buffer.byteLength(line)+1;if(size>131072)throw new Error("Événement distant trop volumineux.");
    if(!line){if(data.length){const raw:unknown=JSON.parse(data.join("\n"));if(id!==undefined&&(!raw||typeof raw!=="object"||String((raw as{seq?:unknown}).seq)!==id))throw new Error("Curseur distant incohérent.");yield raw;}data=[];id=undefined;size=0;continue;}
    const at=line.indexOf(":"),field=at<0?line:line.slice(0,at),value=at<0?"":line.slice(at+1).replace(/^ /,"");if(field==="data")data.push(value);if(field==="id"){if(!/^\d{1,16}$/.test(value))throw new Error("Curseur distant invalide.");id=value;}
   }if(chunk.done){if(data.length||buffer.trim())throw new Error("Événement distant incomplet ; reprise requise.");return;}
  }}finally{signal.removeEventListener("abort",abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
