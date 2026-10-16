// Implements: SPEC-MOT-045 (CA-10, CA-14: operational publication reference and revalidation).
// Supports: gap E-240 (observed revision supplied by the distribution's provider inventory).
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parsePublishedReference, publishedReference, revalidatePublished } from "../src/evaluation/revalidation";
import type { EvaluationSummary } from "../src/evaluation/release";
import { loadSuite } from "../src/evaluation/scenario";

const args = process.argv.slice(2), operation = args.shift();
function argument(name: string): string {
  const index = args.indexOf("--" + name), value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Argument requis : --" + name);
  return value;
}
function output(path: string, protectedFiles: readonly string[]): string {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Le rapport doit être un fichier ordinaire sans lien."); }
  const canonical = (file: string) => { const value = existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file)); return process.platform === "win32" ? value.toLowerCase() : value; };
  if (protectedFiles.some(file => canonical(file) === canonical(path))) throw new Error("La sortie ne peut remplacer ni le livrable publié ni ses preuves d’entrée.");
  return path;
}
function write(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
try {
  if (operation === "record") {
    const evaluationPath = resolve(argument("evaluation")), artifact = resolve(argument("artifact"));
    const destination = output(resolve(argument("state")), [evaluationPath, artifact]);
    const input = JSON.parse(readFileSync(evaluationPath, "utf8")) as { report?: EvaluationSummary & { artifact?: { sha256?: string } }; artifact?: { sha256?: string } } & EvaluationSummary;
    const evaluation = input.report ?? input;
    const reference = publishedReference(evaluation, artifact, argument("model-revision"));
    if (evaluation.artifact?.sha256 !== reference.artifact.sha256) throw new Error("Le rapport doit être lié à l’empreinte du livrable effectivement mesuré.");
    write(output(destination, [evaluationPath, artifact]), reference);
    console.log("Référence qualifiée enregistrée pour la famille " + reference.evaluation.family + ".");
  } else if (operation === "check") {
    const state = resolve(argument("state")), suite = resolve(argument("suite"));
    const reference = parsePublishedReference(JSON.parse(readFileSync(state, "utf8")) as unknown);
    const destination = output(resolve(argument("report")), [state, suite, reference.artifact.path]);
    const result = await revalidatePublished({
      reference, suite: loadSuite(suite), modelRevision: argument("model-revision"),
      execute: async (artifact, run) => {
        const command = /\.[cm]?js$/i.test(extname(artifact)) ? [process.execPath, artifact] : [artifact];
        const child = Bun.spawn([...command, ...run.argv.slice(0, -1), "--max-duration", "180", run.argv.at(-1)!], { cwd: run.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 190_000 });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { code, stdout, stderr };
      },
      onRun: (id, index, run) => console.log(`${id} #${index + 1} : ${run.passed ? "réussi" : "échec"}`),
    });
    write(output(destination, [state, suite, reference.artifact.path]), result);
    console.log(`Famille ${result.family} : ${result.status === "reevaluation_required" ? "à réévaluer" : result.status === "unchanged" ? "référence inchangée" : "réévaluation conforme"}.`);
    if (result.status === "reevaluation_required") process.exitCode = 1;
  } else throw new Error("Utilisation : revalidate.ts record --evaluation rapport --artifact livrable --model-revision révision --state référence ; ou check --state référence --suite jeu --model-revision révision --report rapport.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Réévaluation impossible.");
  process.exitCode = 2;
}
