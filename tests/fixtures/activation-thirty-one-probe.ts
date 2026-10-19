// Actual runCli and terminal composition; synthetic providers, vault and feedback service only.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "../helpers/env";
import { interactive, KEY } from "../helpers/interactive";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { Identity } from "../../src/identity/identity";
import { buildInventory, buildProfile } from "../../src/extension-points/build-flags" with { type: "macro" };
import { projectKey } from "../../src/session/transcript";
const mode = process.argv[2] ?? "runtime", prefix = loadIdentity().get("ENV_PREFIX");
if (mode === "runtime" || mode === "canonical") {
  const results: Record<string, unknown> = {};
  for (const name of mode === "runtime" ? ["ordinary", "fast", "browser-setting", "browser-option", "encryption", "control-setting", "control-option", "overrides"] : ["ordinary", "local-messaging", "recap", "refinement", "guided", "output-files", "explain", "attribution", "shadow", "performance-trace", "slow-ops", "assistant-worker", "team-memory", "dictation", "year-review", "sync-upload"]) {
    const ws = workspace(), provider = new ScriptedProvider([{text: "PRESENCE_RUNTIME_DONE"}]);
    let vaultReads = 0, vaultWrites = 0; const vault = new Map<string, string>();
    const configs: Record<string,Record<string,unknown>> = {
      fast:{models:{fastOutput:{enabled:true}}}, "browser-setting":{browser:{enabled:true}}, encryption:{storage:{encryption:{enabled:true}}}, "control-setting":{engine:{control:{enabled:true}}},
      "local-messaging":{agents:{messaging:{crossSession:true}}}, recap:{ui:{returnSummary:{enabled:true}}}, refinement:{skills:{improvements:{enabled:true}}}, guided:{commands:{createInstructions:{guided:true}}},
      "output-files":{sessions:{outputFiles:{enabled:true}}}, explain:{context:{explanation:{enabled:true}}}, attribution:{attribution:{notes:true}}, shadow:{permissions:{shellAnalysis:"shadow"}},
      "team-memory":{memory:{team:{enabled:true}}}, dictation:{voice:{input:{enabled:true}}}, "year-review":{ui:{yearInReview:{enabled:true}}}, "sync-upload":{settingsSync:{autoUpload:true}},
    };
    const config=configs[name]??{};
    const args = name === "browser-option" ? ["--browser"] : name === "control-option" ? ["--control-channel", "--request-format=jsonl", "--result-format=jsonl"] : [];
    const environment = name === "overrides" ? {[prefix + "FEATURE_OVERRIDES"]: '{"schedule_jitter_ms":17}'} : name === "performance-trace" ? {[prefix + "PERF_TRACE"]: "1"} : name === "slow-ops" ? {[prefix + "SLOW_OP_WARN_MS"]: "1"} : name === "assistant-worker" ? {[prefix + "ASSISTANT_WORKER"]: "true"} : {};
    const result = await cli(["--non-interactive", ...args, ...(name === "control-option" ? [] : ["Probe the product."])], ws, {provider, userConfig: config, env: environment, extra: {credentialVault: {read: (service, account) => {vaultReads++; return vault.get(service + account);}, write: (service, account, value) => {vaultWrites++; vault.set(service + account, value);}, remove: (service, account) => {vault.delete(service + account);}}}});
    results[name] = {...result, requests: provider.requests.length, vaultReads, vaultWrites, archives: existsSync(join(ws.configHome, "archives-v1")), files: readdirSync(ws.configHome)};
  }
  console.log(JSON.stringify({profile: buildProfile(), values: buildInventory(), results}));
} else if (mode === "automatic-consolidation") {
  const ws = workspace(), key = projectKey(realpathSync(ws.project));
  ws.write(`home/config/memory/${key}/fact.md`, "---\nname: Convention\ndescription: Project convention\ntype: project\n---\nPreserve this durable convention.\n");
  const provider = new ScriptedProvider([{text: "Work completed."}], [{text: "No changes needed."}]);
  const result = await cli(["--non-interactive", "Work."], ws, {provider, userConfig: {memory: {automatic: {enabled: true}, recall: {enabled: false}, autoExtraction: {enabled: false}, consolidation: {minSessions: 1, minHours: 0}}}});
  console.log(JSON.stringify({profile: buildProfile(), values: buildInventory(), result, requests: provider.requests.map(request => ({agent: request.agent, tools: request.tools.map(tool => tool.name)}))}));
} else if (mode === "assistant-message") {
  const ws = workspace(), provider = new ScriptedProvider([{text: "Assistant result."}]);
  const result = await cli(["--non-interactive", "Work."], ws, {provider, env: {[prefix + "ASSISTANT_WORKER"]: "true"}});
  console.log(JSON.stringify({profile: buildProfile(), values: buildInventory(), result, requests: provider.requests.map(request => ({agent: request.agent, tools: request.tools.map(tool => tool.name)}))}));
} else if (mode === "frustration") {
  const base = loadIdentity(), identity = new Identity({...base.resolved, values: {...base.resolved.values, SERVICE_FEEDBACK: {...base.resolved.values["SERVICE_DOCS"]!, value: "https://feedback.fixture"}}});
  const outcomes = [];
  for (const input of ["typed", "pasted", "model-output", "veto", "edited-during-turn"]) {
    const ws = workspace(), life = new AbortController(), provider = new ScriptedProvider([{text: input === "model-output" ? "still broken" : "FRUSTRATION_TURN_DONE", ...(input === "edited-during-turn" ? {delayMs: 700} : {})}]);
    let feedback = 0;
    const feedbackFetch = Object.assign(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {feedback++; return Response.json({ok: true});}, {preconnect: () => {}});
    const run = interactive([], ws, {identity, provider, signal: life.signal, userConfig: {ui: {surveys: {enabled: input !== "veto"}}}, extra: {surveyRandom: () => 0, feedbackFetch}});
    let screen = "", code = -1, draftPreserved = false;
    try {
      await run.idle();
      if (input === "pasted") run.paste("still broken"); else run.type(input === "model-output" ? "ordinary message" : "still broken");
      run.type(KEY.enter);
      if (input === "edited-during-turn") {await run.waitFor(() => provider.requests.length === 1); run.type("nouveau brouillon"); await run.waitFor(text => text.includes("nouveau brouillon")); draftPreserved = true; run.type(KEY.ctrlU);}
      await run.waitFor(text => text.includes("Alt+3") || input === "veto" && text.includes("FRUSTRATION_TURN_DONE"));
      screen = run.all().join("\n");
    } finally {life.abort(); code = (await run.done).code;}
    outcomes.push({input, code, targeted: screen.includes("Un problème dans cet échange"), ordinarySurvey: screen.includes("Alt+3"), requests: provider.requests.length, feedback, draftPreserved});
  }
  console.log(JSON.stringify({profile: buildProfile(), values: buildInventory(), outcomes}));
} else throw Error("Unknown activation probe mode.");
