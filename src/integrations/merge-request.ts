// Implements: SPEC-INT-008 (bounded asynchronous forge status), SPEC-INT-009 (links scoped to the current repository).
// Supports: SPEC-INT-008 (only Git worktrees are eligible for status polling), gap E-337.
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { startChild } from "../platform/process";
import { findExecutable } from "../platform/system";
import {
  projectSessions,
  readTranscript,
  type SessionInfo,
} from "../session/sessions";
import type { ToolCall, ToolResultPart } from "../providers/types";
import { splitCommand } from "../permissions/command-split";
export async function forgeJson(
  args: readonly string[],
  options: {
    cwd: string;
    environment: Record<string, string>;
    signal: AbortSignal;
    program?: { file: string; args: string[] };
  },
): Promise<unknown> {
  const file = options.program?.file ?? findExecutable("gh");
  if (!file) throw Error("Outil de forge absent.");
  let text = "",
    oversize = false;
  const child = startChild(file, [...(options.program?.args ?? []), ...args], {
    cwd: options.cwd,
    env: options.environment,
    onData: (chunk) => {
      if (Buffer.byteLength(text) + chunk.length > 131072) {
        oversize = true;
        void child.killTree(100);
      } else text += chunk.toString();
    },
  });
  const scope = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]),
    stop = () => {
      void child.killTree(100);
    };
  scope.addEventListener("abort", stop, { once: true });
  try {
    if (scope.aborted) stop();
    const code = await child.exited;
    if (scope.aborted || code !== 0 || oversize)
      throw Error("Forge indisponible.");
    return JSON.parse(text);
  } finally {
    scope.removeEventListener("abort", stop);
  }
}
const states: Record<string, string> = {
  DRAFT: "brouillon",
  OPEN: "ouverte",
  APPROVED: "approuvée",
  CHANGES_REQUESTED: "modifications demandées",
  MERGED: "fusionnée",
  CLOSED: "fermée",
};
async function hasGitMarker(cwd: string, signal: AbortSignal): Promise<boolean> {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    if (signal.aborted) return false;
    try { const marker = await stat(join(folder, ".git")); if (marker.isFile() || marker.isDirectory()) return true; } catch { /* No accessible Git marker here. */ }
    if (dirname(folder) === folder) return false;
  }
}
export function mergeRequestLabel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return;
  const row = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row["number"]) ||
    Number(row["number"]) < 1 ||
    typeof row["url"] !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(
      row["url"],
    )
  )
    return;
  if (!row["url"].endsWith("/pull/" + row["number"])) return;
  const state = ["MERGED", "CLOSED"].includes(String(row["state"]))
    ? String(row["state"])
    : row["isDraft"] === true
      ? "DRAFT"
      : ["APPROVED", "CHANGES_REQUESTED"].includes(
            String(row["reviewDecision"]),
          )
        ? String(row["reviewDecision"])
        : String(row["state"]);
  return states[state]
    ? `#${row["number"]} · ${states[state]} (${row["url"]})`
    : undefined;
}
export class MergeRequestStatus {
  #closed = false;
  #pending = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #abort = new AbortController();
  #reported = false;
  label?: string;
  constructor(
    private readonly options: {
      cwd: () => string;
      environment: Record<string, string>;
      refreshSeconds: number;
      changed: () => void;
      debug: (text: string) => void;
      program?: { file: string; args: string[] };
    },
  ) {}
  start() {
    void this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh();
    }, this.options.refreshSeconds * 1000);
    this.#timer.unref();
  }
  async refresh() {
    if (this.#closed || this.#pending) return;
    this.#pending = true;
    const cwd = this.options.cwd();
    try {
      if (!await hasGitMarker(cwd, this.#abort.signal)) {
        if (!this.#closed && cwd === this.options.cwd() && this.label !== undefined) { this.label = undefined; this.options.changed(); }
        return;
      }
      if (this.#closed || cwd !== this.options.cwd()) return;
      const raw = await forgeJson(
        ["pr", "view", "--json", "number,url,state,reviewDecision,isDraft"],
        { ...this.options, cwd, signal: this.#abort.signal },
      );
      if (!this.#closed && cwd === this.options.cwd()) {
        this.label = mergeRequestLabel(raw);
        this.options.changed();
      }
    } catch {
      if (!this.#closed) {
        this.label = undefined;
        if (!this.#reported) {
          this.#reported = true;
          this.options.debug("merge request status unavailable");
        }
        this.options.changed();
      }
    } finally {
      this.#pending = false;
    }
  }
  close() {
    this.#closed = true;
    this.#abort.abort();
    clearInterval(this.#timer);
  }
}
export function createdMergeRequests(
  calls: readonly ToolCall[],
  results: readonly ToolResultPart[],
): string[] {
  const urls = new Set<string>();
  for (const call of calls) {
    const command = (call.input as { command?: unknown } | undefined)?.command;
    if (
      !["run_shell", "run_powershell"].includes(call.name) ||
      typeof command !== "string" ||
      !splitCommand(
        command,
        call.name === "run_powershell" ? "powershell" : "posix",
      ).parts.some((part) => /^gh(?:\.exe)?\s+pr\s+create(?:\s|$)/i.test(part))
    )
      continue;
    const result = results.find((r) => r.callId === call.callId && !r.isError);
    for (const part of result?.content ?? [])
      if (part.type === "text")
        for (const match of part.text.matchAll(
          /https:\/\/github\.com\/[^\s<>"'`]+/g,
        )) {
          const url = match[0].replace(/[),.;!?]+$/, "");
          if (
            /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(
              url,
            )
          )
            urls.add(url);
        }
  }
  return [...urls].slice(0, 20);
}
export function sessionsForMergeRequest(
  directory: string,
  project: string,
  reference: string,
): SessionInfo[] {
  if (
    !/^[1-9]\d{0,9}$/.test(reference) &&
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/.test(
      reference,
    )
  )
    throw Error("Référence de demande de fusion invalide.");
  return projectSessions(directory, project).filter((session) =>
    readTranscript(session.path).records.some(
      (record) =>
        record.type === "system" &&
        record.data["event"] === "merge_request_created" &&
        typeof record.data["url"] === "string" &&
        (record.data["url"] === reference ||
          (/^[1-9]\d*$/.test(reference) &&
            record.data["url"].endsWith("/pull/" + reference))),
    ),
  );
}
