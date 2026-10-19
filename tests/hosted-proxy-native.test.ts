// Supports: SPEC-PER-023 (real TLS download through compulsory Linux namespace routing, not proxy declarations alone).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env";
const runtime = process.env.WC_HOSTED_PROXY_NATIVE_BUN, available = process.platform === "win32" && !!runtime;
async function command(args: string[]) { const child = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code !== 0) throw Error(JSON.stringify({ code, out, err })); return out.trim(); }
let pending: Promise<Record<string, any>> | undefined;
function proof() { return pending ??= nativeProof(); }
async function nativeProof(): Promise<Record<string, any>> {
  const directory = join(ROOT, "build/per023"); mkdirSync(directory, { recursive: true });
  const wsl = (...args: string[]) => ["wsl.exe", "-d", "Ubuntu", "--user", "root", "--exec", ...args];
  const nativeRuntime = await command(wsl("/usr/bin/wslpath", "-w", runtime!));
  await command([process.execPath, "--no-env-file", "build", "tests/fixtures/hosted-proxy-native-proof.ts", "--target=bun", "--outfile", join(directory, "proof.js")]);
  await command([process.execPath, "--no-env-file", "build", "src/main.ts", "--compile", "--target=bun-linux-x64", "--compile-executable-path", nativeRuntime, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", join(directory, "product")]);
  const script = await command(wsl("/usr/bin/wslpath", "-u", join(directory, "proof.js"))), product = await command(wsl("/usr/bin/wslpath", "-u", join(directory, "product")));
  const root = await command(wsl("/usr/bin/python3", "-c", "import tempfile,pathlib,json; p=pathlib.Path(tempfile.mkdtemp(prefix='per023-proof-',dir='/var/tmp/whitecode-native-tests-1mstsgkw')); (p/'ownership.json').write_text(json.dumps({'purpose':'upstream-relay-native-proof'})); print(p)"));
  try {
    const result = JSON.parse(await command(wsl("/usr/bin/env", "PATH=/var/tmp/whitecode-native-tests-1mstsgkw/tools/usr/bin:/usr/bin:/bin", "/usr/bin/unshare", "--net", "/bin/sh", "-c", '/usr/sbin/ip link set lo up && exec /usr/bin/setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-sys_ptrace,-perfmon,-sys_admin --no-new-privs -- "$@"', "proxy-fixture", runtime!, "--no-env-file", script, product, root)));
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(result, null, 2)); return result;
  } finally { await command(wsl("/usr/bin/python3", "-c", "import pathlib,sys,json,shutil; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/var/tmp/whitecode-native-tests-1mstsgkw') and p.name.startswith('per023-proof-') and not p.is_symlink(); assert json.loads((p/'ownership.json').read_text())['purpose']=='upstream-relay-native-proof'; shutil.rmtree(p)", root)); }
}
test.skipIf(!available)("SPEC-PER-023/CA-01 — authenticated upstream and local readiness precede token deletion; failed or replaced credentials remain", async () => { const result = await proof(); for (const key of ["ca01", "tokenRetainedUntilReady", "failedStartupKeepsToken", "replacementKept", "replenishedTokenKept", "bootstrapTlsRequired", "authenticationRequired"]) expect({ [key]: result[key] }).toEqual({ [key]: true }); }, 60000);
test.skipIf(!available)("SPEC-PER-023/CA-02 — the actual agent tool downloads with curl, child CA trust and one authenticated persistent TLS upstream", async () => { const result = await proof(); for (const key of ["ca02", "persistent", "tlsVerified", "authenticated", "noDirect", "closedFailure", "childTokenAbsent"]) expect({ [key]: result[key] }).toEqual({ [key]: true }); }, 60000);
test.skipIf(!available)("TECH — kernel refuses same-UID inspection without inspection capabilities after a readable control", async () => { const result = await proof(); expect(result.sameUid).toBe(true); expect(result.memoryBefore.ptraceCap).toBe(false); expect(result.memoryAfter.ptraceCap).toBe(false); expect(result.afterProtection.dumpable).toBe(0); for (const key of ["mem", "vm", "environ", "fd"]) { expect(result.memoryBefore[key]).toBe(true); expect(result.memoryAfter[key]).toBe(false); expect([1, 13]).toContain(result.memoryAfter[key + "_errno"]); } const capabilities = BigInt("0x" + result.beforeProtection.status.find((line: string) => line.startsWith("CapEff:")).split(/\s+/)[1]); expect(capabilities & ((1n << 19n) | (1n << 21n) | (1n << 38n))).toBe(0n); }, 60000);
test.skipIf(!available)("TECH — a distinct native UID with all capabilities dropped downloads using the read-only child CA bundle under private umask", async () => { expect((await proof()).distinctUid).toBe(true); }, 60000);
test.skipIf(!available)("TECH — malformed non-ASCII relay capabilities are refused on GET and CONNECT without interrupting valid child routing", async () => { const result = await proof(); expect(result.nonAsciiCapabilityResponses).toEqual([503, 503]); expect(result.nonAsciiCapabilityRejected).toBe(true); expect(result.relayUsableAfterInvalidCapability).toBe(true); }, 60000);
