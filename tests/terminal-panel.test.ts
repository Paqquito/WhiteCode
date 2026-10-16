// Supports: SPEC-IHM-041/CA-01, CA-02, SPEC-OUT-015/CA-01, CA-02 (native tmux and OS pseudo-terminal).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "../src/platform/system";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { VTerm } from "./helpers/vterm";
import { containsSecret, maskSecrets } from "../src/shared/secrets";
import { interactive, KEY } from "./helpers/interactive";

test.skipIf(process.platform === "win32" || !findExecutable("tmux") || !findExecutable("python3"))(
  "SPEC-IHM-041/CA-01 — SPEC-IHM-041/CA-02 — SPEC-OUT-015/CA-01 — SPEC-OUT-015/CA-02 — a human terminal retains history, restores the conversation and draft, and masks its captured access token",
  async () => {
    const ws = workspace(), output = join(ws.root, "proof.json");
    const child = Bun.spawn([findExecutable("python3")!, join(import.meta.dir, "fixtures/terminal-panel-pty.py"), process.execPath, join(import.meta.dir, "fixtures/terminal-panel-probe.ts"), output], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, TERM: "xterm-256color" }, timeout: 28000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    const result = JSON.parse(readFileSync(output, "utf8"));
    expect(result.code).toBe(0);
    expect(result.requests[1].history.at(-1).parts).toEqual([{ type: "text", text: "DRAFT_RETAINED" }]);
    const captured = JSON.stringify(result.requests[2].history.at(-1));
    expect(captured).toContain("PANEL_NATIVE_ERROR");
    expect(captured).not.toContain("sk-fixture938471620597410000000000");
    expect(captured).toContain("[masqué]");
    const stages: string[] = JSON.parse(readFileSync(output + ".pty.json", "utf8"));
    const terminal = new VTerm(120, 30); terminal.write(stages[0]!);
    expect(terminal.all().join("\n")).toContain("CONVERSATION_KEPT");
    expect(terminal.screen().join("\n")).toContain("DRAFT_RETAINED");
    terminal.write(stages[1]!.slice(stages[0]!.length));
    expect(terminal.screen().join("\n")).toContain("PANEL_NATIVE_ERROR");
  }, 30000,
);

test("TECH — the terminal capture tool is absent without the interactive panel option", async () => {
  const provider = new ScriptedProvider([request => { expect(request.tools.some(tool => tool.name === "capture_terminal")).toBe(false); return { text: "No panel" }; }]);
  expect((await cli(["--non-interactive", "Check tools"], workspace(), { provider })).code).toBe(0);
});

test("TECH — secrets following escaped whitespace are masked without treating a task identifier as a key", () => {
  for (const separator of ["\\n", "\\r", "\\t", "\n"]) {
    const value = `printf '${separator}sk-fixture938471620597410000000000'`;
    expect(containsSecret(value)).toBe(true);
    expect(maskSecrets(value)).toBe(`printf '${separator}[masqué]'`);
  }
  expect(maskSecrets("task-fixture938471620597410000000000")).toBe("task-fixture938471620597410000000000");
});

test("TECH — an unavailable native panel warns, preserves the draft and exposes no invented terminal contents", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([
    request => {
      expect(request.tools.map(tool => tool.name)).toEqual(["capture_terminal"]);
      return { toolCalls: [{ name: "capture_terminal", input: {} }] };
    },
    request => { expect(JSON.stringify(request.history.at(-1))).toContain("No terminal panel is open"); return { text: "No invented output" }; },
  ]);
  const run = interactive(["--toolset", "capture_terminal"], workspace(), { provider, signal: controller.signal, extra: { terminalMultiplexor: null }, userConfig: { ui: { terminal: { enabled: true } } } });
  try {
    await run.idle(); run.type("Retained draft"); run.type("\u001b\u0014");
    await run.waitFor(text => text.includes("tmux est requis"));
    expect(run.screen().join("\n")).toContain("Retained draft");
    run.type(KEY.enter); await run.waitFor(text => text.includes("No invented output"));
    expect(provider.requests[0]!.history.at(-1)).toMatchObject({ role: "user", parts: [{ type: "text", text: "Retained draft" }] });
    await run.idle(); run.type(KEY.ctrlD); run.type(KEY.ctrlD);
    expect((await run.done).code).toBe(0);
  } finally { controller.abort(); await run.done; }
});
