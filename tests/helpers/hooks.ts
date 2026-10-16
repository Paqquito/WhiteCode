// Helpers of the hook tests: hook commands are small Bun scripts, alike on every system.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_SECRET_VARIABLES } from "../../src/config/environment";
import { currentPlatform } from "../../src/platform/system";
import { detectPosixShell } from "../../src/tools/shell-runtime";
import { loadIdentity, type Workspace } from "./env";

export const platform = currentPlatform();
export const prefix = loadIdentity().get("ENV_PREFIX");
export const hostEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") hostEnv[k] = v;
export const POSIX = detectPosixShell(undefined, hostEnv, platform);
export const BUN = process.execPath.replace(/\\/g, "/");
export const PROJECT_DIR = ".pilote-dev";

export function productEnv(ws: Workspace, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) if (!k.startsWith(prefix) && !PUBLIC_SECRET_VARIABLES.includes(k)) out[k] = v;
  // Tests emulate a capable terminal; the host runner's TERM must not disable Unicode or framed pastes.
  return { ...out, TERM: "xterm-256color", HOME: ws.home, USERPROFILE: ws.home, ...extra };
}

/** A command running `file` with Bun, in the shell the hooks use. */
export function bunCommand(file: string): string {
  return POSIX ? `"${BUN}" "${file}"` : `& "${BUN}" "${file}"`;
}

/** A hook command running `body` (TypeScript, with `payload` read from the standard input) through Bun. */
export function hook(ws: Workspace, name: string, body: string): string {
  return bunCommand(ws.write(`scripts/${name}.ts`, `const payload = JSON.parse(await Bun.stdin.text());\n${body}\n`).replace(/\\/g, "/"));
}

/** A hook that appends its payload to a file, then prints `response` when given. */
export function record(ws: Workspace, name: string, response?: unknown) {
  const out = join(ws.root, `${name}.jsonl`).replace(/\\/g, "/");
  const print = response === undefined ? "" : `\nconsole.log(${JSON.stringify(JSON.stringify(response))});`;
  return {
    command: hook(ws, name, `const fs = await import("node:fs"); fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify(payload) + "\\n");${print}`),
    read: (): any[] => {
      if (!existsSync(out)) return [];
      const snapshot = readFileSync(out, "utf8");
      // A polling reader can catch appendFileSync before the final LF; wait for a complete snapshot.
      // Complete malformed records still throw, and an unfinished trailing record cannot satisfy a count assertion.
      return snapshot.endsWith("\n") ? snapshot.split("\n").slice(0, -1).map(line => JSON.parse(line)) : [];
    },
  };
}

export const answer = (ws: Workspace, name: string, response: unknown) => hook(ws, name, `console.log(${JSON.stringify(JSON.stringify(response))});`);
