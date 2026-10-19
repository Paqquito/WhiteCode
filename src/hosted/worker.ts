// Implements: SPEC-API-029 (EF-02/07, secret-free hosted session), SPEC-PLA-002 (independent hosted execution).
// Supports: SPEC-MOD-014 (actual product process and pinned repository preparation).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "../platform/process";
import { nativeExecutorPorts } from "../remote/executor-runtime";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import { securePrivateDirectory } from "../platform/private-file";
import { ordinaryPrivateFile } from "../shared/private-text";
import { ModelCatalog } from "../providers/catalog";
import type { ModelEntry } from "../providers/catalog";
import { hostedSessionIsolation, stopHostedPreparationGroup } from "../platform/hosted-isolation";
import type { HostedIsolationConfiguration } from "../platform/hosted-isolation";
import { HostedProxy } from "../platform/hosted-proxy";
import type { HostedUpstreamConfiguration } from "../platform/hosted-proxy";
import { findExecutable } from "../platform/system";
import { HandoffGit } from "../remote/handoff-git";
import { handoffState, handoffHistory, handoffDigest } from "../remote/handoff-state";
interface Assignment { id: string; repository: string; branch: string; commit: string; prompt: string; environment: string; tools: string[]; connectors: string[]; model: ModelEntry; currency: string; lease: string; maxCost?: number; maxDurationSeconds?: number; handoff?: {state:ReturnType<typeof handoffState>;messages:ReturnType<typeof handoffHistory>;digest:string} }
interface Options { readonly serviceUrl: string; readonly workerToken: string; readonly root: string; readonly prefix: string; readonly productBinary: string; readonly environment: Readonly<Record<string, string>>; readonly isolation?: HostedIsolationConfiguration; readonly upstream?: HostedUpstreamConfiguration; readonly fetch?: typeof fetch; readonly report?: (message: string) => void; readonly pollMs?: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function serviceUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw Error("Service de travail HTTPS requis.");
  return new URL(url.href.replace(/\/?$/, "/"));
}
/** The broker and worker must run on separate hosts or distinct sandboxed OS principals. No provider key crosses this protocol. */
export class HostedWorker {
  readonly #base: URL; readonly #environment: Record<string, string> = {}; readonly #isolation: ReturnType<typeof hostedSessionIsolation>; readonly #root: string; #active?: AbortController; #polling = false; #unsafe = false; #routingFailed = false;
  constructor(readonly options: Options) {
    this.#base = serviceUrl(options.serviceUrl);
    this.#isolation = hostedSessionIsolation(options.isolation);
    if (!/^[A-Z][A-Z0-9_]*_$/.test(options.prefix) || options.workerToken.length < 32) throw Error("Configuration du travailleur invalide.");
    // Host credentials, proxy authentication and product settings never enter model tools.
    const names = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "SHELL", "PROGRAMFILES", "PROGRAMW6432", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]);
    for (const [name, value] of Object.entries(options.environment)) if (names.has(name.toUpperCase())) this.#environment[name] = value;
    mkdirSync(options.root, { recursive: true, mode: 0o700 }); ordinaryPrivateFile(join(options.root, ".hosted-worker-root.json"), 1024);
    const marker = join(options.root, ".hosted-worker-root.json"), stat = lstatSync(options.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || !existsSync(marker) && readdirSync(options.root).length) throw Error("Racine du travailleur non vide ou non possédée par le superviseur.");
    if (!existsSync(marker)) writeAtomic(marker, Buffer.from(JSON.stringify({ version: 1, purpose: "hosted-worker" })), currentPlatform(), true);
    this.#root = realpathSync(options.root); chmodSync(options.root, 0o711);
  }
  async #request(path: string, body: unknown, token: string, signal: AbortSignal): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.#base), { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) { await response.body?.cancel(); throw Error("Bail de travail arrêté ou service indisponible."); }
    const bytes = await response.arrayBuffer(); if (bytes.byteLength > 262144) throw Error("Réponse de travail trop volumineuse."); return JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  async poll(signal: AbortSignal): Promise<boolean> {
    if (this.#routingFailed) throw Error("Relais mandataire indisponible ; travailleur fermé.");
    if (this.#unsafe) throw Error("Arrêt de session non confirmé ; le travailleur refuse toute nouvelle affectation.");
    if (this.#polling) throw Error("Un travail est déjà en cours de préparation ou d’exécution.");
    this.#polling = true;
    try { return await this.#poll(signal); }
    finally { this.#active?.abort(); this.#active = undefined; this.#polling = false; }
  }
  async #poll(signal: AbortSignal): Promise<boolean> {
    if (this.#active) throw Error("Un travail est déjà actif.");
    const raw = await this.#request("workers/next", {}, this.options.workerToken, signal);
    if (object(raw) && raw.work === null) return false;
    if (!object(raw) || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) || typeof raw.lease !== "string" || !/^[a-f0-9]{64}$/.test(raw.lease) || !Array.isArray(raw.tools) || !raw.tools.every(name => typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name)) || !Array.isArray(raw.connectors) || raw.connectors.length !== 0 || typeof raw.repository !== "string" || typeof raw.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(raw.commit) || typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 32000 || typeof raw.currency !== "string" || !object(raw.model)) throw Error("Affectation hébergée invalide ou connecteur non installé.");
    const model = new ModelCatalog({ schemaVersion: 1, currency: raw.currency, models: [raw.model] }).entries[0]!;
    if (model.provider !== "openai_compatible") throw Error("Protocole de modèle non pris en charge.");
    const work = raw as unknown as Assignment, controller = new AbortController(); this.#active = controller;
    if(work.handoff){const state=handoffState(work.handoff.state),messages=handoffHistory(work.handoff.messages);if(state.repository!==work.repository||state.snapshot!==work.commit||state.transferBranch!==work.branch||handoffDigest(state,messages)!==work.handoff.digest)throw Error("Affectation de transfert incohérente.");}
    if (work.maxDurationSeconds !== undefined && (!Number.isSafeInteger(work.maxDurationSeconds) || work.maxDurationSeconds < 1 || work.maxDurationSeconds > 86400)) throw Error("Durée d’affectation invalide.");
    const parent = AbortSignal.any([signal, controller.signal, AbortSignal.timeout((work.maxDurationSeconds ?? 3600) * 1000)]);
    if (lstatSync(this.options.root).isSymbolicLink() || realpathSync(this.options.root) !== this.#root) throw Error("Racine de travailleur remplacée.");
    const directory = mkdtempSync(join(this.#root, "session-")), repository = join(directory, "repository"), home = join(directory, "home"), profile = join(home, "config");
    mkdirSync(repository); mkdirSync(profile, { recursive: true, mode: 0o700 }); securePrivateDirectory(profile);
    const environment = { ...this.#environment, HOME: home, USERPROFILE: home, [this.options.prefix + "CONFIG_HOME"]: profile, OPENAI_API_KEY: work.lease };
    const config = {
      api: { provider: "openai_compatible", baseUrl: new URL(`work/${work.id}/v1/`, this.#base).href, maxRetries: 0 }, models: { selected: model.id, extraCatalog: [model] },
      permissions: { allowRules: work.tools }, extensions: { autoUpdate: "off" }, sessions: { autoTitle: false }, deepLinks: { registration: "disabled" }, integrations: { keepAwake: false },
      memory: { automatic: { enabled: false }, autoExtraction: { enabled: false }, session: { enabled: false } }, engine: { limits: { maxIterations: 32, maxDurationSeconds: 3600, ...(work.maxCost !== undefined ? { maxCost: work.maxCost } : {}) } },
    };
    const configFile = join(profile, "config.json"); ordinaryPrivateFile(configFile, 262144); writeAtomic(configFile, Buffer.from(JSON.stringify(config)), currentPlatform(), true);
    let output = "", heartbeat: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined, isolation: ReturnType<ReturnType<typeof hostedSessionIsolation>["prepare"]> | undefined;
    const preparationGroups = new Set<number>();
    let proxy: HostedProxy | undefined, proxyFailure: (() => void) | undefined;
    const stopPreparation = () => { for (const pid of preparationGroups) try { stopHostedPreparationGroup(pid); preparationGroups.delete(pid); } catch { this.#unsafe = true; } };
    const stopIdentity = () => { try { isolation?.stop(); return true; } catch { this.#unsafe = true; return false; } };
    parent.addEventListener("abort", stopPreparation, { once: true });
    try {
      parent.throwIfAborted();
      await this.#request(`work/${work.id}/status`, {}, work.lease, parent);
      timer = setInterval(() => {
        if (!heartbeat) heartbeat = this.#request(`work/${work.id}/status`, {}, work.lease, parent).then(() => {}, () => controller.abort()).finally(() => { heartbeat = undefined; });
      }, this.options.pollMs ?? 250);
      if (this.options.upstream) {
        try { proxy = await HostedProxy.start(this.options.upstream, { runtime: this.options.productBinary, trustParent: this.#root, signal: parent }); }
        catch (error) { if (!parent.aborted) this.#routingFailed = true; throw error; }
        proxyFailure = () => { if (!parent.aborted) this.#routingFailed = true; controller.abort(); };
        proxy.failure.addEventListener("abort", proxyFailure, { once: true }); if (proxy.failure.aborted) proxyFailure();
        this.options.report?.("Relais mandataire authentifié prêt.");
      }
      // Only preparation receives explicitly configured Git routing. It is never inherited by the product or shell tools.
      const preparation = nativeExecutorPorts({ env: { ...this.#environment, ...Object.fromEntries(Object.entries(this.options.environment).filter(([name]) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name))), HOME: home, USERPROFILE: home, ...(this.options.environment.GIT_SSL_CAINFO ? { GIT_SSL_CAINFO: this.options.environment.GIT_SSL_CAINFO } : {}) }, configDir: profile, prefix: this.options.prefix, redact: value => value, ...(proxy ? { prepareLaunch: (file, args, where, childEnvironment) => proxy!.launch({ command: "hosted repository preparation", file, args, cwd: where, allowed: [repository], environment: childEnvironment }) } : {}), onPrepareChild: child => { if (child.pid !== undefined) preparationGroups.add(child.pid); void child.exited.then(() => { stopPreparation(); if (this.#unsafe) controller.abort(); }); if (parent.aborted) stopPreparation(); } });
      await preparation.prepare(repository, { id: work.id, environment: work.environment, labels: [], repository: work.repository, commit: work.commit, prompt: work.prompt, workSecret: "work_" + work.lease, expiresAt: Date.now() + 3600000 }, parent);
      let historyFile:string|undefined;
      if(work.handoff){
        const git=findExecutable("git");if(!git)throw Error("Git absent.");
        const transfer=new HandoffGit({git,cwd:repository,environment:{...this.#environment,...(this.options.environment.GIT_SSL_CAINFO?{GIT_SSL_CAINFO:this.options.environment.GIT_SSL_CAINFO}:{})},
          ...(proxy ? { launch: (file,args,where,childEnvironment) => proxy!.launch({ command: "hosted handoff preparation", file, args, cwd: where, allowed: [repository], environment: childEnvironment }) } : {}),
          child: child => { if (child.pid !== undefined) preparationGroups.add(child.pid); void child.exited.then(() => { stopPreparation(); if (this.#unsafe) controller.abort(); }); if (parent.aborted) stopPreparation(); },
        });
        // A depth-one fetch may omit the two parents needed for exact restoration.
        await transfer.run(["fetch","--no-tags","origin",work.handoff.state.base,work.handoff.state.index],parent);
        await transfer.restore(work.handoff.state,parent);
        historyFile=join(profile,"handoff-history.json");writeAtomic(historyFile,Buffer.from(JSON.stringify(work.handoff.messages)),currentPlatform(),true);
        await this.#request(`work/${work.id}/handoff-ready`,{digest:work.handoff.digest},work.lease,parent);
        for(;;){
          parent.throwIfAborted();const status=await this.#request(`work/${work.id}/status`,{},work.lease,parent);
          if(object(status)&&status.handoffPhase==="active")break;
          await new Promise<void>(resolve=>{const timer=setTimeout(done,this.options.pollMs??250);function done(){clearTimeout(timer);parent.removeEventListener("abort",done);resolve();}parent.addEventListener("abort",done,{once:true});if(parent.aborted)done();});
        }
      }
      stopPreparation(); if (this.#unsafe) throw Error("Arrêt de préparation non confirmé.");
      parent.throwIfAborted(); await this.#request(`work/${work.id}/status`, {}, work.lease, parent); parent.throwIfAborted();
      const args = ["--non-interactive", "--ephemeral", "--minimal", "--approval-mode", "no_prompt", "--config-scopes", "user", "--connectors-only", "--connectors", "{}", "--toolset", work.tools.join(","), "--model", model.id, "--result-format", "jsonl", "--cwd", repository, ...(historyFile ? ["--handoff-history-file", historyFile] : []), work.prompt];
      const sessionIsolation = this.#isolation.prepare(this.#root, directory); isolation = sessionIsolation;
      const envelope = proxy?.launch({ command: "hosted session", file: "/sandbox-runtime", args, cwd: repository, allowed: [directory], environment });
      const isolated = sessionIsolation.launch(envelope?.file ?? this.options.productBinary, envelope?.args ?? args);
      let child: ReturnType<typeof startChild>;
      try { child = startChild(isolated.file, isolated.args, { cwd: repository, env: envelope?.environment ?? environment, extraFds: envelope?.fds, onData: bytes => { if (output.length < 128000) output += bytes.toString().slice(0, 128000 - output.length); } }); envelope?.spawned(); } catch (error) { envelope?.close(); throw error; }
      const stop = () => { stopIdentity(); void child.killTree(500); }; parent.addEventListener("abort", stop, { once: true }); if (parent.aborted) stop();
      try {
        const code = await child.exited;
        if (!stopIdentity()) throw Error("Arrêt de l’identité de session non confirmé.");
        if (!parent.aborted) await this.#request(`work/${work.id}/result`, { code: code ?? 1, result: output.split(work.lease).join("[redacted work credential]") || "Execution ended without output." }, work.lease, parent);
      } finally { clearInterval(timer); parent.removeEventListener("abort", stop); if (parent.aborted) await child.killTree(500); envelope?.close(); }
    } catch {
      if (!parent.aborted) try { await this.#request(`work/${work.id}/result`, { code: 1, result: "Hosted preparation or execution failed." }, work.lease, AbortSignal.timeout(3000)); } catch {}
      this.options.report?.("Travail hébergé interrompu ou indisponible : " + work.id);
    } finally {
      clearInterval(timer); stopPreparation(); stopIdentity(); if (proxyFailure) proxy?.failure.removeEventListener("abort", proxyFailure); controller.abort(); proxy?.close(); await heartbeat; parent.removeEventListener("abort", stopPreparation); this.#active = undefined;
      if (proxy) this.options.report?.(`Relais mandataire arrêté : ${proxy.metrics.bytes} octets transférés.`);
      if(work.handoff&&!this.#unsafe)try{await this.#request(`work/${work.id}/closed`,{},work.lease,AbortSignal.timeout(3000));}catch{}
      // Retain the session workspace for the owner; the broker never stores its provider credential here.
    }
    if (this.#unsafe) throw Error("Arrêt de session non confirmé ; travailleur fermé.");
    if (this.#routingFailed) throw Error("Relais mandataire indisponible ; travailleur fermé.");
    return true;
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#unsafe && !this.#routingFailed) {
      try { await this.poll(signal); } catch { if (!signal.aborted) this.options.report?.("Service de travail indisponible ; nouvelle tentative différée."); }
      if (!signal.aborted) await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done(); });
    }
    if (this.#unsafe) throw Error("Le travailleur exige une intervention après un arrêt non confirmé.");
    if (this.#routingFailed) throw Error("Relais mandataire indisponible ; aucune nouvelle affectation n’est exécutée.");
  }
}
