import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-IHM-007/CA-10 — typed agent and file mentions with the same name reach the interactive provider as distinct selections", async () => {
  const ws = workspace();
  ws.write("home/config/agents/revue.md", '---\nname: revue\ndescription: "Reviews the requested change."\ntools: ["read_file"]\n---\nRead and report without editing.\n');
  ws.write("project/revue", "HOMONYMOUS_FILE_731");
  const selections: string[] = [];
  const provider = new ScriptedProvider([
    request => { selections.push(JSON.stringify(request.history.filter(message => message.role === "user").at(-1))); return { text: "agent selection received" }; },
    request => { selections.push(JSON.stringify(request.history.filter(message => message.role === "user").at(-1))); return { text: "file selection received" }; },
  ]);
  const controller = new AbortController();
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("Use &revue"); run.type(KEY.enter);
    await run.waitFor(text => text.includes("agent selection received")); await run.idle();
    expect(selections[0]).toContain('requested-agent name=\\"revue\\"');
    expect(selections[0]).not.toContain("HOMONYMOUS_FILE_731");
    run.type("Read @revue"); run.type(KEY.enter);
    await run.waitFor(text => text.includes("file selection received"));
    expect(selections[1]).toContain("HOMONYMOUS_FILE_731");
    expect(selections[1]).not.toContain("requested-agent");
    expect(provider.requests.filter(request => request.purpose === "subagent")).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});

test("SPEC-CMD-075/CA-01 — modal-editing toggles standard editing and persists the choice across a restart", async () => {
  const ws = workspace(), provider = new ScriptedProvider([]);
  const first = interactive([], ws, { provider });
  await first.idle(); first.type("/modal-editing"); first.type(KEY.enter);
  await first.waitFor(t => t.includes("Édition modale activée") && t.includes("-- INSERTION --"));
  const saved = JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"));
  expect(saved.ui.input.editMode).toBe("modal");
  first.type(KEY.ctrlD); first.type(KEY.ctrlD); expect((await first.done).code).toBe(0);
  const second = interactive([], ws, { provider, userConfig: saved });
  await second.waitFor(t => t.includes("-- INSERTION --"));
  second.type("/modal-editing"); second.type(KEY.enter);
  await second.waitFor(t => t.includes("Édition standard rétablie"));
  expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).ui.input.editMode).toBe("standard");
  second.type(KEY.ctrlD); second.type(KEY.ctrlD); expect((await second.done).code).toBe(0);
  expect(provider.requests).toHaveLength(0);
});

test("SPEC-IHM-022/CA-01 — the current task supplies its progressive label to the activity indicator", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "update_todo_list", input: { items: [{ content: "Exécuter les tests", progress_label: "Exécution des tests", status: "in_progress" }] } }] },
    { hang: true },
  ]);
  const controller = new AbortController();
  const run = interactive(["Work."], ws, { provider, signal: controller.signal });
  try {
    await run.waitFor(() => provider.requests.length === 2);
    await run.waitFor(() => run.screen().some(line => /Exécution des tests.*Échap pour interrompre/.test(line)));
    expect(run.screen().join("\n")).toContain("Exécution des tests");
    expect(JSON.stringify(provider.requests[1]!.history)).toContain("in_progress");
  } finally { controller.abort(); await run.done; }
});
