// Acceptance paths for transferring a running command and observing a background agent.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processExists } from "../src/platform/process";
import { currentPlatform } from "../src/platform/system";
import { BackgroundTasks } from "../src/engine/background";
import { runShellTool } from "../src/tools/run-shell";
import { detectPosixShell, ShellRuntime } from "../src/tools/shell-runtime";
import type { ToolContext } from "../src/tools/types";
import { testToolFields, workspace } from "./helpers/env";
import { bunCommand, productEnv } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const call = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ name, input }] });

test("SPEC-IHM-028/CA-01 SPEC-IHM-028/CA-02 — the keyboard task panel lists two live commands and stops the selected one only after confirmation", async () => {
  const ws = workspace(), first = commandFixture(ws);
  const secondStarts = join(ws.root, "second-starts.txt");
  const secondScript = ws.write("scripts/second.ts", `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(secondStarts)}, process.pid + " READY\\n"); await Bun.sleep(30_000);`);
  const provider = new ScriptedProvider([
    { toolCalls: [
      { name: "run_shell", input: { command: first.command, detached: true, description: "première commande" } },
      { name: "run_shell", input: { command: bunCommand(secondScript.replace(/\\/g, "/")), detached: true, description: "seconde commande" } },
    ] }, { text: "deux commandes lancées" },
  ]);
  const controller = new AbortController();
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider, env: productEnv(ws), signal: controller.signal });
  try {
    await run.idle(); run.type("lance les deux"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("deux commandes lancées"));
    const firstPid = await ready(first.starts), secondPid = await ready(secondStarts);
    run.type("brouillon conservé"); run.type("\u001bk");
    await run.waitFor(t => t.includes("Tâches de fond — choisir"), "keyboard task panel");
    const screen = run.screen().join("\n");
    expect(screen).toContain("première commande"); expect(screen).toContain("seconde commande");
    expect(screen.match(/en cours/g)?.length).toBeGreaterThanOrEqual(2);
    await sleep(380); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Détail de b1"));
    await sleep(380); run.type(KEY.down); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Arrêter la tâche b1"));
    expect(processExists(firstPid)).toBe(true); expect(processExists(secondPid)).toBe(true);
    await sleep(380); run.type("o");
    await run.waitFor(t => t.includes("Tâche b1 arrêtée"));
    expect(processExists(firstPid)).toBe(false); expect(processExists(secondPid)).toBe(true);
    expect(run.screen().join("\n")).toContain("brouillon conservé");
  } finally { controller.abort(); await run.done; }
}, 25_000);

function commandFixture(ws: ReturnType<typeof workspace>) {
  const starts = join(ws.root, "starts.txt");
  const release = join(ws.root, "release");
  const script = ws.write("scripts/transfer.ts", `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(starts)}, process.pid + " READY\\n");
console.log("avant transfert");
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(50);
console.log("après transfert");
`);
  return { starts, release, command: bunCommand(script.replace(/\\/g, "/")) };
}

async function ready(path: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) {
      const match = /^(\d+) READY\n$/.exec(readFileSync(path, "utf8"));
      if (match) return Number(match[1]);
    }
    await sleep(50);
  }
  throw new Error("The native command did not become ready.");
}

