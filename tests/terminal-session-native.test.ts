// Supports: SPEC-OUT-010/CA-01, CA-02 (real tmux, live HTTP process, two turns and /clear).
import { expect } from "bun:test";
import { profiledTest } from "./helpers/profiled-test";
const test = profiledTest(import.meta.path);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "../src/platform/system";
import { runToCompletion } from "../src/platform/process";
import { workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test.skipIf(process.platform === "win32" || !findExecutable("tmux"))(
  "SPEC-OUT-010/CA-01 — SPEC-OUT-010/CA-02 — a real terminal server survives a turn and /clear closes its private multiplexer",
  async () => {
    const ws = workspace(), controller = new AbortController();
    ws.write("project/server.ts", 'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("terminal-server-live") }); await Bun.write("port.txt", String(server.port)); console.log("SERVER_READY", server.port);');
    let socket = "", port = 0;
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "terminal_session", input: { session: "server", action: "command", command: `'${process.execPath.replaceAll("'", "'\\''")}' server.ts` } }] },
      { toolCalls: [{ name: "terminal_session", input: { session: "server", action: "wait", pattern: "SERVER_READY", timeout_ms: 5000 } }] },
      request => {
        const history = JSON.stringify(request.history);
        expect(history).toContain("SERVER_READY");
        socket = /tmux -L (terminal-[a-f0-9-]+)/.exec(history)![1]!;
        port = Number(readFileSync(join(ws.project, "port.txt"), "utf8"));
        return { text: "First turn finished" };
      },
      { toolCalls: [{ name: "terminal_session", input: { session: "server", action: "read" } }] },
      request => {
        expect(JSON.stringify(request.history.at(-1))).toContain("SERVER_READY");
        return { text: "Second turn finished" };
      },
      { text: "New conversation" },
    ]);
    const run = interactive([], ws, {
      provider, signal: controller.signal,
      userConfig: { permissions: { allowRules: ["run_shell"] }, tools: { terminalSession: { enabled: true } } },
    });
    const send = (text: string) => { run.type(text); run.type(KEY.enter); };
    try {
      await run.idle(); send("Start the server");
      await run.waitFor(text => text.includes("First turn finished"), "first terminal turn", 15000);
      await run.idle();
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("terminal-server-live");
      send("Read its terminal again");
      await run.waitFor(text => text.includes("Second turn finished"), "second terminal turn");
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("terminal-server-live");
      await run.idle(); send("/clear");
      const deadline = Date.now() + 5000;
      while (runToCompletion(findExecutable("tmux")!, ["-L", socket, "has-session"], { cwd: ws.project, env: process.env as Record<string, string>, timeoutMs: 1000 }).code === 0) {
        if (Date.now() > deadline) throw new Error("/clear left the terminal server running");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
      await run.idle(); send("Confirm the new conversation");
      await run.waitFor(text => text.includes("New conversation"));
      expect(provider.requests.at(-1)!.history.some(message => JSON.stringify(message).includes("SERVER_READY"))).toBe(false);
      await run.idle(); run.type(KEY.ctrlD); run.type(KEY.ctrlD);
      expect((await run.done).code).toBe(0);
    } finally { controller.abort(); await run.done; }
  }, 30000,
);
