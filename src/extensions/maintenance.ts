// Implements: SPEC-EXT-006 CA-01/02 (background checks, immutable versions, fresh executable consent).
// Supports: gap E-178. Downloads run in a separate distribution process, never on the interactive event loop.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryFileLock } from "../platform/file-lock";
import { startChild, type Child } from "../platform/process";
import { productProcess } from "../platform/product-process";
import { listInstalled } from "./store";
export class ExtensionMaintenance {
  #child?:Child; #closed=false; #release?:()=>void; #job?:Promise<void>;readonly #controller=new AbortController();
  constructor(readonly o:{configDir:string;cwd:string;env:Readonly<Record<string,string>>;mode:"off"|"notify"|"auto";intervalMs:number;report:(text:string)=>void;confirm:(question:string,signal:AbortSignal)=>Promise<boolean>}){}
  start():void { if(this.#closed||this.#job||this.o.mode==="off"||!listInstalled(this.o.configDir).length)return;this.#job=this.#run().catch(()=>this.o.report("Vérification des extensions indisponible ; nouvel essai au prochain intervalle.")); }
  async #run():Promise<void>{
    mkdirSync(this.o.configDir,{recursive:true});this.#release=tryFileLock(join(this.o.configDir,"extensions-maintenance.lock"));if(!this.#release)return;
    try{
      const state=join(this.o.configDir,"extensions-maintenance.json");
      if(existsSync(state)){const stat=lstatSync(state);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw Error("État non ordinaire.");try{const time=JSON.parse(readFileSync(state,"utf8")).checkedAt;if(typeof time==="number"&&time<=Date.now()&&Date.now()-time<this.o.intervalMs)return;}catch(error){if(error instanceof SyntaxError){}else throw error;}}
      writeFileSync(state,JSON.stringify({checkedAt:Date.now()}),{mode:0o600});
      const command=productProcess(["extension","update",this.o.mode==="auto"?"--auto":"--notify-only",...(this.o.mode==="auto"?["--approval-pipe"]:[])]);
      let buffer="",pending=Promise.resolve();
      const line=(value:string)=>{if(this.#closed)return;try{const event=JSON.parse(value);if(event.type==="notice"&&typeof event.message==="string")this.o.report(event.message.slice(0,16384));else if(event.type==="approval"&&Number.isSafeInteger(event.id)&&typeof event.question==="string")pending=pending.then(async()=>{const accepted=!this.#closed&&await this.o.confirm(event.question.slice(0,1024),this.#controller.signal);if(!this.#closed)this.#child?.input?.write(JSON.stringify({id:event.id,accepted})+"\n");}).catch(()=>this.#child?.input?.write(JSON.stringify({id:event.id,accepted:false})+"\n"));}catch{this.o.report(value.slice(0,16384));}};
      this.#child=startChild(command.file,command.args,{cwd:this.o.cwd,env:{...this.o.env,GIT_TERMINAL_PROMPT:"0"},keepInputOpen:true,onData:chunk=>{buffer+=chunk.toString("utf8");if(buffer.length>131072){void this.#child?.killTree(100);buffer="";return;}let end;while((end=buffer.indexOf("\n"))>=0){line(buffer.slice(0,end));buffer=buffer.slice(end+1);}},onErrorData:()=>{}});
      const code=await this.#child.exited;await pending;if(!this.#closed&&code===0)writeFileSync(state,JSON.stringify({checkedAt:Date.now()}),{mode:0o600});
    }finally{this.#release?.();this.#release=undefined;}
  }
  async close():Promise<void>{this.#closed=true;this.#controller.abort();this.#child?.input?.end();await this.#child?.killTree(100);await this.#job;}
}
