// Supports: SPEC-API-015 (native CLI, configured commands and signed HTTP requests).
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadIdentity, ROOT, TEST_USER_CONFIG, workspace } from "./helpers/env";
import { productEnv, BUN } from "./helpers/hooks";
import { createHash, createHmac } from "node:crypto";
import { CloudCredentials, parseAwsExport } from "../src/auth/cloud-credentials";
import { tmpdir } from "node:os";
import { comparablePath, realPathOrSelf } from "../src/platform/system";
import { tryFileLock } from "../src/platform/file-lock";

function verified(req: Request, body: string, secret: string): boolean {
  const authorization = req.headers.get("authorization") ?? "", match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!match) return false;
  const url = new URL(req.url), names = match[3]!.split(";"), hash = (value: string) => createHash("sha256").update(value).digest("hex"), hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const canonical = ["POST", url.pathname, "", names.map(name => name + ":" + req.headers.get(name) + "\n").join(""), names.join(";"), hash(body)].join("\n");
  const [day, region, service, terminator] = match[2]!.split("/");
  if (region !== "us-test-1" || service !== "bedrock" || terminator !== "aws4_request") return false;
  const key = hmac(hmac(hmac(hmac("AWS4" + secret, day!), region!), service!), terminator!);
  return createHmac("sha256", key).update(["AWS4-HMAC-SHA256", req.headers.get("x-amz-date"), match[2], hash(canonical)].join("\n")).digest("hex") === match[4];
}

const tree = (path: string): string => readdirSync(path, { withFileTypes: true }).map(entry => entry.isDirectory() ? tree(join(path, entry.name)) : readFileSync(join(path, entry.name), "utf8")).join("\n");
async function scenario(options: { concurrent?: boolean; fail?: boolean; projectOnly?: boolean; rejectedAgain?: boolean; missing?: boolean; tools?: boolean } = {}) {
  const ws = workspace(), identity = loadIdentity(), auth: string[] = [], freshSecret = "fixture-fresh-cloud-secret-3581", freshToken = "fixture-fresh-cloud-session-3581";
  const toolResults:unknown[]=[];
  let oldRequests = 0, release!: () => void;
  const both = new Promise<void>(resolve => release = resolve);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const header = req.headers.get("authorization") ?? ""; auth.push(header);
    const payload = await req.text();
    if (!verified(req, payload, header.includes("Credential=old-access/") ? "old-fixture-secret" : freshSecret)) return new Response("signature mismatch", { status: 403 });
    if (header.includes("Credential=old-access/")) {
      oldRequests++; if (oldRequests >= 2) release();
      if (options.concurrent) await both;
      return Response.json({ message: "expired credentials" }, { status: 403, headers: { "x-amzn-errortype": "ExpiredTokenException" } });
    }
    if (options.rejectedAgain) return Response.json({ message: "still expired" }, { status: 403, headers: { "x-amzn-errortype": "ExpiredTokenException" } });
    if (!header.includes("Credential=new-access/") || req.headers.get("x-amz-security-token") !== freshToken) return new Response("wrong credentials", { status: 403 });
    const body = JSON.parse(payload);
    if (!Array.isArray(body.messages) || !body.inferenceConfig) return new Response("wrong protocol", { status: 400 });
    if(options.tools){
      const result=body.messages.flatMap((message:any)=>message.content).find((part:any)=>part.toolResult?.toolUseId==="cloud-read");
      if(!result)return Response.json({output:{message:{role:"assistant",content:[{toolUse:{toolUseId:"cloud-read",name:"read_file",input:{path:join(ws.project,"evidence.txt")}}}]}},stopReason:"tool_use",usage:{inputTokens:12,outputTokens:7,totalTokens:19}});
      toolResults.push(result);
      if(!JSON.stringify(result).includes("CLOUD_TOOL_EVIDENCE_3581"))return new Response("missing tool output",{status:400});
    }
    return Response.json({ output: { message: { role: "assistant", content: [{ text: "cloud request renewed " + freshSecret }] } }, stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } });
  } });
  const count = join(ws.root, "renewals");
  ws.write("project/evidence.txt","CLOUD_TOOL_EVIDENCE_3581");
  const refresh = ws.write("refresh.ts", `import {existsSync,readFileSync,writeFileSync} from 'node:fs'; const file=${JSON.stringify(count)}; writeFileSync(file,String((existsSync(file)?Number(readFileSync(file,'utf8')):0)+1)); console.log('Cloud sign-in code: EXAMPLE-3581'); await new Promise(resolve=>setTimeout(resolve,200)); process.exit(${options.fail ? 4 : 0});`);
  const exporter = ws.write("export.ts", `console.log(JSON.stringify({Version:1,AccessKeyId:'new-access',SecretAccessKey:${JSON.stringify(freshSecret)},SessionToken:${JSON.stringify(freshToken)},Expiration:new Date(Date.now()+3600000).toISOString()}));`);
  const authConfig = { cloudCredentialRefresh: { aws: { refresh: `"${BUN}" "${refresh.replace(/\\/g,"/")}"`, export: `"${BUN}" "${exporter.replace(/\\/g,"/")}"` } } };
  const config = { ...TEST_USER_CONFIG, api: { provider: "bedrock", baseUrl: `http://127.0.0.1:${server.port}`, maxRetries: 0 }, models: { selected: "cloud-model", extraCatalog: [{ id: "cloud-model", provider: "bedrock", family: "fixture-cloud", label: "Cloud model", contextWindow: 128000, maxOutputTokens: 1024, capabilities: { toolCalling: true } }] }, ...(options.projectOnly ? {} : { auth: authConfig }) };
  ws.write("home/config/config.json", JSON.stringify(config));
  if (options.projectOnly) ws.write(`project/${identity.get("PROJECT_DIR")}/config.json`, JSON.stringify({ auth: authConfig }));
  const entry = ws.write("entry.ts", `import {runCli} from ${JSON.stringify(join(ROOT,"src/headless/run.ts"))}; import {processStreams} from ${JSON.stringify(join(ROOT,"src/platform/io.ts"))}; import {systemInfo} from ${JSON.stringify(join(ROOT,"src/platform/system.ts"))}; import {Identity} from ${JSON.stringify(join(ROOT,"src/identity/identity.ts"))}; import {ModelCatalog} from ${JSON.stringify(join(ROOT,"src/providers/catalog.ts"))}; import {readFileSync} from 'node:fs'; process.exit(await runCli(process.argv.slice(2),{streams:processStreams(),cwd:process.cwd(),environment:process.env,system:{...systemInfo(),home:${JSON.stringify(ws.home)}},identity:new Identity(${JSON.stringify(identity.resolved)}),catalog:new ModelCatalog(JSON.parse(readFileSync(${JSON.stringify(join(ROOT,"tests/fixtures/test.models.json"))},'utf8'))),managedDir:${JSON.stringify(ws.managed)}}));`);
  const run = async () => {
    const child = Bun.spawn([process.execPath,"--no-env-file",entry,"--non-interactive",...(options.projectOnly?["--allow-project-trust"]:[]),"Work"], { cwd: ws.project, env: productEnv(ws,{[identity.get("ENV_PREFIX")+"CONFIG_HOME"]:ws.configHome,...(options.missing?{}:{AWS_ACCESS_KEY_ID:"old-access",AWS_SECRET_ACCESS_KEY:"old-fixture-secret",AWS_SESSION_TOKEN:"old-fixture-session"}),AWS_REGION:"us-test-1"}),stdout:"pipe",stderr:"pipe" });
    const timer=setTimeout(()=>child.kill(),25000);
    try { const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]); return {stdout,stderr,code}; }
    finally { clearTimeout(timer); }
  };
  try { const results = await Promise.all(Array.from({length:options.concurrent?2:1},()=>run())); return {results,auth,count:existsSync(count)?Number(readFileSync(count,"utf8")):0,disk:tree(ws.configHome),freshSecret,freshToken,toolResults}; }
  finally { release();server.stop(true); }
}

