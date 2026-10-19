// Supports: SPEC-API-029, SPEC-PLA-002 (actual native broker, supervisor and session principals).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ROOT } from "./helpers/env";
const runtime = process.env.WC_HOSTED_NATIVE_BUN, distribution = process.env.WC_NATIVE_LINUX_DISTRIBUTION ?? "Ubuntu";
const available = process.platform === "win32" && !!runtime;
let result: Promise<any> | undefined;
async function command(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(JSON.stringify({ argv: argv.slice(0, 4), code, out, err })); return out.trim();
}
const wsl = (...argv: string[]) => ["wsl.exe", "-d", distribution, "--user", "root", "--exec", ...argv];
function proof(): Promise<any> {
  return result ??= (async () => {
    const output = join(ROOT, "build", "hosted-native"); mkdirSync(output, { recursive: true });
    await command([process.execPath, "--no-env-file", "build", "src/main.ts", "--compile", "--target=bun-linux-x64", "--outfile", join(output, "product")]);
    await command([process.execPath, "--no-env-file", "build", "tests/fixtures/hosted-native-proof.ts", "--target=bun", "--outfile", join(output, "proof.js")]);
    const root = (await command(wsl("/usr/bin/mktemp", "-d", "/var/tmp/hosted-proof-XXXXXX"))).trim();
    if (!/^\/var\/tmp\/hosted-proof-[a-zA-Z0-9]{6}$/.test(root)) throw Error("Invalid owned native root");
    const unix = async (path: string) => command(wsl("/usr/bin/wslpath", "-u", path));
    try {
      const [script, bundled, product] = await Promise.all([unix(join(ROOT, "tests/fixtures/hosted-native-launch.sh")), unix(join(output, "proof.js")), unix(join(output, "product"))]);
      const raw = await command(wsl("/usr/bin/unshare", "--mount", "--propagation", "private", "/bin/sh", script, root, bundled, runtime!, product));
      const receipt = JSON.parse(raw); writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); return receipt;
    } finally {
      await command(wsl("/usr/bin/python3", "-c", "import pathlib,sys,json,shutil; p=pathlib.Path(sys.argv[1]); assert str(p).startswith('/var/tmp/hosted-proof-') and p.is_dir() and not p.is_symlink(); m=p/'ownership.json'; assert not m.exists() or json.loads(m.read_text())['purpose']=='hosted-native-proof'; shutil.rmtree(p)", root));
    }
  })();
}
test.skipIf(!available)("SPEC-API-029/CA-02 — a native isolated hosted session uses its personal key exclusively through the broker", async () => {
  const r = await proof(); expect(r.personalUsed).toBe(true); expect(r.noSecrets).toBe(true); expect(r.brokerUid).not.toBe(r.workerUid); expect(r.firstFacts.uid).not.toBe(r.workerUid); expect(r.firstFacts.uid).not.toBe(r.brokerUid);
}, 120000);
test.skipIf(!available)("SPEC-API-029/CA-03 — an imposed organization key overrides the personal key in an actual native product execution", async () => {
  const r = await proof(); expect(r.organizationUsed).toBe(true); expect(r.organizationNotice).toContain("ERR-04"); expect(r.secondFacts.uid).not.toBe(r.firstFacts.uid);
}, 120000);
test.skipIf(!available)("SPEC-API-029/CA-07 — a model command receives kernel refusals when reading worker credentials, broker key, other sessions and privileged processes", async () => {
  const r = await proof();
  for (const facts of [r.firstFacts, r.secondFacts]) { expect(facts.uid).toBeGreaterThanOrEqual(65536); expect(facts.gid).toBe(facts.uid); expect(facts.groups).toEqual([]); expect(facts.noNewPrivs).toBe("1"); for (const capability of [facts.caps, facts.ambient, facts.permitted, facts.inheritable, facts.bounding]) expect(capability).toBe("0000000000000000"); expect(Object.values(facts.refusals).every(Boolean)).toBe(true); expect(Object.keys(facts.refusals)).toHaveLength(9); } expect(r.noSecrets).toBe(true); expect(r.otherActualSessionRefused).toBe(true);
}, 120000);
test.skipIf(!available)("SPEC-API-029/CA-04 — native key revocation stops the actual product and a detached descendant, then refuses new sessions", async () => {
  const r = await proof(); expect(r.revoked).toBe(true); expect(r.descendantStopped).toBe(true);
}, 120000);
test.skipIf(!available)("TECH — revocation interrupts a real blocked root Git clone before any hosted product launch", async () => {
  expect((await proof()).preparationStopped).toBe(true);
}, 120000);
test.skipIf(!available)("TECH — the local lease deadline also interrupts preparation while the broker clock is unchanged", async () => {
  expect((await proof()).preparationDeadlineStopped).toBe(true);
}, 120000);
test.skipIf(!available)("TECH — a live native descendant despite successful kill commands closes the worker to new assignments", async () => {
  expect((await proof()).unconfirmedClosed).toBe(true);
}, 120000);
test.skipIf(!available)("SPEC-API-029/CA-05 — the independent service resolves a revoked key again at the trigger deadline", async () => {
  const r = await proof(); expect(r.revokedHistory).toHaveLength(1); expect(r.revokedHistory[0].reason).toContain("ERR-01"); expect(r.revokedHistory[0].sessionId).toBeUndefined();
}, 120000);
test.skipIf(!available)("SPEC-PLA-002/CA-01 — the initiating client exits before the native service starts a daily isolated session and records its completed link", async () => {
  const r = await proof(); expect(r.dailyHistory).toHaveLength(1); expect(r.dailyHistory[0].status).toBe("completed"); expect(r.dailyHistory[0].url).toStartWith("https://service.example.test/sessions/"); expect(r.dailyHistory[0].sessionId).toBeString();
}, 120000);
test.skipIf(!available)("SPEC-PLA-002/CA-02 — immediate execution starts and completes an isolated native session without waiting for the next deadline", async () => {
  expect((await proof()).immediate).toBe(true);
}, 120000);
test.skipIf(!available)("SPEC-PLA-002/CA-03 — no delegated key at the independent native service deadline creates no session and records ERR-01", async () => {
  const r = await proof(); expect(r.emptyHistory[0].status).toBe("failed"); expect(r.emptyHistory[0].reason).toContain("ERR-01"); expect(r.emptyHistory[0].sessionId).toBeUndefined();
}, 120000);
