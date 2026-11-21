// Supports: SPEC-MOD-002 (FA-05 external interruption), SPEC-MOD-011 (entry point)
// Process entry point: wires the real system, then exits with the code of the run.

import { Identity } from "./identity/identity";
import { MODEL_CATALOG_DATA, RESOLVED_IDENTITY } from "./identity/generated/build-data";
import { ModelCatalog } from "./providers/catalog";
import { onTerminationSignal, processStreams, terminate } from "./platform/io";
import { readProcessEnvironment } from "./platform/environment";
import { systemInfo } from "./platform/system";
import { runCli } from "./headless/run";
import { sandboxGuest } from "./platform/sandbox-guest";
import { buildFlag } from "./extension-points/build-flags" with { type: "macro" };

if (buildFlag("sandbox_commands") && process.argv[2] === "--internal-sandbox-guest") await terminate(await sandboxGuest(process.argv.slice(3), readProcessEnvironment()));
import { runTeamWorker } from "./agents/team-worker";
import { runBrowserNativeHost } from "./integrations/browser-native-host";

if (process.argv[2] === "--browser-native-host") {
  try { await runBrowserNativeHost(process.argv.slice(3)); await terminate(0); }
  catch { await terminate(1); }
}

import licenseText from "./identity/generated/license-text";
if (process.argv.length === 3 && process.argv[2] === "--licenses") {
  processStreams().writeOut(licenseText);
  await terminate(0);
}

const controller = new AbortController();
const unsubscribe = onTerminationSignal(() => controller.abort());
const code = process.argv[2] === "__team-worker" && process.argv.length === 4
  ? await runTeamWorker(process.argv[3]!, controller.signal, text => processStreams().writeOut(text), readProcessEnvironment())
  : await runCli(process.argv.slice(2), {
  streams: processStreams(),
  environment: readProcessEnvironment(),
  cwd: process.cwd(),
  system: systemInfo(),
  identity: new Identity(RESOLVED_IDENTITY),
  catalog: new ModelCatalog(MODEL_CATALOG_DATA),
  signal: controller.signal,
});
unsubscribe();
await terminate(code);
