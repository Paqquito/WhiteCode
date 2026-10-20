// Supports: SPEC-CAD-003 §5, SPEC-CMD-001 (canonical public entry points and host authority).
import { expect, test } from "bun:test";
import { INTERNAL_COMMANDS } from "../src/commands/internal";
import { buildProfile } from "../src/extension-points/build-flags" with { type: "macro" };
import { Host } from "./helpers/control";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { httpConnectorServer } from "./helpers/fake-mcp-http";

test("TECH — session command declarations use the canonical glossary names without old code aliases", () => {
  const names = INTERNAL_COMMANDS.map(command => command.name);
  for (const name of ["agent-catalog", "edit-memory-files", "changelog", "sandbox-settings", "session-link", "usage-stats"]) expect(names).toContain(name);
  for (const name of ["show-environment", "publish-session"]) expect(names.includes(name)).toBe(buildProfile() === "internal");
  for (const name of ["agents", "memory", "release-notes", "sandbox", "session", "stats", "env", "share"]) expect(names).not.toContain(name);
  for (const name of ["allow-dir", "agent-catalog", "preferences", "event-hooks", "connectors", "access-rules", "extensions", "sandbox-settings"]) expect(INTERNAL_COMMANDS.find(command => command.name === name)?.widening).toBe(true);
});

test("TECH — argument refusals show the actual canonical command instead of a retired code name", async () => {
  for (const command of ["changelog", "usage-stats"]) {
    const provider = new ScriptedProvider([]);
    const result = await cli(["--non-interactive", "/" + command + " unexpected"], workspace(), { provider });
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain("Usage : /" + command + ".");
    expect(provider.requests).toHaveLength(0);
  }
});

test("TECH — a non-designated control host cannot invoke canonical administration commands even when escalation is enabled", async () => {
  const provider = new ScriptedProvider([]), ws = workspace(), connector = httpConnectorServer();
  ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { url: connector.url } } }));
  const host = new Host(ws, { provider, argv: ["--wait-for-mcp"], userConfig: { engine: { control: { allowEscalation: true } } } });
  try {
    expect(JSON.stringify(await host.request("get_state"))).toContain("cnx_docs_lookup");
    const requestsBefore = connector.requests.length;
    for (const command of ["/agent-catalog create Test helper", "/sandbox-settings", "/connectors disable docs"]) {
      const reply = await host.request("invoke_command", { command });
      expect(reply["ok"]).toBe(false);
      expect(JSON.stringify(reply)).toContain("escalation_refused");
    }
    expect(host.demands("confirm_escalation")).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
    expect(JSON.stringify(await host.request("get_state"))).toContain("cnx_docs_lookup");
    expect(connector.requests).toHaveLength(requestsBefore);
  } finally { host.feed.end(); await host.finish(); connector.stop(); }
});
