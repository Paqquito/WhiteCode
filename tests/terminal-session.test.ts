// Supports: SPEC-OUT-010/CA-03 (actual tool call refuses before execution without a multiplexer).
import { expect } from "bun:test";
import { profiledTest } from "./helpers/profiled-test";
const test = profiledTest(import.meta.path);
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-OUT-010/CA-03 — calling the enabled tool without a multiplexer explicitly refuses and executes no command", async () => {
  const ws = workspace(),
    marker = join(ws.project, "must-not-exist.txt"),
    provider = new ScriptedProvider([
      (request) => {
        expect(request.tools.map((tool) => tool.name)).toContain(
          "terminal_session",
        );
        return {
          toolCalls: [
            {
              name: "terminal_session",
              input: {
                session: "server",
                action: "command",
                command: "printf executed > must-not-exist.txt",
              },
            },
          ],
        };
      },
      (request) => {
        expect(JSON.stringify(request.history)).toContain(
          "No command was executed",
        );
        expect(JSON.stringify(request.history)).toContain(
          "no supported terminal multiplexer",
        );
        return { text: "Terminal unavailable" };
      },
    ]);
  const result = await cli(["--non-interactive", "Start server"], ws, {
    provider,
    extra: { terminalMultiplexor: null },
    userConfig: { tools: { terminalSession: { enabled: true } } },
  });
  expect(result.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(result.stdout).toContain("Terminal unavailable");
});
