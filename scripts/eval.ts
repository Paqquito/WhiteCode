// Implements: SPEC-MOT-045 (§ 5.2 points 2 and 3: suite run for a family, report attached, release rule)
// Runs the evaluation suite against the real product, with the provider configured in the user settings.
// Usage: bun scripts/eval.ts --suite eval/suite.json --family generic [--runs 5] [--report build/eval-report.json]
//        [--released build/released.json] [--executable dist/<cli>] [--only c01-report-failing-test] [--max-duration <seconds per run>]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONTRACT_VERSION } from "../src/engine/behavior-contract";
import type { ReleasedReference } from "../src/evaluation/release";
import { evaluateSuite, type ProductExecutor } from "../src/evaluation/runner";
import { loadSuite } from "../src/evaluation/scenario";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const suite = loadSuite(resolve(arg("suite") ?? join(root, "eval", "suite.json")));
const only = arg("only");
const selected = only ? { ...suite, scenarios: suite.scenarios.filter((s) => s.id === only) } : suite;
const executable = arg("executable");
const command = executable ? [resolve(executable)] : [process.execPath, join(root, "src", "main.ts")];
const released = arg("released") ? (JSON.parse(readFileSync(resolve(arg("released")!), "utf8")) as ReleasedReference) : undefined;

// Optional cap of each run, in seconds (a looping run on a slow machine would otherwise last up to the iteration limit).
const maxDuration = arg("max-duration");
const execute: ProductExecutor = async ({ cwd, argv }) => {
  const args = maxDuration ? [...argv.slice(0, -1), "--max-duration", maxDuration, argv[argv.length - 1]!] : [...argv];
  const child = Bun.spawn([...command, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

const report = await evaluateSuite(selected, execute, {
  runs: Number(arg("runs") ?? 5),
  contractVersion: CONTRACT_VERSION,
  family: arg("family") ?? "generic",
  released,
  onRun: (id, i, r) =>
    console.log(
      `${r.passed ? "ok  " : "FAIL"} ${id} #${i + 1} — ${Math.round(r.elapsedMs / 1000)} s, ${r.iterations} it., ${r.inputTokens}/${r.outputTokens} tokens, ${r.haltReason}, tools: ${r.tools.join(" ") || "none"}${r.failures.length > 0 ? ` — ${r.failures.join("; ")}` : ""}`,
    ),
});

console.log("");
for (const [clause, c] of Object.entries(report.byClause).sort()) console.log(`${clause}: ${c.passed}/${c.total} scenario(s)`);
console.log(`Global rate: ${(report.decision.rate * 100).toFixed(1)} % — ${report.decision.releasable ? "releasable" : "NOT releasable"}`);
for (const reason of report.decision.reasons) console.log(`- ${reason}`);
const out = resolve(arg("report") ?? join(root, "build", "eval-report.json"));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Report: ${out}`);
process.exit(report.decision.releasable ? 0 : 1);
