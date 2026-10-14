// Supports: SPEC-MCP-016/CA-01/02 (configured registry and verified ordering).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Identity } from "../src/identity/identity";
import { resolveIdentityText } from "../src/identity/resolver";
import { cli, ROOT, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-MCP-016/CA-01 — connector search lists matching registry entries with verified publishers first", async () => {
  let requested = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => { const url = new URL(request.url); requested = url.searchParams.get("q") ?? ""; return Response.json({ connectors: [{ name: "community-tickets", description: "Community ticket connector", transport: "http", verified: false }, { name: "verified-tickets", description: "Verified ticket connector", transport: "http", verified: true }] }); } });
  try {
    const source = JSON.parse(readFileSync(`${ROOT}/identity/dev.identity.json`, "utf8")); source.services.SERVICE_MCP_REGISTRY = server.url.href;
    const result = resolveIdentityText(JSON.stringify(source), { version: "0.1.0" }); if (!result.identity) throw new Error("Fixture identity invalid");
    const run = await cli(["connector", "search", "tickets", "--json"], workspace(), { identity: new Identity(result.identity) });
    expect(run.code).toBe(0); expect(requested).toBe("tickets"); const rows = JSON.parse(run.stdout); expect(rows.map((row: { name: string }) => row.name)).toEqual(["verified-tickets", "community-tickets"]); expect(rows[0].verified).toBe(true);
  } finally { server.stop(true); }
});
test("SPEC-MCP-016/CA-02 — connectors management omits discovery when no registry service is configured", async () => {
  const provider = new ScriptedProvider([]), run = await cli(["--non-interactive", "/connectors"], workspace(), { provider });
  expect(run.code).toBe(0); expect(run.stdout.toLowerCase()).not.toContain("découvrir"); expect(provider.requests).toHaveLength(0);
});
