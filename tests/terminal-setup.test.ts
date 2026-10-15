import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyTerminalPlan, terminalPlan, restoreTerminal, NEWLINE_SEQUENCE } from "../src/interactive/terminal-setup";
import { workspace } from "./helpers/env";
import { parse } from "jsonc-parser";
import { KeyParser } from "../src/ui/keys";
import { interactive,KEY,sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { detectTerminal } from "../src/interactive/terminal-setup";
import { currentPlatform } from "../src/platform/system";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
test("SPEC-INT-021/CA-01 — configuration keeps comments and other shortcuts, backs up exact bytes and sends the newline key", () => {
  const ws = workspace(), original = '// User shortcuts\n[{"key":"ctrl+k","command":"other"}]\n', path = ws.write("terminal/keybindings.json", original), target = { name: "Editor", kind: "editor" as const, path };
  const backup = applyTerminalPlan(terminalPlan(target))!; expect(readFileSync(backup, "utf8")).toBe(original);
  const next = readFileSync(path, "utf8"), bindings = parse(next); expect(next).toContain("// User shortcuts"); expect(bindings[0].command).toBe("other"); expect(bindings[1].args.text).toBe(NEWLINE_SEQUENCE);
  expect(applyTerminalPlan(terminalPlan(target))).toBeUndefined(); restoreTerminal(target, backup); expect(readFileSync(path, "utf8")).toBe(original);
  expect(new KeyParser().feed(NEWLINE_SEQUENCE)[0]).toMatchObject({kind:"key",name:"enter",shift:true});
});
test("SPEC-CMD-071/CA-01 — confirmed terminal setup survives relaunch and its configured sequence inserts a newline",async()=>{
  const ws=workspace(),env={TERM_PROGRAM:"vscode",APPDATA:ws.home,XDG_CONFIG_HOME:ws.home},target=detectTerminal({home:ws.home,platform:currentPlatform(),variable:name=>env[name as keyof typeof env]})!;mkdirSync(dirname(target.path),{recursive:true});
  const run=interactive([],ws,{env,provider:new ScriptedProvider([])});await run.idle();run.type("/configure-terminal");run.type(KEY.enter);await run.waitFor(text=>text.includes("Configurer Maj+Entrée dans"));await sleep(380);run.type("o");await run.waitFor(text=>text.includes("Maj+Entrée configuré"));const settings=parse(readFileSync(target.path,"utf8"));expect(settings[0].args.text).toBe(NEWLINE_SEQUENCE);run.type(KEY.ctrlD);run.type(KEY.ctrlD);expect((await run.done).code).toBe(0);
  const provider=new ScriptedProvider([{text:"newline received"}]),again=interactive([],ws,{env,provider});await again.idle();again.type("first line");again.raw(settings[0].args.text);again.type("second line");again.type(KEY.enter);await again.waitFor(text=>text.includes("newline received"));expect(JSON.stringify(provider.requests[0]!.history)).toContain("first line\\nsecond line");again.type(KEY.ctrlD);again.type(KEY.ctrlD);expect((await again.done).code).toBe(0);
},15000);
test("SPEC-INT-021/CA-02 — an injected failure after publication restores the exact initial terminal configuration", () => {
  const ws = workspace(), original = '{"actions":[],"theme":"dark"}\n', path = ws.write("terminal/settings.json", original), target = { name: "Terminal", kind: "windows-terminal" as const, path };
  expect(() => applyTerminalPlan(terminalPlan(target), () => { throw new Error("injected write failure"); })).toThrow("injected"); expect(readFileSync(path, "utf8")).toBe(original);
});
test("TECH — concurrent terminal changes are preserved and a foreign restoration path is refused", () => {
  const ws = workspace(), path = ws.write("terminal/keys.json", "[]"), target = { name: "Editor", kind: "editor" as const, path }, plan = terminalPlan(target); ws.write("terminal/keys.json", '[{"key":"a"}]');
  expect(() => applyTerminalPlan(plan)).toThrow("modifiée"); expect(() => restoreTerminal(target, path + ".backup-../foreign")).toThrow(); expect(parse(readFileSync(path, "utf8"))).toHaveLength(1);
});
