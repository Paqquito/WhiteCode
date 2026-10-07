// Settings from the command line (SPEC-CFG-004), changes during a session (SPEC-CFG-005), managed preferences
// (SPEC-CFG-003) and the environment imposed by the administrator (SPEC-CFG-008).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "../src/config/settings";
import { cli, workspace } from "./helpers/env";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
import { ScriptedProvider } from "./helpers/scripted-provider";

const PROJECT_DIR = ".pilote-dev";
const results = (provider: ScriptedProvider, i: number) =>
  provider.requests[i]!.history.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : [])) as unknown as Array<{ isError: boolean; content: Array<{ text: string }> }>;

describe("SPEC-CFG-004 settings on the command line", () => {
  test("SPEC-CFG-004/CA-01 — --config-source sets models.selected = small, the project says large: small is effective, from the cli scope", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ models: { selected: "large" } }));
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await cli(["--non-interactive", "--allow-project-trust", "--config-source", '{"models":{"selected":"small"}}', "x"], ws, { provider });
    expect(r.code).toBe(0);
    expect(provider.requests[0]!.model.id).toBe("test-small");
    const s = Settings.load({
      sources: [
        { scope: "project", name: "p", text: JSON.stringify({ models: { selected: "large" } }) },
        { scope: "cli", name: "--config-source", text: JSON.stringify({ models: { selected: "small" } }) },
      ],
      projectTrusted: true,
    });
    expect([s.get("models.selected"), s.origin("models.selected")]).toEqual(["small", "cli"]);
  });

  test("SPEC-CFG-004/CA-02 — --config-source with small and --model medium: medium is effective", async () => {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    await cli(["--non-interactive", "--config-source", '{"models":{"selected":"small"}}', "--model", "medium", "x"], workspace(), { provider });
    expect(provider.requests[0]!.model.id).toBe("test-medium");
  });

  test("SPEC-CFG-004/CA-03 — --config-source with invalid JSON: the launch stops on ERR-01", async () => {
    const r = await cli(["--non-interactive", "--config-source", '{"models": ', "x"], workspace(), { provider: new ScriptedProvider([]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-source : JSON invalide.");
  });
});

describe("SPEC-CFG-005 changes during a session", () => {
  test("SPEC-CFG-005/CA-01 — a deny rule added to the user settings during the session: the next call is refused without restart", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "a\n");
    const b = ws.write("project/b.txt", "b\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { toolCalls: [{ name: "read_file", input: { path: b } }] }, { text: "done" }]);
    let written = false;
    const r = await cli(["--non-interactive", "x"], ws, {
      provider,
      extra: {
        onEvent: (e) => {
          if (e.type !== "tool_result" || written) return;
          written = true;
          const config = JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"));
          writeFileSync(join(ws.configHome, "config.json"), JSON.stringify({ ...config, permissions: { denyRules: ["read_file(b.txt)"] } }));
        },
      },
    });
    expect(r.code).toBe(0);
    const [first, second] = results(provider, 2);
    expect(first!.isError).toBe(false);
    expect(second!.isError).toBe(true);
    expect(second!.content[0]!.text).toContain("Denied by the rule read_file(b.txt)");
  });

  test("SPEC-CFG-005/CA-02 — SPEC-CFG-005/CA-03 — a cold key changed: announced for the next session; a file made invalid: the previous configuration stays, with a warning", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "a\n");
    const b = ws.write("project/b.txt", "b\n");
    const c = ws.write("project/c.txt", "c\n");
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "read_file", input: { path: a } }] },
      { toolCalls: [{ name: "read_file", input: { path: b } }] },
      { toolCalls: [{ name: "read_file", input: { path: c } }] },
      { text: "done" },
    ]);
    const path = join(ws.configHome, "config.json");
    let step = 0;
    const r = await cli(["--non-interactive", "x"], ws, {
      provider,
      userConfig: { permissions: { denyRules: ["read_file(c.txt)"] } },
      extra: {
        onEvent: (e) => {
          if (e.type !== "tool_result") return;
          step++;
          const config = JSON.parse(step === 1 ? readFileSync(path, "utf8") : "{}");
          if (step === 1) writeFileSync(path, JSON.stringify({ ...config, models: { ...config.models, effort: "low" } }));
          if (step === 2) writeFileSync(path, "{ this is not json");
        },
      },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Paramètres modifiés : models.effort ; ils prendront effet à la prochaine session.");
    expect(r.stderr).toMatch(/Paramètres invalides dans .*config.json : la configuration précédente reste appliquée./);
    const third = results(provider, 3)[2]!;
    expect(third.isError).toBe(true); // the deny rule of the last valid version still applies
  });
});

describe("SPEC-CFG-003 managed settings", () => {
  test("SPEC-CFG-003/CA-12 — SPEC-CFG-003/CA-15 — an invalid managed preference: only that value is ignored; the other managed settings and the session go on", async () => {
    const ws = workspace();
    ws.write("project/b.txt", "b\n");
    ws.write("managed/policy.json", JSON.stringify({ models: { effort: "extreme" }, permissions: { denyRules: ["read_file(b.txt)"] } }));
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "b.txt") } }] }, { text: "done" }]);
    const r = await cli(["--non-interactive", "x"], ws, { provider });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("models.effort");
    expect(results(provider, 1)[0]!.content[0]!.text).toContain("Denied by the rule read_file(b.txt)");
  });
});

describe("SPEC-CFG-008 environment imposed by the administrator", () => {
  test("TECH — SPEC-CFG-008/EF-01, EF-02, ERR-01 — an imposed variable replaces the user's one before the provider starts; an invalid name is ignored", async () => {
    const ws = workspace();
    const server = startFakeOpenAI([{ text: "through the imposed server" }]);
    ws.write("managed/policy.json", JSON.stringify({ environment: { variables: { OPENAI_BASE_URL: server.baseURL, "BAD NAME": "x" } } }));
    const r = await cli(["--non-interactive", "x"], ws, { userConfig: { api: { baseUrl: null } }, env: { OPENAI_BASE_URL: "http://127.0.0.1:9/v1" } });
    expect(r.stdout).toBe("through the imposed server\n");
    expect(r.stderr).toContain("Variable imposée invalide : BAD NAME.");
    server.stop();
  });
});
