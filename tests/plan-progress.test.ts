import { expect, test } from "bun:test";
import { bench } from "./helpers/engine";
import { runTurn } from "../src/engine/loop";
import { checkPlanProgressTool } from "../src/tools/check-plan-progress";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { prefix } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("TECH — an approved plan beyond the assessment limit is refused before spawning instead of silently losing steps", async () => {
  let assessed = false, published = false;
  const tool = checkPlanProgressTool({ approved: () => Array.from({ length: 65 }, (_, index) => `${index + 1}. Required step`).join("\n"), evidence: () => [], check: async () => { assessed = true; return "{}"; }, publish: () => { published = true; } });
  const b = bench([{ toolCalls: [{ name: tool.name, input: {} }] }, { text: "Assessment limit reported." }], { tools: [tool as never] });
  await runTurn(b.deps, "Check the approved plan", new AbortController().signal);
  expect(assessed).toBe(false); expect(published).toBe(false); expect(JSON.stringify(b.toolResults())).toContain("exceeds the assessment bounds");
});
const call = (name: string, input: unknown) => ({ toolCalls: [{ name, input }] });

test("TECH — the verbatim plan report masks a configured credential before direct terminal publication", async () => {
  const ws = workspace(), secret = "PLAN_DISPLAY_SECRET_7799", fingerprint = createHash("sha256").update("openai_compatible:" + secret).digest("hex");
  ws.write("home/config/" + basename(loadIdentity().get("USER_STATE_FILE")), JSON.stringify({ keyConfirmations: { [fingerprint]: true } }));
  const provider = new ScriptedProvider([call("submit_plan", { plan_text: "1. Implement the requested change." }), call("check_plan_progress", {}), { text: "SAFE_PLAN_REPORT_PUBLISHED" }], [{ text: JSON.stringify({ steps: [{ step: 1, status: "skipped", reason: "No proof exists. Provider supplied: " + secret, evidence: [] }] }) }]);
  const controller = new AbortController(), run = interactive(["--approval-mode=planning"], ws, { provider, signal: controller.signal, env: { [prefix + "PLAN_CHECK_TOOL"]: "1", OPENAI_API_KEY: secret } });
  try {
    await run.idle(); run.type("Plan and verify.\r"); await run.waitFor(text => text.includes("Que faire de ce plan ?")); await sleep(380); run.type("2");
    await run.waitFor(text => text.includes("SAFE_PLAN_REPORT_PUBLISHED"));
    expect(run.all().join("\n")).not.toContain(secret); expect(run.all().join("\n")).toContain("[redacted credential]");
  } finally { controller.abort(); await run.done; }
}, 15000);
test("SPEC-OUT-025/CA-01 — a four-step approved plan reports its unexecuted fourth step with explicit absence of evidence", async () => {
  const ws = workspace(), files = [1, 2, 3, 4].map(n => join(ws.project, `step-${n}.txt`)); let assessed = false;
  const plan = files.map((_, n) => `${n + 1}. Create step-${n + 1}.txt`).join("\n");
  const p = new ScriptedProvider([call("submit_plan", { plan_text: plan }), ...files.slice(0, 3).map((path, n) => call("write_file", { path, content: `STEP_EVIDENCE_${n + 1}` })), call("check_plan_progress", {}), { text: "PLAN_REPORT_PUBLISHED" }], [request => {
    expect(request.tools.map(tool => tool.name)).toEqual(["find_files", "read_file", "search_content"]);
    const user = request.history.find(message => message.role === "user"), inputText = user?.role === "user" ? user.parts.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
    const input = JSON.parse(inputText.split("\n").at(-1)!) as { steps: string[]; evidence: Array<{ id: string; kind: string; text: string }> };
    expect(input.steps).toHaveLength(4); const writes = input.evidence.filter(proof => proof.kind === "write_file"); expect(writes).toHaveLength(3); expect(writes[0]!.text).toContain("STEP_EVIDENCE_1"); expect(writes[0]!.text).toContain("difference"); assessed = true;
    return { text: JSON.stringify({ steps: input.steps.map((_, n) => ({ step: n + 1, status: n === 3 ? "skipped" : "completed", reason: n === 3 ? "No execution evidence exists for this step." : "The file write completed and its difference was recorded.", evidence: n === 3 ? [] : [writes[n]!.id] })) }) };
  }]);
  const stop = new AbortController(), run = interactive(["--approval-mode=planning"], ws, { provider: p, env: { [prefix + "PLAN_CHECK_TOOL"]: "1" }, signal: stop.signal });
  try {
    await run.idle(); run.type("Carry out this plan"); run.type(KEY.enter); await run.waitFor(text => text.includes("Que faire de ce plan ?")); await sleep(350); run.type("2");
    await run.waitFor(text => text.includes("PLAN_REPORT_PUBLISHED")); expect(assessed).toBe(true);
    for (let n = 0; n < 3; n++) expect(readFileSync(files[n]!, "utf8")).toBe(`STEP_EVIDENCE_${n + 1}`);
    expect(existsSync(files[3]!)).toBe(false); expect(run.all().join("\n")).toContain("no execution evidence"); await run.idle(); run.type(KEY.ctrlD); run.type(KEY.ctrlD); expect((await run.done).code).toBe(0);
  } finally { stop.abort(); await run.done; }
}, 15000);
test("SPEC-OUT-025/CA-02 — plan checking refuses a session with no genuinely approved plan", async () => {
  const ws = workspace(), p = new ScriptedProvider([call("check_plan_progress", {}), { text: "No approved plan" }]);
  const r = await cli(["--non-interactive", "Check"], ws, { provider: p, env: { [prefix + "PLAN_CHECK_TOOL"]: "1" } });
  expect(r.code).toBe(0); expect(JSON.stringify(p.requests.at(-1)?.history)).toContain("No plan has been approved"); expect(p.requests.filter(request => request.purpose === "subagent")).toHaveLength(0);
});
