// Supports: SPEC-CMD-091 CA-01, SPEC-MOD-015 (real temporary commits, exact index/worktree/untracked restoration).
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startChild } from "../platform/process";
import type { Child } from "../platform/process";
import type { SandboxLaunch } from "../platform/sandbox-kernel";
import { containsSecret } from "../shared/secrets";
import { handoffBranch, handoffRepository, handoffState, type HandoffState } from "./handoff-state";
import { tryFileLock } from "../platform/file-lock";
import { ordinaryPrivateFile } from "../shared/private-text";
interface Options { git: string; cwd: string; environment: Readonly<Record<string,string>>; denied?: (path:string)=>boolean; projectDirectory?: string; launch?: (file:string,args:readonly string[],cwd:string,environment:Record<string,string>)=>SandboxLaunch; child?: (child:Child)=>void }
interface Entry { mode: string; oid: string; path: string }
interface ScreenBudget { size: number; digests: Set<string> }
const oid = (s:string) => /^[a-f0-9]{40,64}$/.test(s);
/** The source stash is never dropped. It remains a named recovery ref even after a confirmed transfer. */
export class HandoffGit {
  #backup?: string; #temporary?: string; #release?:()=>void; #original?: {repository:string;branch:string;base:string};
  constructor(readonly options: Options) {}
  get recovery() { return this.#backup; }
  async run(args: string[], signal: AbortSignal, input?: string, extra: Record<string,string> = {}, allowFailure = false): Promise<Buffer> {
    signal.throwIfAborted();
    const out: Buffer[] = []; let size=0, excess=false,timedOut=false;
    const environment: Record<string,string> = {};
    const ordinary=new Set(["PATH","PATHEXT","SYSTEMROOT","WINDIR","TEMP","TMP","HOME","USERPROFILE","LANG","LC_ALL","TERM","SSL_CERT_FILE","SSL_CERT_DIR"]);
    for (const [k,v] of Object.entries(this.options.environment)) if (ordinary.has(k.toUpperCase())) environment[k]=v;
    // A caller may provide a private CA bundle; routing, credentials and executable Git configuration are not inherited.
    if (this.options.environment.GIT_SSL_CAINFO) environment.GIT_SSL_CAINFO=this.options.environment.GIT_SSL_CAINFO;
    const commandArgs=["--no-optional-locks","-c","core.hooksPath=","-c","core.fsmonitor=false","-c","core.attributesFile=","-c","core.autocrlf=false","-c","credential.helper=","-c","protocol.allow=never","-c","protocol.https.allow=always",...args];
    const childEnvironment={...environment,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_ASKPASS:"",GIT_ATTR_NOSYSTEM:"1",GIT_AUTHOR_NAME:"Session transfer",GIT_AUTHOR_EMAIL:"transfer@localhost",GIT_COMMITTER_NAME:"Session transfer",GIT_COMMITTER_EMAIL:"transfer@localhost",...extra};
    const launch=this.options.launch?.(this.options.git,commandArgs,this.options.cwd,childEnvironment);
    let child:Child;
    try { child = startChild(launch?.file??this.options.git,launch?.args??commandArgs,{
      cwd:this.options.cwd, env:launch?.environment??childEnvironment,extraFds:launch?.fds,input,
      onData: chunk=>{if((size+=chunk.length)>32*1024*1024){excess=true;void child.killTree(0);}else out.push(chunk);},onErrorData:()=>{}
    }); } catch(error) {launch?.close();throw error;}
    try {launch?.spawned();this.options.child?.(child);}catch(error){await child.killTree(0);await child.exited;launch?.close();throw error;}
    const stop=()=>{void child.killTree(0);};signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();const timer=setTimeout(()=>{timedOut=true;stop();},30000);
    try { const code=await child.exited; signal.throwIfAborted(); if(excess||timedOut||code!==0&&!allowFailure)throw Error("Opération Git de transfert refusée ou interrompue ("+args[0]+").");return Buffer.concat(out); }
    finally {clearTimeout(timer);signal.removeEventListener("abort",stop);launch?.close();}
  }
  async #text(args:string[],signal:AbortSignal,input?:string,extra?:Record<string,string>,allow=false) { return (await this.run(args,signal,input,extra,allow)).toString("utf8").trim(); }
  async #unsafeConfiguration(signal:AbortSignal) { return this.#text(["config","--local","--get-regexp","^(include|url\\.|filter\\.|core\\.(fsmonitor|sshCommand)|http\\.|credential\\.|remote\\..*\\.proxy)"],signal,undefined,undefined,true); }
  async inspect(signal:AbortSignal) {
    const root=await this.#text(["rev-parse","--show-toplevel"],signal);
    if(realpathSync(root)!==realpathSync(this.options.cwd))throw Error("Lancez /handoff à la racine du dépôt.");
    const unsafe=await this.#unsafeConfiguration(signal);
    if(unsafe)throw Error("Configuration Git exécutable ou routage local personnalisé : transfert automatique refusé.");
    const repository=await this.#text(["config","--get","remote.origin.url"],signal),branch=await this.#text(["symbolic-ref","--short","HEAD"],signal),base=await this.#text(["rev-parse","HEAD"],signal);
    handoffRepository(repository);if(!handoffBranch(branch)||!oid(base))throw Error("Branche Git courante invalide.");
    const advertised=await this.#text(["ls-remote","--heads",repository,"refs/heads/"+branch],signal);
    if(advertised.split(/\s/)[0]!==base)throw Error("La branche de base doit déjà être publiée à l’identique ; aucun commit local non publié n’est envoyé.");
    if((await this.#text(["ls-files","--unmerged"],signal)))throw Error("Conflits Git non résolus : transfert refusé.");
    const flags=await this.#text(["ls-files","--debug"],signal);
    if([...flags.matchAll(/flags: ([a-f0-9]+)/g)].some(match=>match[1]!=="0"))throw Error("Index Git spécial (sparse, assume-unchanged ou intent-to-add) : transfert refusé.");
    const paths=await this.run(["ls-files","-z","--cached","--others","--exclude-standard"],signal);
    if(!Buffer.from(paths.toString("utf8")).equals(paths))throw Error("Chemins non UTF-8 refusés.");
    const names=[...new Set(paths.toString().split("\0").filter(Boolean))];if(names.length>5000)throw Error("Trop de fichiers pour le transfert.");
    for(const name of names){
      this.#path(name);const file=resolve(this.options.cwd,name);
      if(this.options.denied?.(file))throw Error("Lecture d’un fichier refusée par les permissions ordinaires.");
      let missing=false;
      for(let parent=dirname(file);parent!==resolve(this.options.cwd);parent=dirname(parent)){try{const stat=lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("Dossier lié ou spécial refusé.");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;missing=true;break;}if(dirname(parent)===parent)throw Error("Chemin hors dépôt.");}
      if(missing)continue;
      try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error("Fichier lié, spécial ou partagé refusé.");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    this.#original={repository,branch,base};
    const dirty=!!(await this.#text(["status","--porcelain=v1","--untracked-files=all"],signal));
    return {...this.#original,dirty};
  }
  #path(path:string) {
    if(!path||path.length>1024||path.includes("\\")||path.startsWith("/")||/[\x00-\x1f\x7f:]/.test(path)||path.split("/").some(p=>!p||p==="."||p===".."||p.toLowerCase()===".git"||p===this.options.projectDirectory||/^(?:\.env.*|\.ssh|\.npmrc|\.netrc|\.gitmodules|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(p)))throw Error("Chemin exclu ou dangereux dans le dépôt ; transfert refusé.");
  }
  async #tree(commit:string,signal:AbortSignal):Promise<Entry[]> {
    if(!oid(commit))throw Error("Objet Git invalide.");
    const bytes=await this.run(["ls-tree","-rz",commit],signal),result:Entry[]=[];
    if(!Buffer.from(bytes.toString("utf8")).equals(bytes))throw Error("Noms Git non UTF-8 : transfert refusé.");
    for(const record of bytes.toString().split("\0").filter(Boolean)){
      const m=/^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);if(!m)throw Error("Liens, sous-modules ou fichiers spéciaux : transfert refusé.");
      this.#path(m[3]!);result.push({mode:m[1]!,oid:m[2]!,path:m[3]!});
    }
    if(result.length>5000)throw Error("Trop de fichiers pour le transfert.");return result;
  }
  #content(bytes:Buffer,budget:ScreenBudget) {
    if(bytes.length>2*1024*1024)throw Error("Contenu de transfert trop volumineux.");
    const digest=createHash("sha256").update(bytes).digest("hex");if(budget.digests.has(digest))return;
    if((budget.size+=bytes.length)>16*1024*1024)throw Error("Contenu de transfert trop volumineux.");
    const text=bytes.toString("utf8");if(bytes.includes(0)||!Buffer.from(text).equals(bytes)||containsSecret(text))throw Error("Contenu binaire ou sensible : transfert refusé.");
    budget.digests.add(digest);
  }
  async #screen(base:Entry[],trees:Entry[][],signal:AbortSignal,budget:ScreenBudget={size:0,digests:new Set()}) {
    const known=new Map(base.map(e=>[e.path,e]));const checked=new Set<string>();
    for(const tree of trees)for(const entry of tree){
      const old=known.get(entry.path);if(old?.oid===entry.oid&&old.mode===entry.mode)continue;
      if(this.options.denied?.(resolve(this.options.cwd,entry.path)))throw Error("Lecture d’un fichier refusée par les permissions ordinaires.");
      const ignored=await this.#text(["check-ignore","--no-index","--",entry.path],signal,undefined,undefined,true);if(ignored)throw Error("Fichier exclu des envois : transfert refusé.");
      if(checked.has(entry.oid))continue;checked.add(entry.oid);
      const size=Number(await this.#text(["cat-file","-s",entry.oid],signal));if(!Number.isSafeInteger(size)||size<0||size>2*1024*1024)throw Error("Contenu de transfert trop volumineux.");
      this.#content(await this.run(["cat-file","blob",entry.oid],signal),budget);
    }
  }
  async #preflight(base:string,signal:AbortSignal) {
    // Read existing index objects and ordinary files before stash can persist their bytes in the object database.
    const baseTree=await this.#tree(base,signal),stages=await this.run(["ls-files","--stage","-z"],signal),index:Entry[]=[];
    if(!Buffer.from(stages.toString("utf8")).equals(stages))throw Error("Chemins non UTF-8 refusés.");
    for(const record of stages.toString().split("\0").filter(Boolean)){
      const match=/^(100644|100755) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(record);if(!match)throw Error("Index spécial ou lié : transfert refusé.");
      this.#path(match[3]!);index.push({mode:match[1]!,oid:match[2]!,path:match[3]!});
    }
    if(index.length>5000)throw Error("Trop de fichiers pour le transfert.");
    const budget:ScreenBudget={size:0,digests:new Set()};await this.#screen(baseTree,[index],signal,budget);
    const changed=await this.run(["diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",base,"--"],signal),others=await this.run(["ls-files","--others","--exclude-standard","-z"],signal);
    const names=new Set<string>();for(const bytes of [changed,others]){if(!Buffer.from(bytes.toString("utf8")).equals(bytes))throw Error("Chemins non UTF-8 refusés.");for(const name of bytes.toString().split("\0").filter(Boolean))names.add(name);}
    if(names.size>5000)throw Error("Trop de fichiers pour le transfert.");
    for(const name of names){
      signal.throwIfAborted();this.#path(name);const file=resolve(this.options.cwd,name);
      if(this.options.denied?.(file))throw Error("Lecture d’un fichier refusée par les permissions ordinaires.");
      if(await this.#text(["check-ignore","--no-index","--",name],signal,undefined,undefined,true))throw Error("Fichier exclu des envois : transfert refusé.");
      try{lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
      ordinaryPrivateFile(file,2*1024*1024);
      const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      try{
        const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>2*1024*1024)throw Error("Fichier lié, spécial ou volumineux : transfert refusé.");
        const bytes=Buffer.alloc(stat.size);let offset=0;
        while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error("Fichier modifié pendant le précontrôle.");offset+=count;}
        const after=fstatSync(fd),named=lstatSync(file);ordinaryPrivateFile(file,2*1024*1024);
        if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||named.dev!==stat.dev||named.ino!==stat.ino||this.options.denied?.(file))throw Error("Fichier modifié ou lecture révoquée pendant le précontrôle.");
        this.#content(bytes,budget);
      }finally{closeSync(fd);}
    }
  }
  async capture(signal:AbortSignal):Promise<HandoffState> {
    const original=this.#original;if(!original)throw Error("Précontrôle Git requis.");
    const current=await this.inspect(signal);
    if(current.repository!==original.repository||current.base!==original.base||current.branch!==original.branch)throw Error("Dépôt ou branche modifiés pendant le consentement.");
    await this.#preflight(original.base,signal);
    const id=randomUUID(),ref="refs/session-handoff/"+id;
    const gitDirectory=await this.#text(["rev-parse","--absolute-git-dir"],signal);this.#temporary=mkdtempSync(join(gitDirectory,"handoff-"));
    this.#release=tryFileLock(join(gitDirectory,"handoff.lock"));if(!this.#release)throw Error("Un autre transfert possède déjà ce dépôt.");
    let work=original.base,index=original.base,untracked:Entry[]=[];
    if(await this.#text(["status","--porcelain=v1","--untracked-files=all"],signal)){
      // Git keeps its own recovery ref even if the process dies before our additional ref is installed.
      const previous=await this.#text(["rev-parse","--verify","refs/stash"],signal,undefined,undefined,true);
      try { await this.#text(["stash","push","--include-untracked","--message","handoff-"+id],signal); }
      finally {
        const cleanup=AbortSignal.timeout(10000),saved=await this.#text(["rev-parse","--verify","refs/stash"],cleanup,undefined,undefined,true);
        if(oid(saved)&&saved!==previous&&(await this.#text(["show","-s","--format=%s",saved],cleanup)).endsWith(": handoff-"+id)){this.#backup=saved;await this.#text(["update-ref",ref,saved],cleanup);this.#backup=ref;}
      }
      if(!this.#backup)throw Error("Sauvegarde Git absente.");
      const stash=await this.#text(["rev-parse",this.#backup],signal);
      if(await this.#text(["rev-parse",stash+"^1"],signal)!==original.base)throw Error("Branche modifiée pendant la sauvegarde.");
      work=stash;index=await this.#text(["rev-parse",stash+"^2"],signal);
      const third=await this.#text(["rev-parse","--verify",stash+"^3"],signal,undefined,undefined,true);if(oid(third))untracked=await this.#tree(third,signal);
    }
    const baseTree=await this.#tree(original.base,signal),indexTree=await this.#tree(index,signal),workTree=await this.#tree(work,signal);
    await this.#screen(baseTree,[indexTree,workTree,untracked],signal);
    const environment={GIT_INDEX_FILE:join(this.#temporary,"index")};
    await this.#text(["read-tree",work],signal,undefined,environment);
    if(untracked.length)await this.#text(["update-index","-z","--index-info"],signal,untracked.map(e=>`${e.mode} ${e.oid}\t${e.path}\0`).join(""),environment);
    const tree=await this.#text(["write-tree"],signal,undefined,environment),indexRoot=await this.#text(["rev-parse",index+"^{tree}"],signal);
    const staged=await this.#text(["commit-tree",indexRoot,"-p",original.base,"-m","Session transfer index"],signal);
    const snapshot=await this.#text(["commit-tree",tree,"-p",original.base,"-p",staged,"-m","Session transfer working tree"],signal);
    const transferBranch="handoff/"+id;await this.#text(["update-ref","refs/heads/"+transferBranch,snapshot],signal);
    return handoffState({version:1,...original,index:staged,snapshot,transferBranch});
  }
  async publish(state:HandoffState,signal:AbortSignal) {
    await this.#text(["push","--porcelain","--no-verify",state.repository,"refs/heads/"+state.transferBranch+":refs/heads/"+state.transferBranch],signal);
  }
  async recover(signal:AbortSignal) {
    if(!this.#backup)return;
    const original=this.#original,repository=await this.#text(["config","--get","remote.origin.url"],signal),branch=await this.#text(["symbolic-ref","--short","HEAD"],signal,undefined,undefined,true),base=await this.#text(["rev-parse","HEAD"],signal);
    if(!original||handoffRepository(repository)!==handoffRepository(original.repository)||branch!==original.branch||base!==original.base||await this.#unsafeConfiguration(signal))throw Error("Dépôt, branche, révision ou configuration modifiés ; sauvegarde conservée dans "+this.#backup+". Restauration manuelle requise, aucun reset forcé.");
    if(await this.#text(["status","--porcelain=v1","--untracked-files=all"],signal))throw Error("Le dépôt a changé ; sauvegarde conservée dans "+this.#backup+". Restauration manuelle requise, aucun reset forcé.");
    await this.#text(["stash","apply","--index",this.#backup],signal);
  }
  async restore(raw:HandoffState,signal:AbortSignal) {
    const state=handoffState(raw),url=await this.#text(["config","--get","remote.origin.url"],signal);
    if(handoffRepository(url)!==handoffRepository(state.repository))throw Error("Dépôt différent : restauration de transfert refusée.");
    if(await this.#text(["rev-parse","HEAD"],signal)!==state.snapshot||await this.#text(["status","--porcelain=v1","--untracked-files=all"],signal))throw Error("Destination modifiée : restauration refusée.");
    const parents=(await this.#text(["cat-file","commit",state.snapshot],signal)).split("\n\n")[0]!.split("\n").filter(line=>line.startsWith("parent ")).map(line=>line.slice(7));
    if(parents.length!==2||parents[0]!==state.base||parents[1]!==state.index)throw Error("Parents du snapshot incohérents.");
    const base=await this.#tree(state.base,signal),staged=await this.#tree(state.index,signal),work=await this.#tree(state.snapshot,signal);await this.#screen(base,[staged,work],signal);
    const existing=await this.#text(["show-ref","--hash","--verify","refs/heads/"+state.branch],signal,undefined,undefined,true);if(existing&&existing!==state.base)throw Error("Branche de destination divergente.");
    await this.#text(["update-ref","refs/heads/"+state.branch,state.base],signal);
    await this.#text(["symbolic-ref","HEAD","refs/heads/"+state.branch],signal);
    await this.#text(["read-tree",state.index],signal);
    // The worktree is deliberately untouched: snapshot-only files become untracked; staged/unstaged deltas are exact.
    if(await this.#text(["rev-parse","HEAD"],signal)!==state.base||await this.#text(["write-tree"],signal)!==await this.#text(["rev-parse",state.index+"^{tree}"],signal))throw Error("État Git restauré non confirmé.");
  }
  close() { this.#release?.();this.#release=undefined;if(this.#temporary&&existsSync(this.#temporary)&&lstatSync(this.#temporary).isDirectory())rmSync(this.#temporary,{recursive:true}); }
}
