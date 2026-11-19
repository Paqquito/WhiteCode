// Implements: SPEC-BLD-007 (EF-01 every acceptance criterion traced to a test), rule 4 (test names carry criterion identifiers)
// Checks tests/claims.json against the test names, then writes the criterion → tests matrix to build/trace-matrix.md.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specIndex as specs } from "./spec-index";

const root = join(import.meta.dir, "..");
const problems: string[] = [];

interface Claims {
  readonly increment: number | string;
  readonly claims: Record<string, string[]>;
}
const claims = JSON.parse(readFileSync(join(root, "tests/claims.json"), "utf8")) as Claims;

// Test names: first argument of test("…").
const covered = new Map<string, string[]>();
const testFiles = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts"));
let testCount = 0;
for (const f of testFiles) {
  const text = readFileSync(join(root, "tests", f), "utf8");
  // Conditional and parameterized tests name their criterion after the condition or the case table.
  for (const m of text.matchAll(/\btest(?:\.(?:skipIf|if|each)\([^()]*(?:\([^()]*\)[^()]*)*\))?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    testCount++;
    const name = m[1]!;
    if (!/^(SPEC-[A-Z]{3}-\d{3}\/CA-\d{2}|TECH|D-\d{2}|E-\d{3})/.test(name)) problems.push(`${f}: test name without criterion, decision or TECH prefix: "${name}"`);
    for (const c of name.matchAll(/(SPEC-[A-Z]{3}-\d{3})\/(CA-\d{2})/g)) {
      const sheet = specs.get(c[1]!);
      if (!sheet) problems.push(`${f}: unknown sheet ${c[1]}`);
      else if (sheet.obsolete) problems.push(`${f}: obsolete sheet ${c[1]}`);
      else if (!sheet.criteria.includes(c[2]!)) problems.push(`${f}: ${c[1]} has no ${c[2]}`);
      const key = `${c[1]}/${c[2]}`;
      covered.set(key, [...(covered.get(key) ?? []), `${f}: ${name}`]);
    }
  }
}

const lines = [`# Matrice de traçabilité — incrément ${claims.increment}`, "", "| Critère | Tests |", "|---|---|"];
let claimed = 0;
for (const [sheet, cas] of Object.entries(claims.claims)) {
  for (const ca of cas) {
    claimed++;
    const key = `${sheet}/${ca}`;
    const tests = covered.get(key);
    if (!specs.get(sheet)?.criteria.includes(ca)) problems.push(`claims.json: ${key} does not exist`);
    if (!tests) problems.push(`claims.json: ${key} is claimed but no test covers it`);
    lines.push(`| ${key} | ${(tests ?? ["**non couvert**"]).map((t) => t.replace(/\|/g, "\\|")).join("<br>")} |`);
  }
}
mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "build/trace-matrix.md"), `${lines.join("\n")}\n`);

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.error(`Traceability: ${claimed} claimed criteria, all covered; ${covered.size} criteria cited by ${testCount} tests.`);
