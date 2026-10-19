// Supports: SPEC-CMD-108 (verified downloaded-version notification), gap E-160.
// Implements: SPEC-INS-002 (deferred updates), SPEC-INS-003 (package manager advice), SPEC-INS-007 (maintenance idle gate).
// Supports: SPEC-INS-008, SPEC-OBS-015 (bounded network checks without credentials), E-156.
import { existsSync, lstatSync, realpathSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { NativeStore } from "./native-store";
import type { SystemInfo } from "../platform/system";
import type { EnvironmentView } from "../config/environment";
import type { Identity } from "../identity/identity";
import type { Settings } from "../config/settings";
import { comparablePath } from "../platform/system";
import { configuredNetwork } from "../config/network";
import { compareVersions } from "../platform/semver";
import {buildFlag} from "../extension-points/build-flags" with {type:"macro"};

export function nativeTarget(system: SystemInfo): string {
  if (!["windows","macos","linux"].includes(system.platform) || !["x64","arm64"].includes(system.arch)) throw new Error('Plateforme non prise en charge.');
  const libc = system.platform === 'linux' ? buildFlag("libc_variant_musl") ? '-musl' : buildFlag("libc_variant_glibc") ? '-glibc' : existsSync(`/lib/ld-musl-${system.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`) ? '-musl' : '-glibc' : '';
  return `${system.platform}-${system.arch}${libc}`;
}
export type InstallationMethod = 'native' | 'homebrew' | 'npm' | 'winget' | 'source';
export function installationMethod(executable: string, native: NativeStore): InstallationMethod {
  if (native.isNative(executable)) return 'native'; const path = executable.replace(/\\/g,'/').toLowerCase(), slug = native.o.cli.toLowerCase();
  if (path.includes(`/cellar/${slug}/`) || path.includes(`/homebrew/opt/${slug}/`)) return 'homebrew';
  if (path.includes(`/node_modules/${slug}/`) || path.includes(`/node_modules/@${slug}/`)) return 'npm';
  if (path.includes(`/microsoft/winget/packages/${slug}.`) || path.includes(`/winget/packages/${slug}.`)) return 'winget';
  try { const file=join(dirname(executable),'installation-method.json'), s=lstatSync(file); if (s.isFile() && !s.isSymbolicLink() && s.size < 1024) { const m=JSON.parse(readFileSync(file,'utf8')); if (m.package===slug && ['npm','homebrew','winget'].includes(m.method)) return m.method; } } catch {}
  return 'source';
}
export function packageAdvice(method: InstallationMethod, cli: string): string | undefined {
  return method==='homebrew' ? `brew upgrade ${cli}` : method==='npm' ? `npm install --global ${cli}@latest` : method==='winget' ? `winget upgrade --id ${cli}` : undefined;
}
export function multipleInstallations(path: string, cli: string, platform: SystemInfo['platform']): string[] {
  const results = new Map<string,string>();
  for (const directory of path.split(delimiter)) { if (!directory) continue; for (const name of platform==='windows' ? [cli+'.exe',cli+'.cmd'] : [cli]) {
    const file=join(directory,name); try { const real=realpathSync(file); if (lstatSync(real).isFile()) results.set(comparablePath(real,platform),file); } catch {}
  } } return [...results.values()];
}
export function configuredInstallation(o: { identity: Identity; env: EnvironmentView; system: SystemInfo; configDir: string; settings: Settings; signal?: AbortSignal; report: (text: string)=>void; fetch?: typeof fetch }): NativeStore {
  return new NativeStore({ ...(buildFlag("update_prerelease_channel")?{testDistribution:{service:o.env.own("TEST_INSTALL_SERVICE")??"",token:o.env.own("TEST_INSTALL_TOKEN")??""}}:{}),root: join(o.configDir,'installation'), cli: o.identity.get('PRODUCT_CLI'), platform: o.system.platform, target: nativeTarget(o.system), service: o.identity.has('SERVICE_DOWNLOADS') ? o.identity.get('SERVICE_DOWNLOADS') : '', currentVersion: o.identity.version, minimum: o.settings.get<string | undefined>('updates.minimumAllowedVersion'), systemRoot:o.env.public('SystemRoot'), fetch: o.fetch ?? configuredNetwork(o.env), signal: o.signal, report: o.report });
}
export class InstallationMaintenance {
  #timer?: ReturnType<typeof setTimeout>; #running?: Promise<void>; readonly #stop=new AbortController();
  constructor(readonly o: { store: NativeStore; enabled: boolean; channel: string; keep: number; lastInteraction: ()=>number; now?: ()=>number; delayMs?: number; idleMs?: number; intervalMs?: number; report: (text: string)=>void; log: (event: string, count: number)=>void; onUpdated?: (version: string)=>void }) {}
  start(): void { if (this.#timer || this.#running || this.#stop.signal.aborted) return; this.#schedule(this.o.delayMs??30000); }
  #schedule(delay:number): void { this.#timer=setTimeout(()=>{ this.#timer=undefined; this.#running=this.#tick().finally(()=>{ this.#running=undefined; if (!this.#stop.signal.aborted) this.#schedule((this.o.now?.()??Date.now())-this.o.lastInteraction() < (this.o.idleMs??60000) ? this.o.delayMs??30000 : this.o.intervalMs??3600000); }); },delay); this.#timer.unref?.(); }
  async #tick(): Promise<void> {
    const now=this.o.now?.()??Date.now(); if (now-this.o.lastInteraction() < (this.o.idleMs??60000)) { this.o.log('deferred',0); return; }
    const store = new NativeStore({ ...this.o.store.o, signal: AbortSignal.any([this.#stop.signal, ...(this.o.store.o.signal ? [this.o.store.o.signal] : [])]) });
    try { if (this.o.enabled) { const release=await store.release(this.o.channel); if (this.#stop.signal.aborted) return; if (compareVersions(release.version,store.o.currentVersion)>0) { const update=await store.install(release); this.o.onUpdated?.(update.version); this.o.report(`Mise à jour ${update.version} prête pour le prochain lancement. Consultez /release-notes.`); this.o.log('updated',1); } }
      if (!this.#stop.signal.aborted) { const removed=this.o.store.prune(this.o.keep); this.o.log('pruned',removed.length); }
    } catch { if (!this.#stop.signal.aborted) this.o.log('failed',1); }
  }
  async close(): Promise<void> { this.#stop.abort(); clearTimeout(this.#timer); await this.#running; }
}
export async function preflight(o:{ urls: readonly string[]; configDir:string; fetch:typeof fetch; prefix:string; signal?:AbortSignal; timeoutMs?:number }):Promise<Array<{status:'ok'|'error';area:string;message:string}>> {
  const signal=AbortSignal.any([...(o.signal?[o.signal]:[]),AbortSignal.timeout(o.timeoutMs??3000)]);
  const network = o.urls.map(async address=>{ try { const u=new URL(address); if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw new Error('adresse invalide'); u.search=''; u.hash=''; const r=await o.fetch(u,{method:'HEAD',redirect:'error',signal}); await r.body?.cancel(); if (r.status >= 500) throw new Error('service indisponible'); return {status:'ok' as const,area:'Réseau',message:'Service joignable.'}; } catch(cause) { const tls=/certificate|certificat|TLS|SSL/i.test(String(cause)); return {status:'error' as const,area:'Réseau',message:tls?`Certificat non reconnu ; configurez ${o.prefix}EXTRA_CA_CERTS avec l’autorité de votre organisation.`:'Service injoignable ; vérifiez HTTP_PROXY, HTTPS_PROXY et NO_PROXY, puis le pare-feu.'}; } });
  const folder=async()=>{const file=join(o.configDir,`.preflight-${randomUUID()}`);try { mkdirSync(o.configDir,{recursive:true});writeFileSync(file,'',{flag:'wx',mode:0o600});unlinkSync(file);return {status:'ok' as const,area:'Dossiers',message:'Dossier de configuration inscriptible.'}; } catch {return {status:'error' as const,area:'Dossiers',message:'Dossier de configuration non inscriptible ; vérifiez ses permissions.'};}};
  return Promise.all([...network,folder()]);
}
