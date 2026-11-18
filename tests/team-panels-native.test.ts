// Supports: SPEC-AGT-012/015 (real process panes, leader death and reattachment, not metadata alone).
// Supports: SPEC-AGT-012/015 (native compilation precedes the unchanged timed behavioral bench), gap E-321.
// Supports: SPEC-AGT-012/015 (independent native scenarios retain their original assertions and deadlines), gap E-335.
import {beforeAll,expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {ROOT} from "./helpers/env";
const runtime=process.env["WC_TEAM_NATIVE_BUN"];
const available=process.platform==="win32"&&!!runtime;
let preparation:Promise<{project:string;compilationMs:number}>|undefined;
async function command(args:string[]):Promise<string>{
 const child=Bun.spawn(args,{cwd:ROOT,stdout:"pipe",stderr:"pipe"});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw Error(`Native team bench failed (${code}): ${out}\n${err}`);return out.trim();
}
const wsl=(...args:string[])=>["wsl.exe","-d","Ubuntu","--user","root","--cd","/tmp","--exec",...args];
function prepare(){return preparation??=(async()=>{
 const project=await command(wsl("/usr/bin/wslpath","-u",ROOT)),native=await command(wsl("/usr/bin/wslpath","-w",runtime!));
 const compilationStarted=performance.now();
 await command([process.execPath,"--no-env-file","build","src/main.ts","--compile","--target=bun-linux-x64","--compile-executable-path",native,"--no-compile-autoload-dotenv","--no-compile-autoload-bunfig","--outfile",join(ROOT,"build/team-worker-linux")]);
 return {project,compilationMs:performance.now()-compilationStarted};
})();}
beforeAll(async()=>{if(available)await prepare();},60000);
async function proof(scenario:"panes"|"lifecycle"){
 const {project,compilationMs}=await prepare(),benchStarted=performance.now();
 const output=await command(wsl("/usr/bin/python3",project+"/tests/fixtures/team-panel-native.py",runtime!,project,scenario)),result=JSON.parse(output) as Record<string,unknown>;
 const measured:Record<string,unknown>={...result,compilationMs,benchMs:performance.now()-benchStarted};
 mkdirSync(join(ROOT,"build"),{recursive:true});writeFileSync(join(ROOT,`build/team-native-${scenario}-evidence.json`),JSON.stringify(measured,null,2)+"\n");return measured;
}
test.skipIf(!available)("SPEC-AGT-012/CA-01 — the real product runs in a separate tmux pane with isolated environment and ordinary file permissions",async()=>{
 const result=await proof("panes");expect(result.passed).toBe(true);expect(result.deniedReadPreserved).toBe(true);expect(result.serverAndDotenvSecretsAbsent).toBe(true);expect(result.compiledDotenvAndBunfigDisabled).toBe(true);expect(result.workerDeathRevokesSuspendedTool).toBe(true);
},60000);
test.skipIf(!available)("SPEC-AGT-015/CA-01 — after real leader death the same worker and pane reattach and deliver unread messages and report",async()=>{
 const result=await proof("lifecycle");expect(result.sameWorker).toBe(true);expect(result.unreadMessageAndReportDelivered).toBe(true);expect(result.workerPid).not.toBe(result.leaderPid);expect(result.orphanSelfStops).toBe(true);
},60000);
