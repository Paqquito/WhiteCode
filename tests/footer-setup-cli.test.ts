// Supports: SPEC-CMD-068 (specialised child context and protected settings approval).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Host } from "./helpers/control";
import { companyFixture } from "./helpers/company";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { TEST_USER_CONFIG } from "./helpers/env";
import { hook, productEnv } from "./helpers/hooks";
import { interactive } from "./helpers/interactive";
test("SPEC-CMD-068/CA-01 — requesting branch and model delegates to the setup agent, proposes a line and saves only after protected-file approval", async () => {
  const f = companyFixture(),
    path = join(f.ws.configHome, "config.json"),
    command = hook(
      f.ws,
      "actual-footer",
      'const { spawnSync } = await import("node:child_process"); const result = spawnSync("git", ["branch", "--show-current"], { cwd: payload.cwd, encoding: "utf8" }); if(result.status!==0) throw Error("Git unavailable"); console.log(result.stdout.trim()+" | "+payload.model.id);',
    );
  f.repository();
  f.git("branch", "-M", "footer-proof");
  const provider = new ScriptedProvider([
    (request) => {
      expect(JSON.stringify(request.history)).toContain("branche et modèle");
      return { toolCalls: [{ name: "read_file", input: { path } }] };
    },
    {
      text: "Proposition : lire la branche courante et le modèle du flux JSON.",
      toolCalls: [
        {
          name: "write_file",
          input: {
            path,
            content: JSON.stringify({
              ...TEST_USER_CONFIG,
              ui: { footerLine: { command } },
            }),
          },
        },
      ],
    },
    {
      text: "Ligne enregistrée : branche et modèle. Supprimez ui.footerLine.command pour annuler.",
    },
  ]);
  const h = new Host(f.ws, {
    provider,
    env: productEnv(f.ws),
    init: { decisionAuthority: true },
    userConfig: { engine: { control: { allowEscalation: true } } },
    answers: {
      confirm_escalation: (params) => ({
        decision: "confirm",
        escalationId: params["escalationId"],
      }),
      approval_request: () => ({ decision: "allow" }),
    },
  });
  try {
    const result = await h.request("invoke_command", {
      command: "/footer-line branche et modèle",
    });
    expect(JSON.stringify(result)).toContain("Ligne enregistrée");
    expect(h.demands("approval_request").length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path, "utf8")).ui.footerLine.command).toBe(
      command,
    );
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
  const controller = new AbortController(),
    run = interactive([], f.ws, {
      provider: new ScriptedProvider([]),
      signal: controller.signal,
      env: productEnv(f.ws),
      userConfig: { ui: { footerLine: { command } } },
    });
  try {
    await run.idle();
    await run.waitFor((text) => text.includes("footer-proof | test-medium"));
    expect(run.screen().join("\n")).toContain("footer-proof | test-medium");
  } finally {
    controller.abort();
    await run.done;
  }
}, 10000);