test("SPEC-API-015/CA-01 — a rejected signed cloud request runs the approved refresh and export commands, then succeeds without persisting credentials", async () => {
  const run=await scenario({tools:true}), result=run.results[0]!;
  expect(result.code,result.stderr+result.stdout+JSON.stringify(run.toolResults)).toBe(0);expect(result.stdout).toContain("cloud request renewed");expect(result.stderr).toContain("EXAMPLE-3581");expect(run.count).toBe(1);expect(run.auth).toHaveLength(3);
  expect(run.auth[0]).toContain("Credential=old-access/");expect(run.auth[1]).toContain("Credential=new-access/");
  expect(JSON.stringify(run.toolResults)).toContain("CLOUD_TOOL_EVIDENCE_3581");
  for(const secret of [run.freshSecret,run.freshToken])expect(result.stdout+result.stderr+run.disk).not.toContain(secret);
},30000);

test("TECH — missing initial cloud credentials are refreshed before the request and redacted from its first response", async () => {
  const run=await scenario({missing:true}),result=run.results[0]!;
  expect(result.code).toBe(0);expect(run.count).toBe(1);expect(run.auth).toHaveLength(1);expect(result.stdout).toContain("cloud request renewed");
  expect(result.stdout+result.stderr+run.disk).not.toContain(run.freshSecret);expect(result.stdout+result.stderr+run.disk).not.toContain(run.freshToken);
},30000);

test("TECH — two CLI sessions share one cloud refresh, each exports credentials into its own memory",async()=>{
  const run=await scenario({concurrent:true});expect(run.results.map(result=>result.code),JSON.stringify({results:run.results,requests:run.auth.length,renewals:run.count})).toEqual([0,0]);expect(run.count).toBe(1);expect(run.auth).toHaveLength(4);
},30000);

