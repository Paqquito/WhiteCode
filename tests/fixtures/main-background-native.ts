// Private PTY bench of the real interactive composition. Provider responses are scripted.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import identityText from "../../identity/dev.identity.json";
import catalogText from "./test.models.json";
import { Identity } from "../../src/identity/identity";
import { resolveIdentityText } from "../../src/identity/resolver";
import { ModelCatalog } from "../../src/providers/catalog";
import { processStreams } from "../../src/platform/io";
import { systemInfo } from "../../src/platform/system";
import { runCli } from "../../src/headless/run";
import { ScriptedProvider } from "../helpers/scripted-provider";

const [root, mode = "workflow"] = process.argv.slice(2);
if (!root?.startsWith("/var/tmp/mb51-")) throw new Error("Private native bench path required.");
const identity = new Identity(resolveIdentityText(JSON.stringify(identityText), { version: "0.1.0" }).identity!);
const home = join(root, "home"), config = join(home, "config"), project = join(root, "project"), managed = join(root, "managed");
for (const path of [home, config, project, managed, join(project, identity.get("PROJECT_DIR"))]) mkdirSync(path, { recursive: true });
writeFileSync(join(project, "shared.txt"), "ORIGINAL");
writeFileSync(join(config, "config.json"), JSON.stringify({
  api: { provider: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1" }, models: { identifierMap: { large: "test-large", medium: "test-medium", small: "test-small" } },
  extensions: { autoUpdate: "off" }, deepLinks: { registration: "disabled" }, integrations: { keepAwake: false }, sessions: { autoTitle: false },
  config: { featureFlagsEnabled: false }, ui: { maxFramesPerSecond: 120, exitConfirmation: false },
  memory: { automatic: { enabled: false }, autoExtraction: { enabled: false }, session: { enabled: false } },
}));
const call = (name: string, input: unknown) => ({ toolCalls: [{ name, input }] });
const first = new ScriptedProvider(mode === "budget" ? [{ text: "FIRST_WAITING", delayMs: 5000 }] : mode === "close" ? [{ text: "FIRST_WAITING", delayMs: 30_000, ...call("write_file", { path: join(project, "late.txt"), content: "LATE" }) }] : [
  call("read_file", { path: join(project, "shared.txt") }),
  { text: "FIRST_WAITING", delayMs: 5000, ...call("write_file", { path: join(project, "shared.txt"), content: "STALE WRITE" }) },
  call("write_file", { path: join(project, "denied.txt"), content: "DENIED WRITE" }),
  { text: "FIRST_DONE" }, { text: "FIRST_RESUMED" },
]);
const second = new ScriptedProvider(mode === "close" ? [{ text: "SECOND_WAITING", delayMs: 30_000 }] : [
  call("read_file", { path: join(project, "shared.txt") }), call("write_file", { path: join(project, "shared.txt"), content: "PEER WRITE" }),
  call("write_file", { path: join(project, "accepted.txt"), content: "ACCEPTED" }), { text: "SECOND_DONE" }, { text: "SECOND_RESUMED" },
]);
const life = new AbortController(); process.on("SIGTERM", () => life.abort());
const code = await runCli(["--allow-rule=read_file", "--allow-rule=write_file(shared.txt)", ...(mode === "budget" ? ["--model=large", "--max-cost=0.90"] : [])], {
  streams: processStreams(), identity, catalog: new ModelCatalog(catalogText), cwd: project, system: { ...systemInfo(), home }, managedDir: managed, policyFileProtection: () => ({ writable: false }), onboarding: false,
  environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", [identity.get("ENV_PREFIX") + "CONFIG_HOME"]: config }, signal: life.signal,
  providerFactory: () => ({ id: "simulated", async *stream(request, signal) {
    appendFileSync(join(root, "requests.jsonl"), JSON.stringify({ id: request.conversationId, history: request.history }) + "\n");
    let completed = false;
    const aborted = () => { if (!completed) appendFileSync(join(root, "aborts.jsonl"), JSON.stringify({ id: request.conversationId }) + "\n"); };
    signal.addEventListener("abort", aborted, { once: true });
    try { yield* (JSON.stringify(request.history).includes("first context") ? first : second).stream(request, signal); completed = true; }
    finally { signal.removeEventListener("abort", aborted); }
  } }),
  onEvent: event => appendFileSync(join(root, "events.jsonl"), JSON.stringify(event) + "\n"),
});
writeFileSync(join(root, "exit.json"), JSON.stringify({ code }));
