// Implements: SPEC-CFG-006 (explicit user preferences, conflict and exact restoration).
// Supports: gap E-173 (versioned settings service contract and conservative preference allowlist).
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import type { CompanyAccount } from "../auth/company-account";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { containsSecret } from "../shared/secrets";
import { tryFileLock } from "../platform/file-lock";
import { currentPlatform } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import { SETTING_BY_KEY } from "./settings-schema";
import { validateSettingValue } from "./settings";
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function document(text:string):Record<string,unknown>{const errors:ParseError[]=[];const raw:unknown=parse(text,errors,{allowTrailingComma:true});if(errors.length||!object(raw))throw new Error("Paramètres illisibles : synchronisation refusée.");return raw;}
export class SettingsSync {
  constructor(readonly options:{account:{request:CompanyAccount["request"];profile():Promise<{account:string;organization:{id:string}}|undefined>};file:string;include:readonly string[];redact:(text:string)=>string}){}
  #read():string{ordinaryPrivateFile(this.options.file,1048576);return existsSync(this.options.file)?readPrivateText(this.options.file,1048576):"{}\n";}
  #safe(key:string,value:unknown):boolean { const def=SETTING_BY_KEY.get(key);const text=JSON.stringify(value);return !!def&&def.scopes.includes("user")&&!def.secret&&(/^(ui\.|models\.selected$|context\.language$)/.test(key))&&!/(command|token|secret|credential|header)/i.test(key)&&validateSettingValue(key,value)===undefined&&!containsSecret(text)&&this.options.redact(text)===text; }
  #selected(raw:Record<string,unknown>):Record<string,unknown>{const result:Record<string,unknown>={};for(const key of this.options.include){let value:unknown=raw;for(const part of key.split("."))value=object(value)?value[part]:undefined;if(value!==undefined&&this.#safe(key,value))result[key]=value;}return result;}
  #snapshot(raw:unknown):{revision:string;values:Record<string,unknown>}{if(!object(raw)||typeof raw.revision!=="string"||!/^[a-zA-Z0-9._-]{1,128}$/.test(raw.revision)||!object(raw.values)||Object.keys(raw.values).length>128)throw new Error("Instantané distant invalide.");return {revision:raw.revision,values:raw.values};}
  async #locked<T>(action:(identity:{account:string;organizationId:string})=>Promise<T>):Promise<T>{mkdirSync(dirname(this.options.file),{recursive:true});const release=tryFileLock(this.options.file+".sync-lock");if(!release)throw new Error("Synchronisation déjà en cours.");try{const profile=await this.options.account.profile();if(!profile)throw new Error("Connectez-vous pour synchroniser vos paramètres.");return await action({account:profile.account,organizationId:profile.organization.id});}finally{release();}}
  #known(identity:{account:string;organizationId:string}):string{const path=this.options.file+".sync-state.json";if(!existsSync(path))return "0";const raw:unknown=JSON.parse(readPrivateText(path,32768));return object(raw)&&raw.account===identity.account&&raw.organizationId===identity.organizationId?this.#snapshot(raw).revision:"0";}
  #remember(revision:string,identity:{account:string;organizationId:string}):void{const path=this.options.file+".sync-state.json";ordinaryPrivateFile(path,32768);writeAtomic(path,Buffer.from(JSON.stringify({revision,values:{},...identity})),currentPlatform(),true);}
  async push(signal:AbortSignal,resolution?:"local"|"remote"|"diff"):Promise<string>{return this.#locked(async(identity)=>{const local=this.#selected(document(this.#read())),remote=this.#snapshot(await this.options.account.request("settings","snapshot",undefined,signal,identity));
    if(remote.revision!==this.#known(identity)&&resolution!=="local")throw new Error(`Conflit de paramètres : garder le local (--resolve local), garder le distant (config pull), ou voir les différences (--resolve diff).${resolution==="diff"?"\n"+JSON.stringify({local,remote:Object.fromEntries(Object.entries(remote.values).filter(([key,value])=>this.#safe(key,value)))},null,2):""}`);
    const result=await this.options.account.request("settings","snapshot",{baseRevision:remote.revision,values:local},signal,identity);if(object(result)&&result.conflict===true)throw new Error("Conflit de paramètres : garder le local, garder le distant ou voir les différences.");const saved=this.#snapshot(result);this.#remember(saved.revision,identity);return saved.revision;});}
  async pull(signal:AbortSignal,beforePublish?:()=>void):Promise<string>{return this.#locked(async(identity)=>{const original=this.#read();let next=original;const remote=this.#snapshot(await this.options.account.request("settings","snapshot",undefined,signal,identity));for(const [key,value]of Object.entries(remote.values))if(this.options.include.includes(key)&&this.#safe(key,value))next=applyEdits(next,modify(next,key.split("."),value,{formattingOptions:{insertSpaces:true,tabSize:2,eol:original.includes("\r\n")?"\r\n":"\n"}}));document(next);beforePublish?.();if(this.#read()!==original)throw new Error("Paramètres modifiés pendant la récupération ; état humain conservé.");
    const backup=this.options.file+".sync-backup-"+randomUUID();ordinaryPrivateFile(backup,1048576);writeAtomic(backup,Buffer.from(original),currentPlatform(),true);if(readPrivateText(backup,1048576)!==original)throw new Error("Sauvegarde non vérifiée.");writeAtomic(this.options.file,Buffer.from(next),currentPlatform(),true);this.#remember(remote.revision,identity);return backup;});}
  restore(backup:string):void{if(!backup.startsWith(this.options.file+".sync-backup-")||!/^[a-f0-9-]{36}$/.test(backup.slice((this.options.file+".sync-backup-").length)))throw new Error("Sauvegarde étrangère à ces paramètres.");const text=readPrivateText(backup,1048576);document(text);ordinaryPrivateFile(this.options.file,1048576);writeAtomic(this.options.file,Buffer.from(text),currentPlatform(),true);}
}
