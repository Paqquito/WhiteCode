import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectSessions } from "../src/session/sessions";
import { workspace, cli } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
const send = (run: ReturnType<typeof interactive>, value: string) => { run.type(value); run.type(KEY.enter); };
const stop = async (run: ReturnType<typeof interactive>) => { run.type(KEY.ctrlD); run.type(KEY.ctrlD); return run.done; };

test("SPEC-SES-005/CA-01 — selecting another project and resuming here copies its conversation and announces the new folder", async () => {
  const ws = workspace(); await cli(["--non-interactive", "Ancien projet"], ws, { provider: new ScriptedProvider([{ text: "ancienne réponse" }]) });
  const old = projectSessions(join(ws.configHome, "sessions"), ws.project)[0]!, bytes = readFileSync(old.path, "utf8"), project = join(ws.root, "other"); mkdirSync(project);
  const p = new ScriptedProvider([{ text: "nouveau dossier confirmé" }]), run = interactive([], { ...ws, project }, { provider: p }); await run.idle();
  send(run, `/reopen ${old.id}`); await run.waitFor(text => text.includes("Reprendre ici")); await sleep(380); run.type("2"); await run.waitFor(text => text.includes("ancienne réponse")); await run.idle(); send(run, "suite"); await run.waitFor(text => text.includes("nouveau dossier confirmé")); await stop(run);
  expect(JSON.stringify(p.requests[0]?.history)).toContain("explicitly resumed a copy"); expect(JSON.stringify(p.requests[0]?.history)).toContain(project.replace(/\\/g, "\\\\")); expect(readFileSync(old.path, "utf8")).toBe(bytes);
}, 20000);
test("SPEC-SES-005/CA-02 — a removed original folder offers only resume-here and the old transcript remains intact", async () => {
  const ws = workspace(); await cli(["--non-interactive", "ancien"], ws, { provider: new ScriptedProvider([{ text: "historique" }]) });
  const old = projectSessions(join(ws.configHome, "sessions"), ws.project)[0]!, project = join(ws.root, "other"); mkdirSync(project); rmSync(ws.project, { recursive: true });
  const run = interactive([], { ...ws, project }, { provider: new ScriptedProvider([]) }); await run.idle(); send(run, `/reopen ${old.id}`); await run.waitFor(text => text.includes("Reprendre ici")); expect(run.screen().join("\n")).not.toContain("Ouvrir dans le dossier"); await sleep(380); run.type("1"); await run.waitFor(text => text.includes("historique")); await stop(run);
}, 20000);
test("SPEC-CMD-010/CA-01 — blue applies only to the selected session and default restores its border", async () => {
  const one = interactive([], workspace(), { provider: new ScriptedProvider([]), env: { TERM: "xterm-256color", FORCE_COLOR: "1" } }), two = interactive([], workspace(), { provider: new ScriptedProvider([]), env: { TERM: "xterm-256color", FORCE_COLOR: "1" } }); await one.idle(); await two.idle();
  const border = (run: typeof one) => run.term.vt.grid.find(row => row.map(cell => cell.ch).join("").includes("Votre message"))?.find(cell => cell.ch === "│")?.sgr;
  const original = border(one); expect(original).toBeDefined(); expect(border(two)).toBe(original);
  send(one, "/session-color blue"); await one.waitFor(text => text.includes("Couleur de session : blue")); expect(two.all().join("\n")).not.toContain("Couleur de session : blue");
  expect(border(one)).not.toBe(original); expect(border(two)).toBe(original);
  send(one, "/session-color default"); await one.waitFor(text => text.includes("Couleur de session : default")); expect(border(one)).toBe(original); await stop(one); await stop(two);
});
test("SPEC-CMD-005/CA-01 — an aside answers during a blocked main turn without cancelling or joining its history", async () => {
  const p = new ScriptedProvider([{ text: "principal terminé", delayMs: 1500 }, { text: "réponse annexe" }]);
  const ws = workspace(), run = interactive([], ws, { provider: p }); await run.idle(); send(run, "travail long"); while (!p.requests.length) await sleep(10);
  send(run, "/aside explique le contexte"); await run.waitFor(text => text.includes("réponse annexe")); expect(p.requests).toHaveLength(2); expect(p.requests[1]?.tools.every(tool => tool.name === "read_file")).toBe(true); await run.waitFor(text => text.includes("principal terminé")); await run.idle(); await stop(run);
  const text = readFileSync(projectSessions(join(ws.configHome, "sessions"), ws.project)[0]!.path, "utf8"); expect(text).not.toContain("réponse annexe"); expect(text).not.toContain("explique le contexte");
}, 15000);
