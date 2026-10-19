// Supports: SPEC-AGT-012/015 (real process panes, leader death and reattachment, not metadata alone).
import {expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {ROOT} from "./helpers/env";
const runtime=process.env["WC_TEAM_NATIVE_BUN"];
const available=process.platform==="win32"&&!!runtime;
let evidence:Promise<Record<string,unknown>>|undefined;
async function command(args:string[]):Promise<string>{
 const child=Bun.spawn(args,{cwd:ROOT,stdout:"pipe",stderr:"pipe"});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw Error(`Native team bench failed (${code}): ${out}\n${err}`);return out.trim();
}
function proof(){return evidence??=(async()=>{
 const wsl=(...args:string[])=>["wsl.exe","-d","Ubuntu","--user","root","--cd","/tmp","--exec",...args];
 const project=await command(wsl("/usr/bin/wslpath","-u",ROOT)),native=await command(wsl("/usr/bin/wslpath","-w",runtime!));
 await command([process.execPath,"--no-env-file","build","src/main.ts","--compile","--target=bun-linux-x64","--compile-executable-path",native,"--no-compile-autoload-dotenv","--no-compile-autoload-bunfig","--outfile",join(ROOT,"build/team-worker-linux")]);
 const output=await command(wsl("/usr/bin/python3",project+"/tests/fixtures/team-panel-native.py",runtime!,project)),result=JSON.parse(output) as Record<string,unknown>;
 mkdirSync(join(ROOT,"build"),{recursive:true});writeFileSync(join(ROOT,"build/lot9-increment63-team-native-evidence.json"),JSON.stringify(result,null,2)+"\n");return result;
})();}
test.skipIf(!available)("SPEC-AGT-012/CA-01 — the real product runs in a separate tmux pane with isolated environment and ordinary file permissions",async()=>{
 const result=await proof();expect(result.passed).toBe(true);expect(result.deniedReadPreserved).toBe(true);expect(result.serverAndDotenvSecretsAbsent).toBe(true);expect(result.compiledDotenvAndBunfigDisabled).toBe(true);expect(result.workerDeathRevokesSuspendedTool).toBe(true);
},60000);
test.skipIf(!available)("SPEC-AGT-015/CA-01 — after real leader death the same worker and pane reattach and deliver unread messages and report",async()=>{
 const result=await proof();expect(result.sameWorker).toBe(true);expect(result.unreadMessageAndReportDelivered).toBe(true);expect(result.workerPid).not.toBe(result.leaderPid);expect(result.orphanSelfStops).toBe(true);
},60000);
