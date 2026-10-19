// Supports: SPEC-API-021 (real attachment, HTTP and subprocess boundaries).
import { expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadIdentity, ROOT, TEST_USER_CONFIG, workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { startFakeAnthropic } from "./helpers/fake-anthropic-server";
import { makePdf } from "./helpers/pdf";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicFiles } from "../src/providers/anthropic-files";
import { testModel } from "./helpers/env";
import type { ModelRequest } from "../src/providers/types";
import { ContentStore } from "../src/session/content-store";
import { retainedHistory } from "../src/session/retained-history";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";

async function scenario(options: { compatible?: boolean; expire?: boolean; denied?: boolean; changed?: boolean } = {}) {
  const ws = workspace(), identity = loadIdentity(), backend = startFakeAnthropic([{ text: "first document received" }, { text: "second document received" }]);
  const bytes = makePdf(["Large attachment " + "x".repeat(300_000)]), uploads: Buffer[] = [], metadata: string[] = [];
  writeFileSync(join(ws.project, "large.pdf"), bytes);
  let active = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/files" && req.method === "POST") {
      const form = await req.formData(), file = form.get("file");
      if (!(file instanceof Blob)) return new Response("missing file", { status: 400 });
      uploads.push(Buffer.from(await file.arrayBuffer())); active = "file_" + uploads.length;
      return Response.json({ id: active, type: "file", filename: "large.pdf", mime_type: "application/pdf", size_bytes: file.size, created_at: new Date().toISOString(), expires_at: null, downloadable: false });
    }
    if (path.startsWith("/v1/files/") && req.method === "GET") {
      metadata.push(path);
      if (options.expire && uploads.length === 1) return Response.json({ type: "error", error: { type: "not_found_error", message: "expired" } }, { status: 404 });
      return Response.json({ id: active, type: "file", filename: "large.pdf", mime_type: "application/pdf", size_bytes: bytes.length, created_at: new Date().toISOString(), expires_at: null, downloadable: false });
    }
    if (options.changed && path === "/v1/messages" && backend.requests.length === 0) writeFileSync(join(ws.project, "large.pdf"), makePdf(["changed document " + "y".repeat(300_000)]));
    return fetch(backend.url + path, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: await req.arrayBuffer() } : {}) });
  } });
  const config = {
    ...TEST_USER_CONFIG, api: { provider: "anthropic", baseUrl: `http://127.0.0.1:${server.port}` },
    models: { selected: "file-model", extraCatalog: [{ id: "file-model", provider: "anthropic", family: "fixture-files", label: "File model", contextWindow: 128000, maxOutputTokens: 1024, capabilities: { toolCalling: true, pdf: true, filesApi: options.compatible !== false } }] },
  };
  ws.write("home/config/config.json", JSON.stringify(config));
  const entry = ws.write("entry.ts", `import {runCli} from ${JSON.stringify(join(ROOT,"src/headless/run.ts"))}; import {processStreams} from ${JSON.stringify(join(ROOT,"src/platform/io.ts"))}; import {systemInfo} from ${JSON.stringify(join(ROOT,"src/platform/system.ts"))}; import {Identity} from ${JSON.stringify(join(ROOT,"src/identity/identity.ts"))}; import {ModelCatalog} from ${JSON.stringify(join(ROOT,"src/providers/catalog.ts"))}; import {readFileSync} from 'node:fs'; process.exit(await runCli(process.argv.slice(2),{streams:processStreams(),cwd:process.cwd(),environment:process.env,system:{...systemInfo(),home:${JSON.stringify(ws.home)}},identity:new Identity(${JSON.stringify(identity.resolved)}),catalog:new ModelCatalog(JSON.parse(readFileSync(${JSON.stringify(join(ROOT,"tests/fixtures/test.models.json"))},'utf8'))),managedDir:${JSON.stringify(ws.managed)}}));`);
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, "--non-interactive", "--request-format", "jsonl", "--result-format", "jsonl", ...(options.denied ? ["--deny-rule", "read_file(large.pdf)"] : [])], { cwd: ws.project, env: productEnv(ws, { [identity.get("ENV_PREFIX") + "CONFIG_HOME"]: ws.configHome, ANTHROPIC_API_KEY: "fixture-file-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` }), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write([1,2].map(n => JSON.stringify({ type: "user", content: `Read document ${n} @large.pdf` })).join("\n") + "\n"); child.stdin.end();
    const timer = setTimeout(() => child.kill(), 25000);
    let result: [string, string, number];
    try { result = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); }
    finally { clearTimeout(timer); }
    const [stdout, stderr, code] = result;
    if (code !== 0) throw new Error(`CLI failed (${code}): ${stderr}\n${stdout.slice(-4000)}`);
    return { stdout, stderr, code, uploads, metadata, requests: backend.requests, bytes: Buffer.from(bytes) };
  } finally { server.stop(true); backend.stop(); }
}

