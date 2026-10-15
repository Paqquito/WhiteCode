// Supports: SPEC-INT-014 (actual interactive selector and native MCP fixture).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
function fixture() {
  const ws = workspace(),
    log = ws.write("methods.log", "");
  const config = ws.write(
    "channels.json",
    JSON.stringify({
      tools: [],
      logFile: log,
      resources: [
        {
          uri: "team-channel:C123",
          name: "dev-platform",
          text: "PRIVATE CHANNEL CONTENT MUST NOT BE READ",
        },
        {
          uri: "team-channel:C456",
          name: "dev-tools",
          text: "OTHER PRIVATE CHANNEL CONTENT",
        },
        { uri: "team-channel:C789", name: "support", text: "SUPPORT CONTENT" },
      ],
    }),
  );
  ws.write(
    "home/config/connectors.json",
    JSON.stringify({
      servers: {
        equipe: {
          transport: "stdio",
          command: process.execPath,
          args: [join(import.meta.dir, "helpers/mcp-server.ts"), config],
        },
      },
    }),
  );
  return { ws, log };
}
test("SPEC-INT-014/CA-01 — typing @equipe:dev proposes cached channels and inserts a destination without reading content", async () => {
  const f = fixture(),
    controller = new AbortController(),
    provider = new ScriptedProvider([{ text: "Destination received." }]),
    run = interactive(["--wait-for-mcp"], f.ws, {
      provider,
      signal: controller.signal,
      userConfig: {
        ui: { promptSuggestions: false },
        sessions: { autoTitle: false },
      },
    });
  try {
    await run.idle();
    run.type("@equipe:dev");
    await run.waitFor(
      (t) =>
        t.includes("equipe:dev-platform") && t.includes("equipe:dev-tools"),
    );
    expect(provider.requests.length).toBe(0);
    run.type(KEY.enter);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Destination received."));
    const request = JSON.stringify(provider.requests[0]!.history);
    expect(request).toContain("Untrusted destination reference only");
    expect(request).toContain("dev-platform");
    expect(request).not.toContain("PRIVATE CHANNEL CONTENT");
    expect(readFileSync(f.log, "utf8")).not.toContain("resources/read");
  } finally {
    controller.abort();
    await run.done;
  }
}, 12000);
test("TECH — disabling channel suggestions leaves the channel selector empty", async () => {
  const f = fixture(),
    controller = new AbortController(),
    run = interactive(["--wait-for-mcp"], f.ws, {
      provider: new ScriptedProvider([]),
      signal: controller.signal,
      userConfig: { integrations: { teamChat: { channelSuggestions: false } } },
    });
  try {
    await run.idle();
    run.type("@equipe:dev");
    await new Promise((r) => setTimeout(r, 150));
    expect(run.screen().join("\n")).not.toContain("equipe:dev-platform");
    expect(readFileSync(f.log, "utf8")).not.toContain("resources/read");
  } finally {
    controller.abort();
    await run.done;
  }
}, 10000);
