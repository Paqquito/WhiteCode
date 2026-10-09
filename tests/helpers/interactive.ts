// Interactive runs of the product on an emulated terminal: keys are typed, screens are awaited.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type RunDependencies } from "../../src/headless/run";
import { systemInfo } from "../../src/platform/system";
import type { ModelProvider } from "../../src/providers/types";
import type { Identity } from "../../src/identity/identity";
import { captureStreams, loadCatalog, loadIdentity, TEST_USER_CONFIG, trustedPolicyFile, type Workspace } from "./env";
import { fakeTerminal } from "./vterm";

export const KEY = {
  enter: "\r",
  altEnter: "\u001b\r",
  escape: "\u001b",
  ctrlC: "\u0003",
  ctrlD: "\u0004",
  ctrlS: "\u0013",
  altS: "\u001bs",
  altX: "\u001bx",
  ctrlU: "\u0015",
  ctrlW: "\u0017",
  ctrlZ: "\u001a",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
  ctrlLeft: "\u001b[1;5D",
  shiftTab: "\u001b[Z",
} as const;

function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const b = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b) ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export interface InteractiveRun {
  readonly term: ReturnType<typeof fakeTerminal>;
  readonly done: Promise<{ code: number; stdout: string; stderr: string }>;
  /** Visible rows of the terminal. */
  screen(): string[];
  /** Scrollback and visible rows. */
  all(): string[];
  /** Keys as typed: plain text arrives one character at a time; escape sequences as they are. */
  type(data: string): void;
  /** A paste framed by the terminal. */
  paste(text: string): void;
  /** Raw input in one chunk (a paste without framing, for the heuristic). */
  raw(data: string): void;
  /** Waits until `predicate` holds for the whole text (scrollback and screen). */
  waitFor(predicate: (text: string) => boolean, what?: string, timeoutMs?: number): Promise<void>;
  /** Waits until the product is ready for an entry (the placeholder of an idle input area). */
  idle(): Promise<void>;
  finished(): boolean;
}

export const IDLE_PLACEHOLDER = "Votre message";
const ESC = String.fromCharCode(27);

export function interactive(
  argv: string[],
  ws: Workspace,
  o: { provider?: ModelProvider; columns?: number; rows?: number; userConfig?: Record<string, unknown>; env?: Record<string, string>; signal?: AbortSignal; identity?: Identity; extra?: Partial<RunDependencies> } = {},
): InteractiveRun {
  const identity = o.identity ?? loadIdentity();
  writeFileSync(join(ws.configHome, "config.json"), JSON.stringify(deepMerge(TEST_USER_CONFIG, { ui: { maxFramesPerSecond: 240 }, ...(o.userConfig ?? {}) })));
  const term = fakeTerminal(o.columns ?? 100, o.rows ?? 30);
  const streams = { ...captureStreams({ tty: true }), terminal: term };
  let finished = false;
  const done = runCli(argv, {
    streams,
    environment: { [`${identity.get("ENV_PREFIX")}CONFIG_HOME`]: ws.configHome, ...(o.env ?? {}) },
    cwd: ws.project,
    system: { ...systemInfo(), home: ws.home },
    identity,
    catalog: loadCatalog(),
    managedDir: ws.managed,
    policyFileProtection: trustedPolicyFile,
    providerFactory: o.provider ? () => o.provider! : undefined,
    signal: o.signal,
    ...o.extra,
  }).then((code) => {
    finished = true;
    return { code, stdout: streams.out.join(""), stderr: streams.err.join("") };
  });
  const text = () => term.vt.all().join("\n");
  const run: InteractiveRun = {
    term,
    done,
    screen: () => term.vt.screen(),
    all: () => term.vt.all(),
    type: (data) => {
      if (data.includes(ESC)) term.type(data);
      else for (const ch of data) term.type(ch);
    },
    paste: (t) => term.type(`${ESC}[200~${t}${ESC}[201~`),
    raw: (data) => term.type(data),
    finished: () => finished,
    async waitFor(predicate, what = "condition", timeoutMs = 8_000) {
      const end = Date.now() + timeoutMs;
      while (!predicate(text())) {
        if (finished) {
          const r = await done;
          if (!predicate(text())) throw new Error(`run finished (code ${r.code}) before: ${what}\n${r.stderr}\n--- screen ---\n${text()}`);
          return;
        }
        if (Date.now() > end) throw new Error(`timeout waiting for: ${what}\n--- screen ---\n${text()}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    idle: () => run.waitFor((t) => t.includes(IDLE_PLACEHOLDER), "idle input area"),
  };
  return run;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
