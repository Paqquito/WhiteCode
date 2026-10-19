// Implements: SPEC-MOD-021/022 (standalone local service and detached session launcher).
import { join } from "node:path";
import { mkdirSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { ResidentRemote } from "./remote";
import type { AdminDependencies } from "../admin/subcommands";
import type { ParsedSubcommand } from "../cli/families";
import { loadConfiguration } from "../config/load";
import { nativeCredentialVault } from "../platform/credential-vault";
import { openPrivateStorage, storeExists } from "../session/private-storage";
import { projectKey } from "../session/transcript";
import {
  readTranscript,
  activeChain,
  rebuildHistory,
} from "../session/sessions";
import { detachProduct } from "../platform/resident-process";
import { productProcess } from "../platform/product-process";
import { PUBLIC_SECRET_VARIABLES } from "../config/environment";
import {
  ResidentSupervisor,
  readResidentEndpoint,
  type ResidentEndpoint,
} from "./supervisor";
import type { WorkerRecord } from "./worker";
import { sanitize } from "../ui/text";
import { maskSecrets } from "../shared/secrets";
import { notifyLocal } from "../platform/notification";
import { residentRequest } from "./transport";
import { attachResident } from "./client";
import { loadJobTemplate, createJobWorkspace, readJobState } from "./jobs";
import { defaultAssistantDirectory, installAssistant } from "./install";
import { authDialog } from "../interactive/auth-dialog";
function productEnvironment(
  deps: AdminDependencies,
  root: string,
): Record<string, string> {
  const prefix = deps.identity.get("ENV_PREFIX"),
    environment = deps.env.childEnvironment({
      [prefix + "CONFIG_HOME"]: root,
      [prefix + "BACKGROUND_WORKER"]: "1",
      [prefix + "NO_SURVEYS"]: "1",
    });
  for (const name of PUBLIC_SECRET_VARIABLES) {
    const value = deps.env.public(name);
    if (value !== undefined) environment[name] = value;
  }
  for (const name of ["NO_TELEMETRY", "EXTRA_CA_CERTS"]) {
    const value = deps.env.own(name);
    if (value !== undefined) environment[prefix + name] = value;
  }
  return environment;
}
export function residentBootstrap(root: string): string {
  const path = join(root, "resident-runtime"); mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path || readdirSync(path).length) throw Error("Dossier de lancement résident non sûr.");
  return path;
}
export async function ensureResident(
  deps: AdminDependencies,
  root: string,
  privateLaunch = false,
): Promise<ResidentEndpoint> {
  deps.assertPolicy?.();
  let old = readResidentEndpoint(root);
  if (old)
    try {
      await residentRequest(
        old,
        "/state",
        undefined,
        AbortSignal.timeout(1000),
      );
      return old;
    } catch {}
  const command = productProcess(["service", "start", "--foreground"]);
  await detachProduct(command.file, command.args, {
    cwd: privateLaunch ? residentBootstrap(root) : deps.cwd,
    environment: productEnvironment(deps, root),
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    deps.signal?.throwIfAborted();
    old = readResidentEndpoint(root);
    if (old)
      try {
        await residentRequest(
          old,
          "/state",
          undefined,
          AbortSignal.timeout(500),
        );
        return old;
      } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(
    "Le superviseur local n’a pas démarré ; essayez service start --foreground pour le diagnostic.",
  );
}
async function foregroundResident(
  deps: AdminDependencies,
  configuration: ReturnType<typeof loadConfiguration>,
): Promise<number> {
  const root = configuration.locations.configDir,
    settings = configuration.firstPass,
    environment = productEnvironment(deps, root);
  const transcript = (record: WorkerRecord) =>
    join(root, "sessions", projectKey(record.cwd), record.id + ".jsonl");
  let remote: ResidentRemote;
  const supervisor = new ResidentSupervisor({
    root,
    maxConcurrent: settings.get<number>("sessions.background.maxConcurrent"),
    waitMs: Math.min(
      86400000,
      Math.max(1000, settings.get<number>("permissions.detachedWaitTimeout")),
    ),
    assertPolicy: () => deps.assertPolicy?.(),
    launchCwd: record => record.kind === "remote" ? residentBootstrap(root) : record.cwd,
    remote: { start: body => remote.start(body), state: () => remote.state(), stop: () => remote.stop(), revoke: body => remote.revoke(body) },
    environment: (record) => ({
      ...environment,
      ...(record.kind === "remote" ? { [deps.env.prefix + "REMOTE_WORKER"]: "1" } : {}),
      ...(record.kind === "assistant"
        ? { [deps.identity.get("ENV_PREFIX") + "ASSISTANT_WORKER"]: "1" }
        : {}),
      ...(record.kind === "job"
        ? { [deps.identity.get("ENV_PREFIX") + "JOB_WORKSPACE"]: record.cwd }
        : {}),
    }),
    program: (record) =>
      productProcess([
        "--non-interactive",
        ...(record.kind === "remote" ? ["--cwd", record.cwd] : []),
        "--control-channel",
        "--request-format=jsonl",
        "--result-format=jsonl",
        "--approval-mode=" + record.mode,
        "--wait-for-capacity",
        ...(storeExists(transcript(record))
          ? ["--reopen=" + record.id]
          : ["--assign-session-id", record.id]),
        ...(record.jobRestrictions?.tools !== undefined
          ? ["--toolset=" + record.jobRestrictions.tools.join(",")]
          : []),
        ...(record.jobRestrictions?.denyRules.flatMap((rule) => [
          "--deny-rule",
          rule,
        ]) ?? []),
        ...(record.jobRestrictions?.askRules.flatMap((rule) => [
          "--ask-rule",
          rule,
        ]) ?? []),
      ]),
    createJob: (name, request) =>
      createJobWorkspace(
        deps.system.home,
        deps.identity.get("PRODUCT_SLUG"),
        loadJobTemplate(root, name, loadConfiguration({ ...deps }).firstPass),
        request,
      ),
    jobState: (record) => readJobState(record.cwd),
    wasAccepted: (record, id) =>
      storeExists(transcript(record)) &&
      readTranscript(transcript(record)).records.some(
        (line) =>
          line.type === "user" &&
          JSON.stringify(line.data["content"]).includes(
            "[accepted-event:" + id + "]",
          ),
      ),
    history: (record) => {
      if (!storeExists(transcript(record))) return [];
      const history = rebuildHistory(
        activeChain(readTranscript(transcript(record)).records).chain,
      );
      return history.messages
        .filter((message) => message.role !== "system_note")
        .flatMap((message) => {
          const text =
            message.role === "assistant"
              ? message.text
              : message.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n");
          const parts = [];
          for (let offset = 0; offset < text.length; offset += 4096)
            parts.push({
              role: message.role,
              text: text.slice(offset, offset + 4096),
              continued: offset > 0,
            });
          return parts;
        });
    },
    notify: async (_record, kind) => {
      if (
        settings.get<string>("notifications.channel") !== "disabled" &&
        settings.get<boolean>("ui.notifications.agentEnabled")
      )
        await notifyLocal(
          deps.identity.get("PRODUCT"),
          kind === "waiting"
            ? "Une session détachée attend votre autorisation."
            : "Une session détachée a terminé son tour.",
          environment,
        );
    },
  });
  remote = new ResidentRemote(deps, supervisor);
  const stop = () => {
    void supervisor.close();
  };
  deps.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await supervisor.start();
    if (settings.get<string[]>("daemon.workers").includes("assistant")) {
      const cwd =
        settings.get<string | undefined>("assistant.installDirectory") ??
        defaultAssistantDirectory(
          deps.system.home,
          deps.identity.get("PRODUCT_SLUG"),
        );
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const endpoint = readResidentEndpoint(root)!;
      await residentRequest(
        endpoint,
        "/workers",
        { kind: "assistant", cwd },
        AbortSignal.timeout(5000),
      );
    }
    deps.streams.writeOut("Service résident actif sur le poste local.\n");
    await supervisor.done;
    return 0;
  } finally {
    deps.signal?.removeEventListener("abort", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await supervisor.close();
  }
}
export async function runResidentAdmin(
  deps: AdminDependencies,
  parsed: ParsedSubcommand,
): Promise<number> {
  const out = (text: string) =>
      deps.streams.writeOut(sanitize(maskSecrets(text)) + "\n"),
    err = (text: string) =>
      deps.streams.writeErr(sanitize(maskSecrets(text)) + "\n");
  let release: (() => void) | undefined;
  try {
    deps.assertPolicy?.();
    const configuration = loadConfiguration({ ...deps }),
      root = configuration.locations.configDir,
      settings = configuration.firstPass;
    if (deps.env.ownBoolean("OFFLINE_MINIMAL") === true)
      throw Error("Le service résident est indisponible en mode minimal.");
    if (
      settings.get<boolean>("daemon.installAsService") &&
      parsed.family === "service" &&
      parsed.operation === "start"
    )
      throw Error(
        "L’enregistrement comme service de connexion n’est pas encore livré ; désactivez daemon.installAsService pour un lancement local.",
      );
    if (parsed.family === "service" && parsed.args.length)
      throw Error("Cette opération ne prend aucun argument.");
    release = await openPrivateStorage({
      root,
      enabled: settings.get<boolean>("storage.encryption.enabled"),
      service: deps.identity.get("PRODUCT_SLUG") + ":archives",
      vault:
        deps.credentialVault ??
        nativeCredentialVault({
          interactive: deps.streams.stdinIsTTY,
          environment: deps.env.childEnvironment(),
        }),
      notice: err,
    });
    if (
      parsed.family === "service" &&
      parsed.operation === "start" &&
      parsed.options.has("foreground")
    )
      return await foregroundResident(deps, configuration);
    if (parsed.family === "job" && parsed.operation === "create") {
      const name = parsed.args[0];
      if (!name)
        throw Error(
          "Modèle de travail requis : job create <modèle> [consigne].",
        );
      loadJobTemplate(root, name, settings);
      const endpoint = await ensureResident(deps, root),
        prompt = parsed.args.slice(1).join(" ");
      const value = await residentRequest(
        endpoint,
        "/workers",
        {
          kind: "job",
          template: name,
          ...(prompt ? { prompt } : {}),
          mode:
            settings.get<string>("permissions.initialMode") === "no_prompt"
              ? "no_prompt"
              : "ask",
        },
        AbortSignal.any([
          ...(deps.signal ? [deps.signal] : []),
          AbortSignal.timeout(5000),
        ]),
      );
      out(
        parsed.options.has("json")
          ? JSON.stringify(value)
          : `Travail ${value["id"]} · ${value["cwd"]}`,
      );
      return 0;
    }
    if (
      parsed.family === "resident-agent" &&
      parsed.operation === "attach" &&
      !parsed.args.length
    ) {
      const terminal = deps.streams.terminal;
      if (!terminal || !deps.streams.stdinIsTTY || !deps.streams.stdoutIsTTY)
        throw Error("Le rattachement exige un terminal interactif.");
      let directory = settings.get<string | undefined>(
        "assistant.installDirectory",
      );
      if (!directory) {
        const proposed = defaultAssistantDirectory(
          deps.system.home,
          deps.identity.get("PRODUCT_SLUG"),
        );
        if (
          (await authDialog(
            terminal,
            "Installer l’assistant dans " + proposed + " ?",
            false,
            deps.signal,
          )) !== true
        ) {
          out("Installation annulée.");
          return 0;
        }
        deps.assertPolicy?.();
        directory = installAssistant({
          directory: proposed,
          project: configuration.locations.projectRoot,
          projectDirectory: deps.identity.get("PROJECT_DIR"),
          settingsFile: configuration.locations.userSettingsFile,
          platform: deps.system.platform,
        });
      }
      const endpoint = await ensureResident(deps, root),
        worker = await residentRequest(
          endpoint,
          "/workers",
          { kind: "assistant", cwd: directory },
          deps.signal ?? AbortSignal.timeout(5000),
        );
      if (typeof worker["id"] !== "string")
        throw Error("Réponse du superviseur invalide.");
      await attachResident({
        endpoint,
        id: worker["id"],
        streams: deps.streams,
        signal: deps.signal,
      });
      return 0;
    }
    const endpoint =
      parsed.family === "service" && parsed.operation === "start"
        ? await ensureResident(deps, root)
        : readResidentEndpoint(root);
    if (!endpoint)
      throw Error(
        "Le service résident n’est pas actif ; lancez service start.",
      );
    const scope = () =>
      AbortSignal.any([
        ...(deps.signal ? [deps.signal] : []),
        AbortSignal.timeout(5000),
      ]);
    let value: Record<string, unknown>;
    if (parsed.family === "job" && parsed.operation === "reply") {
      const id = parsed.args[0],
        text = parsed.args.slice(1).join(" ");
      if (!id || !/^[a-f0-9-]{36}$/i.test(id) || !text.trim())
        throw Error("Usage : job reply <id> <message>.");
      const state = await residentRequest(
        endpoint,
        "/state",
        undefined,
        scope(),
      );
      if (
        !Array.isArray(state["workers"]) ||
        !state["workers"].some(
          (row) =>
            row &&
            typeof row === "object" &&
            (row as Record<string, unknown>)["id"] === id &&
            (row as Record<string, unknown>)["kind"] === "job",
        )
      )
        throw Error("Travail introuvable.");
      value = await residentRequest(
        endpoint,
        "/workers/" + id + "/message",
        { text },
        scope(),
      );
      out(JSON.stringify(value));
      return 0;
    }
    if (parsed.family === "service")
      value = await residentRequest(
        endpoint,
        parsed.operation === "stop"
          ? "/stop"
          : parsed.operation === "show-log"
            ? "/log"
            : "/state",
        parsed.operation === "stop" ? {} : undefined,
        scope(),
      );
    else if (parsed.operation === "list") {
      value = await residentRequest(endpoint, "/state", undefined, scope());
      if (parsed.family === "job" && Array.isArray(value["workers"]))
        value = {
          ...value,
          workers: value["workers"].filter(
            (row) =>
              row &&
              typeof row === "object" &&
              (row as Record<string, unknown>)["kind"] === "job",
          ),
        };
    } else {
      const id = parsed.args[0];
      if (!id || !/^[a-f0-9-]{36}$/i.test(id) || parsed.args.length !== 1)
        throw Error("Identifiant de session attendu.");
      if (parsed.operation === "attach") {
        await attachResident({
          endpoint,
          id,
          streams: deps.streams,
          signal: deps.signal,
        });
        return 0;
      }
      if (parsed.operation === "stop")
        value = await residentRequest(
          endpoint,
          "/workers/" + id + "/stop",
          {},
          scope(),
        );
      else if (parsed.operation === "show-log") {
        const attached = await residentRequest(
          endpoint,
          "/workers/" + id + "/attach",
          {},
          scope(),
        );
        await residentRequest(
          endpoint,
          "/workers/" + id + "/detach",
          { client: attached["client"] },
          scope(),
        );
        value = { history: attached["history"] };
      } else throw Error("Rattachement interactif en cours de développement.");
    }
    if (parsed.options.has("json")) out(JSON.stringify(value));
    else if (Array.isArray(value["workers"]))
      out(
        value["workers"]
          .map((worker) => {
            const row = worker as Record<string, unknown>,
              job = row["jobState"] as
                { state: string; summary: string } | undefined;
            return `${row["id"]} · ${row["kind"]} · ${job?.state ?? row["status"]} · ${job?.summary ?? row["summary"]}`;
          })
          .join("\n") || "Aucun travailleur local.",
      );
    else out(JSON.stringify(value));
    return 0;
  } catch (error) {
    err((error as Error).message);
    return 2;
  } finally {
    release?.();
  }
}
export async function launchBackground(
  deps: AdminDependencies,
  prompt: string,
): Promise<string> {
  const configuration = loadConfiguration({ ...deps }),
    root = configuration.locations.configDir;
  deps.assertPolicy?.();
  if (!prompt.trim() || prompt.length > 65536)
    throw Error("Consigne d’arrière-plan invalide.");
  const endpoint = await ensureResident(deps, root),
    value = await residentRequest(
      endpoint,
      "/workers",
      {
        kind: "background",
        cwd: deps.cwd,
        prompt,
        mode:
          configuration.firstPass.get<string>("permissions.initialMode") ===
          "no_prompt"
            ? "no_prompt"
            : "ask",
      },
      AbortSignal.any([
        ...(deps.signal ? [deps.signal] : []),
        AbortSignal.timeout(5000),
      ]),
    );
  if (typeof value["id"] !== "string")
    throw Error("Réponse du service résident invalide.");
  return value["id"];
}
