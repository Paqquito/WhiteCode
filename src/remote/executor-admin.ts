// Implements: SPEC-MOD-023/024, SPEC-API-028 (standalone machine credential and real worker composition), gap E-186.
import { join, resolve } from "node:path";
import type { AdminDependencies } from "../admin/subcommands";
import type { ParsedSubcommand } from "../cli/families";
import { loadConfiguration } from "../config/load";
import { configuredNetwork } from "../config/network";
import { nativeCredentialVault } from "../platform/credential-vault";
import { PUBLIC_SECRET_VARIABLES } from "../config/environment";
import { maskSecrets } from "../shared/secrets";
import { Executor, ExecutorCredentialInvalid } from "./executor";
import { limitsSource } from "../permissions/limits-source";
import {
  executorCredentials,
  executorLoop,
  executorRequest,
  nativeExecutorPorts,
} from "./executor-runtime";
export async function runExecutorAdmin(
  deps: AdminDependencies,
  parsed: ParsedSubcommand,
): Promise<number> {
  const report = (text: string) =>
    deps.streams.writeErr(maskSecrets(text) + "\n");
  try {
    deps.assertPolicy?.();
    if (parsed.args.length || parsed.operation !== "start")
      throw new Error(
        "Usage : session-runner start | job-runner start --organization <id> --environment <id> [--credential-file <fichier privé>] [--root <dossier>] [--concurrent-sessions <n>].",
      );
    if (
      deps.env.ownBoolean("OFFLINE_MINIMAL") === true ||
      !deps.identity.has("SERVICE_REMOTE_SESSIONS")
    )
      throw new Error(
        "Service d’exécuteur absent de cette distribution ou du mode courant.",
      );
    const organization = parsed.options.get("organization"),
      environment = parsed.options.get("environment");
    if (
      typeof organization !== "string" ||
      typeof environment !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(organization) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(environment)
    )
      throw new Error("Organisation et environnement nommés requis.");
    const configuration = loadConfiguration({ ...deps }),
      settings = configuration.firstPass,
      capacity = Number(
        parsed.options.get("concurrent-sessions") ??
          settings.get<number>("remote.runner.concurrency"),
      );
    const requiredLimits = () =>
      limitsSource({
        managedDir: configuration.locations.managedDir,
        configDir: configuration.locations.configDir,
        organizationId: deps.identity.resolved.policyAnchor?.organizationId,
        protection: deps.policyFileProtection,
        report,
      }).authority().required;
    if (requiredLimits()) {
      report(
        "Capacités distantes indisponibles : une source obligatoire de limites de compte ne peut pas être satisfaite par cet exécuteur machine ; inscription refusée.",
      );
      return 4;
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16)
      throw new Error("Capacité entière requise, entre 1 et 16.");
    const vault =
        deps.credentialVault ??
        nativeCredentialVault({ environment: deps.env.childEnvironment() }),
      credentials = executorCredentials(
        vault,
        deps.identity.get("KEYCHAIN_SERVICE") + ":executors",
        organization,
        environment,
      );
    const credentialFile = parsed.options.get("credential-file");
    if (typeof credentialFile === "string")
      await credentials.import(resolve(deps.cwd, credentialFile));
    const secrets = PUBLIC_SECRET_VARIABLES.map((name) =>
        deps.env.public(name),
      ).filter((value): value is string => !!value),
      redact = (text: string) =>
        secrets.reduce(
          (safe, value) => safe.split(value).join("[redacted credential]"),
          maskSecrets(text),
        );
    const root = parsed.options.get("root"),
      ports = nativeExecutorPorts({
        env: deps.env.childEnvironment(),
        configDir: configuration.locations.configDir,
        prefix: deps.env.prefix,
        redact,
      });
    const runner = new Executor({
      kind: parsed.family === "session-runner" ? "session" : "job",
      organizationId: organization,
      environment,
      root:
        typeof root === "string"
          ? resolve(deps.cwd, root)
          : join(configuration.locations.configDir, "runner-work"),
      labels: [
        ...new Set([
          deps.system.platform,
          ...settings.get<string[]>("remote.runner.labels"),
        ]),
      ],
      capacity,
      credential: async () => {
        try {
          deps.assertPolicy?.();
          if (requiredLimits())
            throw new Error(
              "Source obligatoire de limites modifiée ; exécuteur arrêté.",
            );
        } catch (error) {
          report(maskSecrets((error as Error).message));
          throw new ExecutorCredentialInvalid();
        }
        return credentials.read();
      },
      request: executorRequest(
        deps.identity.get("SERVICE_REMOTE_SESSIONS"),
        deps.companyFetch ?? configuredNetwork(deps.env),
      ),
      ...ports,
      report,
    });
    report(
      `Rôle : exécuteur ${parsed.family === "session-runner" ? "de sessions" : "de travaux"} ; lieu d’exécution : infrastructure locale ; organisation ${organization}, environnement ${environment}.`,
    );
    await executorLoop(runner, deps.signal ?? new AbortController().signal);
    return runner.credentialInvalid ? 2 : deps.signal?.aborted ? 130 : 0;
  } catch (error) {
    report(error instanceof Error ? error.message : "Exécuteur indisponible.");
    return deps.signal?.aborted ? 130 : 2;
  }
}
