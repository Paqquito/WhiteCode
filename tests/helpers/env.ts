// Test helpers: identities, a fictitious model catalogue, isolated workspaces and an in-process CLI runner.
// No real provider nor model name is used (decision D-09): tests configure the provider explicitly.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Identity } from "../../src/identity/identity";
import { resolveIdentityText } from "../../src/identity/resolver";
import { isResolveFailure, ModelCatalog, type ResolvedModel } from "../../src/providers/catalog";
import { runCli, type RunDependencies } from "../../src/headless/run";
import type { StandardStreams } from "../../src/platform/io";
import { systemInfo } from "../../src/platform/system";
import type { PolicyFileProtectionReader } from "../../src/platform/policy-file";
import type { ModelProvider } from "../../src/providers/types";
import { NO_PROTECTED_LOCATIONS } from "../../src/permissions/paths";
import type { ToolContext, ToolSettings } from "../../src/tools/types";

export const ROOT = resolve(import.meta.dir, "../..");
/** Virtual administrator-owned source; native file authority is tested separately. */
export const trustedPolicyFile: PolicyFileProtectionReader = () => ({ writable: false });

export function loadIdentity(file = "identity/dev.identity.json"): Identity {
  const result = resolveIdentityText(readFileSync(join(ROOT, file), "utf8"), { version: "0.1.0" });
  if (!result.identity) throw new Error(result.issues.map((i) => i.message).join("\n"));
  return new Identity(result.identity);
}

/** Fictitious catalogue of the tests (tests/fixtures/test.models.json). */
export function loadCatalog(): ModelCatalog {
  return new ModelCatalog(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/test.models.json"), "utf8")));
}

export const TEST_IDENTIFIER_MAP = { large: "test-large", medium: "test-medium", small: "test-small" };

/** Resolves a model of the fictitious catalogue, throwing on failure. */
export function testModel(value: string, provider = "openai_compatible", identity = loadIdentity()): ResolvedModel {
  const r = loadCatalog().resolve(value, provider, identity, { unknownContextWindow: 128_000, identifierMap: TEST_IDENTIFIER_MAP });
  if (isResolveFailure(r)) throw new Error(JSON.stringify(r));
  return r;
}

/** Project folder of the development identity (derived, never written by hand). */
const DEV_PROJECT_DIR = loadIdentity().get("PROJECT_DIR");

export interface Workspace {
  readonly root: string;
  readonly home: string;
  readonly configHome: string;
  readonly managed: string;
  readonly project: string;
  write(relative: string, content: string): string;
}

/** Temporary home, configuration folder, managed folder and project, never the real ones. */
export function workspace(): Workspace {
  // The real path of the temporary folder: on CI runners it is a short 8.3 name (Windows) or behind a symbolic link
  // (macOS), and the product compares the paths of the tools with real paths.
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "ws-"));
  const ws = {
    root,
    home: join(root, "home"),
    configHome: join(root, "home", "config"),
    managed: join(root, "managed"),
    project: join(root, "project"),
    write(relative: string, content: string) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
  };
  for (const d of [ws.home, ws.configHome, ws.managed, ws.project]) mkdirSync(d, { recursive: true });
  // Isolation: the project folder of the workspace stops the upward search of the project root (SPEC-CFG-001,
  // nested projects), so that a product folder of the real home above the temporary folder is never taken as a project.
  mkdirSync(join(ws.project, DEV_PROJECT_DIR), { recursive: true });
  return ws;
}

export interface CapturedStreams extends StandardStreams {
  readonly out: string[];
  readonly err: string[];
}

