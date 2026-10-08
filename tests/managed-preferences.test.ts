// Managed preference locks and administrator-only keys, through the shared session drivers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { productEnv, record } from "./helpers/hooks";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const CONFIRMED = {
  init: { decisionAuthority: true },
  userConfig: { engine: { control: { allowEscalation: true } } },
  answers: { confirm_escalation: (params: Record<string, unknown>) => ({ decision: "confirm", escalationId: params["escalationId"] }) },
};

describe("managed preferences", () => {
  test("SPEC-CFG-001/CA-03 — /preferences displays the organisation lock and refuses a change without writing either file", async () => {
    const ws = workspace();
    const managed = ws.write("managed/policy.json", JSON.stringify({ permissions: { initialMode: "ask" } }));
    const provider = new ScriptedProvider([]);
    const abort = new AbortController();
    const run = interactive([], ws, { provider, signal: abort.signal, env: productEnv(ws), userConfig: { ui: { exitConfirmation: false } } });
    try {
      await run.idle();
      const user = join(ws.configHome, "config.json");
      const before = readFileSync(user, "utf8");
      const policy = readFileSync(managed, "utf8");
      run.type("/preferences" + KEY.enter);
      await run.waitFor((t) => t.includes("imposé par votre organisation") && t.includes("lecture seule"), "managed lock in the preferences list");
      run.type("/preferences permissions.initialMode" + KEY.enter);
      await run.waitFor((t) => t.includes("source : managed") && t.includes("imposé par votre organisation"), "managed lock on the individual preference");
      run.type("/preferences permissions.initialMode planning" + KEY.enter);
      await run.waitFor((t) => t.includes("Ce réglage est fixé par l'organisation") && t.includes("lecture seule"), "managed change refused");
      expect(readFileSync(user, "utf8")).toBe(before);
      expect(readFileSync(managed, "utf8")).toBe(policy);
      expect(provider.requests).toHaveLength(0);
      run.type("/quit" + KEY.enter);
      expect((await run.done).code).toBe(0);
    } finally {
      abort.abort();
      await run.done;
    }
  }, 20_000);

  test("TECH — a lock introduced with the same effective value between control requests is enforced before /preferences writes", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([]);
    const host = new Host(ws, { provider, ...CONFIRMED });
    try {
      const initial = await host.request("invoke_command", { command: "/preferences permissions.initialMode" });
      expect(JSON.stringify(initial)).toContain("source : default");
      const user = join(ws.configHome, "config.json");
      const before = readFileSync(user, "utf8");
      const managed = ws.write("managed/policy.json", JSON.stringify({ permissions: { initialMode: "ask" } }));
      const policy = readFileSync(managed, "utf8");
      const refused = await host.request("invoke_command", { command: "/preferences permissions.initialMode planning" });
      expect(JSON.stringify(refused)).toContain("Ce réglage est fixé par l'organisation");
      expect(JSON.stringify(refused)).toContain("lecture seule");
      const current = await host.request("invoke_command", { command: "/preferences permissions.initialMode" });
      expect(JSON.stringify(current)).toContain("source : managed");
      expect(JSON.stringify(current)).toContain("imposé par votre organisation");
      expect(readFileSync(user, "utf8")).toBe(before);
      expect(readFileSync(managed, "utf8")).toBe(policy);
      expect(provider.requests).toHaveLength(0);
    } finally {
      host.feed.end();
      expect((await host.finish()).code).toBe(0);
    }
  }, 20_000);

  test("SPEC-CFG-003/CA-04 — hooksConfig.managedOnly in the user file is warned about and ignored; the user hook still runs", async () => {
    const ws = workspace();
    const hook = record(ws, "user-prompt");
    const provider = new ScriptedProvider([{ text: "done" }]);
    const result = await cli(["--non-interactive", "Read the project summary."], ws, {
      provider,
      env: productEnv(ws),
      userConfig: { hooksConfig: { managedOnly: true }, hooks: { prompt_submitted: [{ actions: [{ type: "command", command: hook.command }] }] } },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("`hooksConfig.managedOnly` n'est pas autorisé dans les paramètres de portée utilisateur");
    expect(result.stderr).toContain("valeur ignorée");
    expect(result.stdout).toBe("done\n");
    expect(hook.read()).toHaveLength(1);
    expect(hook.read()[0].event).toBe("prompt_submitted");
    expect(provider.requests).toHaveLength(1);
  });
});
