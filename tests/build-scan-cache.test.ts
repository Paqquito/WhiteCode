import { expect, test } from "bun:test";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Identity } from "../src/identity/identity";
import { scanDirectory, type ScanCache } from "../src/identity/files";
import { loadIdentity, workspace } from "./helpers/env";

const identity = (terms: string[], exceptions: Array<{ terme: string; contexte: string; justification: string }> = []) => {
  const base = loadIdentity();
  return new Identity({ ...base.resolved, compatibility: { ...base.resolved.compatibility, forbiddenTerms: terms, scanExceptions: exceptions } });
};

test("TECH — build scan caching checks file fingerprints, rules, exceptions and every binary encoding before reuse", () => {
  const ws = workspace(), file = ws.write("project/probe.bin", "ordinary data");
  const cache: ScanCache = new Map(), rules = identity(["neutral_probe_728"]);
  expect(scanDirectory(ws.project, rules, cache)).toEqual([]);
  expect(cache.size).toBe(1);
  expect(scanDirectory(ws.project, rules, cache)).toEqual(scanDirectory(ws.project, rules));
  for (const data of [Buffer.from("NEUTRAL-probe 728"), Buffer.from("neutral_probe_728", "utf16le"), Buffer.from("neutral_probe_728", "utf16le").swap16(), Buffer.concat([Buffer.from([0]), Buffer.from("neutral_probe_728", "utf16le")])]) {
    writeFileSync(file, data);
    const expected = scanDirectory(ws.project, rules);
    expect(expected.length).toBeGreaterThan(0);
    const cached = scanDirectory(ws.project, rules, cache);
    expect(cached).toEqual(expected);
    Reflect.set(cached[0]!, "term", "caller mutation");
    expect(scanDirectory(ws.project, rules, cache)).toEqual(expected);
  }
  const allowed = identity(["neutral_probe_728"], [{ terme: "neutral_probe_728", contexte: "probe.bin", justification: "Synthetic exception" }]);
  expect(scanDirectory(ws.project, allowed, cache)).toEqual([]);
  expect(scanDirectory(ws.project, rules, cache).length).toBeGreaterThan(0);
  expect(scanDirectory(ws.project, identity(["another_probe"]), cache)).toEqual([]);
  writeFileSync(file, gzipSync(Buffer.from("neutral_probe_728")));
  expect(scanDirectory(ws.project, rules, cache).length).toBeGreaterThan(0);
  writeFileSync(file, Buffer.from("504b0304", "hex"));
  expect(() => scanDirectory(ws.project, rules, cache)).toThrow("Format compressé non pris en charge");
});

test("TECH — a cached directory never skips file-kind validation", () => {
  const ws = workspace(), cache: ScanCache = new Map(), rules = identity(["neutral_probe_728"]);
  ws.write("project/ordinary.txt", "ordinary data");
  scanDirectory(ws.project, rules, cache);
  symlinkSync(ws.root, join(ws.project, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => scanDirectory(ws.project, rules, cache)).toThrow("Lien non parcouru");
});