export function captureStreams(options: { stdin?: string; tty?: boolean; stdinSource?: AsyncIterable<string>; onOut?: (text: string) => void; onErr?: (text: string) => void } = {}): CapturedStreams {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writeOut: (t) => {
      out.push(t);
      options.onOut?.(t);
    },
    writeErr: (t) => {
      err.push(t);
      options.onErr?.(t);
    },
    readAllStdin: async () => options.stdin ?? "",
    stdinLines: async function* () {
      if (options.stdinSource) {
        yield* options.stdinSource;
        return;
      }
      const lines = (options.stdin ?? "").split(/\r?\n/);
      if (lines[lines.length - 1] === "") lines.pop();
      yield* lines;
    },
    stdinIsTTY: options.tty ?? (options.stdin === undefined && options.stdinSource === undefined),
    stdoutIsTTY: options.tty ?? false,
  };
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** User settings of the tests: the reference provider on an unused local address, and the fictitious tiers. */
export const TEST_USER_CONFIG = {
  api: { provider: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1" },
  models: { identifierMap: TEST_IDENTIFIER_MAP },
  sessions: { autoTitle: false }, // Stable scripted conversations; dedicated title tests enable optional metadata traffic.
};

export async function cli(
  argv: string[],
  ws: Workspace,
  options: {
    provider?: ModelProvider;
    env?: Record<string, string>;
    stdin?: string;
    /** A live standard input, read line by line while the run goes on. */
    stdinSource?: AsyncIterable<string>;
    /** Called with each write to the standard output, as it happens. */
    onOut?: (text: string) => void;
    /** Called with each write to the standard error, as it happens. */
    onErr?: (text: string) => void;
    tty?: boolean;
    signal?: AbortSignal;
    identity?: Identity;
    /** Merged into TEST_USER_CONFIG; `null` writes no user settings at all. */
    userConfig?: Record<string, unknown> | null;
    extra?: Partial<RunDependencies>;
  } = {},
): Promise<CliRun> {
  const identity = options.identity ?? loadIdentity();
  if (options.userConfig !== null) {
    writeFileSync(join(ws.configHome, "config.json"), JSON.stringify(deepMerge(TEST_USER_CONFIG, options.userConfig ?? {})));
  }
  const streams = captureStreams({ stdin: options.stdin, tty: options.tty, stdinSource: options.stdinSource, onOut: options.onOut, onErr: options.onErr });
  const env: Record<string, string> = {
    [`${identity.get("ENV_PREFIX")}CONFIG_HOME`]: ws.configHome,
    ...options.env,
  };
  const code = await runCli(argv, {
    streams,
    environment: env,
    cwd: ws.project,
    system: { ...systemInfo(), home: ws.home },
    identity,
    catalog: loadCatalog(),
    managedDir: ws.managed,
    policyFileProtection: trustedPolicyFile,
    providerFactory: options.provider ? () => options.provider! : undefined,
    signal: options.signal,
    ...options.extra,
  });
  return { code, stdout: streams.out.join(""), stderr: streams.err.join("") };
}

/** Default tool settings of the catalogue (SPEC-CFG-002), for direct tool tests. */
export const TEST_TOOL_SETTINGS: ToolSettings = {
  readDefaultLines: 1500,
  readMaxLineLength: 2500,
  readMaxBytesWithoutRange: 384 * 1024,
  readPdfMaxPages: 15,
  resultInlineLimit: 40_000,
  writeMaxSize: 10 * 1024 * 1024,
  editLenientMatching: true,
  findMaxResults: 250,
  findTimeoutMs: 20_000,
  respectIgnoreFiles: true,
  searchDefaultLimit: 200,
  searchMaxLineLength: 400,
  searchTimeoutMs: 30_000,
};

/** Fields of a tool context other than the location ones: settings, a fresh read state, no protected location. */
export function testToolFields(overrides: Partial<ToolContext> = {}): Pick<ToolContext, "settings" | "readState" | "protectedLocations" | "readDenied" | "modelImages"> & Partial<ToolContext> {
  return { settings: TEST_TOOL_SETTINGS, readState: new Map(), protectedLocations: NO_PROTECTED_LOCATIONS, readDenied: () => false, modelImages: true, ...overrides };
}
