// Supports: SPEC-OBS-012 (minimal debug journal), SPEC-API-002 (EF-07 authentication headers never logged), SPEC-CFG-007 (RG-01)

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  log(domain: string, message: string, data?: unknown): void;
}

export const DISABLED_DEBUG_LOG: DebugLog = { enabled: false, log: () => {} };

export function createDebugLog(target: { kind: "stderr"; write: (text: string) => void } | { kind: "file"; path: string }, domains: readonly string[]): DebugLog {
  if (target.kind === "file") mkdirSync(dirname(target.path), { recursive: true });
  return {
    enabled: true,
    log(domain, message, data) {
      if (domains.length > 0 && !domains.includes(domain)) return;
      const line = `${new Date().toISOString()} [${domain}] ${message}${data === undefined ? "" : ` ${JSON.stringify(redact(data))}`}\n`;
      if (target.kind === "stderr") target.write(line);
      else appendFileSync(target.path, line, { mode: 0o600 });
    },
  };
}
