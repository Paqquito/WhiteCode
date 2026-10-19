// Supports: SPEC-API-029, SPEC-PLA-002 (standalone hosted broker/worker).
import { startHostedServiceFile, hostedWorkerFile } from "../src/hosted/runtime";
import { onTerminationSignal, terminate } from "../src/platform/io";
const [mode, path, ...extra] = process.argv.slice(2);
if (!path || extra.length || !["server", "worker"].includes(mode ?? "")) {
  console.error("Usage : bun --no-env-file scripts/hosted-service.ts server|worker <configuration-privée.json>");
  await terminate(2);
}
const controller = new AbortController(), unsubscribe = onTerminationSignal(() => controller.abort());
try {
  if (mode === "server") {
    const service = await startHostedServiceFile(path!);
    console.log(JSON.stringify({ event: "ready", url: service.url }));
    try { await new Promise<void>(resolve => { controller.signal.addEventListener("abort", () => resolve(), { once: true }); if (controller.signal.aborted) resolve(); }); }
    finally { await service.close(); }
  } else {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") environment[name] = value;
    await hostedWorkerFile(path!, environment).run(controller.signal);
  }
} catch { console.error("Service hébergé arrêté : configuration invalide ou ressource indisponible."); unsubscribe(); await terminate(1); }
unsubscribe(); await terminate(0);
