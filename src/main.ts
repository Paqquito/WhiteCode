// Supports: SPEC-MOD-002 (FA-05 external interruption), SPEC-MOD-011 (entry point)
// Process entry point: wires the real system, then exits with the code of the run.

import { Identity } from "./identity/identity";
import { MODEL_CATALOG_DATA, RESOLVED_IDENTITY } from "./identity/generated/build-data";
import { ModelCatalog } from "./providers/catalog";
import { onTerminationSignal, processStreams, terminate } from "./platform/io";
import { readProcessEnvironment } from "./platform/environment";
import { systemInfo } from "./platform/system";
import { runCli } from "./headless/run";

const controller = new AbortController();
const unsubscribe = onTerminationSignal(() => controller.abort());
const code = await runCli(process.argv.slice(2), {
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
