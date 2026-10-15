import { expect, test } from "bun:test";
import { readFileSync, realpathSync, mkdirSync, linkSync } from "node:fs";
import { join } from "node:path";
import { AgentMemory, agentMemoryName } from "../src/agents/agent-memory";
import { workspace, loadIdentity, testToolFields,cli } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { readFileTool } from "../src/tools/read-file";
import { decide } from "../src/permissions/engine";
import { spawnSync } from "node:child_process";
import { currentPlatform } from "../src/platform/system";
const fact = "---\nname: Convention\ndescription: Persisted convention\ntype: project\n---\nUse meaningful integration tests.\n";
test("SPEC-AGT-007/CA-01 — local agent memory is excluded by Git while project memory remains versionable", () => {
  const ws = workspace(), projectDir = join(realpathSync(ws.project), loadIdentity().get("PROJECT_DIR")), memories = new AgentMemory({ configDir: ws.configHome, projectDir, indexFile: "index.md", redact: text => text });
  expect(spawnSync("git", ["init", "-q"], { cwd: ws.project }).status).toBe(0);
  const local = memories.open("reviewer", "local"); local.put("fact.md", fact);
  const shared = memories.open("reviewer", "project"); shared.put("fact.md", fact);
  expect(spawnSync("git", ["check-ignore", join(local.root, "fact.md")], { cwd: ws.project }).status).toBe(0);
  expect(spawnSync("git", ["check-ignore", join(shared.root, "fact.md")], { cwd: ws.project }).status).toBe(1);
  expect(readFileSync(join(projectDir, ".gitignore"), "utf8")).toContain("/agent-memory-local/");
});
test("SPEC-AGT-007/CA-02 — an agent reading another agent's memory reaches an explicit permission request", () => {
  const ws = workspace(), memories = new AgentMemory({ configDir: ws.configHome, projectDir: join(ws.project, ".data"), indexFile: "index.md", redact: text => text }), a = memories.open("one", "user"), b = memories.open("two", "user");
  b.put("fact.md", fact); const tool = memories.tool(readFileTool as never, a), context = { ...testToolFields({cwd:ws.project}), platform: currentPlatform(), home: ws.home } as never;
  const input = { path: join(b.root, "fact.md") } as never, contribution = tool.permissionContribution!(input, context);
  const decision = decide({ toolName: tool.name, subject: tool.ruleSubject(input, context), flags: tool.flags(input), contribution, available: true }, { mode: "ask", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform: currentPlatform() });
  expect(decision.kind).toBe("ask"); expect(contribution).toBe("ask");
});
test("TECH — namespace conversion is portable and collision resistant and exclusions reject links", () => {
  expect(agentMemoryName("a:b")).not.toBe(agentMemoryName("a-b")); expect(agentMemoryName("CON")).toMatch(/^[a-z0-9-]+$/);
  const ws = workspace(), projectDir = join(ws.project, "meta"), file = ws.write("project/other", "outside");
  mkdirSync(projectDir);linkSync(file,join(projectDir,".gitignore"));
  const memories = new AgentMemory({ configDir: ws.configHome, projectDir, indexFile: "index.md", redact: text => text });expect(()=>memories.open("one", "local")).toThrow("ordinary");expect(readFileSync(file,"utf8")).toBe("outside");
});
test("TECH — a real declared agent writes its own local memory with scoped instructions and no parent read credit",async()=>{
 const ws=workspace(),identity=loadIdentity(),root=join(ws.project,identity.get("PROJECT_DIR"),"agent-memory-local",agentMemoryName("recorder")),file=join(root,"fact.md");ws.write("home/config/agents/recorder.md",'---\nname: recorder\ndescription: Records a durable fact\nmemory: local\ntools: ["write_file"]\n---\nRecord durable project facts.\n');
 const provider=new ScriptedProvider([{toolCalls:[{name:"spawn_agent",input:{role:"recorder",description:"Record fact",prompt:"Remember the test convention."}}]},{text:"Parent done."}],[request=>{expect(JSON.stringify(request.system)).toContain(root.replaceAll("\\","\\\\"));return {toolCalls:[{name:"write_file",input:{path:file,content:fact}}]};},{text:"Remembered."}]);
 const result=await cli(["--non-interactive","Work"],ws,{provider});expect(result.code).toBe(0);expect(readFileSync(file,"utf8")).toBe(fact);
});
test("TECH — a real agent cannot read another agent's memory without a human permission decision",async()=>{
 const ws=workspace(),identity=loadIdentity(),memories=new AgentMemory({configDir:ws.configHome,projectDir:join(ws.project,identity.get("PROJECT_DIR")),indexFile:identity.get("MEMORY_INDEX_FILE"),redact:text=>text}),other=memories.open("other","user");other.put("fact.md",fact);const file=join(other.root,"fact.md");ws.write("home/config/agents/reader.md",'---\nname: reader\ndescription: Reads its own memories\nmemory: user\ntools: ["read_file"]\n---\nRead only authorized context.\n');let asked=0;
 const provider=new ScriptedProvider([{toolCalls:[{name:"spawn_agent",input:{role:"reader",description:"Read fact",prompt:"Inspect the other memory."}}]},{text:"Parent done."}],[{toolCalls:[{name:"read_file",input:{path:file}}]},request=>{expect(JSON.stringify(request.history)).not.toContain("Use meaningful integration tests");return{text:"Access refused."};}]);
 const result=await cli(["--non-interactive","--approval-mode","ask","Work"],ws,{provider,extra:{authorities:{human:{request:async()=>{asked++;return{answer:"no"};}}}}});expect(result.code).toBe(0);expect(asked).toBe(1);
});
