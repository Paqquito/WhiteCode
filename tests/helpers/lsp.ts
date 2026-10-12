// A small independent LSP peer on real standard pipes. It records protocol messages and publishes test diagnostics.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./env";
import { BUN } from "./hooks";

export function languageServer(ws: Workspace, options: { delayMs?: number; crash?: boolean; locations?: unknown[]; applyEdit?: boolean; encoding?: string; incremental?: boolean; stale?: boolean; otherUris?: string[]; publishTarget?: boolean } = {}) {
  const record = join(ws.root, "language-server.jsonl");
  const script = ws.write("scripts/language-server.ts", `
import { appendFileSync } from "node:fs";
const record = ${JSON.stringify(record)}, delay = ${options.delayMs ?? 0}, crash = ${options.crash ?? false}, locations = ${JSON.stringify(options.locations ?? null)}, applyEdit = ${options.applyEdit ?? false}, encoding = ${JSON.stringify(options.encoding ?? "utf-16")}, incremental = ${options.incremental ?? false}, stale = ${options.stale ?? false};
let currentUri;
const otherUris = ${JSON.stringify(options.otherUris ?? [])}, publishTarget = ${options.publishTarget ?? true};
appendFileSync(record, JSON.stringify({ method: "started", pid: process.pid }) + "\\n");
let input = Buffer.alloc(0);
const send = (value) => { const body = JSON.stringify({jsonrpc:"2.0", ...value}); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); };
const reply = (request, result) => send({id:request.id, result});
function receive(message) {
  appendFileSync(record, JSON.stringify({ ...message, at: Date.now() }) + "\\n");
  if (message.method === "initialize") { reply(message, { capabilities: { positionEncoding: encoding, textDocumentSync: incremental ? 2 : 1, referencesProvider: true, definitionProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, callHierarchyProvider: true } }); return; }
  if (message.method === "initialized" && crash) process.exit(1);
  if (message.method === "initialized" && applyEdit) send({id: "server-edit", method:"workspace/applyEdit", params:{edit:{changes:{"file:///outside":[{newText:"BAD"}]}}}});
  if (["textDocument/didOpen", "textDocument/didChange"].includes(message.method)) {
    const doc = message.params.textDocument, content = doc.text ?? message.params.contentChanges[0].text;
    currentUri = doc.uri;
    if (publishTarget) setTimeout(() => send({method:"textDocument/publishDiagnostics", params:{uri:doc.uri, version:stale ? doc.version - 1 : doc.version, diagnostics: content.includes("BAD") ? [{range:{start:{line:0,character:6},end:{line:0,character:9}},severity:1,message:"Type mismatch: invalid test expression."},{range:{start:{line:0,character:6},end:{line:0,character:9}},severity:1,message:"Type mismatch: invalid test expression."}] : []}}), delay);
    for (const uri of otherUris) setTimeout(() => send({method:"textDocument/publishDiagnostics", params:{uri,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1,message:"OTHER_ERROR"}]}}), delay);
    return;
  }
  if (message.method === "shutdown") { reply(message, null); return; }
  if (message.method === "exit") process.exit(0);
  if (message.method === "textDocument/references" || message.method === "textDocument/definition" || message.method === "textDocument/implementation") { reply(message, locations ?? [{uri:message.params.textDocument.uri,range:{start:{line:0,character:6},end:{line:0,character:11}}}]); return; }
  if (message.method === "textDocument/hover") { reply(message, {contents:{kind:"plaintext",value:"test function: () => number"}}); return; }
  if (message.method === "textDocument/documentSymbol") { reply(message, [{name:"value",kind:12,range:{start:{line:0,character:6},end:{line:0,character:11}},selectionRange:{start:{line:0,character:6},end:{line:0,character:11}}}]); return; }
  if (message.method === "workspace/symbol") { reply(message, [{name:"value",kind:12,location:{uri:currentUri,range:{start:{line:0,character:6},end:{line:0,character:11}}}}]); return; }
  if (message.method === "textDocument/prepareCallHierarchy") { reply(message, [{name:"value",kind:12,uri:currentUri,range:{start:{line:0,character:6},end:{line:0,character:11}},selectionRange:{start:{line:0,character:6},end:{line:0,character:11}}}]); return; }
  if (message.method === "callHierarchy/incomingCalls" || message.method === "callHierarchy/outgoingCalls") { reply(message, [{from:message.params.item,to:message.params.item,fromRanges:[{start:{line:0,character:6},end:{line:0,character:11}}]}]); return; }
  if (message.id !== undefined) reply(message, []);
}
for await (const chunk of Bun.stdin.stream()) {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const end = input.indexOf("\\r\\n\\r\\n"); if (end < 0) break;
    const count = Number(/Content-Length: (\\d+)/i.exec(input.subarray(0, end).toString("ascii"))?.[1]);
    if (input.length < end + 4 + count) break;
    const value = JSON.parse(input.subarray(end + 4, end + 4 + count).toString("utf8")); input = input.subarray(end + 4 + count); receive(value);
  }
}
`);
  return { declaration: { command: BUN, args: [script], extensions: [".ts"], languageId: "typescript" }, messages: () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}
