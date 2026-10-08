// Control protocol of the integration kit (SPEC-MOD-006): a host drives a run in progress over the standard input and
// output, multiplexed with the `jsonl` events. Also the widening commands invoked by a host (SPEC-CMD-001 CA-10) and
// `/allow-dir` (SPEC-CMD-002).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, type Workspace } from "./helpers/env";
import { Host, type HostOptions, type Message } from "./helpers/control";
import { PROJECT_DIR } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const AUTHORITY = { decisionAuthority: true };
const ESCALATION = { engine: { control: { allowEscalation: true } } };
const write = (path: string, content = "x") => ({ toolCalls: [{ name: "write_file", input: { path, content } }] });
const read = (path: string) => ({ toolCalls: [{ name: "read_file", input: { path } }] });
const turnDone = (h: Host, n = 1) => h.waitFor((m) => m.type === "turn_completed" && m["turn"] === n);
const toolResults = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history.at(-1) ?? null);
const host = (ws: Workspace, provider: ScriptedProvider, o: Partial<HostOptions> = {}) => new Host(ws, { provider, ...o });
const error = (m: Message) => m["error"] as { code: string; message: string };
const result = (m: Message) => m["result"] as Record<string, unknown>;

async function end(h: Host) {
  h.feed.end();
  return h.finish();
}

describe("SPEC-MOD-006 decisions of the host", () => {
  test("SPEC-MOD-006/CA-01 — a designated host: a correlated approval_request is sent and awaited", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([write(target), { text: "fini" }]);
    const h = host(ws, p, { init: AUTHORITY, answers: { approval_request: () => ({ decision: "allow" }) } });
    h.user("écris");
    await turnDone(h);
    const r = await end(h);
    expect(r.code).toBe(0);
    expect(h.messages[0]!.type).toBe("control_init"); // § 5.4 step 2: first
    expect(h.messages[0]!["protocolVersion"]).toBe("1.0");
    const [demand] = h.demands("approval_request");
    expect(demand).toBeDefined();
    expect(String(demand!["id"])).toMatch(/^e-/);
    expect((demand!["params"] as Record<string, unknown>)["toolName"]).toBe("write_file");
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  test("SPEC-MOD-006/CA-02 — a host that does not answer in time: the action is denied and a warning is emitted", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([write(target), { text: "fini" }]);
    const h = host(ws, p, { init: { ...AUTHORITY, responseTimeoutMs: 1_000 } });
    h.user("écris");
    await turnDone(h);
    const r = await end(h);
    expect(h.demands("approval_request")).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
    expect(h.messages.some((m) => m.type === "error" && m["code"] === "warning" && String(m["message"]).includes("Aucune décision reçue"))).toBe(true);
    expect(toolResults(p, 1)).toContain("No decision was received");
    expect(r.code).toBe(0);
  });

  test("SPEC-MOD-006/CA-03 — parameters replaced by the host: they apply, after a new validation", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([write(target, "du modèle"), { text: "fini" }, write(target, "encore"), { text: "fini" }]);
    let answer: Record<string, unknown> = { decision: "allow_modified", input: { path: target, content: "de l'hôte" } };
    const h = host(ws, p, { init: AUTHORITY, answers: { approval_request: () => answer } });
    h.user("écris");
    await turnDone(h);
    expect(readFileSync(target, "utf8")).toBe("de l'hôte");
    expect(toolResults(p, 1)).toContain("The control host replaced the parameters");
    // Parameters that fail the validation are never executed.
    answer = { decision: "allow_modified", input: { content: "sans chemin" } };
    h.user("encore");
    await turnDone(h, 2);
    await end(h);
    expect(readFileSync(target, "utf8")).toBe("de l'hôte");
    expect(toolResults(p, 3)).toContain("parameters given by the control host are invalid");
  });

  test("SPEC-MOD-006/CA-04 — an explicit refusal rule: the answer allow of the host does not lift it", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([write(target), { text: "fini" }]);
    const h = host(ws, p, { argv: ["--deny-rule", "write_file(**/a.txt)"], init: AUTHORITY, answers: { approval_request: () => ({ decision: "allow" }) } });
    h.user("écris");
    await turnDone(h);
    await end(h);
    expect(h.demands("approval_request")).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
    expect(h.messages.some((m) => m.type === "permission" && m["decision"] === "deny")).toBe(true);
  });

  test("SPEC-MOD-006/CA-07 — a host that is not designated but handles decisions: it is never asked", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([write(target), { text: "fini" }]);
    const h = host(ws, p, { init: { demands: ["approval_request"] }, answers: { approval_request: () => ({ decision: "allow" }) } });
    h.user("écris");
    await turnDone(h);
    await end(h);
    expect(h.demands("approval_request")).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
  });

  test("TECH — a designated host that does not handle approval_request: the automated behaviour applies (FA-01)", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([write(target), { text: "fini" }]);
    const h = host(ws, p, { init: { ...AUTHORITY, demands: [] } });
    h.user("écris");
    await turnDone(h);
    await end(h);
    expect(existsSync(target)).toBe(false);
    expect(toolResults(p, 1)).toContain("no_prompt");
  });
});

