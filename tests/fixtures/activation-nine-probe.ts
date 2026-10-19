// Real runCli wiring in an isolated compiled build profile; all credentials and providers are fictitious.
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { buildProfile, buildInventory } from "../../src/extension-points/build-flags" with { type: "macro" };
const ws = workspace(), mode = process.argv[2] ?? "default", prefix = loadIdentity().get("ENV_PREFIX");
const environment: Record<string, string> = {}, options: string[] = ["--non-interactive", "Probe the compiled product."], tools: string[][] = [];
if (mode === "tools") { environment[prefix + "PLAN_CHECK_TOOL"] = "1"; options.splice(1, 0, "--toolset", "terminal_session,check_plan_progress"); }
if (mode === "script") ws.write("managed/policy.json", JSON.stringify({ tools: { scriptMode: { enabled: true } } }));
if (mode === "api") { environment[prefix + "API_RECORDING"] = "record"; environment[prefix + "API_RECORDING_DIR"] = join(ws.root, "references"); }
if (mode === "diagnostics") {
  Object.assign(environment, { [prefix + "DEBUG"]: "1", [prefix + "DEBUG_FILE"]: join(ws.root, "explicit-debug.log"), [prefix + "SESSION_RECORDING"]: join(ws.root, "explicit-terminal.cast"), [prefix + "PROFILE"]: "all", [prefix + "TELEMETRY"]: "1", OTEL_METRICS_EXPORTER: "console", OTEL_LOGS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "console" });
}
const provider = new ScriptedProvider([request => { tools.push(request.tools.map(tool => tool.name)); return { text: "COMPILED_ACTIVATION_PROBE_DONE" }; }]);
const result = await cli(options, ws, { provider, env: environment, userConfig: mode === "tools" ? { tools: { terminalSession: { enabled: true } } } : {}, extra: { allowApiRecording: true, terminalMultiplexor: null, observabilityFetch: (async (_input, _init) => Response.json({ ok: true })) as typeof fetch } });
function list(directory: string): string[] { return readdirSync(directory).flatMap(name => { const path = join(directory, name), stat = lstatSync(path); return stat.isSymbolicLink() ? [] : stat.isDirectory() ? list(path) : [path.slice(ws.root.length + 1).replaceAll("\\", "/")]; }); }
const files = list(ws.root), references = files.filter(path => path.startsWith("references/"));
console.log(JSON.stringify({ profile: buildProfile(), values: buildInventory(), mode, result, requests: provider.requests.length, tools, files, references: references.map(path => readFileSync(join(ws.root, path), "utf8")) }));
