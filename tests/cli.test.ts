import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const PROJECT_DIR = loadIdentity().get("PROJECT_DIR");

test("TECH — a value-taking option cannot swallow a coordination flag and launch a service", async () => {
  for (const args of [["--orchestrator", "connector-server", "start", "--root"], ["connector-server", "start", "--root", "--orchestrator"]]) {
    const ws = workspace(); ws.write("project/--orchestrator/.keep", "");
    let factories = 0;
    const provider = new ScriptedProvider([]);
    const result = await cli(args, ws, { provider, extra: { providerFactory: () => { factories++; return provider; } } });
    expect(result.code).toBe(2); expect(result.stdout).toBe(""); expect(factories).toBe(0);
    expect(result.stderr).not.toContain("Rôle : service de connecteur");
  }
  const ws = workspace(); ws.write("project/--orchestrator/.keep", "");
  const literal = await cli(["connector-server", "start", "--root=--orchestrator"], ws, { provider: new ScriptedProvider([]) });
  expect(literal.code).toBe(0); expect(literal.stderr).toContain("Rôle : service de connecteur");
});

test("TECH — an unavailable coordination role cannot enter the authentication command shortcuts", async () => {
  for (const command of ["/login", "/logout"]) {
    const result = await cli(["--orchestrator", command], workspace());
    expect(result.code).toBe(2); expect(result.stderr).toContain("ne dispose pas de la capacité de coordination");
    expect(result.stdout).toBe("");
  }
});

test("TECH — a leading coordination flag stays before the literal-argument separator", async () => {
  const ws = workspace(); ws.write("sample.json", "{}");
  const provider = new ScriptedProvider([]);
  const result = await cli(["--orchestrator", "config", "validate", "--", join(ws.root, "sample.json")], ws, { provider });
  expect(result.code).toBe(2); expect(result.stderr).toContain("opération d'administration");
  expect(provider.requests).toHaveLength(0);
});

test("TECH — a coordination word after the separator is ordinary prompt text", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]);
  const result = await cli(["--non-interactive", "--", "--orchestrator"], workspace(), { provider });
  expect(result.code).toBe(0); expect(JSON.stringify(provider.requests[0]!.history)).toContain("--orchestrator");
});

test("SPEC-MOD-011/CA-10 — the coordination role belongs to a session and is rejected on all hosting services", async () => {
  for (const family of ["direct-server", "connector-server", "remote-access", "service", "session-runner", "job-runner"]) {
    for (const args of [[family, "start", "--orchestrator"], ["--orchestrator", family, "start"]]) {
      const ws = workspace(); const provider = new ScriptedProvider([]);
      const result = await cli(args, ws, { provider });
      expect(result.code).toBe(2); expect(result.stdout).toBe("");
      expect(result.stderr).toContain("appartient à une session");
      expect(provider.requests).toHaveLength(0);
      expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
    }
  }
});

test("SPEC-MOD-011/CA-11 — a session engine without coordination capability refuses before any session or model request", async () => {
  for (const args of [["--non-interactive", "--orchestrator", "go"], ["direct-server", "connect", "wss://example.test", "--orchestrator"], ["job", "create", "sample", "--orchestrator"]]) {
    const ws = workspace(); const provider = new ScriptedProvider([]);
    const result = await cli(args, ws, { provider });
    expect(result.code).toBe(2); expect(result.stderr).toContain("ne dispose pas de la capacité de coordination");
    expect(provider.requests).toHaveLength(0); expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
  }
});

test("TECH — coordination flags have no value, do not apply to administration, and preserve help without effects", async () => {
  const wrong = await cli(["config", "validate", "--orchestrator"], workspace());
  expect(wrong.code).toBe(2); expect(wrong.stderr).toContain("opération d'administration");
  const value = await cli(["direct-server", "start", "--orchestrator=false"], workspace());
  expect(value.code).toBe(2); expect(value.stderr).toContain("n’accepte pas de valeur");
  const help = await cli(["--orchestrator", "connector-server", "start", "--help"], workspace());
  expect(help.code).toBe(0); expect(help.stdout).toContain("Serveur de connecteur"); expect(help.stderr).toBe("");
});

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
    const provider = new ScriptedProvider([]);
    const r = await cli(["--non-interactive", "--extension-dir-watch", "x"], workspace(), { provider });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("non disponible dans cette version");
    expect(provider.requests).toHaveLength(0);
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

  test("SPEC-MOD-002/CA-05 — SPEC-MOT-009/CA-04 — an external stop signal records the state and exits with 130", async () => {
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

  test("SPEC-SES-001/CA-07 — encrypted storage with a locked vault refuses persistent startup without a clear transcript", async () => {
    const ws = workspace(), provider = new ScriptedProvider([]);
    const r = await cli(["--non-interactive", "x"], ws, { provider, userConfig: { storage: { encryption: { enabled: true } }, engine: { nonInteractive: { persistSession: true } } }, extra: { credentialVault: { read() { throw new Error("locked fixture"); }, write() { throw new Error("must not write"); }, remove() {} } } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("coffre"); expect(provider.requests).toHaveLength(0);
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
