// Implements: SPEC-INS-001 (verified installation), SPEC-INS-004 (manual updates), SPEC-INS-005 (installation and usage locks).
// Supports: SPEC-INS-002 (next-launch activation), SPEC-INS-007 (safe pruning), E-156.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, symlinkSync, realpathSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PlatformName } from "../platform/system";
import { comparablePath, isWithin } from "../platform/system";
import { compareVersions } from "../platform/semver";
import { tryFileLock } from "../platform/file-lock";
import { writeAtomic } from "../tools/text-file";
import { verifyArtifactSignature } from "../platform/artifact-signature";
import {buildFlag} from "../extension-points/build-flags" with {type:"macro"};

export const isVersion = (v: unknown): v is string => typeof v === "string" && /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(v);
export interface Release { readonly version: string; readonly minimumAllowedVersion?: string; readonly notes: string; readonly artifact: { readonly url: string; readonly sha256: string; readonly size: number; readonly signature?: "platform" } }
export interface NativeOptions { readonly testDistribution?:{readonly service:string;readonly token:string}; readonly root: string; readonly cli: string; readonly platform: PlatformName; readonly target: string; readonly service: string; readonly currentVersion: string; readonly minimum?: string; readonly systemRoot?: string; readonly fetch: typeof fetch; readonly signal?: AbortSignal; readonly report: (text: string) => void }
const fail = (message: string): Error => new Error(`Installation : ${message}`);
const url = (value: string): URL => { const u = new URL(value); if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search) throw fail("adresse HTTPS sans identifiants requise."); return u; };
export class NativeStore {
  readonly versions: string; readonly bin: string; readonly locks: string; readonly usage: string;
  constructor(readonly o: NativeOptions) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(o.cli) || !isVersion(o.currentVersion) || o.minimum !== undefined && !isVersion(o.minimum)) throw fail("identité ou version invalide.");
    this.versions = join(o.root, "versions"); this.bin = join(o.root, "bin"); this.locks = join(o.root, "locks"); this.usage = join(o.root, "usage");
  }
  #directory(path: string): void {
    const parts: string[] = []; for (let p = resolve(path); !existsSync(p); p = dirname(p)) { if (p === dirname(p)) throw fail("dossier inaccessible."); parts.push(p); }
    for (let p = resolve(path); ; p = dirname(p)) { if (existsSync(p)) { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw fail("dossier lié ou non ordinaire refusé."); } if (p === dirname(p)) break; }
    for (const p of parts.reverse()) { try { mkdirSync(p, { mode: 0o700 }); } catch(cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; const s=lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw fail('dossier concurrent non ordinaire refusé.'); } }
  }
  #inside(path: string): void { if (!isWithin(resolve(path), resolve(this.o.root), this.o.platform) || comparablePath(resolve(path), this.o.platform) === comparablePath(resolve(this.o.root), this.o.platform)) throw fail("cible hors du magasin."); this.#directory(dirname(path)); }
  async #locked<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    this.#directory(this.locks); const path = join(this.locks, `${key}.lock`); let release: (() => void) | undefined; const end = Date.now() + 30000;
    while (!(release = tryFileLock(path))) { signal.throwIfAborted(); if (Date.now() >= end) throw fail("opération concurrente ; réessayez."); await new Promise(r => setTimeout(r, 25)); }
    try { signal.throwIfAborted(); return await action(); } finally { release(); }
  }
  // Implements: SPEC-INS-006. The private branch and its environment names are erased outside the test profile.
  #distribution(version:string):{service:string;headers:Record<string,string>;private:boolean}{
    if(isVersion(version)&&Number(version.split('.')[0])>=900000){
      if(buildFlag("update_prerelease_channel")){const source=this.o.testDistribution;if(!source?.service||!source.token||source.token.length>8192||/[\x00-\x20\x7f]/.test(source.token))throw fail("distribution privée de test non configurée.");url(source.service);return{service:source.service,headers:{Authorization:"Bearer "+source.token},private:true};}
      throw fail("version réservée aux essais ; utilisez stable ou latest.");
    }
    return{service:this.o.service,headers:{},private:false};
  }
  async release(target: string): Promise<Release> {
    if (!['stable','latest'].includes(target) && !isVersion(target)) throw fail("cible inconnue.");
    const distribution=this.#distribution(target);
    const base = url(distribution.service.endsWith('/') ? distribution.service : distribution.service+'/');
    const address = new URL(`v1/${target}.json`, base);
    const signal = AbortSignal.any([...(this.o.signal ? [this.o.signal] : []), AbortSignal.timeout(10000)]);
    const r = await this.o.fetch(address, { signal, redirect: 'error', headers: { Accept: 'application/json',...distribution.headers } });
    if (!r.ok || !r.body) { await r.body?.cancel(); throw fail("manifeste indisponible ; vérifiez le réseau et le mandataire."); }
    const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 131072) throw fail("manifeste trop volumineux."); chunks.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail("manifeste invalide."); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail("manifeste invalide.");
    const m = raw as Record<string, unknown>; const artifacts = m.artifacts as Record<string, unknown> | undefined; const artifact = artifacts?.[this.o.target] as Record<string, unknown> | undefined;
    if (m.schemaVersion !== 1 || !isVersion(m.version) || isVersion(target) && target !== m.version || Number(m.version.split('.')[0]) >= 900000 && !distribution.private || m.minimumAllowedVersion !== undefined && !isVersion(m.minimumAllowedVersion) || !artifact || typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || typeof artifact.size !== 'number' || !Number.isInteger(artifact.size) || artifact.size < 1 || artifact.size > 536870912 || m.notes !== undefined && (typeof m.notes !== 'string' || m.notes.length > 16000)) throw fail("manifeste ou plateforme invalide.");
    if (artifact.signature !== undefined && artifact.signature !== 'platform') throw fail('signature de manifeste invalide.');
    const download = url(new URL(artifact.url, base).href); if (download.origin !== base.origin) throw fail("téléchargement sur une autre origine refusé.");
    return { version: m.version, ...(m.minimumAllowedVersion ? { minimumAllowedVersion: m.minimumAllowedVersion as string } : {}), notes: String(m.notes ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,''), artifact: { url: download.href, sha256: artifact.sha256, size: artifact.size, ...(artifact.signature === 'platform' ? {signature:'platform' as const} : {}) } };
  }
  minimum(release?: Release): string | undefined {
    let cached: string | undefined; const path=join(this.o.root,'minimum.json');
    if(existsSync(path)) { this.#directory(this.o.root); const stat=lstatSync(path); if(!stat.isFile() || stat.isSymbolicLink() || stat.size>256) throw fail('minimum local invalide ; vérifiez l’installation.'); try { cached=JSON.parse(readFileSync(path,'utf8')).version; } catch { throw fail('minimum local illisible ; vérifiez l’installation.'); } if(!isVersion(cached)) throw fail('minimum local invalide.'); }
    return [this.o.minimum, cached, release?.minimumAllowedVersion].filter((v): v is string => v !== undefined).sort(compareVersions).at(-1);
  }
  async rememberMinimum(release: Release): Promise<void> {
    if(!release.minimumAllowedVersion) return;
    const signal=AbortSignal.any([...(this.o.signal?[this.o.signal]:[]),AbortSignal.timeout(10000)]);
    await this.#locked('minimum',signal,async()=>{ const version=this.minimum(release); writeAtomic(join(this.o.root,'minimum.json'),Buffer.from(JSON.stringify({version})),this.o.platform,true); });
  }
  assertCurrent(release?: Release): void { const min = this.minimum(release); if (min && compareVersions(this.o.currentVersion, min) < 0) throw fail("cette version n’est plus prise en charge ; lancez installation update."); }
  binary(version: string): string { if (!isVersion(version)) throw fail("version invalide."); return join(this.versions, version, this.o.cli + (this.o.platform === 'windows' ? '.exe' : '')); }
  async install(release: Release, force = false): Promise<{ version: string; path: string; launcher: string }> {
    const distribution=this.#distribution(release.version);
    if (!isVersion(release.version) || release.minimumAllowedVersion !== undefined && !isVersion(release.minimumAllowedVersion) || !release.artifact || !/^[a-f0-9]{64}$/.test(release.artifact.sha256) || !Number.isInteger(release.artifact.size) || release.artifact.size < 1 || release.artifact.size > 536870912) throw fail('version ou artefact invalide.');
    if (url(release.artifact.url).origin !== url(distribution.service).origin) throw fail('téléchargement sur une autre origine refusé.');
    if (release.artifact.signature !== undefined && release.artifact.signature !== 'platform') throw fail('signature de manifeste invalide.');
    const minimum = this.minimum(release); if (minimum && compareVersions(release.version, minimum) < 0) throw fail("version inférieure au minimum autorisé.");
    const signal = AbortSignal.any([...(this.o.signal ? [this.o.signal] : []), AbortSignal.timeout(60000)]);
    return this.#locked(`install-${release.version}`, signal, async () => {
      this.#directory(this.versions); const binary = this.binary(release.version), versionDir = dirname(binary);
      const present = existsSync(versionDir);
      if (present) { this.#directory(versionDir); if (!this.#verified(binary, release)) throw fail("version déjà présente et différente ; conservation sans écrasement."); if (release.artifact.signature === 'platform') await verifyArtifactSignature(binary, this.o.platform,this.o.systemRoot); }
      if (!present || force) {
        const staging = join(this.versions, `.partial-${release.version}-${randomUUID()}`); this.#inside(staging); mkdirSync(staging, { mode: 0o700 }); const temp = join(staging, this.o.cli + (this.o.platform === 'windows' ? '.exe' : ''));
        try {
          this.o.report('Téléchargement et vérification de la version.');
          const response = await this.o.fetch(url(release.artifact.url), { signal, redirect: 'error',headers:distribution.headers }); if (!response.ok || !response.body) { await response.body?.cancel(); throw fail("téléchargement impossible ; vérifiez le réseau et le mandataire."); }
          const reader = response.body.getReader(), fd = openSync(temp, 'wx', 0o700), hash = createHash('sha256'); let size = 0;
          try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > release.artifact.size) throw fail('taille de téléchargement incorrecte.'); hash.update(part.value); let offset = 0; while (offset < part.value.byteLength) offset += writeSync(fd, part.value, offset); } fsyncSync(fd); }
          finally { closeSync(fd); await reader.cancel().catch(() => {}); }
          if (size !== release.artifact.size || hash.digest('hex') !== release.artifact.sha256) throw fail('empreinte invalide ; installation annulée.');
          if (release.artifact.signature === 'platform') await verifyArtifactSignature(temp, this.o.platform,this.o.systemRoot);
          signal.throwIfAborted(); if (this.o.platform !== 'windows') chmodSync(temp, 0o700);
          writeAtomic(join(staging, 'receipt.json'), Buffer.from(JSON.stringify({ version: release.version, sha256: release.artifact.sha256, size })), this.o.platform, true);
          // A forced reinstall checks a fresh download, while an in-use immutable executable stays in place.
          if (!present) { this.#inside(versionDir); renameSync(staging, versionDir); }
        } finally { this.#inside(staging); rmSync(staging, { recursive: true, force: true }); }
      }
      const launcher = await this.#locked('activation', signal, async () => {
        this.#directory(this.bin); const launcher = join(this.bin, this.o.cli + (this.o.platform === 'windows' ? '.cmd' : ''));
        if (this.o.platform === 'windows') {
          if (/[\r\n!]/.test(binary)) throw fail('chemin non pris en charge par le lanceur Windows.');
          writeAtomic(launcher, Buffer.from(`@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${binary.replace(/%/g,'%%')}" %*\r\n`), this.o.platform, true);
        } else { const link = join(this.bin, `.launcher-${randomUUID()}`); try { symlinkSync(binary, link); renameSync(link, launcher); } finally { rmSync(link, { force: true }); } }
        writeAtomic(join(this.o.root, 'active.json'), Buffer.from(JSON.stringify({ version: release.version })), this.o.platform, true); return launcher;
      }); await this.rememberMinimum(release); return { version: release.version, path: binary, launcher };
    });
  }
  #verified(binary: string, release: Release): boolean { try { const s = lstatSync(binary); return s.isFile() && !s.isSymbolicLink() && s.size === release.artifact.size && createHash('sha256').update(readFileSync(binary)).digest('hex') === release.artifact.sha256; } catch { return false; } }
  pin(version: string): () => void {
    if (!isVersion(version)) throw fail('version invalide.'); this.#directory(this.locks); const gate = tryFileLock(join(this.locks, `install-${version}.lock`)); if (!gate) throw fail('version occupée pendant le démarrage.');
    try { if (!existsSync(this.binary(version))) throw fail('version absente.'); const dir = join(this.usage, version); this.#directory(dir); const release = tryFileLock(join(dir, `${process.pid}-${randomUUID()}.lock`)); if (!release) throw fail('verrou d’usage indisponible.'); return release; } finally { gate(); }
  }
  prune(keep = 2): string[] {
    if (!Number.isInteger(keep) || keep < 2 || keep > 100) throw fail('conservation invalide.'); if (!existsSync(this.versions)) return [];
    this.#directory(this.versions); this.#directory(this.locks); const versions = readdirSync(this.versions).filter(isVersion).sort((a,b) => compareVersions(b,a)); const saved = new Set(versions.slice(0,keep));
    try { const active = JSON.parse(readFileSync(join(this.o.root, 'active.json'),'utf8')); if (isVersion(active.version)) saved.add(active.version); } catch {}
    // The launcher is authoritative even if writing its auxiliary receipt was interrupted.
    try { const launcher=join(this.bin,this.o.cli+(this.o.platform==='windows'?'.cmd':'')); const content=this.o.platform==='windows' ? readFileSync(launcher,'utf8') : readlinkSync(launcher); for (const v of versions) if (content.includes(this.binary(v).replace(/%/g,this.o.platform==='windows'?'%%':'%'))) saved.add(v); } catch {}
    const removed: string[] = [];
    for (const v of versions) { if (saved.has(v)) continue; const gate = tryFileLock(join(this.locks, `install-${v}.lock`)); if (!gate) continue;
      const leases: Array<() => void> = []; try { const dir = join(this.usage,v); let busy = false; if (existsSync(dir)) { this.#directory(dir); for (const name of readdirSync(dir)) { if (!/^\d+-[a-f0-9-]{36}\.lock$/.test(name)) { busy=true;break; } const lease = tryFileLock(join(dir,name)); if (!lease) { busy=true; break; } leases.push(lease); } }
        if (busy) continue; const version = join(this.versions,v); this.#inside(version); const s = lstatSync(version); if (!s.isDirectory() || s.isSymbolicLink()) continue;
        // A version contains exactly the executable and our receipt; never recursively follow arbitrary added paths.
        const names = readdirSync(version); if (names.some(n => ![this.o.cli+(this.o.platform==='windows'?'.exe':''),'receipt.json'].includes(n))) continue;
        if (names.some(n => { const stat=lstatSync(join(version,n)); return !stat.isFile() || stat.isSymbolicLink(); })) continue;
        rmSync(version,{recursive:true}); removed.push(v);
      } finally { for (const release of leases) release(); gate(); }
    } return removed;
  }
  isNative(executable: string): boolean { try { return comparablePath(realpathSync(executable),this.o.platform) === comparablePath(realpathSync(this.binary(this.o.currentVersion)),this.o.platform); } catch { return false; } }
}
