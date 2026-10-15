import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { LivingDocuments } from "../src/memory/living-docs";
import { workspace,cli,loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { textOutcome } from "../src/tools/types";
function setup(changeBefore = false) {
  const ws = workspace(), path = ws.write("project/guide.md", "LIVING Project guide\n\nOriginal convention.\n"), notices: string[] = [];
  const docs = new LivingDocuments({ signal: new AbortController().signal, enabled: () => true, header: () => "LIVING", everyTurns: 1, denied: () => false, redact: text => text, notify: (_path, title) => notices.push(title), report: error => { throw error; },
    update: async (_document, _signal, wrap) => { if (changeBefore) writeFileSync(path, "LIVING Project guide\nHuman change.\n"); const tool = wrap({ execute: async (input: never) => { writeFileSync(path, (input as { content: string }).content); return textOutcome("written"); } } as never); await tool.execute({ content: "LIVING Project guide\n\nOriginal convention.\nDecision: use integration tests.\n" } as never, {} as never); },
  }); return { path, docs, notices };
}
test("SPEC-MOT-032/CA-01 — a previously read living document is updated in the background and the user is notified", async () => {
  const b = setup(); b.docs.read(b.path); b.docs.turn(); await b.docs.close(1000);
  expect(readFileSync(b.path, "utf8")).toContain("Decision: use integration tests"); expect(b.notices).toEqual(["Project guide"]);
});
test("SPEC-MOT-032/CA-02 — a human edit made during preparation prevents the background write", async () => {
  const b = setup(true); b.docs.read(b.path); b.docs.turn(); await b.docs.close(1000);
  expect(readFileSync(b.path, "utf8")).toContain("Human change"); expect(b.notices).toEqual([]);
});
test("TECH — documents without the configured header are never sent to a worker", async () => {
  const b = setup(); writeFileSync(b.path, "# Ordinary guide\n"); b.docs.read(b.path); b.docs.turn(); await b.docs.close(1000); expect(b.notices).toEqual([]); expect(readFileSync(b.path, "utf8")).toBe("# Ordinary guide\n");
});
test("TECH — the real driver follows a read living document and uses the ordinary file executor to publish a decision",async()=>{
 const ws=workspace(),header=loadIdentity().get("LIVING_DOC_HEADER")+" Design decisions",file=ws.write("project/decisions.md",header+"\n\nExisting guidance.\n"),updated=header+"\n\nExisting guidance.\nDecision: use integration tests.\n";
 const provider=new ScriptedProvider([{toolCalls:[{name:"read_file",input:{path:file}}]},{text:"Decision: use integration tests."},{toolCalls:[{name:"read_file",input:{path:file}}]},{toolCalls:[{name:"write_file",input:{path:file,content:updated}}]},{text:"Decision recorded."}]);
 const result=await cli(["--non-interactive","--allow-rule","write_file","Decide a test strategy."],ws,{provider,userConfig:{memory:{livingDocs:{enabled:true,everyTurns:1}}}});expect(result.code).toBe(0);expect(readFileSync(file,"utf8")).toBe(updated);expect(result.stderr+result.stdout).toContain("Document vivant mis à jour");expect(provider.requests.filter(request=>request.purpose==="subagent").length).toBeGreaterThan(0);
});
