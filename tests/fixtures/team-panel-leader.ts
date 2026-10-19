// Native bench: real product workers and tmux, scripted provider only; no real model claim.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity, type Workspace } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";

const [mode, descriptor] = process.argv.slice(2);
if (mode === "init") { const ws = workspace(); ws.write("project/allowed.txt", "ALLOWED_TEAM_WITNESS"); ws.write("project/denied.txt", "DENIED_TEAM_SECRET"); writeFileSync(descriptor!, JSON.stringify(ws)); console.log(ws.root); }
else {
  const ws = JSON.parse(readFileSync(descriptor!, "utf8")) as Workspace, identity = loadIdentity(), prefix = identity.get("ENV_PREFIX");
  const marker = join(ws.root, "worker-idle"), hook = join(ws.root, "waiting.sh"), events = join(ws.root, `${mode}-events.jsonl`);
  const command = (name: string, input: unknown) => ({ toolCalls: [{ name, input }] });
  writeFileSync(hook, `#!/bin/sh\nif [ ! -f '${marker}' ]; then touch '${marker}'; sleep 30; fi\n`);
  const creates = mode === "create" || mode === "cancel";
  const scripted = new ScriptedProvider(creates ? [command("form_team", { team: "review" }), command("spawn_agent", { team: "review", name: "reader", role: "general", description: "Native pane", prompt: "Read the task and report." }), { hang: true }] : [command("work_item_list", {}), { hang: true }], mode === "cancel" ? [command("run_shell", { command: `printf started > '${join(ws.root, "tool-started")}'; sleep 8; printf LATE_EFFECT > '${join(ws.project, "late.txt")}'` }), { text: "Unexpected delayed completion" }] : [command("read_file", { path: join(ws.project, "allowed.txt") }), command("read_file", { path: join(ws.project, "denied.txt") }), command("message_agent", { to: "lead", message: "UNREAD_TEAM_MESSAGE_51" }), { text: "UNREAD_TEAM_REPORT_51" }]);
  const controller = new AbortController(); process.on("SIGTERM", () => controller.abort());
  const result = await cli(["--non-interactive", "--approval-mode=no_prompt", "--toolset=form_team,spawn_agent,message_agent,read_file,work_item_list,run_shell", "--deny-rule", "read_file(denied.txt)", ...(mode === "cancel" ? ["--allow-rule", "run_shell"] : []), ...(creates ? ["--assign-session-id", "51515151-5151-4151-8151-515151515151"] : ["--reopen=51515151-5151-4151-8151-515151515151"]), "Coordinate the native team."], ws, {
    provider: { id: scripted.id, async *stream(request, signal) { appendFileSync(join(ws.root, "model-requests.jsonl"), JSON.stringify({ mode, agent: request.agent, purpose: request.purpose, history: request.history }) + "\n"); if (request.purpose !== "subagent") await Bun.sleep(mode === "resume" ? 500 : 100); yield* scripted.stream(request, signal); } },
    onErr: text => appendFileSync(join(ws.root, `${mode}-stderr.txt`), text),
    env: { PATH: process.env["PATH"]!, HOME: ws.home, TMUX: process.env["TMUX"]!, TMUX_PANE: process.env["TMUX_PANE"]!, [`${prefix}NO_TELEMETRY`]: "1" }, signal: controller.signal,
    userConfig: { agents: { teams: { displayBackend: "auto", orphanTimeoutMinutes: 1, shutdownTimeoutSeconds: 1 } }, config: { featureFlagsEnabled: false }, hooks: { teammate_waiting: [{ actions: [{ type: "command", command: `sh '${hook}'`, timeout: "45s" }] }] } },
    extra: { onboarding: false, teamWorkerProgram: args => ({ file: join(import.meta.dir, "../../build/team-worker-linux"), args: [...args] }), onEvent: event => { appendFileSync(events, JSON.stringify(event) + "\n"); if (mode === "resume" && event.type === "notification" && event.message.includes("idle")) writeFileSync(join(ws.root, "reattached"), "yes"); } },
  });
  writeFileSync(join(ws.root, `${mode}-exit.json`), JSON.stringify(result));
}
