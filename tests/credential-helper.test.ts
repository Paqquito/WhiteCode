import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { processExists } from "../src/platform/process";
import { join } from "node:path";
import { CredentialHelper } from "../src/auth/credential-helper";
import { workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
test("TECH — credential expiry coalesces concurrent renewals and closure joins its helper process", async () => {
  const ws = workspace(), count = join(ws.root, "count"), remembered: string[] = []; let now = 0;
  const file = ws.write("helper.ts", `const fs = await import("node:fs"); const path = ${JSON.stringify(count)}; const n = fs.existsSync(path) ? Number(fs.readFileSync(path,"utf8"))+1 : 1; fs.writeFileSync(path,String(n)); console.log("fixture-credential-" + process.pid + "-" + n);`);
  const helper = new CredentialHelper({ command: `"${BUN}" "${file.replace(/\\/g, "/")}"`, cwd: ws.project, env: productEnv(ws), ttlMs: () => 100, now: () => now, remember: key => { remembered.push(key); }, diagnostic: () => {} });
  try {
    const signal = new AbortController().signal, first = await helper.get(signal); expect(await helper.get(signal)).toBe(first); now = 101;
    const keys = await Promise.all(Array.from({ length: 5 }, () => helper.get(signal))); expect(new Set(keys).size).toBe(1); expect(keys[0]).not.toBe(first); expect(readFileSync(count, "utf8")).toBe("2"); expect(remembered).toHaveLength(2);
  } finally { await helper.close(); }
  await expect(helper.get(new AbortController().signal)).rejects.toThrow();
});
test("TECH — cancelling either coalesced caller preserves the other caller and returns cancellation promptly", async () => {
  for (const cancelled of [0, 1]) {
    const ws = workspace(), file = ws.write("helper.ts", 'setTimeout(() => console.log("fixture-credential-" + process.pid), 300);');
    const helper = new CredentialHelper({ command: `"${BUN}" "${file.replace(/\\/g, "/")}"`, cwd: ws.project, env: productEnv(ws), ttlMs: () => 100, remember: () => {}, diagnostic: () => {} });
    const signals = [new AbortController(), new AbortController()];
    try {
      let completed = false;
      const outcomes = signals.map(controller => helper.get(controller.signal).then(value => { completed = true; return value; }, () => "cancelled"));
      signals[cancelled]!.abort(); expect(await outcomes[cancelled]).toBe("cancelled"); expect(completed).toBe(false); expect(await outcomes[1 - cancelled]).toStartWith("fixture-credential-");
    } finally { await helper.close(); }
  }
});
test("TECH — closing an active helper stops and joins its process without retaining a value", async () => {
  const ws = workspace(), pidFile = join(ws.root, "pid"), file = ws.write("helper.ts", `const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const helper = new CredentialHelper({ command: `"${BUN}" "${file.replace(/\\/g, "/")}"`, cwd: ws.project, env: productEnv(ws), ttlMs: () => 100, remember: () => { throw new Error("Cancelled value retained"); }, diagnostic: () => {} });
  const outcome = helper.get(new AbortController().signal).then(() => "value", () => "stopped");
  try {
    const limit = performance.now() + 3000; while (!existsSync(pidFile) && performance.now() < limit) await Bun.sleep(5); expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8")); expect(processExists(pid)).toBe(true); await helper.close(); expect(await outcome).toBe("stopped"); expect(processExists(pid)).toBe(false);
  } finally { await helper.close(); }
}, 5000);
test("TECH — invalid or failing helper output is explicit and never falls back to another credential", async () => {
  for (const body of ['console.log("line one\\nline two")', 'console.error("fixture-secret-on-stderr"); process.exit(7)']) {
    const ws = workspace(), file = ws.write("helper.ts", body), diagnostics: unknown[] = [];
    const helper = new CredentialHelper({ command: `"${BUN}" "${file.replace(/\\/g, "/")}"`, cwd: ws.project, env: productEnv(ws), ttlMs: () => 100, remember: () => { throw new Error("Invalid credential retained"); }, diagnostic: value => { diagnostics.push(value); } });
    try { await expect(helper.get(new AbortController().signal)).rejects.toThrow(); expect(JSON.stringify(diagnostics)).not.toContain("fixture-secret-on-stderr"); }
    finally { await helper.close(); }
  }
});
