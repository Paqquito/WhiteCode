// Supports: SPEC-IHM-041, SPEC-OUT-015 (real CLI terminal in an OS pseudo-terminal).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/headless/run";
import { processStreams } from "../../src/platform/io";
import { systemInfo } from "../../src/platform/system";
import { workspace, loadIdentity, loadCatalog, TEST_USER_CONFIG, trustedPolicyFile } from "../helpers/env";
import { productEnv } from "../helpers/hooks";
import { ScriptedProvider } from "../helpers/scripted-provider";

const ws = workspace(), identity = loadIdentity(), controller = new AbortController();
writeFileSync(join(ws.configHome, "config.json"), JSON.stringify({ ...TEST_USER_CONFIG, ui: { terminal: { enabled: true } } }));
const provider = new ScriptedProvider([
  { text: "CONVERSATION_KEPT" },
  { toolCalls: [{ name: "capture_terminal", input: {} }] },
  { text: "PANEL_CAPTURED" },
]);
process.on("SIGTERM", () => controller.abort());
const code = await runCli([], {
  streams: processStreams(), cwd: ws.project, system: { ...systemInfo(), home: ws.home },
  environment: productEnv(ws, { [`${identity.get("ENV_PREFIX")}CONFIG_HOME`]: ws.configHome }),
  identity, catalog: loadCatalog(), managedDir: ws.managed, policyFileProtection: trustedPolicyFile,
  providerFactory: () => provider, signal: controller.signal,
});
writeFileSync(process.argv[2]!, JSON.stringify({ code, requests: provider.requests }));
