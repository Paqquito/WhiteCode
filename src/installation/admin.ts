// Implements: SPEC-INS-004 (standalone update/check), SPEC-INS-003 (delegate package updates).
// Supports: SPEC-CMD-108 (installation information), E-156.
import type { AdminDependencies } from "../admin/subcommands";
import type { ParsedSubcommand } from "../cli/families";
import { loadConfiguration } from "../config/load";
import { configuredInstallation, installationMethod, packageAdvice, multipleInstallations } from "./runtime";
export async function runInstallationAdmin(deps: AdminDependencies, parsed: ParsedSubcommand, write:(value:unknown,text:()=>string)=>void, out:(text:string)=>void, err:(text:string)=>void):Promise<number> {
  try {
    deps.assertPolicy?.(); if (parsed.args.length) throw new Error('Cette opération ne prend aucun argument.');
    if (parsed.operation === 'update' && deps.env.ownBoolean('OFFLINE_MINIMAL') === true) throw new Error('Mise à jour indisponible en mode minimal hors ligne.');
    const config=loadConfiguration({...deps}); const store=configuredInstallation({ ...deps,configDir:config.locations.configDir,settings:config.settings,fetch:deps.installationFetch,report:parsed.options.has('json')?()=>{}:out });
    const method=installationMethod(deps.installationExecutable??process.execPath,store), advice=packageAdvice(method,deps.identity.get('PRODUCT_CLI'));
    if (parsed.operation==='show') { const result={version:deps.identity.version,method,root:method==='native'?store.o.root:undefined,updateCommand:advice,installations:multipleInstallations(deps.env.public('PATH')??deps.env.public('Path')??'',store.o.cli,deps.system.platform)}; write(result,()=>`${deps.identity.get('PRODUCT')} ${result.version}\nInstallation : ${method}${advice?`\nMise à jour : ${advice}`:''}${result.installations.length>1?'\nAttention : installations multiples.':''}`); return 0; }
    if (config.settings.origin('updates.automatic.enabled')==='managed' && !config.settings.get<boolean>('updates.automatic.enabled')) throw new Error('Les mises à jour sont désactivées par votre organisation.');
    const requested=parsed.options.get('channel'), locked=config.settings.origin('updates.channel')==='managed';
    if (requested!==undefined && !['stable','latest'].includes(String(requested))) throw new Error('Canal invalide : stable ou latest.');
    if (locked && requested!==undefined && requested!==config.settings.get('updates.channel')) throw new Error('Canal imposé par votre organisation.');
    if (advice) { write({version:deps.identity.version,method,updateCommand:advice},()=>`Installation gérée par ${method}. Lancez : ${advice}`); return 2; }
    const target=parsed.options.get('version')??requested??config.settings.get<string>('updates.channel'), release=await store.release(String(target));
    const min=store.minimum(release); if (min) { const {compareVersions}=await import('../platform/semver'); if (compareVersions(release.version,min)<0) throw new Error('Version demandée inférieure au minimum autorisé.'); }
    const check=parsed.options.has('check'); const result=check ? undefined : await store.install(release,parsed.options.has('force'));
    write({before:deps.identity.version,after:result?.version??deps.identity.version,available:release.version,installed:!!result,notes:release.notes,launcher:result?.launcher},()=>check?`Version actuelle : ${deps.identity.version}\nDisponible : ${release.version}\nAucune installation effectuée.`:`Version actuelle : ${deps.identity.version}\nVersion installée : ${result!.version}\n${release.notes}\nAjoutez ${store.bin} au chemin PATH pour le prochain lancement.`); return 0;
  } catch(cause) { err((cause as Error).message); return 1; }
}
