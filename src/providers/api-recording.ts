// Implements: SPEC-OBS-018 (request fingerprint, stream-preserving record/replay, explicit misses).
// Supports: SPEC-API-002, SPEC-BLD-007, E-157.
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest } from './types';
import { writeAtomic } from '../tools/text-file';
import { currentPlatform } from '../platform/system';
import { maskSecrets } from '../shared/secrets';

export type RecordingMode='record'|'replay'|'auto';
const LIMIT=32*1024*1024;
export function requestFingerprint(request:ModelRequest): string {
  const ids=new Map<string,number>();const id=(value:string)=>{if(!ids.has(value))ids.set(value,ids.size+1);return ids.get(value)!;};
  const native=(value:unknown):unknown=>Array.isArray(value)?value.map(native):value && typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!['id','created','timestamp','request_id','signature'].includes(k)).map(([k,v])=>[k,k==='input'?v:native(v)])):value;
  const history=request.history.map(m=>m.role==='assistant'?{...m,toolCalls:m.toolCalls.map(c=>({...c,callId:id(c.callId)})),native:{provider:m.native.provider,content:native(m.native.content)}}:m.role==='user'?{...m,parts:m.parts.map(p=>p.type==='tool_result'?{...p,callId:id(p.callId)}:p)}:m);
  const value={model:request.model.id,system:request.system.map(b=>({text:b.text})),tools:request.tools,history,maxOutputTokens:request.maxOutputTokens,thinking:request.thinking,effort:request.effort,contextEditing:request.contextEditing};
  const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v && typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([k,item])=>[k,stable(item)])):v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function ordinaryDirectory(path:string,create:boolean):void {
  const missing:string[]=[];for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Le dossier de références doit être ordinaire, sans lien.');}else missing.push(p);if(p===dirname(p))break;}
  if(create) for(const p of missing.reverse()){try{mkdirSync(p,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Dossier concurrent non ordinaire.');}}
}
function scrub(value:unknown,secrets:readonly string[],depth=0):unknown {
  if(depth>64)throw new Error('Référence API trop profonde.');
  if(typeof value==='string'){let text=maskSecrets(value);for(const secret of secrets.filter(s=>s.length>0))text=text.split(secret).join('[redacted]');return text;}
  if(Array.isArray(value))return value.map(v=>scrub(v,secrets,depth+1));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[scrub(k,secrets,depth+1) as string,/authorization|api[_-]?key|password|secret|(?:^|_)token$/i.test(k)?'[redacted]':scrub(v,secrets,depth+1)]));return value;
}
export function withApiRecording(provider:ModelProvider,o:{mode?:RecordingMode;directory:string;secrets:readonly string[]}):ModelProvider {
  if(!o.mode)return provider;
  return {id:provider.id,async *stream(request,signal){
    signal.throwIfAborted();ordinaryDirectory(o.directory,o.mode!=='replay');const key=requestFingerprint(request),file=join(o.directory,key+'.json');
    if(o.mode==='replay'||o.mode==='auto'&&existsSync(file)) {
      if(!existsSync(file))throw new Error(`Aucune réponse enregistrée pour cette requête (clé ${key}).`);
      const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>LIMIT)throw new Error('Référence API non ordinaire ou trop volumineuse.');
      const saved=readReference(file);
      if(!object(saved)||saved.version!==1||saved.key!==key||!Array.isArray(saved.events)||saved.events.length>100000||saved.events.some(e=>!validEvent(e)))throw new Error('Référence API invalide.');
      const events=scrub(saved.events,o.secrets) as ModelEvent[];
      for(const event of events){signal.throwIfAborted();yield event;}return;
    }
    const events:ModelEvent[]=[];let size=0;
    for await(const event of provider.stream(request,signal)){const safe=scrub(event,o.secrets) as ModelEvent;size+=Buffer.byteLength(JSON.stringify(safe));if(size>LIMIT||events.length>=100000)throw new Error('Référence API trop volumineuse ; enregistrement arrêté.');events.push(safe);yield event;}
    signal.throwIfAborted();const bytes=Buffer.from(JSON.stringify({version:1,key,events}));if(bytes.length>LIMIT)throw new Error('Référence API trop volumineuse.');writeAtomic(file,bytes,currentPlatform(),true);
  }};
}

const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
function readReference(file:string):unknown {
  const before=lstatSync(file),fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>LIMIT||stat.dev!==before.dev||stat.ino!==before.ino)throw new Error('Référence API remplacée pendant la lecture.');
    const bytes=Buffer.alloc(stat.size+1);let n=0;
    while(n<bytes.length){const count=readSync(fd,bytes,n,bytes.length-n,null);if(!count)break;n+=count;}
    if(n>stat.size)throw new Error('Référence API modifiée pendant la lecture.');
    return JSON.parse(bytes.subarray(0,n).toString('utf8'));
  } finally {closeSync(fd);}
}
function validEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (e.type === "text_delta" || e.type === "thinking_delta") return typeof e.text === "string";
  const call = (v: unknown) => object(v) && typeof v.callId === "string" && typeof v.name === "string" && Object.hasOwn(v, "input");
  if (e.type === "tool_call") return call(e.call);
  if (e.type !== "message_complete" || !["end_turn","tool_use","max_tokens","refusal","pause_turn","other"].includes(String(e.stopReason))) return false;
  const a = e.assistant as Record<string, unknown> | undefined, u = e.usage as Record<string, unknown> | undefined;
  return !!a && a.role === "assistant" && typeof a.text === "string" && Array.isArray(a.toolCalls) && a.toolCalls.every(call) && object(a.native) && typeof a.native.provider === "string" && !!u && ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"].every(k => typeof u[k] === "number" && Number.isSafeInteger(u[k]) && (u[k] as number) >= 0);
}
