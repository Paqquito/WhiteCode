// Implements: SPEC-CMD-037 (interactive installation, direct secret deposit, unmerged workflow request).
// Supports: SPEC-API-011 (masked credential input), SPEC-INT-008 (human-authenticated forge CLI).
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { startChild } from "../platform/process";
import { findExecutable } from "../platform/system";
import { ownedByCurrentUser, securePrivateDirectory } from "../platform/private-file";
import { parseYaml } from "../platform/yaml";

export interface ForgeAppContract {
  readonly workflow: string;
  readonly installationCheckUrl: string;
  readonly secretName: string;
  readonly secretInput: string;
}
export interface ForgeInstallUi {
  repository(current: string): Promise<string | undefined>;
  flow(): Promise<"mention" | "review" | undefined>;
  confirm(message: string): Promise<boolean>;
  secret(message: string): Promise<string | undefined>;
}
interface Options {
  cwd: string;
  environment: Record<string, string>;
  signal: AbortSignal;
  app: string;
  product: string;
  contract: ForgeAppContract | undefined;
  ui: ForgeInstallUi;
  open(url: string): boolean;
  remember(secret: string): void;
  assertPolicy(): void;
  program?: { file: string; args: string[] };
  fetch?: typeof fetch;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Réponse de forge invalide.");
  return value as Record<string, unknown>;
}
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const secretPattern = /^[A-Z_][A-Z0-9_]{0,99}$/;
function https(value: unknown): URL {
  if (typeof value !== "string") throw Error("Adresse HTTPS requise.");
  let url: URL;
  try { url = new URL(value); } catch { throw Error("Adresse HTTPS invalide."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw Error("Adresse HTTPS sans identifiants requise.");
  return url;
}
function contract(value: ForgeAppContract | undefined) {
  if (!value) throw Error("Configurez git.forgeApp dans les paramètres utilisateur ou gérés : flux réutilisable de la société épinglé à un commit, URL HTTPS de vérification d’installation et noms du secret et de son entrée. Aucun secret ni branche n’a été créé.");
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/(\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml)@([a-f0-9]{40})$/.exec(value.workflow);
  if (!match || !secretPattern.test(value.secretName) || /^GITHUB(?:_|$)/i.test(value.secretName) || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(value.secretInput)) throw Error("Contrat de flux de la société invalide ; un commit complet et des noms de secrets explicites sont requis.");
  return { ...value, repository: match[1]!, path: match[2]!, sha: match[3]!, check: https(value.installationCheckUrl) };
}

/** Both pipes are discarded for secret commands; even a failing CLI cannot echo the credential. */
async function command(options: Options, file: string, args: string[], settings: { cwd?: string; environment?: Record<string, string>; input?: string; secret?: boolean; missing?: boolean } = {}): Promise<string> {
  options.assertPolicy();
  if (options.signal.aborted) throw Error("Installation interrompue.");
  let output = "", overflow = false;
  const child = startChild(file, args, {
    cwd: settings.cwd ?? options.cwd, env: settings.environment ?? options.environment,
    ...(settings.input !== undefined ? { input: settings.input } : {}),
    onData: chunk => {
      if (settings.secret) return;
      if (Buffer.byteLength(output) + chunk.length > 262144) { overflow = true; void child.killTree(100); }
      else output += chunk.toString();
    }, onErrorData: () => {},
  });
  const scope = AbortSignal.any([options.signal, AbortSignal.timeout(60000)]), stop = () => { void child.killTree(100); };
  scope.addEventListener("abort", stop, { once: true });
  try {
    if (scope.aborted) stop();
    const code = await child.exited;
    if (scope.aborted || (code !== 0 && !(settings.missing && code === 1)) || overflow) throw Error("Commande de forge ou Git refusée, interrompue ou indisponible.");
    options.assertPolicy();
    return output.trim();
  } finally { scope.removeEventListener("abort", stop); }
}
function workflowSource(raw: unknown, cfg: ReturnType<typeof contract>) {
  const content = record(raw);
  if (content["type"] !== "file" || content["encoding"] !== "base64" || typeof content["content"] !== "string" || !Number.isSafeInteger(content["size"]) || Number(content["size"]) > 65536 || content["path"] !== cfg.path) throw Error("Flux épinglé illisible ou trop volumineux.");
  const bytes = Buffer.from(content["content"], "base64");
  if (bytes.length !== content["size"] || bytes.length > 65536) throw Error("Contenu du flux épinglé invalide.");
  let source: Record<string, unknown>;
  try { source = record(parseYaml(bytes.toString("utf8"))); } catch { throw Error("Syntaxe du flux de société invalide."); }
  const call = record(record(source["on"])["workflow_call"]), inputs = record(call["inputs"]), secrets = record(call["secrets"]), jobs = record(source["jobs"]);
  if (record(inputs["mode"])["type"] !== "string" || record(secrets[cfg.secretInput])["required"] !== true || !Object.keys(jobs).length) throw Error("Le flux de société doit déclarer workflow_call, l’entrée mode de type string, le secret requis configuré et des tâches exécutables.");
  if (Object.entries(inputs).some(([key, value]) => key !== "mode" && record(value)["required"] === true) || Object.entries(secrets).some(([key, value]) => key !== cfg.secretInput && record(value)["required"] === true)) throw Error("Le flux de société exige des entrées non prises en charge par ce contrat.");
  for (const job of Object.values(jobs)) {
    const row = record(job);
    if (typeof row["uses"] === "string" && /@[a-f0-9]{40}$/.test(row["uses"])) continue;
    if (!row["runs-on"] || !Array.isArray(row["steps"]) || !row["steps"].length || !row["steps"].every(step => { const entry = record(step); return typeof entry["run"] === "string" && !!entry["run"].trim() || typeof entry["uses"] === "string" && !!entry["uses"].trim(); })) throw Error("Tâche du flux de société sans exécution reconnue.");
  }
}
export function forgeWorkflow(app: string, cfg: ForgeAppContract, mode: "mention" | "review"): string {
  const event = mode === "mention" ? "  issue_comment:\n    types: [created]" : "  pull_request:\n    types: [opened, synchronize, reopened]";
  const guard = mode === "mention" ? `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association) && contains(github.event.comment.body, '@${app}')` : "github.event.pull_request.head.repo.full_name == github.repository";
  return `name: Agent de développement\non:\n${event}\npermissions:\n  contents: read\n  issues: write\n  pull-requests: write\njobs:\n  agent:\n    if: \${{ ${guard} }}\n    uses: ${cfg.workflow}\n    with:\n      mode: ${mode}\n    secrets:\n      ${cfg.secretInput}: \${{ secrets.${cfg.secretName} }}\n`;
}
function gitEnvironment(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(?:GIT_|GCM_|SSH_ASKPASS|DISPLAY$)/i.test(key)));
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function installForgeApp(options: Options): Promise<string> {
  const configured = contract(options.contract);
  const cfg = { ...configured, secretName: configured.secretName.slice(0, 67) + "_" + randomBytes(16).toString("hex").toUpperCase() };
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(options.app) || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(options.product)) throw Error("Identité d’application de forge invalide.");
  const gh = options.program?.file ?? findExecutable("gh"), git = findExecutable("git");
  if (!gh || !git) throw Error("Installez les outils gh et Git, puis authentifiez vous-même gh avec les droits d’administration du dépôt. Relancez /install-forge-app.");
  const cli = async (args: string[], input?: string, secret = false) => command(options, gh, [...(options.program?.args ?? []), ...args], { ...(input !== undefined ? { input } : {}), secret });
  const json = async (args: string[]) => { const text = await cli(args); try { return JSON.parse(text) as unknown; } catch { throw Error("Réponse structurée de la forge illisible."); } };
  await cli(["auth", "status", "--active"]);
  const current = record(await json(["repo", "view", "--json", "nameWithOwner,url"]));
  if (typeof current["nameWithOwner"] !== "string" || !repositoryPattern.test(current["nameWithOwner"])) throw Error("Dépôt courant non reconnu. Configurez son origine avec gh avant de recommencer.");
  const forge = https(current["url"]);
  if (forge.pathname !== "/" + current["nameWithOwner"]) throw Error("Origine du dépôt incohérente.");
  await cli(["auth", "status", "--active", "--hostname", forge.host]);
  const name = await options.ui.repository(current["nameWithOwner"]);
  if (name === undefined) return "Installation annulée.";
  if (!repositoryPattern.test(name)) throw Error("Nom de dépôt attendu : propriétaire/dépôt.");
  const target = `${forge.host}/${name}`;
  const repo = record(await json(["api", "repos/" + name, "--hostname", forge.host]));
  if (repo["full_name"] !== name || !Number.isSafeInteger(repo["id"]) || Number(repo["id"]) < 1 || record(repo["permissions"])["admin"] !== true) throw Error("Droits d’administration du dépôt requis. Un administrateur doit installer l’application, déposer le secret et ouvrir une demande de fusion pour le flux de société.");
  if (typeof repo["default_branch"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(repo["default_branch"]) || repo["default_branch"].includes("..") || repo["default_branch"].endsWith("/")) throw Error("Branche par défaut invalide.");
  const clone = https(repo["clone_url"]);
  if (clone.origin !== forge.origin || clone.pathname !== "/" + name + ".git") throw Error("Adresse Git du dépôt incohérente.");
  workflowSource(await json(["api", `repos/${cfg.repository}/contents/${cfg.path}?ref=${cfg.sha}`, "--hostname", forge.host]), cfg);
  const requireUnusedSecret = async () => {
    const secrets = await json(["secret", "list", "--repo", target, "--app", "actions", "--json", "name"]);
    if (!Array.isArray(secrets)) throw Error("Liste des secrets du dépôt indisponible.");
    if (secrets.some(value => record(value)["name"] === cfg.secretName)) throw Error(`Le secret ${cfg.secretName} existe déjà. Installation arrêtée ; relancez l’assistant pour obtenir un autre nom dédié.`);
  };
  await requireUnusedSecret();
  const mode = await options.ui.flow();
  if (!mode) return "Installation annulée.";
  const path = `.github/workflows/${options.product}-agent.yml`, source = forgeWorkflow(options.app, cfg, mode);
  if (!await options.ui.confirm(`Installer l’application ${options.app} pour ${name} (${mode === "mention" ? "mentions réservées aux collaborateurs" : "revue des demandes internes"}) ?\nFlux : ${cfg.workflow}\nFichier : ${path}\nSecret du coffre : ${cfg.secretName}\nPermissions du flux : lecture du code, écriture des tickets et demandes de fusion.\nVérification de société : ${cfg.check.href}\nLa demande de fusion devra être relue et fusionnée par un humain.`)) return "Installation annulée.";
  const installation = new URL(`/apps/${options.app}/installations/new`, forge.origin);
  options.assertPolicy();
  if (options.signal.aborted) throw Error("Installation interrompue.");
  options.open(installation.href);
  if (!await options.ui.confirm(`Installez vous-même l’application sur ${name} dans le navigateur : ${installation.href}\nConfirmer l’installation pour la vérifier auprès de la société ?`)) return "Installation annulée.";
  options.assertPolicy();
  const response = await (options.fetch ?? fetch)(cfg.check.href, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ version: 1, application: options.app, repository: name, repositoryId: repo["id"] }), redirect: "error", signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) });
  if (!response.ok || !response.body) throw Error("Installation non vérifiée ; aucun secret ni branche créé.");
  const reader = response.body.getReader(); let checkText = "", size = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16384) { await reader.cancel(); throw Error("Réponse de vérification trop volumineuse."); } checkText += Buffer.from(chunk.value).toString(); } }
  finally { reader.releaseLock(); }
  let checked: Record<string, unknown>;
  try { checked = record(JSON.parse(checkText)); } catch { throw Error("Réponse de vérification de société invalide."); }
  if (checked["version"] !== 1 || checked["installed"] !== true || checked["application"] !== options.app || checked["repository"] !== name || checked["repositoryId"] !== repo["id"]) throw Error("Installation de l’application sur le dépôt non vérifiée ; aucun secret ni branche créé.");
  options.assertPolicy();
  const inherited = { ...gitEnvironment(options.environment), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  const author = async (key: string) => {
    const value = await command(options, git, ["config", "--get", key], { environment: inherited });
    if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw Error("Identité Git utilisateur requise avant création de la branche.");
    return value;
  };
  const authorName = await author("user.name"), authorEmail = await author("user.email");
  const trust: string[] = [];
  for (const key of ["http.sslCAInfo", "http.sslCAPath"]) {
    let value = await command(options, git, ["config", "--global", "--path", "--get-urlmatch", key, clone.href], { environment: inherited, missing: true });
    if (!value) value = await command(options, git, ["config", "--system", "--path", "--get-urlmatch", key, clone.href], { environment: inherited, missing: true });
    if (value) {
      if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw Error("Autorité de confiance Git invalide.");
      trust.push("-c", `${key}=${value}`);
    }
  }
  // Read only identity and public CA paths before suppressing every inherited Git configuration for network operations.
  const environment = { ...inherited, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const credentials = `!${[gh, ...(options.program?.args ?? []), "auth", "git-credential"].map(shellQuote).join(" ")}`;
  const flags = ["-c", "credential.helper=", "-c", `credential.helper=${credentials}`, "-c", "credential.interactive=false", "-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "http.sslVerify=true", ...trust, "-c", "fetch.recurseSubmodules=false", "-c", "push.recurseSubmodules=false"];
  // A private bare repository avoids checkout filters, project hooks and changes to the user's index/branch.
  const parent = realpathSync.native(tmpdir()), temporary = mkdtempSync(join(parent, `${options.product}-forge-`));
  let proof: ReturnType<typeof lstatSync> | undefined, created = false, branch: string | undefined, pushed = false;
  try {
    securePrivateDirectory(temporary); proof = lstatSync(temporary);
    const execute = (args: string[], input?: string, extra: Record<string, string> = {}) => command(options, git, [...flags, ...args], { cwd: temporary, environment: { ...environment, ...extra }, ...(input !== undefined ? { input } : {}) });
    await execute(["init", "--bare", "--template=", "."]);
    await execute(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", clone.href, `refs/heads/${repo["default_branch"]}`]);
    const base = await execute(["rev-parse", "FETCH_HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw Error("Révision Git du dépôt invalide.");
    if (await execute(["ls-tree", "--name-only", base, "--", path])) throw Error(`Le fichier ${path} existe déjà ; relisez-le manuellement avant toute modification.`);
    let secret = await options.ui.secret(`Secret de service dédié à ${name} : ${cfg.secretName}. Saisie masquée, envoi direct au coffre de la forge. Aucun identifiant de connexion à la forge n’est demandé.`);
    if (secret === undefined) return "Installation annulée ; aucun secret ni branche créé.";
    if (secret) options.remember(secret);
    if (!secret || secret.length > 8192 || /[\u0000-\u0020\u007f]/.test(secret)) { secret = ""; throw Error("Secret invalide : valeur non vide sans espace ni caractère de contrôle, au plus 8192 caractères."); }
    try {
      await requireUnusedSecret();
      await cli(["secret", "set", cfg.secretName, "--repo", target, "--app", "actions"], secret, true); created = true;
    }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Le secret ")) throw error;
      throw Error(`Secret non créé ou non confirmé : vérifiez le coffre du dépôt, puis ajoutez ${cfg.secretName} manuellement s’il est absent. Installation arrêtée avant la branche et la demande de fusion.`);
    }
    finally { secret = ""; }
    const secrets = await json(["secret", "list", "--repo", target, "--app", "actions", "--json", "name"]);
    if (!Array.isArray(secrets) || !secrets.some(value => record(value)["name"] === cfg.secretName)) throw Error("Présence du secret dans le coffre non confirmée.");
    const index = { GIT_INDEX_FILE: join(temporary, "installation.index") };
    await execute(["read-tree", base], undefined, index);
    const blob = await execute(["hash-object", "-w", "--stdin"], source);
    if (!/^[a-f0-9]{40,64}$/.test(blob)) throw Error("Objet Git du flux invalide.");
    await execute(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, index);
    const tree = await execute(["write-tree"], undefined, index);
    const commit = await execute(["commit-tree", tree, "-p", base], `Configurer l’application ${options.app}\n`, { GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Error("Commit Git du flux invalide.");
    branch = `${options.product}/install-forge-${randomUUID()}`;
    await execute(["update-ref", "refs/heads/" + branch, commit]);
    await execute(["push", clone.href, `refs/heads/${branch}:refs/heads/${branch}`]); pushed = true;
    const body = join(temporary, "request.md");
    writeFileSync(body, `Installation de l’application ${options.app} sur ${name}.\n\nFlux réutilisable de la société : ${cfg.workflow}.\nMode : ${mode}. Secret : ${cfg.secretName}, conservé uniquement dans le coffre de la forge.\n\nRelisez le flux et ses permissions avant toute fusion.\n`, { flag: "wx", mode: 0o600 });
    const url = https(await cli(["pr", "create", "--repo", target, "--head", branch, "--base", repo["default_branch"], "--title", `Configurer ${options.app}`, "--body-file", body]));
    if (url.origin !== forge.origin || !new RegExp(`^/${name.replaceAll(".", "\\.")}/pull/[1-9][0-9]*$`).test(url.pathname)) throw Error("Adresse de demande de fusion incohérente.");
    const request = record(await json(["pr", "view", url.href, "--repo", target, "--json", "url,state,headRefName,baseRefName,files"]));
    if (request["url"] !== url.href || request["state"] !== "OPEN" || request["headRefName"] !== branch || request["baseRefName"] !== repo["default_branch"] || !Array.isArray(request["files"]) || request["files"].length !== 1 || record(request["files"][0])["path"] !== path) throw Error("Contenu de la demande de fusion non confirmé.");
    return `Demande de fusion ouverte et vérifiée : ${url.href}\nFlux : ${path}. Secret présent dans le coffre : ${cfg.secretName}. Relisez puis fusionnez vous-même la demande.`;
  } catch (error) {
    const cause = error instanceof Error && /^(?:Secret non créé|Secret invalide|Le secret |Le fichier |Identité Git utilisateur)/.test(error.message) ? error.message : "Installation arrêtée : vérifiez les droits de publication des flux, la disponibilité des services et le contrat du flux.";
    throw Error(cause + (created ? ` Le secret ${cfg.secretName} a déjà été créé dans le coffre ; sa suppression éventuelle relève de l’administrateur.` : "") + (pushed ? ` La branche ${branch} a été poussée et reste à relire ; aucune fusion n’a été demandée.` : ""));
  } finally {
    const now = lstatSync(temporary);
    if (proof && !now.isSymbolicLink() && now.isDirectory() && now.dev === proof.dev && now.ino === proof.ino && realpathSync.native(temporary) === temporary && ownedByCurrentUser(temporary)) rmSync(temporary, { recursive: true });
  }
}