describe("SPEC-MOD-006 requests of the host", () => {
  test("SPEC-MOD-006/CA-05 — a change to a mode the policy forbids: refused with a reason, the mode unchanged", async () => {
    const ws = workspace();
    const h = host(ws, new ScriptedProvider([]), { init: AUTHORITY });
    const refused = await h.request("set_approval_mode", { mode: "unrestricted" });
    expect(refused["ok"]).toBe(false);
    expect(error(refused).code).toBe("mode_refused");
    expect(error(refused).message).toContain("Mode refusé par la politique en vigueur.");
    const state = await h.request("get_state");
    expect(result(state)["permissionMode"]).toBe("no_prompt");
    expect((await end(h)).code).toBe(0);
  });

  test("SPEC-MOD-006/CA-08 — a host that is not designated: set_tool_permissions and set_approval_mode are refused", async () => {
    const ws = workspace();
    const h = host(ws, new ScriptedProvider([]), { init: {} });
    const rules = await h.request("set_tool_permissions", { add: [{ decision: "deny", rule: "run_shell" }] });
    const mode = await h.request("set_approval_mode", { mode: "planning" });
    for (const m of [rules, mode]) {
      expect(m["ok"]).toBe(false);
      expect(error(m).code).toBe("not_designated");
    }
    expect(result(await h.request("get_state"))["permissionMode"]).toBe("no_prompt");
    await end(h);
  });

  test("SPEC-MOD-006/CA-09 — a designated host sending an allow rule: it is not added without a distinct action of the user", async () => {
    const ws = workspace();
    const h = host(ws, new ScriptedProvider([]), { init: AUTHORITY, userConfig: ESCALATION, answers: { confirm_escalation: (params) => ({ decision: "refuse", escalationId: params["escalationId"] }) } });
    const allow = await h.request("set_tool_permissions", { add: [{ decision: "allow", rule: "write_file" }] });
    expect(allow["ok"]).toBe(false);
    expect(error(allow).message).toBe("Élargissement refusé : confirmation de l'utilisateur requise.");
    // A restrictive rule is added at once, and listed.
    const deny = await h.request("set_tool_permissions", { add: [{ decision: "deny", rule: "run_shell" }] });
    expect(result(deny)["rules"]).toEqual([{ decision: "deny", rule: "run_shell" }]);
    await end(h);
  });

  test("SPEC-MOD-006/CA-10 — a designated host asking for a more permissive mode without action of the user: refused, the mode unchanged", async () => {
    const ws = workspace();
    const h = host(ws, new ScriptedProvider([]), { init: AUTHORITY });
    const wider = await h.request("set_approval_mode", { mode: "auto_edit" });
    expect(wider["ok"]).toBe(false);
    expect(error(wider).code).toBe("escalation_refused");
    expect(result(await h.request("get_state"))["permissionMode"]).toBe("no_prompt");
    // A more restrictive mode is applied, and the stream says so (RG-04).
    const narrower = await h.request("set_approval_mode", { mode: "planning" });
    expect(result(narrower)["mode"]).toBe("planning");
    expect(h.messages.some((m) => m.type === "permission_mode" && m["mode"] === "planning")).toBe(true);
    await end(h);
  });

  test("SPEC-MOD-006/CA-11 SPEC-CMD-001/CA-10 — a host that is not designated invoking /allow-dir: not executed, the scope unchanged", async () => {
    const ws = workspace();
    const other = join(ws.root, "voisin");
    mkdirSync(other);
    writeFileSync(join(other, "f.txt"), "voisin");
    const p = new ScriptedProvider([read(join(other, "f.txt")), { text: "fini" }]);
    const h = host(ws, p, { init: {}, userConfig: ESCALATION });
    const r = await h.request("invoke_command", { command: `/allow-dir ${other}` });
    expect(r["ok"]).toBe(false);
    expect(error(r).code).toBe("escalation_refused");
    // The same command in a user message follows the same rules.
    h.user(`/allow-dir ${other}`);
    await h.waitFor((m) => m.type === "error" && String(m["message"]).startsWith("Élargissement refusé"));
    h.user("lis");
    await turnDone(h);
    await end(h);
    expect(toolResults(p, 1)).toContain("Action denied");
  });

  test("SPEC-MOD-006/CA-12 — allowEscalation false: an allow rule, a wider mode or a widening command are refused without confirm_escalation", async () => {
    const ws = workspace();
    const h = host(ws, new ScriptedProvider([]), { init: AUTHORITY, answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
    const replies = [
      await h.request("set_tool_permissions", { add: [{ decision: "allow", rule: "write_file" }] }),
      await h.request("set_approval_mode", { mode: "auto_edit" }),
      await h.request("invoke_command", { command: `/allow-dir ${ws.root}` }),
    ];
    for (const m of replies) expect(error(m).code).toBe("escalation_refused");
    expect(h.demands("confirm_escalation")).toHaveLength(0);
    await end(h);
  });

  test("SPEC-MOD-006/CA-13 SPEC-CMD-002/CA-01 — allowEscalation true: /allow-dir waits for confirm_escalation, then the folder is readable without asking", async () => {
    const ws = workspace();
    const other = join(ws.root, "voisin");
    mkdirSync(other);
    writeFileSync(join(other, "f.txt"), "contenu voisin");
    const p = new ScriptedProvider([read(join(other, "f.txt")), { text: "fini" }]);
    const h = host(ws, p, { init: AUTHORITY, userConfig: ESCALATION, answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
    const r = await h.request("invoke_command", { command: `/allow-dir ${other}` });
    expect(r["ok"]).toBe(true);
    expect(String(result(r)["shown"])).toContain("Dossier ajouté pour la session");
    const [demand] = h.demands("confirm_escalation");
    expect((demand!["params"] as Record<string, unknown>)["command"]).toBe(`/allow-dir ${other}`);
    h.user("lis");
    await turnDone(h);
    await end(h);
    expect(toolResults(p, 1)).toContain("contenu voisin");
    expect(h.demands("approval_request")).toHaveLength(0);
  });

  test("SPEC-MOD-006/CA-14 — a confirmation for another escalation, or received after the delay: without effect", async () => {
    const ws = workspace();
    let reply: (params: Record<string, unknown>) => unknown = () => ({ decision: "confirm", escalationId: "déjà-utilisé" });
    const h = host(ws, new ScriptedProvider([]), { init: { ...AUTHORITY, responseTimeoutMs: 1_000 }, userConfig: ESCALATION, answers: { confirm_escalation: (params) => reply(params) } });
    const reused = await h.request("set_approval_mode", { mode: "auto_edit" });
    expect(error(reused).code).toBe("escalation_refused");
    reply = (params) => new Promise((r) => setTimeout(() => r({ decision: "confirm", escalationId: params["escalationId"] }), 1_400));
    const late = await h.request("set_approval_mode", { mode: "auto_edit" });
    expect(error(late).code).toBe("escalation_refused");
    await new Promise((r) => setTimeout(r, 600)); // the late answer arrives, and changes nothing
    expect(result(await h.request("get_state"))["permissionMode"]).toBe("no_prompt");
    await end(h);
  });

  test("SPEC-MOD-006/CA-15 — allowEscalation true in the project scope: ignored, the widenings stay refused", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify(ESCALATION));
    const h = host(ws, new ScriptedProvider([]), { argv: ["--allow-project-trust"], init: AUTHORITY, answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
    const r = await h.request("set_approval_mode", { mode: "auto_edit" });
    expect(error(r).code).toBe("escalation_refused");
    expect(h.demands("confirm_escalation")).toHaveLength(0);
    const run = await end(h);
    expect(run.stderr).toContain("engine.control.allowEscalation");
  });
});

describe("SPEC-MOD-006 channel", () => {
  test("SPEC-MOD-006/CA-06 — a channel broken during a turn: the run stops cleanly and the session can be reopened", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ hang: true }]);
    const h = host(ws, p, { init: AUTHORITY });
    const init = await h.waitFor((m) => m.type === "control_init");
    h.user("longue tâche");
    await h.waitFor((m) => m.type === "user");
    const r = await end(h);
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("Canal de contrôle rompu");
    expect(h.messages.at(-1)!.type).toBe("run_completed");
    const id = String(init["sessionId"]);
    const reopened = await cli(["--non-interactive", `--reopen=${id}`, "suite"], ws, { provider: new ScriptedProvider([{ text: "repris" }]) });
    expect(reopened.code).toBe(0);
    expect(reopened.stdout).toContain("repris");
  });

  test("TECH — an unknown major version is refused at the initialization (EF-06, ERR-01); a newer minor version is accepted", async () => {
    const ws = workspace();
    const h = host(ws, new ScriptedProvider([]), { init: { protocolVersion: "2.0" } });
    const r = await end(h);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Version de protocole non prise en charge : 2.0.");
    const ok = host(workspace(), new ScriptedProvider([]), { init: { protocolVersion: "1.7" } });
    expect(result(await ok.request("get_state"))["designated"]).toBe(false);
    expect((await end(ok)).code).toBe(0);
  });

  test("TECH — unknown, malformed and duplicate requests get correlated errors, without stopping the run (FA-04, ERR-02, ERR-03, RG-03)", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "toujours là" }]);
    const h = host(ws, p, { init: {} });
    expect(error(await h.request("teleport")).code).toBe("unknown_request");
    expect(error(await h.request("add_context", { text: 3 })).code).toBe("invalid_request");
    h.send({ type: "control_request", id: "même", request: "get_state" });
    h.send({ type: "control_request", id: "même", request: "get_state" });
    await h.waitFor((m) => m.type === "control_response" && m["id"] === "même" && m["ok"] === false);
    h.send({ type: "control_response", id: "inconnu", ok: true, result: {} });
    await h.waitFor((m) => m.type === "error" && m["message"] === "Réponse orpheline ignorée.");
    h.user("encore là ?");
    await turnDone(h);
    expect((await end(h)).code).toBe(0);
  });

  test("TECH — requests in flight during a turn: get_state answers, cancel_turn stops the turn, the next message is handled (EF-02)", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ hang: true }, { text: "deuxième" }]);
    const h = host(ws, p, { init: {} });
    h.user("longue tâche");
    await h.waitFor((m) => m.type === "user");
    const state = await h.request("get_state");
    expect(result(state)["turnInProgress"]).toBe(true);
    expect(result(await h.request("cancel_turn"))).toEqual({ cancelled: true });
    await turnDone(h);
    const injected = await h.request("inject_user_message", { content: "suite" });
    expect(typeof result(injected)["messageId"]).toBe("string");
    const second = await turnDone(h, 2);
    expect(second["result"]).toBe("deuxième");
    const r = await end(h);
    expect(r.code).toBe(0);
    expect(h.messages.at(-1)!["turns"]).toBe(2);
  });

  test("TECH — add_context reaches the next request as data; list_commands marks the widening commands; shutdown ends the run", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "vu" }]);
    const h = host(ws, p, { init: {} });
    await h.request("add_context", { text: "fichier ouvert : main.ts", kind: "file" });
    const commands = result(await h.request("list_commands"))["commands"] as Array<Record<string, unknown>>;
    expect(commands.find((c) => c["name"] === "allow-dir")?.["widening"]).toBe(true);
    h.user("regarde");
    await turnDone(h);
    expect(JSON.stringify(p.requests[0]!.history)).toContain("Context added by the control host (file)");
    expect(result(await h.request("shutdown"))).toEqual({});
    const after = await h.request("get_state");
    expect(error(after).code).toBe("shutting_down");
    const r = await h.finish();
    expect(r.code).toBe(0);
    expect(h.messages.at(-1)!.type).toBe("run_completed");
  });

  test("TECH — the option needs the jsonl formats; a notification follows each turn when the host handles notify", async () => {
    const ws = workspace();
    const r = await cli(["--non-interactive", "--control-channel", "x"], ws, {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--control-channel exige");
    const h = host(workspace(), new ScriptedProvider([{ text: "ok" }]), { init: { demands: ["notify"] } });
    h.user("bonjour");
    await turnDone(h);
    await h.waitFor((m) => m.type === "control_request" && m["request"] === "notify");
    await end(h);
    expect(h.demands("notify")[0]!["params"]).toEqual({ kind: "turn_completed", turn: 1, haltReason: "completed" });
  });
});
