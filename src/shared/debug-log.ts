// Implements: SPEC-OBS-012 (CA-01, CA-02, EF-01 to EF-03, FA-01), gap E-141.
// Supports: SPEC-API-002 (EF-07 authentication headers never logged), SPEC-CFG-007 (RG-01)

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { restrictFileToOwner, writeNewPrivateWindowsFile } from "../platform/private-file";
import { currentPlatform } from "../platform/system";
import { maskSecrets } from "./secrets";

const SECRET_KEYS = /(authorization|api[-_]?key|x-api-key|token|secret|password)/i;

/** Masks secret-looking fields recursively before anything is written. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "••••" : redact(v);
    return out;
  }
  return value;
}

export interface DebugLog {
  readonly enabled: boolean;
  readonly path: string | undefined;
  log(domain: string, message: string, data?: unknown): void;
}

export const DISABLED_DEBUG_LOG: DebugLog = { enabled: false, path: undefined, log: () => {} };

export function createDebugLog(target: { kind: "stderr"; write: (text: string) => void } | { kind: "file"; path: string; write: (text: string) => void }, domains: readonly string[]): DebugLog {
  const included = domains.filter((domain) => !domain.startsWith("!"));
  const excluded = domains.filter((domain) => domain.startsWith("!")).map((domain) => domain.slice(1));
  let path = target.kind === "file" ? target.path : undefined;
  let identity: { ino: number; dev: number } | undefined;
  const fallback = () => {
    path = undefined;
    target.write("Journal de débogage inaccessible : repli sur la sortie d'erreur.\n");
  };
  if (path !== undefined) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      let existing;
      try { existing = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing) {
        if (!existing.isFile() || existing.nlink !== 1) throw new Error("Unsafe debug file.");
        restrictFileToOwner(path);
      } else if (currentPlatform() === "windows") writeNewPrivateWindowsFile(path, Buffer.alloc(0));
      else writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      identity = lstatSync(path);
    } catch { fallback(); }
  }
  return {
    enabled: true,
    get path() { return path; },
    log(domain, message, data) {
      if (excluded.includes(domain) || (included.length > 0 && !included.includes(domain))) return;
      const line = maskSecrets(`${new Date().toISOString()} [${domain}] ${message}${data === undefined ? "" : ` ${JSON.stringify(redact(data))}`}\n`);
      if (path !== undefined) {
        try {
          const before = lstatSync(path);
          if (!before.isFile() || before.nlink !== 1 || before.ino !== identity?.ino || before.dev !== identity.dev) throw new Error("Unsafe or replaced debug file.");
          restrictFileToOwner(path);
          const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = fstatSync(fd);
            if (!opened.isFile() || opened.nlink !== 1 || before.ino !== opened.ino || before.dev !== opened.dev) throw new Error("Debug file changed.");
            const bytes = Buffer.from(line);
            for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
          } finally { closeSync(fd); }
          return;
        } catch { fallback(); }
      }
      target.write(line);
    },
  };
}
