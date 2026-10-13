// Supports: SPEC-OUT-008; actual shell, interactive recommendation and sanitized model result.
import { expect, test } from "bun:test";
import { workspace, loadIdentity } from "./helpers/env";
import { interactive } from "./helpers/interactive";
import { productEnv, POSIX, bunCommand } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { stripShellHints, ShellHintStream } from "../src/tools/shell-hints";

test("SPEC-OUT-008/CA-08 — a real shell hint is removed from the model result and a configured extension is recommended", async () => {
  const ws = workspace(), c = new AbortController(), tag = loadIdentity().get("HINT_TAG");
  ws.write("home/config/catalogs/fixture/catalog.json", JSON.stringify({ name: "fixture", extensions: [{ name: "helper", source: ".", version: "0.1.0" }] }));
  const emit = ws.write("project/emit.ts", `console.log('normal output');console.log(${JSON.stringify(`<${tag} v="1" type="extension" value="helper@fixture" />`)});`);
  const p = new ScriptedProvider([{ toolCalls: [{ name: POSIX ? "run_shell" : "run_powershell", input: { command: bunCommand(emit.replaceAll("\\", "/")) } }] }, { text: "done" }]);
  const ui = interactive([], ws, { provider: p, signal: c.signal, env: productEnv(ws), userConfig: { permissions: { allowRules: ["run_shell", "run_powershell"] }, extensions: { catalogs: { fixture: { source: ws.project } } } } });
  try {
    await ui.idle(); ui.type("run the emitter\r"); await ui.waitFor(t => t.includes("Extension suggérée") && t.includes("helper@fixture") && t.includes("done"));
    const data = JSON.stringify(p.requests[1]!.history); expect(data).toContain("normal output"); expect(data).not.toContain(`<${tag}`);
    expect(ui.all().join("\n")).toContain("Commande émettrice");
  } finally { c.abort(); await ui.done; }
}, 15000);

test("TECH — malformed and unsupported hints are stripped, without recommending or accepting command text", () => {
  const found: string[] = [], collect = (s: string) => found.push(s);
  const output = stripShellHints('first<fixture-hint v="2" type="extension" value="a@c" /><fixture-hint v="1" type="extension" value="../../shell@c" /><fixture-hint bad><fixture-hint v="1" type="extension" value="a@c" />last', "fixture-hint", collect);
  expect(found).toEqual(["a@c"]); expect(output).toBe("firstlast");
});

test("TECH — every possible stream split hides a hint from model-visible background progress", () => {
  const value = 'before<fixture-hint v="1" type="extension" value="a@c" />after';
  for (let split = 0; split <= value.length; split++) {
    const filter = new ShellHintStream("fixture-hint");
    expect(filter.push(value.slice(0, split)) + filter.push(value.slice(split), true)).toBe("beforeafter");
  }
  const filter = new ShellHintStream("fixture-hint");
  expect(filter.push("plain <fixture-hint-other />", true)).toBe("plain <fixture-hint-other />");
  const huge = new ShellHintStream("fixture-hint"); expect(huge.push("<fixture-hint " + "x".repeat(10000))).toBe(""); expect(huge.push("/>after", true)).toBe("after");
});
