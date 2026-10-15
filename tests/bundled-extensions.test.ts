// Supports: SPEC-EXT-013 (activation and ordinary reloading without a catalogue).
import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("SPEC-EXT-013/CA-01 — an offline bundled extension is inactive by default and its skill appears after activation and reload", async () => {
  const ws = workspace(),
    p = new ScriptedProvider([]),
    h = new Host(ws, {
      provider: p,
      init: { decisionAuthority: true },
      answers: {
        confirm_escalation: (params) => ({
          decision: "confirm",
          escalationId: params["escalationId"],
        }),
      },
      userConfig: {
        engine: { control: { allowEscalation: true } },
        skills: { discovery: { enabled: false } },
      },
    });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/skill-list" }),
      ),
    ).not.toContain("review-kit:checklist");
    const config = join(ws.configHome, "config.json"),
      before = JSON.parse(readFileSync(config, "utf8"));
    const enabled = await cli(
      ["extension", "enable", "review-kit@bundled"],
      ws,
      { userConfig: before },
    );
    expect(enabled.code).toBe(0);
    expect(readFileSync(config, "utf8")).toContain(
      '"review-kit@bundled": true',
    );
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/reload-extensions" }),
      ),
    ).toContain("review-kit@bundled");
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/skill-list" }),
      ),
    ).toContain("review-kit:checklist");
    const listed = await cli(["extension", "list", "--json"], ws, {
      userConfig: JSON.parse(readFileSync(config, "utf8")),
    });
    expect(JSON.parse(listed.stdout)).toContainEqual(
      expect.objectContaining({
        name: "review-kit",
        catalog: "bundled",
        bundled: true,
      }),
    );
    const removed = await cli(
      ["extension", "remove", "review-kit@bundled", "--force"],
      ws,
    );
    expect(removed.code).not.toBe(0);
    expect(removed.stderr).toContain("seulement être désactivées");
    expect(p.requests).toHaveLength(0);
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 20000);
