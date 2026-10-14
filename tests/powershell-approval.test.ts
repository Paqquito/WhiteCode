import { expect, test } from "bun:test";
import { join } from "node:path";
import { bench } from "./helpers/engine";
import { runTurn } from "../src/engine/loop";
import { runPowerShellTool } from "../src/tools/run-shell";
import { parseRule, type Rule } from "../src/permissions/rules";
const tool = { ...runPowerShellTool, isEnabled: () => true };
test("SPEC-PER-005/CA-01 — a file-reading alias obeys the rule naming its complete PowerShell cmdlet", async () => {
  const input = { command: "" }, rules: Rule[] = [];
  const b = bench([{ toolCalls: [{ name: "run_powershell", input }] }, { text: "Refused" }], { mode: "auto_approve", tools: [tool as never], rules });
  input.command = `gc '${join(b.ws.project, "local.txt").replace(/'/g, "''")}'`;
  rules.push(parseRule("run_powershell(Get-Content *)", "deny", "user", b.ws.project) as Rule);
  await runTurn(b.deps, "Read", new AbortController().signal); expect(JSON.stringify(b.toolResults())).toContain("Denied by the rule run_powershell(Get-Content *)");
});
test("SPEC-PER-005/CA-02 — encoded PowerShell commands cannot use broad or exact automatic allow rules", async () => {
  for (const pattern of ["run_powershell", "run_powershell(powershell -EncodedCommand SGVsbG8=)"]) {
    let examined = 0;
    const command = "powershell -EncodedCommand SGVsbG8=", b = bench([{ toolCalls: [{ name: "run_powershell", input: { command } }] }, { text: "Refused" }], { mode: "auto_approve", tools: [tool as never], rules: [parseRule(pattern, "allow", "user", "/") as Rule], authorities: { classifier: { decide: async request => { examined++; expect(request.summary).toContain("powershell"); return "block"; } } } });
    await runTurn(b.deps, "Run", new AbortController().signal); expect(examined).toBe(1); expect(JSON.stringify(b.toolResults())).toContain("Blocked by the approval classifier");
  }
});
