// Supports: SPEC-EXT-021 CA-02 (native evidence through the existing skill and ordinary product tools).
import {test,expect} from "bun:test";
import {join,resolve} from "node:path";
import {mkdirSync,writeFileSync} from "node:fs";
const root=resolve(import.meta.dir,".."),runtime=process.env.WC_BATCH_NATIVE_BUN,available=process.platform==="win32"&&!!runtime;
const wsl=(...args:string[])=>["wsl.exe","-d",process.env.WC_NATIVE_LINUX_DISTRIBUTION??"Ubuntu","--user","root","--exec",...args];
async function command(args:string[]){const child=Bun.spawn(args,{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"});const[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error(JSON.stringify({code,out,err}));return out.trim();}
let pending:Promise<any>|undefined;
function proof(){return pending??=(async()=>{
  const output=join(root,"build/ext021");mkdirSync(output,{recursive:true});
  await command([process.execPath,"--no-env-file","build","tests/fixtures/batch-native-proof.ts","--target=bun","--outfile",join(output,"proof.js")]);
  const owned=await command(wsl("/usr/bin/mktemp","-d","/var/tmp/whitecode-native-tests-1mstsgkw/ext021-proof-XXXXXX"));
  if(!/^\/var\/tmp\/whitecode-native-tests-1mstsgkw\/ext021-proof-[A-Za-z0-9]{6}$/.test(owned))throw Error("Private proof root required.");
  try{
    const bundle=await command(wsl("/usr/bin/wslpath","-u",join(output,"proof.js")));
    const text=await command(wsl(runtime!,"--no-env-file",bundle,owned,runtime!)),receipt=JSON.parse(text);
    writeFileSync(join(output,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
    writeFileSync(join(output,"permission-evidence.json"),await command(wsl("/usr/bin/cat",owned+"/permission-evidence.json"))+"\n");
    for(const page of receipt.reviewPages)writeFileSync(join(output,"review-"+page.url.split("/").at(-1)+".html"),page.html);
    return receipt;
  }finally{
    await command(wsl("/usr/bin/python3","-c","import pathlib,sys,json,shutil; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/var/tmp/whitecode-native-tests-1mstsgkw') and p.name.startswith('ext021-proof-') and p.is_dir() and not p.is_symlink(); m=p/'ownership.json'; assert not m.exists() or json.loads(m.read_text())['purpose']=='ext021-native-proof'; shutil.rmtree(p)",owned));
  }
})();}
test.skipIf(!available)("SPEC-EXT-021/CA-02 — the actual batch skill rejects a write before ordinary plan approval and creates separate native Git worktrees afterwards",async()=>{const r=await proof();expect(r.approvedPlan).toBe(true);expect(r.planningEnforced).toBe(true);expect(r.realWorktrees).toBe(true);expect(new Set(r.gitDirectories).size).toBe(3);},120000);
test.skipIf(!available)("SPEC-EXT-021/CA-02 — a real targeted test fails while two other agents publish real branches and consultable HTTPS review requests",async()=>{const r=await proof();expect(r.realTargetedFailure).toBe(true);expect(r.independentSuccesses).toBe(2);expect(r.reviews).toHaveLength(2);expect(r.consultableHttpsReviews).toBe(true);expect(r.summary).toContain("FAILED beta");for(const review of r.reviews)expect(r.summary).toContain(review.url);},120000);
test.skipIf(!available)("SPEC-EXT-021/CA-02 — synthesis follows observed background reports, never merges and preserves the original dirty repository and failed copy",async()=>{const r=await proof();expect(r.summary).toContain("1 fail");expect(r.originalPreserved).toBe(true);expect(r.noMerge).toBe(true);expect(r.failedCopyKept).toBe(true);},120000);
test.skipIf(!available)("SPEC-EXT-021/CA-02 — native detached agents obey a bound and inherit ordinary labelled human permission for both pushes",async()=>{const r=await proof();expect(r.peakAgents).toBe(2);expect(r.permissionCount).toBeGreaterThanOrEqual(8);expect(r.delegatedPermissions).toBeGreaterThanOrEqual(4);expect(r.pushPermissions).toBe(2);},120000);
