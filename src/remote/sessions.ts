// Implements: SPEC-MOD-014 (creation, early link, resumable event consumption), SPEC-API-029 (client secret boundary and cost request).
// Supports: gap E-176 (delegated-key checks and versioned service contracts).
import{randomUUID}from"node:crypto";import type{CompanyAccount}from"../auth/company-account";
interface RemoteAccount{profile:CompanyAccount["profile"];request:CompanyAccount["request"];events:CompanyAccount["events"]}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value),positive=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>0;
export interface RemoteSessionInput{readonly repository:string;readonly branch:string;readonly commit:string;readonly prompt:string;readonly environment?:string;readonly maxCost?:number;readonly managedMaxCost?:number;readonly maxDurationSeconds?:number}
export class RemoteSessions {
 #owner:{organizationId:string;account:string}|undefined;
 constructor(readonly options:{account:RemoteAccount;consoleUrl?:string;sessionUrl:string;report:(text:string)=>void;event:(event:{seq:number;type:string;text?:string})=>void;retryDelayMs?:number}){}
 async create(input:RemoteSessionInput,signal:AbortSignal):Promise<{id:string;url:string;effectiveMaxCost?:number}>{
  signal.throwIfAborted();const profile=await this.options.account.profile();if(!profile)throw new Error("Connectez un compte de la société pour les sessions distantes.");const identity={organizationId:profile.organization.id,account:profile.account};
  if(!input.prompt.trim()||input.prompt.length>32000||!input.repository||input.repository.length>4096||!input.branch||input.branch.length>240||!/^[a-f0-9]{40,64}$/.test(input.commit)||input.environment!==undefined&&!/^[a-zA-Z0-9_-]{1,128}$/.test(input.environment)||input.maxCost!==undefined&&!positive(input.maxCost))throw new Error("Demande de session distante invalide.");
  const status=await this.options.account.request("sessions","key-status",{repository:input.repository},signal,identity);
  if(!object(status)||status.delegatedKey!==true){const link=this.options.consoleUrl?` Console : ${this.options.consoleUrl}`:"";throw new Error("ERR-01 — Aucune clé de fournisseur n’est confiée au service : déposez-en une dans la console."+link);}
  if(status.repositoryAccessible!==true)throw new Error("Dépôt non accessible au service. Configurez son accès depuis la console.");
  for(const name of["managedLimit","keyLimit"])if(status[name]!==undefined&&!positive(status[name]))throw new Error("Limites distantes invalides.");
  if(input.managedMaxCost!==undefined&&!positive(input.managedMaxCost))throw new Error("Plafond géré invalide.");
  const caps=[input.maxCost,input.managedMaxCost,status.managedLimit,status.keyLimit].filter(positive),expected=caps.length?Math.min(...caps):undefined;
  const body={idempotencyKey:randomUUID(),repository:input.repository,branch:input.branch,commit:input.commit,prompt:input.prompt,...(input.environment?{environment:input.environment}:{}),...(input.maxCost!==undefined?{maxCost:input.maxCost}:{}),...(input.managedMaxCost!==undefined?{clientMaxCost:input.managedMaxCost}:{}),...(input.maxDurationSeconds!==undefined?{maxDurationSeconds:input.maxDurationSeconds}:{})};
  const raw=await this.options.account.request("sessions","create",body,signal,identity);if(!object(raw)||typeof raw.id!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id)||typeof raw.url!=="string")throw new Error("Création distante invalide.");
  const base=new URL(this.options.sessionUrl),url=new URL(raw.url);if(url.protocol!=="https:"||url.origin!==base.origin||url.username||url.password||url.hash)throw new Error("Lien distant hors service autorisé.");
  if(expected!==undefined&&(!positive(raw.effectiveMaxCost)||Math.abs(raw.effectiveMaxCost-expected)>1e-9)){try{await this.options.account.request("sessions",`${raw.id}/stop`,{},AbortSignal.timeout(5000),identity);}catch{}throw new Error("Plafond distant incohérent : arrêt demandé avant poursuite.");}
  this.options.report(`Session distante ${raw.id} : ${url.href}${expected!==undefined?` · plafond effectif ${expected}`:""}`);
  this.#owner=identity;
  return{id:raw.id,url:url.href,...(expected!==undefined?{effectiveMaxCost:expected}:{})};
 }
 async follow(id:string,signal:AbortSignal):Promise<"completed"|"failed"|"stopped">{if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error("Identifiant distant invalide.");let after=0,failures=0;
  for(;;){signal.throwIfAborted();try{for await(const raw of this.options.account.events(`${id}/events`,after,signal,this.#owner)){signal.throwIfAborted();if(!object(raw)||!Number.isSafeInteger(raw.seq)||Number(raw.seq)<1||typeof raw.type!=="string"||!["queued","started","progress","permission","completed","failed","stopped"].includes(raw.type)||raw.text!==undefined&&(typeof raw.text!=="string"||raw.text.length>32000))throw new Error("Événement distant invalide.");const seq=Number(raw.seq);if(seq<=after)continue;if(seq!==after+1)throw new Error("Trou dans le flux distant.");after=seq;failures=0;this.options.event({seq,type:raw.type,...(typeof raw.text==="string"?{text:raw.text}:{})});if(["completed","failed","stopped"].includes(raw.type))return raw.type as "completed"|"failed"|"stopped";}}
    catch{signal.throwIfAborted();}if(++failures>5)throw new Error("Flux distant interrompu ; reprenez la session depuis son lien.");await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},this.options.retryDelayMs??500);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
  }
 }
}