test("TECH — a failing cloud refresh, another rejection and a project command cannot loop or run unapproved commands",async()=>{
  const failed=await scenario({fail:true});expect(failed.results[0]!.code).not.toBe(0);expect(failed.count).toBe(1);expect(failed.auth).toHaveLength(1);
  const twice=await scenario({rejectedAgain:true});expect(twice.results[0]!.code).not.toBe(0);expect(twice.count).toBe(1);expect(twice.auth).toHaveLength(2);
  const project=await scenario({projectOnly:true});expect(project.results[0]!.code).not.toBe(0);expect(project.count).toBe(0);expect(project.results[0]!.stderr).toContain("auth.cloudCredentialRefresh");
},60000);

test("TECH — a cancelled cloud waiter leaves another waiter running and neither export output nor credentials are logged", async () => {
  const ws=workspace(), script=ws.write("refresh.ts","console.log('refresh-started'); await new Promise(resolve=>setTimeout(resolve,150));"), exportScript=ws.write("export.ts","console.error('fixture-private-export-output'); console.log(JSON.stringify({Version:1,AccessKeyId:'access',SecretAccessKey:'fixture-private-export-output',Expiration:new Date(Date.now()+60000).toISOString()}));"), first=new AbortController(), second=new AbortController(), notices:string[]=[], secrets:string[]=[];
  const credentials=new CloudCredentials({commands:{refresh:`"${BUN}" "${script}"`,export:`"${BUN}" "${exportScript}"`},service:"cloud-cancel",home:ws.home,cwd:ws.project,env:productEnv(ws),remember:value=>secrets.push(value),report:value=>{notices.push(value);first.abort();},assertCurrent:()=>{}});
  try {
    const one=credentials.get(first.signal), two=credentials.get(second.signal);
    await expect(one).rejects.toThrow();
    const value=JSON.parse(await two);expect(value.secretAccessKey).toBe("fixture-private-export-output");expect(secrets).toContain("fixture-private-export-output");expect(notices.join("")).not.toContain("fixture-private-export-output");
  } finally {await credentials.close();}
},10000);

test("TECH — expired or malformed AWS exports are rejected without including their bytes",()=>{
  for(const row of [{AccessKeyId:'fixture-secret'},{AccessKeyId:'a',SecretAccessKey:'fixture-secret',Expiration:'invalid'},{AccessKeyId:'a',SecretAccessKey:'fixture-secret',Expiration:'2001-01-01T00:00:00Z'},null]){
    let message='';try{parseAwsExport(JSON.stringify(row));}catch(error){message=(error as Error).message;}expect(message).not.toBe('');expect(message).not.toContain('fixture-secret');
  }
});

test("TECH — cloud command timeout and policy revocation stop before export; a dead lock owner does not leave a stale mutex",async()=>{
  const ws=workspace(), refresh=ws.write("slow.ts","console.log('started'); await new Promise(resolve=>setTimeout(resolve,5000));"), exporter=ws.write("export.ts","console.log(JSON.stringify({Version:1,AccessKeyId:'a',SecretAccessKey:'s'}));");
  const base={commands:{refresh:`"${BUN}" "${refresh}"`,export:`"${BUN}" "${exporter}"`},service:"cloud-timeout",home:ws.home,cwd:ws.project,env:productEnv(ws),remember:()=>{},report:()=>{},assertCurrent:()=>{},refreshTimeoutMs:300};
  const timed=new CloudCredentials(base);
  try{await expect(timed.get(new AbortController().signal)).rejects.toThrow("impossible");}finally{await timed.close();}
  let revoked=false;
  const denied=new CloudCredentials({...base,service:"cloud-revoked",refreshTimeoutMs:2000,report:()=>{revoked=true;},assertCurrent:()=>{if(revoked)throw new Error("revoked");}});
  try{await expect(denied.get(new AbortController().signal)).rejects.toThrow();}finally{await denied.close();}
  const immediate=ws.write("ready.ts","console.log('ready');"), unlocked=new CloudCredentials({...base,service:"cloud-dead-owner",commands:{refresh:`"${BUN}" "${immediate}"`,export:base.commands.export}});
  const directory=join(tmpdir(),"cloud-auth-"+createHash("sha256").update("cloud-dead-owner\n"+comparablePath(realPathOrSelf(ws.home))).digest("hex")), lock=join(directory,"refresh.lock");
  const owner=ws.write("owner.ts",`import {tryFileLock} from ${JSON.stringify(join(ROOT,"src/platform/file-lock.ts"))}; const release=tryFileLock(${JSON.stringify(lock)});if(!release)process.exit(1);console.log('locked');setInterval(()=>{},1000);`);
  const child=Bun.spawn([process.execPath,"--no-env-file",owner],{env:productEnv(ws),stdout:"pipe",stderr:"pipe"}),reader=child.stdout.getReader(),timer=setTimeout(()=>child.kill(),3000);
  try{const chunk=await reader.read();expect(new TextDecoder().decode(chunk.value)).toContain("locked");expect(tryFileLock(lock)).toBeUndefined();child.kill();await child.exited;const value=await unlocked.get(new AbortController().signal);expect(JSON.parse(value).accessKeyId).toBe('a');}
  finally{clearTimeout(timer);child.kill();await child.exited;await reader.cancel();await unlocked.close();}
},15000);
