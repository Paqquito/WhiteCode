// Implements: SPEC-EXT-036 (bounded background exploration, isolated verification, confirmed-only artifact), gap E-214.
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { startChild } from "../platform/process";
import { isWithin, realPathOrSelf, currentPlatform } from "../platform/system";
import { readPrivateText, ordinaryPrivateFile } from "../shared/private-text";
import type { BackgroundTasks } from "../engine/background";
import type { ReviewArtifact, ReviewFinding } from "../tools/review-artifact";
import { textOutcome, type Tool } from "../tools/types";

export interface DefectCandidate {
  file: string;
  start_line: number;
  end_line: number;
  severity: number;
  category: string;
  explanation: string;
  proposed_diff?: string;
}
export interface VerifiedDefect {
  confirmed: boolean;
  reason: string;
  quote: string;
  line: number;
  reproduction?: string;
}
export interface DefectScanOptions {
  readonly cwd: () => string;
  readonly tempDir: string;
  readonly git: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly background: BackgroundTasks;
  readonly fleetSize: () => number;
  readonly maxDuration: () => number;
  readonly agentTimeout: () => number;
  readonly readDenied: (path: string) => boolean;
  readonly redact: (value: string) => string;
  readonly explore: (
    files: readonly string[],
    angle: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly verify: (
    candidate: DefectCandidate,
    cwd: string,
    analysisOnly: boolean,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly reproduce: (
    cwd: string,
    script: string,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; output: string }>;
  readonly publish: (
    artifact: ReviewArtifact,
    signal: AbortSignal,
  ) => Promise<void>;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
async function git(
  o: DefectScanOptions,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const chunks: Buffer[] = [];
  let length = 0,
    excess = false;
  const child = startChild(
    o.git,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=",
      ...args,
    ],
    {
      cwd,
      env: { ...o.environment, GIT_TERMINAL_PROMPT: "0" },
      onData: (chunk) => {
        if ((length += chunk.length) > 1048576) {
          excess = true;
          void child.killTree(0);
        } else chunks.push(chunk);
      },
      onErrorData: () => {},
    },
  );
  const stop = () => {
      void child.killTree(0);
    },
    timer = setTimeout(stop, 10000);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const code = await child.exited;
    if (signal.aborted || excess || code !== 0)
      throw Error("Review Git operation unavailable.");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export class DefectScans {
  readonly artifacts = new Map<string, ReviewArtifact>();
  constructor(readonly options: DefectScanOptions) {}
  tool(): Tool<{ scope?: string[]; analysisOnly?: boolean }> {
    return {
      name: "run_defect_scan",
      description: () =>
        "Start a bounded local background defect campaign. Read-only explorers review changes, independent verifiers confirm candidates, and only confirmed findings enter the review artifact. Verification tests use disposable isolated copies and ordinary permissions. Set analysisOnly for reasoning without tests, copies or repository changes. No fixes are applied. Follow the returned task with background_output.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "array",
            maxItems: 50,
            items: { type: "string", minLength: 1, maxLength: 4096 },
          },
          analysisOnly: { type: "boolean" },
        },
        additionalProperties: false,
      },
      isEnabled: () => true,
      flags: (input) => ({
        readOnly: input.analysisOnly === true,
        concurrencySafe: false,
        destructive: false,
        requiresPermission: false,
        openWorld: false,
      }),
      ruleSubject: () => ({ kind: "none" }),
      permissionContribution: () => "allow",
      summary: () => "Start a defect review campaign",
      execute: async (input, ctx) => {
        const cwd = realPathOrSelf(ctx.cwd);
        if (cwd !== realPathOrSelf(this.options.cwd()))
          return textOutcome(
            "This campaign belongs to the main session workspace.",
            true,
            "permission_denied",
          );
        if (
          this.options.background.running.some(
            (task) => task.description === "Campagne de recherche de défauts",
          )
        )
          return textOutcome(
            "A defect campaign is already running.",
            true,
            "unavailable",
          );
        const task = this.options.background.start(
          "agent",
          "Campagne de recherche de défauts",
          async (signal, write) => {
            const scope = AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.min(3600000, this.options.maxDuration()),
              ),
            ]);
            const findings: ReviewFinding[] = [];
            let partial = false;
            try {
              partial = await this.#run(
                cwd,
                input.scope ?? [],
                input.analysisOnly === true,
                scope,
                findings,
                write,
              );
            } catch (error) {
              partial = true;
              write(
                "Campaign incomplete: " +
                  this.options.redact((error as Error).message) +
                  "\n",
              );
            }
            const artifact: ReviewArtifact = {
              title: "Recherche de défauts",
              summary: `${findings.length} défaut(s) confirmé(s).${partial ? " Couverture partielle : délai, interruption ou incident." : ""}${input.analysisOnly ? " Analyse seule, sans exécution ni copie." : ""}`,
              findings,
            };
            this.artifacts.set(task.id, artifact);
            while (this.artifacts.size > 20)
              this.artifacts.delete(this.artifacts.keys().next().value!);
            write(JSON.stringify(artifact) + "\n");
            if (!signal.aborted) await this.options.publish(artifact, signal);
            return {
              status: signal.aborted ? "stopped" : "completed",
              summary: JSON.stringify(artifact),
            };
          },
        );
        return textOutcome(
          `Defect campaign started as ${task.id}. It runs in the background; continue other work. ${input.analysisOnly ? "Analysis only: no tests, isolated copies or repository writes." : "Tests, if authorized, run only in disposable isolated copies."}`,
        );
      },
    };
  }
  async #run(
    cwd: string,
    scope: readonly string[],
    analysisOnly: boolean,
    signal: AbortSignal,
    findings: ReviewFinding[],
    write: (text: string) => void,
  ): Promise<boolean> {
    const o = this.options,
      root = (
        await git(o, cwd, ["rev-parse", "--show-toplevel"], signal)
      ).trim();
    if (realPathOrSelf(root) !== cwd)
      throw Error("Run the campaign from the repository root.");
    const head = (await git(o, cwd, ["rev-parse", "HEAD"], signal)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw Error("No repository revision.");
    let names: string[];
    if (scope.length)
      names = scope.map((path) =>
        relative(cwd, resolve(cwd, path)).replace(/\\/g, "/"),
      );
    else {
      let base = "HEAD";
      for (const ref of [
        "refs/remotes/origin/HEAD",
        "refs/heads/main",
        "refs/heads/master",
      ]) {
        try {
          const value = (
            await git(o, cwd, ["rev-parse", "--verify", ref], signal)
          ).trim();
          if (/^[a-f0-9]{40,64}$/.test(value)) {
            base = value;
            break;
          }
        } catch {
          signal.throwIfAborted();
        }
      }
      names = [
        ...(
          await git(
            o,
            cwd,
            [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--name-only",
              "-z",
              `${base}...${head}`,
              "--",
            ],
            signal,
          )
        ).split("\0"),
        ...(
          await git(
            o,
            cwd,
            [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--name-only",
              "-z",
              "HEAD",
              "--",
            ],
            signal,
          )
        ).split("\0"),
      ];
    }
    names = [...new Set(names.filter(Boolean))];
    if (names.length > 200)
      throw Error("Review scope exceeds 200 files; provide a smaller scope.");
    const sources = new Map<string, string>();
    for (const name of names) {
      const path = resolve(cwd, name);
      if (
        !isWithin(path, cwd, currentPlatform()) ||
        path === cwd ||
        realPathOrSelf(path) !== path ||
        o.readDenied(path) ||
        name.split("/").includes(".git")
      )
        continue;
      try {
        const text = readPrivateText(path, 262144);
        if (o.redact(text) !== text) continue;
        sources.set(name, text);
      } catch {
        /* Deleted, binary or unreadable sources are not candidates for automated verification. */
      }
    }
    if (!sources.size)
      throw Error("Nothing readable to review in the requested changes.");
    const files = [...sources.keys()],
      size = Math.min(Math.max(1, o.fleetSize()), 16, files.length),
      angles = ["correctness", "security", "concurrency", "regressions"],
      candidates: DefectCandidate[] = [];
    const explorers = await Promise.allSettled(
      Array.from({ length: size }, async (_, i) =>
        o.explore(
          files.filter((_, index) => index % size === i),
          angles[i % angles.length]!,
          AbortSignal.any([signal, AbortSignal.timeout(o.agentTimeout())]),
        ),
      ),
    );
    let partial = explorers.some(
      (result) => result.status !== "fulfilled" || !Array.isArray(result.value),
    );
    for (const result of explorers) {
      if (result.status !== "fulfilled" || !Array.isArray(result.value))
        continue;
      for (const raw of result.value.slice(0, 20)) {
        if (
          !object(raw) ||
          typeof raw.file !== "string" ||
          !sources.has(raw.file) ||
          !Number.isSafeInteger(raw.start_line) ||
          Number(raw.start_line) < 1 ||
          !Number.isSafeInteger(raw.end_line) ||
          Number(raw.end_line) < Number(raw.start_line) ||
          Number(raw.end_line) > sources.get(raw.file)!.split(/\r?\n/).length ||
          !Number.isInteger(raw.severity) ||
          Number(raw.severity) < 0 ||
          Number(raw.severity) > 3 ||
          typeof raw.category !== "string" ||
          raw.category.length > 64 ||
          typeof raw.explanation !== "string" ||
          !raw.explanation.trim() ||
          raw.explanation.length > 8192
        )
          continue;
        const candidate: DefectCandidate = {
          file: raw.file,
          start_line: Number(raw.start_line),
          end_line: Number(raw.end_line),
          severity: Number(raw.severity),
          category: o.redact(raw.category),
          explanation: o.redact(raw.explanation),
          ...(typeof raw.proposed_diff === "string" &&
          raw.proposed_diff.length <= 32768
            ? { proposed_diff: o.redact(raw.proposed_diff) }
            : {}),
        };
        if (
          !candidates.some(
            (c) =>
              c.file === candidate.file &&
              c.start_line === candidate.start_line,
          ) &&
          candidates.length < 20
        )
          candidates.push(candidate);
      }
    }
    write(
      `Exploration completed: ${candidates.length} candidate(s), ${size} reader(s).\n`,
    );
    for (const candidate of candidates) {
      signal.throwIfAborted();
      let container: string | undefined, copy: string | undefined;
      try {
        let verificationCwd = cwd;
        if (!analysisOnly) {
          container = mkdtempSync(join(o.tempDir, "review-"));
          copy = join(container, "copy");
          await git(
            o,
            cwd,
            ["worktree", "add", "--detach", "--", copy, head],
            signal,
          );
          for (const [name, text] of sources) {
            const target = resolve(copy, name);
            if (
              !isWithin(target, copy, currentPlatform()) ||
              realPathOrSelf(target) !== target
            )
              throw Error("Linked review copy source.");
            ordinaryPrivateFile(target, 262144);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, text, { flag: "w" });
          }
          verificationCwd = copy;
        }
        const raw = await o.verify(
          candidate,
          verificationCwd,
          analysisOnly,
          AbortSignal.any([signal, AbortSignal.timeout(o.agentTimeout())]),
        );
        if (
          !object(raw) ||
          raw.confirmed !== true ||
          typeof raw.reason !== "string" ||
          raw.reason.length < 20 ||
          raw.reason.length > 8192 ||
          typeof raw.quote !== "string" ||
          raw.quote.length > 1000 ||
          !Number.isSafeInteger(raw.line) ||
          Number(raw.line) < candidate.start_line ||
          Number(raw.line) > candidate.end_line
        )
          continue;
        const line = sources.get(candidate.file)!.split(/\r?\n/)[
          Number(raw.line) - 1
        ]!;
        if (!raw.quote.trim() || !line.includes(raw.quote)) continue;
        if (!analysisOnly) {
          if (
            typeof raw.reproduction !== "string" ||
            !raw.reproduction.trim() ||
            raw.reproduction.length > 16000
          )
            continue;
          const proof = await o.reproduce(
            verificationCwd,
            raw.reproduction,
            signal,
          );
          if (!proof.ok) {
            write(
              `Unconfirmed candidate omitted: ${candidate.file}:${candidate.start_line}.\n`,
            );
            continue;
          }
        }
        const current = readPrivateText(resolve(cwd, candidate.file), 262144);
        if (fingerprint(current) !== fingerprint(sources.get(candidate.file)!))
          continue;
        findings.push({
          id: randomUUID(),
          ...candidate,
          explanation: o.redact(
            candidate.explanation + "\nVerification: " + raw.reason,
          ),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        partial = true;
        write(
          `Candidate omitted after verification failure: ${candidate.file}:${candidate.start_line}.\n`,
        );
      } finally {
        if (copy && container) {
          const relativeCopy = relative(container, copy);
          if (
            relativeCopy !== "copy" ||
            !isWithin(container, o.tempDir, currentPlatform())
          )
            throw Error("Review cleanup boundary failed.");
          try {
            await git(
              o,
              cwd,
              ["worktree", "remove", "--force", "--", copy],
              AbortSignal.timeout(10000),
            );
            if (!existsSync(copy)) {
              ordinaryPrivateFile(join(container, "cleanup-probe"), 0);
              rmSync(container, { recursive: true, force: true });
            }
          } catch {
            write("Disposable review copy retained after cleanup failure.\n");
          }
        }
      }
    }
    return partial;
  }
}