test("SPEC-API-021/CA-01 — a large PDF attached in two CLI requests is uploaded once and both requests use the same service reference", async () => {
  const run = await scenario();
  expect(run.code).toBe(0); expect(run.stdout).toContain("second document received"); expect(run.requests).toHaveLength(2);
  expect(run.uploads).toHaveLength(1); expect(run.uploads[0]!.equals(run.bytes)).toBe(true);
  for (const request of run.requests) {
    const documents = (request.body["messages"] as any[]).flatMap(message => message.content).filter(part => part.type === "document");
    expect(documents.length).toBeGreaterThan(0); expect(documents.every(part => part.source.type === "file" && part.source.file_id === "file_1")).toBe(true);
    expect(JSON.stringify(request.body)).not.toContain(run.bytes.toString("base64"));
  }
}, 30000);

test("TECH — an expired remote document is uploaded again, while a provider without Files API receives inline PDF bytes", async () => {
  const expired = await scenario({ expire: true }); expect(expired.code).toBe(0); expect(expired.uploads).toHaveLength(2); expect(expired.metadata.length).toBeGreaterThan(0);
  expect(JSON.stringify(expired.requests[1]!.body)).toContain('"file_id":"file_2"');
  const inline = await scenario({ compatible: false }); expect(inline.code).toBe(0); expect(inline.uploads).toHaveLength(0); expect(inline.requests).toHaveLength(2);
  expect(JSON.stringify(inline.requests[1]!.body)).toContain(inline.bytes.toString("base64"));
}, 45000);

test("TECH — a denied PDF is never uploaded and a changed PDF receives a new fingerprint", async () => {
  const denied = await scenario({ denied: true }); expect(denied.uploads).toHaveLength(0); expect(denied.stderr).toContain("n'est pas accessible");
  expect(JSON.stringify(denied.requests)).not.toContain(denied.bytes.toString("base64"));
  const changed = await scenario({ changed: true }); expect(changed.uploads).toHaveLength(2); expect(changed.uploads[0]!.equals(changed.uploads[1]!)).toBe(false);
}, 45000);

test("TECH — simultaneous preparations in one session upload a PDF once, and another session owns a separate reference", async () => {
  let uploads = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "POST") { uploads++; await new Promise(resolve => setTimeout(resolve, 50)); }
    return Response.json({ id: "file_" + uploads, type: "file", filename: "a.pdf", mime_type: "application/pdf", size_bytes: 300000, created_at: new Date().toISOString(), expires_at: null, downloadable: false });
  } });
  try {
    const files = new AnthropicFiles(new Anthropic({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: "fixture", maxRetries: 0 }));
    const model = testModel("large"), request: ModelRequest = { conversationId: "one", model: { ...model, capabilities: { ...model.capabilities, pdf: true, filesApi: true } }, system: [], tools: [], history: [{ role: "user", parts: [{ type: "document", mediaType: "application/pdf", name: "a.pdf", dataBase64: Buffer.from(makePdf(["x".repeat(300000)])).toString("base64") }] }], maxOutputTokens: 100, thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false } };
    await Promise.all([files.prepare(request, new AbortController().signal), files.prepare(request, new AbortController().signal)]);
    expect(uploads).toBe(1);
    await files.prepare({ ...request, conversationId: "two" }, new AbortController().signal); expect(uploads).toBe(2);
  } finally { server.stop(true); }
});

test("TECH — retained PDF bytes use the content store and a missing blob becomes an explicit unavailable document", () => {
  const ws = workspace(), store = new ContentStore(join(ws.configHome,"content")), part = { type: "document" as const, name: "a.pdf", sourcePath: join(ws.project,"a.pdf"), mediaType: "application/pdf" as const, dataBase64: Buffer.from(makePdf(["document"])).toString("base64") };
  const encoded = store.encode(part) as {dataBase64:{$contentRef:string;encoding:string}};
  expect(encoded.dataBase64.encoding).toBe("base64");expect(store.decode(encoded)).toEqual(part);
  expect(retainedHistory([{role:"user",parts:[store.decode(encoded)]}])).toHaveLength(1);
  unlinkSync(join(store.root,encoded.dataBase64.$contentRef+".blob"));
  expect(store.decode(encoded)).toEqual({type:"text",text:"[Stored document unavailable.]"});
});

test("TECH — withdrawn PDF permissions apply to inline fallback and uploads before any HTTP request", async () => {
  let calls = 0;
  const client = new Anthropic({apiKey:"fixture",baseURL:"http://127.0.0.1:9",fetch:Object.assign(async()=>{calls++;throw new Error("unexpected HTTP request");},{preconnect:()=>{}}) as typeof fetch}), model = testModel("large");
  const request:ModelRequest={conversationId:"withdrawn",model:{...model,capabilities:{...model.capabilities,pdf:true,filesApi:false}},system:[],tools:[],history:[{role:"user",parts:[{type:"document",mediaType:"application/pdf",name:"a.pdf",dataBase64:Buffer.from(makePdf(["x".repeat(300000)])).toString("base64")}]}],maxOutputTokens:100,thinking:{enabled:false,mode:"adaptive",budgetTokens:0,showSummaries:false}};
  const files = new AnthropicFiles(client,undefined,()=>false);
  await expect(files.prepare(request,new AbortController().signal)).rejects.toThrow("autoris");
  await expect(files.prepare({...request,model:{...request.model,capabilities:{...request.model.capabilities,filesApi:true}}},new AbortController().signal)).rejects.toThrow("autoris");
  expect(calls).toBe(0);
});

