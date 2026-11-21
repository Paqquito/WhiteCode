// Supports: SPEC-CMD-091 CA-01 (actual internal command, HTTPS service, Git and isolated product).
import {test,expect} from "bun:test";
import {join,resolve} from "node:path";
import {cpSync,mkdirSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
const root=resolve(import.meta.dir,".."),runtime=process.env.WC_HANDOFF_NATIVE_BUN,available=process.platform==="win32"&&!!runtime;
const wsl=(...args:string[])=>["wsl.exe","-d",process.env.WC_NATIVE_LINUX_DISTRIBUTION??"Ubuntu","--user","root","--exec",...args];
async function command(args:string[],cwd=root){const child=Bun.spawn(args,{cwd,stdin:"ignore",stdout:"pipe",stderr:"pipe"});const[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error(JSON.stringify({code,out,err}));return out.trim();}
let pending:Promise<any>|undefined;
function proof(){return pending??=(async()=>{
  const output=join(root,"build/cmd091"),compilation=join(output,"internal-"+crypto.randomUUID());mkdirSync(compilation,{recursive:true});
  for(const name of ["src","scripts","docs","prompts","identity"])cpSync(join(root,name),join(compilation,name),{recursive:true});
  for(const name of ["package.json","bun.lock","tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES.txt"])cpSync(join(root,name),join(compilation,name));
  mkdirSync(join(compilation,"tests/fixtures"),{recursive:true});cpSync(join(root,"tests/fixtures/handoff-native-proof.ts"),join(compilation,"tests/fixtures/handoff-native-proof.ts"));
  symlinkSync(realpathSync(join(root,"node_modules")),join(compilation,"node_modules"),process.platform==="win32"?"junction":"dir");
  await command([process.execPath,"--no-env-file","scripts/generate.ts","--profile","internal"],compilation);
  await command([process.execPath,"--no-env-file","build","src/main.ts","--compile","--target=bun-linux-x64","--no-compile-autoload-dotenv","--no-compile-autoload-bunfig","--outfile",join(compilation,"product")],compilation);
  await command([process.execPath,"--no-env-file","build","tests/fixtures/handoff-native-proof.ts","--target=bun","--outfile",join(compilation,"proof.js")],compilation);
  const owned=await command(wsl("/usr/bin/mktemp","-d","/var/tmp/whitecode-native-tests-1mstsgkw/cmd091-proof-XXXXXX"));
  if(!/^\/var\/tmp\/whitecode-native-tests-1mstsgkw\/cmd091-proof-[a-zA-Z0-9]{6}$/.test(owned))throw Error("Private proof root required.");
  const unix=(path:string)=>command(wsl("/usr/bin/wslpath","-u",path));
  try{
    const [script,bundle,binary]=await Promise.all([unix(join(root,"tests/fixtures/handoff-native-launch.sh")),unix(join(compilation,"proof.js")),unix(join(compilation,"product"))]);
    const text=await command(wsl("/usr/bin/unshare","--mount","--propagation","private","/bin/sh",script,owned,bundle,runtime!,binary));
    const receipt=JSON.parse(text);writeFileSync(join(output,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");return receipt;
  }finally{
    await command(wsl("/usr/bin/python3","-c","import pathlib,sys,json,shutil; p=pathlib.Path(sys.argv[1]); assert str(p).startswith('/var/tmp/whitecode-native-tests-1mstsgkw/cmd091-proof-') and p.is_dir() and not p.is_symlink(); m=p/'ownership.json'; assert not m.exists() or json.loads(m.read_text())['purpose']=='cmd091-native-proof'; shutil.rmtree(p)",owned));
  }
})();}
test.skipIf(!available)("SPEC-CMD-091/CA-01 — actual internal /handoff confirms ordinary consent and restores Git at another isolated process",async()=>{const r=await proof();expect(r.realCommand).toBe(true);expect(r.ordinaryConsent).toBe(true);expect(r.remoteRestored).toBe(true);expect(r.sourceHead).toBe(r.destinationHead);expect(r.workerStopped).toBe(true);},120000);
test.skipIf(!available)("SPEC-CMD-091/CA-01 — real HTTPS Git publishes the temporary branch and the actual product receives complete history in the selected environment",async()=>{const r=await proof();expect(r.realHttpsGit).toBe(true);expect(r.historyConsumed).toBe(true);expect(r.environment).toBe("second");expect(r.localRecoverable).toBe(true);},120000);
test.skipIf(!available)("SPEC-CMD-091/CA-01 — refusal, actual push cancellation and HTTPS service failures preserve exact staged, unstaged and untracked source files",async()=>{const r=await proof();expect(r.consentRefused).toBe(true);expect(r.pushCancelledSafely).toBe(true);expect(r.pushFailedSafely).toBe(true);expect(r.serviceFailedSafely).toBe(true);},120000);
test.skipIf(!available)("SPEC-CMD-091/CA-01 — excluded files, linked files and hidden special index states explicitly refuse transfer",async()=>{const r=await proof();expect(r.excludedSafely).toBe(true);expect(r.specialIndexRefused).toBe(true);expect(r.linkedFilesRefused).toBe(true);},120000);
test.skipIf(!available)("TECH — handoff recovery preserves a different clean branch until the original branch is restored",async()=>{const r=await proof();expect(r.otherCleanBranchPreserved).toBe(true);},120000);
test.skipIf(!available)("TECH — actual handoff rechecks a remote-only policy revoked during ordinary consent",async()=>{const r=await proof();expect(r.remotePolicyRevokedDuringConsent).toBe(true);},120000);
