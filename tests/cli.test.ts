import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const PROJECT_DIR = loadIdentity().get("PROJECT_DIR");

describe("SPEC-MOD-011 global options", () => {
  test("SPEC-MOD-011/CA-01 — a misspelled option fails with a suggestion", async () => {
    const r = await cli(["--non-interactiv", "x"], workspace());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Vouliez-vous dire --non-interactive ?");
  });

  test("SPEC-MOD-011/CA-02 — --model on the command line wins over the configuration", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await cli(["--non-interactive", "--model", "medium", "x"], ws, { provider, userConfig: { models: { selected: "small" } } });
    expect(r.code).toBe(0);
    expect(provider.requests[0]!.model.tier).toBe("MODEL_MEDIUM");
  });

  test("SPEC-MOD-011/CA-04 — without --allow-unrestricted-mode the unrestricted mode is refused", async () => {
    const r = await cli(["--non-interactive", "--approval-mode", "unrestricted", "x"], workspace(), { provider: new ScriptedProvider([]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--allow-unrestricted-mode");
  });

  test("SPEC-MOD-011/CA-05 — --connectors-only without --connectors fails, naming both options", async () => {
    const r = await cli(["--connectors-only", "x"], workspace());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--connectors-only");
    expect(r.stderr).toContain("--connectors");
  });

  test("SPEC-MOD-011/CA-07 — --help shows the help and exits with 0", async () => {
    const r = await cli(["--help"], workspace());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--non-interactive");
    expect(r.stdout).toContain("--allow-project-trust");
  });

  test("SPEC-MOD-011/CA-08 — --remote-session with --background is refused before any process or network call", async () => {
    const provider = new ScriptedProvider([]);
    const r = await cli(["--remote-session", "a", "--background", "b"], workspace(), { provider });
    expect(r.code).toBe(2);
    expect(provider.requests).toHaveLength(0);
  });

  test("SPEC-MOD-011/CA-09 — --background with --reopen is refused explicitly", async () => {
    const r = await cli(["--background", "b", "--reopen=abc"], workspace());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--background et --reopen");
  });

  test("SPEC-MOD-011/CA-12 — --dry-run without --restore-files stops before creating a session, code 2", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([]);
    const r = await cli(["--non-interactive", "--dry-run", "x"], ws, { provider });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--restore-files");
    expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  test("TECH — a catalogued option whose feature is not delivered is refused, never ignored", async () => {
    const r = await cli(["--non-interactive", "--wait-for-capacity", "x"], workspace());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("non disponible dans cette version");
  });
});

describe("SPEC-MOD-002 non-interactive mode", () => {
  test("SPEC-MOD-002/CA-01 — a request in argument: the result on stdout and code 0", async () => {
    const r = await cli(["--non-interactive", "bonjour"], workspace(), { provider: new ScriptedProvider([{ text: "Salut !" }]) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Salut !\n");
  });

  test("SPEC-MOD-002/CA-02 — an action requiring permission without rule is refused, the model is told and the run goes on", async () => {
    const ws = workspace();
    const outside = ws.write("home/private.txt", "PRIVATE");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: outside } }] }, { text: "Je n'ai pas pu lire le fichier." }]);
    const r = await cli(["--non-interactive", "lis"], ws, { provider });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Je n'ai pas pu lire le fichier.\n");
    const history = JSON.stringify(provider.requests[1]!.history);
    expect(history).toContain("Action denied");
    expect(history).not.toContain("PRIVATE");
  });

  test("SPEC-MOD-002/CA-03 — without a terminal and without the option, the automated mode is chosen", async () => {
    const r = await cli(["bonjour"], workspace(), { provider: new ScriptedProvider([{ text: "ok" }]), tty: false });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ok\n");
  });

  test("SPEC-MOD-002/CA-04 — SPEC-MOD-005/CA-01 — with a limit of 3 iterations the run stops with code 3", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "a");
    const step = { toolCalls: [{ name: "read_file", input: { path: file } }] };
    const r = await cli(["--non-interactive", "--max-iterations", "3", "--result-format", "json", "boucle"], ws, { provider: new ScriptedProvider([step, step, step, step, step]) });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ haltReason: "iteration_limit", iterations: 3 });
  });

  test("SPEC-MOD-002/CA-05 — an external stop signal records the state and exits with 130", async () => {
    const ws = workspace();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ hang: true }]), signal: controller.signal });
    expect(r.code).toBe(130);
    const sessions = join(ws.configHome, "sessions");
    const [projectFolder] = readdirSync(sessions);
    const files = readdirSync(join(sessions, projectFolder!)).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
  });

  test("SPEC-MOD-002/CA-06 — a configuration error writes nothing on stdout and exits with 2", async () => {
    const r = await cli(["--non-interactive", "--config-source", "missing.json", "x"], workspace(), { provider: new ScriptedProvider([]) });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("TECH — the request is read from the standard input when no argument is given (EF-06), and required (ERR-01)", async () => {
    const provider = new ScriptedProvider([{ text: "lu" }]);
    const r = await cli(["--non-interactive"], workspace(), { provider, stdin: "ligne 1\nligne 2\n" });
    expect(r.code).toBe(0);
    expect(JSON.stringify(provider.requests[0]!.history[0])).toContain("ligne 1\\nligne 2");
    const empty = await cli(["--non-interactive"], workspace(), { stdin: "" });
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("Aucune demande");
  });

  test("E-013 — encrypted storage requested: the persistent session refuses to start, nothing written in clear", async () => {
    const ws = workspace();
    const r = await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]), userConfig: { storage: { encryption: { enabled: true } } } });
    expect(r.code).toBe(2);
    expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
  });

  test("TECH — a transcript is written for the run (SPEC-SES-001) and the project settings folder is not the user folder (E-030)", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/config.json`, "{}");
    const r = await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(r.code).toBe(0);
    const sessions = join(ws.configHome, "sessions");
    expect(readdirSync(sessions)).toHaveLength(1);
  });
});

describe("SPEC-MOD-003 formats", () => {
  test("SPEC-MOD-003/CA-03 — json output: a single object with answer, cost, duration and turns", async () => {
    const r = await cli(["--non-interactive", "--model", "large", "--result-format", "json", "x"], workspace(), { provider: new ScriptedProvider([{ text: "réponse", usage: { input: 1_000_000, output: 100_000 } }]) });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]!);
    expect(doc).toMatchObject({ type: "result", result: "réponse", haltReason: "completed", turns: 1, iterations: 1, cost: { currency: "USD", known: true } });
    expect(doc.cost.confirmed).toBeCloseTo(4 + 2, 5); // 1 M input at 4 + 0.1 M output at 20
    expect(typeof doc.elapsedMs).toBe("number");
  });
});
