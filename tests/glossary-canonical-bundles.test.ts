// Real main bundles and generated profiles; never writes generated files in the calling checkout.
import {beforeAll,expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {createHash} from "node:crypto";
import {BUILD_OPTIONS,resolveBuildOptions,type BuildFlagName,type BuildProfile} from "../src/extension-points/build-options";
import {activationProfile} from "./helpers/activation-profile";
import {ACTIVATION_MARKERS,CANONICAL_MARKERS} from "./helpers/activation-markers";
const reduced=Object.fromEntries(Object.keys(BUILD_OPTIONS).filter(name=>!name.startsWith("libc_variant_")).map(name=>[name,false]));
type Bundle={root:string;environment:Record<string,string>;profile:BuildProfile;overrides:Record<string,boolean>;source:string;output:string;inventory:string};
const bundles=new Map<string,Bundle>();
function command(f:Pick<Bundle,"root"|"environment">,args:string[],timeout=30000){const r=spawnSync(process.execPath,["--no-env-file",...args],{cwd:f.root,env:f.environment,encoding:"utf8",windowsHide:true,timeout,maxBuffer:3000000});if(r.status!==0)throw Error(r.stdout+r.stderr+String(r.error??""));return r;}
beforeAll(()=>{
  for(const[name,profile,overrides]of [["public","public",{}],["internal","internal",{}],["development","development",{}],["test","test",{}],["internal-reduced","internal",reduced],["test-reduced","test",reduced]] as Array<[string,BuildProfile,Record<string,boolean>]>) {
    const f=activationProfile(profile,overrides),output=join(f.root,"build/canonical-matrix/main.mjs"),inventory=join(f.root,"tests/compiled/activation-inventory-probe.js");mkdirSync(dirname(output),{recursive:true});mkdirSync(dirname(inventory),{recursive:true});
    command(f,["build","src/main.ts","--target=bun","--minify","--outfile",output]);
    command(f,["build","tests/fixtures/activation-inventory-probe.ts","--target=bun","--minify","--outfile",inventory]);
    const source=readFileSync(output,"utf8").replace(/\\x([a-f0-9]{2})|\\u([a-f0-9]{4})/gi,(_match,hex,unicode)=>String.fromCharCode(parseInt(hex??unicode,16)));
    bundles.set(name,{...f,profile,overrides,source,output,inventory});
    writeFileSync(join(dirname(output),"bundle-proof.json"),JSON.stringify({name,profile,overrides,sha256:createHash("sha256").update(readFileSync(output)).digest("hex")},null,2));
  }
},180000);
test("TECH — six real main bundles remove capability bodies and descriptions according to profiles and explicit omissions",()=>{
  expect(Object.keys(ACTIVATION_MARKERS)).toHaveLength(31);
  for(const[name,b]of bundles){const values=resolveBuildOptions(b.profile,b.overrides);
    for(const[flag,m]of Object.entries(ACTIVATION_MARKERS)){const included=values[flag as BuildFlagName]&&(!m.internal||b.profile==="internal");for(const marker of [...m.body,...(m.description??[])])expect({bundle:name,flag,marker,present:b.source.includes(marker)}).toEqual({bundle:name,flag,marker,present:included});}
    // These are the actual two local JSON parsers; the identity diagnostic's unrelated overrides are retained.
    const overrideParsers=[...b.source.matchAll(/JSON\.parse\([^;]{0,100}\.overrides\)/g)].length;expect({bundle:name,overrideParsers}).toEqual({bundle:name,overrideParsers:values.config_feature_overrides?2:0});
    for(const[flag,definition]of Object.entries(BUILD_OPTIONS))if(!values[flag as BuildFlagName])for(const marker of definition.absentMarkers)expect(b.source.includes(marker),name+" "+flag+" "+marker).toBe(false);
    expect(b.source.includes("Wait without a shell process"),name+" shared wait capability").toBe(values.mode_self_initiated||values.mode_assistant_persistent);
  }
},30000);
test("TECH — canonical capabilities have their actual bodies removed independently of the exact 134-name registry",()=>{
  expect(Object.keys(CANONICAL_MARKERS)).toHaveLength(33);
  for(const[name,b]of bundles){const values=resolveBuildOptions(b.profile,b.overrides);
    for(const[flag,m]of Object.entries(CANONICAL_MARKERS)){const included=values[flag as BuildFlagName]&&(!m.internal||b.profile==="internal")&&!(m.unlessDiscreet&&b.profile==="internal"&&values.ui_internal_notices);for(const marker of [...m.body,...(m.description??[])])expect({bundle:name,flag,marker,present:b.source.includes(marker)}).toEqual({bundle:name,flag,marker,present:included});}
    expect(/\.shellShadow\b/.test(b.source),name+" shell observer access").toBe(values.shell_syntax_analysis&&values.shell_syntax_analysis_shadow);
  }
},30000);
test("TECH — generated inventory and product entry point stay fixed despite forged profile and option environment variables",()=>{
  for(const[name,b]of bundles){const environment={...b.environment,BUILD_PROFILE:"internal",WC_BUILD_PROFILE:"internal",WC_BUILD_OPTIONS:JSON.stringify(Object.fromEntries(Object.keys(BUILD_OPTIONS).map(flag=>[flag,true])))};
    const proof=JSON.parse(command({...b,environment},[b.inventory]).stdout) as {profile:string;values:unknown};expect(proof.profile).toBe(b.profile);expect(proof.values).toEqual(resolveBuildOptions(b.profile,b.overrides));
    const result=command({...b,environment},[b.output,"--version"]);expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);writeFileSync(join(dirname(b.output),"entry-proof.json"),JSON.stringify({name,code:result.status,stdout:result.stdout,stderr:result.stderr,inventory:proof},null,2));
  }
},30000);