test("SPEC-AGT-017/CA-02 — moving a running foreground command to the background preserves its PID and complete output", async () => {
  const ws = workspace();
  const fixture = commandFixture(ws);
  const provider = new ScriptedProvider([
    call("run_shell", { command: fixture.command, description: "commande continue" }),
    { text: "tour libéré" },
    call("background_output", { task_id: "b1", timeout: 5_000 }),
    { text: "commande terminée" },
  ]);
  const controller = new AbortController();
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider, env: productEnv(ws), signal: controller.signal });
  try {
    await run.idle();
    run.type("lance"); run.type(KEY.enter);
    const pid = await ready(fixture.starts);
    run.type("\u001bg");
    await run.waitFor((text) => text.includes("tour libéré"), "foreground released without restarting the command", 4_000);
    expect(processExists(pid)).toBe(true);
    expect(readFileSync(fixture.starts, "utf8")).toBe(`${pid} READY\n`);
    expect(JSON.stringify(provider.requests[1]?.history)).toContain("task b1");
    writeFileSync(fixture.release, "go");
    run.type("lis la fin"); run.type(KEY.enter);
    await run.waitFor((text) => text.includes("commande terminée"));
    const output = JSON.stringify(provider.requests[3]?.history);
    expect(output).toContain("avant transfert");
    expect(output).toContain("après transfert");
    expect(output).toContain("completed");
    expect(processExists(pid)).toBe(false);
    expect(readFileSync(fixture.starts, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { writeFileSync(fixture.release, "go"); controller.abort(); await run.done; }
}, 20_000);

test("TECH — failure to create the background output file preserves foreground cancellation", async () => {
  const ws = workspace();
  const fixture = commandFixture(ws);
  const environment = productEnv(ws);
  const background = new BackgroundTasks({ dir: ws.write("blocked-tasks", "ordinary file"), maxOutputBytes: 10_000, monitorMaxLinesPerMinute: 10, monitorWindowMs: 10 });
  const shell = new ShellRuntime({ platform: currentPlatform(), projectCwd: ws.project, allowedDirectories: [ws.project], childEnv: environment,
    forcedVariables: {}, excluded: () => false, posix: detectPosixShell(undefined, environment, currentPlatform()), workDir: join(ws.root, "shell"),
    settings: { defaultTimeoutMs: 60_000, maxTimeoutMs: 60_000, outputLimit: 10_000, graceMs: 200, powershellLoadProfile: false } });
  const controller = new AbortController();
  const context = { ...testToolFields(), platform: currentPlatform(), home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal: controller.signal, shell, background } as ToolContext;
  const running = runShellTool.execute({ command: fixture.command }, context);
  try {
    const pid = await ready(fixture.starts);
    expect(() => background.detachForeground()).toThrow();
    expect(background.hasForeground).toBe(true);
    controller.abort();
    const result = await Promise.race([running, sleep(6_000).then(() => { throw new Error("Foreground cancellation was lost after the failed transfer."); })]);
    expect(result.errorKind).toBe("interrupted");
    expect(processExists(pid)).toBe(false);
  } finally { controller.abort(); await shell.stopAll(); await running; }
}, 15_000);

test("SPEC-AGT-018/CA-01 — the live task panel shows the current tool, tool count and reported tokens of a background agent", async () => {
  const ws = workspace();
  const fixture = commandFixture(ws);
  const provider = new ScriptedProvider([
    call("spawn_agent", { description: "recherche en cours", prompt: "execute the command", detached: true }),
    { text: "principal disponible" },
    call("background_output", { task_id: "a1", timeout: 5_000 }),
    { text: "rapport reçu" },
  ], [call("run_shell", { command: fixture.command }), { text: "rapport de l’agent" }]);
  const controller = new AbortController();
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider, env: productEnv(ws), signal: controller.signal });
  try {
    await run.idle();
    run.type("délègue"); run.type(KEY.enter);
    await ready(fixture.starts);
    await run.waitFor(() => /Agent a1.*run_shell/.test(run.screen().join("\n")), "live background agent activity");
    const panel = run.screen().join("\n");
    expect(panel).toContain("1 outil");
    expect(panel).toContain("110 jetons");
    await run.waitFor((text) => text.includes("principal disponible"));
    run.type("/background-tasks"); run.type(KEY.enter);
    await run.waitFor((text) => text.includes("Tâches de fond — choisir") && text.includes("run_shell"), "activity in task details");
    await sleep(380); run.type(KEY.escape);
    await run.idle();
    writeFileSync(fixture.release, "go");
    run.type("lis le rapport"); run.type(KEY.enter);
    await run.waitFor((text) => text.includes("rapport reçu"));
    expect(JSON.stringify(provider.requests.filter((request) => request.purpose !== "subagent").at(-1)?.history)).toContain("rapport de l’agent");
  } finally { writeFileSync(fixture.release, "go"); controller.abort(); await run.done; }
}, 20_000);

test("TECH — cancelling the parent turn after a transfer leaves its command alive, then background_stop stops that same process", async () => {
  const ws = workspace();
  const fixture = commandFixture(ws);
  const provider = new ScriptedProvider([
    call("run_shell", { command: fixture.command }),
    { text: "attente du modèle", delayMs: 30_000 },
    call("background_stop", { task_id: "b1" }),
    { text: "tâche arrêtée" },
  ]);
  const controller = new AbortController();
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider, env: productEnv(ws), signal: controller.signal });
  try {
    await run.idle(); run.type("lance"); run.type(KEY.enter);
    const pid = await ready(fixture.starts);
    run.type("\u001bg");
    await run.waitFor((text) => text.includes("attente du modèle"));
    run.type(KEY.ctrlC);
    await run.waitFor((text) => text.includes("Interrompu par l'utilisateur."));
    expect(processExists(pid)).toBe(true);
    run.type("arrête la tâche"); run.type(KEY.enter);
    await run.waitFor((text) => text.includes("tâche arrêtée"));
    expect(processExists(pid)).toBe(false);
    expect(readFileSync(fixture.starts, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { controller.abort(); await run.done; }
}, 20_000);

test("TECH — transferring a command preserves its original timeout and supports a remapped shortcut", async () => {
  const ws = workspace();
  const fixture = commandFixture(ws);
  const provider = new ScriptedProvider([
    call("run_shell", { command: fixture.command, timeout: 3_000 }),
    { text: "transfert effectué" },
    call("background_output", { task_id: "b1", timeout: 7_000 }),
    { text: "délai confirmé" },
  ]);
  const controller = new AbortController();
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider, env: productEnv(ws), signal: controller.signal,
    userConfig: { ui: { keybindings: { bindings: { "task.background": ["alt+k"] } } } } });
  try {
    await run.idle(); run.type("lance"); run.type(KEY.enter);
    const pid = await ready(fixture.starts);
    expect(run.screen().join("\n")).toContain("Alt+K");
    run.type("\u001bk");
    await run.waitFor((text) => text.includes("transfert effectué"));
    run.type("attends la limite"); run.type(KEY.enter);
    await run.waitFor((text) => text.includes("délai confirmé"), "original command timeout", 10_000);
    expect(JSON.stringify(provider.requests[3]?.history)).toContain("timed_out");
    expect(processExists(pid)).toBe(false);
  } finally { controller.abort(); await run.done; }
}, 20_000);
