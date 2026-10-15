// Supports: SPEC-MOD-023/024, SPEC-API-028 (real process and configured HTTPS ports), gap E-186.
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import type { CredentialVault } from "../platform/credential-vault";
import { startChild } from "../platform/process";
import { productProcess } from "../platform/product-process";
import { findExecutable } from "../platform/system";
import { readPrivateText } from "../shared/private-text";
import {
  Executor,
  ExecutorCredentialInvalid,
  type ExecutorCredential,
  type Assignment,
} from "./executor";
export function executorRequest(base: string, network: typeof fetch) {
  const endpoint = new URL(base.replace(/\/?$/, "/") + "executors/");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    throw Error("Un service HTTPS configuré est requis.");
  return async (
    path: string,
    body: unknown,
    parent: AbortSignal,
    token: string,
  ): Promise<unknown> => {
    const url = new URL(path, endpoint);
    if (
      url.origin !== endpoint.origin ||
      !url.pathname.startsWith(endpoint.pathname) ||
      url.hash ||
      url.search
    )
      throw Error("Adresse d’exécuteur hors service.");
    const response = await network(url, {
      method: "POST",
      headers: {
        Authorization:
          (token.startsWith("work_") ? "Work " : "Executor ") + token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([parent, AbortSignal.timeout(10000)]),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      if (token.startsWith("executor_")) throw new ExecutorCredentialInvalid();
      throw Error("Work lease expired or revoked.");
    }
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.startsWith("application/json")
    ) {
      await response.body?.cancel();
      throw Error("Service d’exécuteur indisponible.");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        if ((length += value.value.byteLength) > 262144)
          throw Error("Réponse d’exécuteur trop volumineuse.");
        chunks.push(value.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}
export function executorCredentials(
  vault: CredentialVault,
  service: string,
  organization: string,
  environment: string,
) {
  const key =
    "executor-v1-" +
    createHash("sha256")
      .update(organization + "\0" + environment)
      .digest("hex");
  return {
    read: async (): Promise<ExecutorCredential | undefined> => {
      const text = await vault.read(service, key);
      if (!text) return;
      return JSON.parse(text) as ExecutorCredential;
    },
    import: async (path: string) => {
      const value: unknown = JSON.parse(readPrivateText(path, 16384));
      if (
        !value ||
        typeof value !== "object" ||
        !("kind" in value) ||
        value.kind !== "executor" ||
        !("token" in value) ||
        typeof value.token !== "string" ||
        !/^executor_[A-Za-z0-9_-]{32,256}$/.test(value.token) ||
        !("organizationId" in value) ||
        value.organizationId !== organization ||
        !("environment" in value) ||
        value.environment !== environment ||
        !("expiresAt" in value) ||
        typeof value.expiresAt !== "number" ||
        value.expiresAt <= Date.now() ||
        value.expiresAt > Date.now() + 31 * 86400000
      )
        throw new ExecutorCredentialInvalid();
      await vault.write(service, key, JSON.stringify(value));
    },
  };
}
async function processResult(
  file: string,
  args: readonly string[],
  o: {
    cwd: string;
    env: Record<string, string>;
    signal: AbortSignal;
    input?: string;
    write?: (text: string) => void;
  },
): Promise<{ code: number; output: string }> {
  o.signal.throwIfAborted();
  let output = "";
  const child = startChild(file, args, {
    cwd: o.cwd,
    env: o.env,
    input: o.input,
    onData: (chunk) => {
      const text = chunk.toString();
      o.write?.(text);
      if (output.length < 128000)
        output += text.slice(0, 128000 - output.length);
    },
  });
  const stop = () => {
    void child.killTree(500);
  };
  o.signal.addEventListener("abort", stop, { once: true });
  if (o.signal.aborted) stop();
  try {
    const code = await child.exited;
    o.signal.throwIfAborted();
    return { code: code ?? 1, output };
  } finally {
    o.signal.removeEventListener("abort", stop);
    if (o.signal.aborted) await child.killTree(500);
  }
}
export function nativeExecutorPorts(o: {
  env: Record<string, string>;
  configDir: string;
  prefix: string;
  redact: (text: string) => string;
}) {
  const git = findExecutable("git");
  if (!git) throw Error("Git est requis pour préparer les travaux.");
  return {
    prepare: async (
      directory: string,
      work: Assignment,
      signal: AbortSignal,
    ) => {
      const command = async (args: readonly string[]) => {
        const result = await processResult(
          git,
          ["-c", "core.hooksPath=", ...args],
          {
            cwd: directory,
            env: {
              ...o.env,
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "",
              GIT_OPTIONAL_LOCKS: "0",
            },
            signal,
          },
        );
        if (result.code !== 0) throw Error("Préparation du dépôt impossible.");
      };
      await command([
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        "--",
        work.repository,
        directory,
      ]);
      const metadata = join(directory, ".git");
      if (
        lstatSync(metadata).isSymbolicLink() ||
        !lstatSync(metadata).isDirectory()
      )
        throw Error("Métadonnées Git liées refusées.");
      writeFileSync(
        join(metadata, "info", "attributes"),
        "* -filter -ident -text -eol\n",
        { mode: 0o600 },
      );
      await command(["fetch", "--no-tags", "--depth=1", "origin", work.commit]);
      await command(["checkout", "--detach", work.commit]);
    },
    run: async (
      directory: string,
      input: Pick<Assignment, "id" | "prompt">,
      signal: AbortSignal,
      write: (text: string) => void,
    ) => {
      const command = productProcess([
        "--non-interactive",
        "--ephemeral",
        "--approval-mode",
        "no_prompt",
        "--request-format",
        "jsonl",
        "--result-format",
        "jsonl",
        "--cwd",
        directory,
      ]);
      const result = await processResult(command.file, command.args, {
        cwd: directory,
        env: {
          ...o.env,
          [o.prefix + "CONFIG_HOME"]: o.configDir,
          [o.prefix + "JOB_WORKSPACE"]: directory,
          [o.prefix + "REMOTE_WORKER"]: "1",
        },
        signal,
        input: JSON.stringify({ type: "user", content: input.prompt }) + "\n",
        write: (text) => write(o.redact(text)),
      });
      return { code: result.code, result: o.redact(result.output) };
    },
  };
}
export async function executorLoop(
  runner: Executor,
  signal: AbortSignal,
  intervalMs = 1000,
): Promise<void> {
  await runner.register(signal);
  try {
    while (!signal.aborted && runner.state === "registered") {
      await runner.poll(signal);
      if (signal.aborted || runner.state !== "registered") break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, intervalMs);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  } finally {
    await runner.close();
  }
}