test("TECH — a control-host refusal prevents a previously attached PDF from reaching the next real provider request", async () => {
  const ws = workspace(), backend = startFakeAnthropic([{text:"first document received"},{text:"must not be reached"}]), bytes = Buffer.from(makePdf(["private document"]));
  writeFileSync(join(ws.project,"a.pdf"),bytes);
  const host = new Host(ws,{
    provider:new ScriptedProvider([]),extra:{providerFactory:undefined},init:{decisionAuthority:true},
    env:{ANTHROPIC_API_KEY:"fixture-key",ANTHROPIC_BASE_URL:backend.url},
    userConfig:{api:{provider:"anthropic"},models:{selected:"file-model",extraCatalog:[{id:"file-model",provider:"anthropic",family:"fixture-files",label:"File model",contextWindow:128000,maxOutputTokens:1024,capabilities:{toolCalling:true,pdf:true,filesApi:false}}]}},
  });
  try {
    host.user("Read @a.pdf");await host.waitFor(message=>message.type==="turn_completed"&&message["turn"]===1);
    expect(backend.requests).toHaveLength(1);expect(JSON.stringify(backend.requests[0]!.body)).toContain(bytes.toString("base64"));
    const denial=await host.request("set_tool_permissions",{add:[{decision:"deny",rule:"read_file(a.pdf)"}]});expect(denial["ok"]).toBe(true);
    host.user("What does it contain?");await host.waitFor(message=>message.type==="turn_completed"&&message["turn"]===2);
    expect(backend.requests).toHaveLength(1);
  } finally {host.feed.end();await host.finish();backend.stop();}
},20000);

test("TECH — a cancelled queued PDF preparation returns before another upload finishes and sends no second upload", async () => {
  let started!:()=>void, release!:()=>void, uploads=0;
  const uploading=new Promise<void>(resolve=>started=resolve), hold=new Promise<void>(resolve=>release=resolve);
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
    if(req.method==="POST"){uploads++;started();await hold;}
    return Response.json({id:"file_owned",type:"file",filename:"a.pdf",mime_type:"application/pdf",size_bytes:300000,created_at:new Date().toISOString(),expires_at:null});
  }});
  const first=new AbortController(), second=new AbortController(), model=testModel("large"), request:ModelRequest={conversationId:"queued",model:{...model,capabilities:{...model.capabilities,pdf:true,filesApi:true}},system:[],tools:[],history:[{role:"user",parts:[{type:"document",mediaType:"application/pdf",name:"a.pdf",dataBase64:Buffer.from(makePdf(["x".repeat(300000)])).toString("base64")}]}],maxOutputTokens:100,thinking:{enabled:false,mode:"adaptive",budgetTokens:0,showSummaries:false}};
  const files=new AnthropicFiles(new Anthropic({baseURL:`http://127.0.0.1:${server.port}`,apiKey:"fixture",maxRetries:0,timeout:2000})), active=files.prepare(request,first.signal);
  try{
    await uploading;let rejected=false;
    const queued=files.prepare(request,second.signal).catch(()=>{rejected=true;});second.abort();
    await new Promise(resolve=>setTimeout(resolve,30));expect(rejected).toBe(true);expect(uploads).toBe(1);
    release();await active;await queued;
  }finally{release();first.abort();second.abort();await active.catch(()=>undefined);server.stop(true);}
},5000);

test("TECH — PDF size and encoding limits also apply when Files API is disabled",async()=>{
  let calls=0;
  const files=new AnthropicFiles(new Anthropic({baseURL:"http://127.0.0.1:9",apiKey:"fixture",fetch:Object.assign(async()=>{calls++;throw new Error("unexpected HTTP request");},{preconnect:()=>{}}) as typeof fetch})), model=testModel("large");
  const request:ModelRequest={model:{...model,capabilities:{...model.capabilities,pdf:true,filesApi:false}},system:[],tools:[],history:[],maxOutputTokens:100,thinking:{enabled:false,mode:"adaptive",budgetTokens:0,showSummaries:false}};
  const withDocument=(dataBase64:string):ModelRequest=>({...request,history:[{role:"user",parts:[{type:"document",mediaType:"application/pdf",name:"a.pdf",dataBase64}]}]});
  await expect(files.prepare(withDocument(Buffer.alloc(20*1024*1024+1).toString("base64")),new AbortController().signal)).rejects.toThrow("volumineux");
  await expect(files.prepare(withDocument(Buffer.from("not a PDF").toString("base64")),new AbortController().signal)).rejects.toThrow("invalide");
  expect(calls).toBe(0);
});
