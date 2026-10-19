// Supports: SPEC-PER-015 (actual Linux namespace confinement; never infer evidence from a skipped native run).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env";
const runtime = process.env.WC_SANDBOX_NATIVE_BUN, available = process.platform === "win32" && !!runtime;
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(JSON.stringify({ code, out, err })); return out.trim();
}
let pending: Promise<Record<string, unknown>> | undefined;
function proof() { return pending ??= nativeProof(); }
async function nativeProof(): Promise<Record<string, unknown>> {
  const directory = join(ROOT, "build", "per015"); mkdirSync(directory, { recursive: true });
  const wsl = (...args: string[]) => ["wsl.exe", "-d", "Ubuntu", "--user", "root", "--exec", ...args];
  const nativeRuntime = await command(wsl("/usr/bin/wslpath", "-w", runtime!));
  await command([process.execPath, "--no-env-file", "build", "tests/fixtures/sandbox-native-proof.ts", "--target=bun", "--outfile", join(directory, "proof.js")]);
  await command([process.execPath, "--no-env-file", "build", "src/main.ts", "--compile", "--target=bun-linux-x64", "--compile-executable-path", nativeRuntime, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", join(directory, "product")]);
  const script = await command(wsl("/usr/bin/wslpath", "-u", join(directory, "proof.js")));
  const product = await command(wsl("/usr/bin/wslpath", "-u", join(directory, "product")));
  const root = await command(wsl("/usr/bin/python3", "-c", "import tempfile,pathlib,json; p=pathlib.Path(tempfile.mkdtemp(prefix='sandbox-proof-',dir='/var/tmp/whitecode-native-tests-1mstsgkw')); (p/'ownership.json').write_text(json.dumps({'purpose':'sandbox-native-proof'})); print(p)"));
  try {
    const result = JSON.parse(await command(wsl("/usr/bin/env", "PATH=/var/tmp/whitecode-native-tests-1mstsgkw/tools/usr/bin:/usr/bin:/bin", "/usr/bin/unshare", "--net", "/bin/sh", "-c", '/usr/sbin/ip link set lo up && exec "$@"', "sandbox-fixture", runtime!, "--no-env-file", script, product, root)));
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (root) await command(wsl("/usr/bin/python3", "-c", "import pathlib,sys,json,shutil; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/var/tmp/whitecode-native-tests-1mstsgkw') and p.name.startswith('sandbox-proof-') and not p.is_symlink(); assert json.loads((p/'ownership.json').read_text())['purpose']=='sandbox-native-proof'; shutil.rmtree(p)", root));
  }
}
const check = async (facts: readonly string[]) => { const receipt = await proof(); for (const fact of facts) expect({ [fact]: receipt[fact] }).toEqual({ [fact]: true }); };
test.skipIf(!available)("SPEC-PER-015/CA-01 — a real confined command writes its project, blocks outside/sensitive/shared files and reports to the model and user", () => check(["inside", "outsideUnchanged", "noSecret", "outsideDenied", "completed", "absentDenied", "ca01"]), 60000);
test.skipIf(!available)("SPEC-PER-015/CA-02 — the actual executor executes a confined write without any approval request", () => check(["ca02"]), 60000);
test.skipIf(!available)("SPEC-PER-015/CA-03 — the actual executor asks ordinary approval for an exit and obeys the managed veto", () => check(["ca03", "managedVeto"]), 60000);
test.skipIf(!available)("TECH — native domain/TLS relay rejects SNI changes, direct TCP/DNS, Unix sockets, directory FDs and survives tree cancellation", () => check(["networkAllowed", "networkDenied", "noDirectEscape", "unixBlocked", "tlsAllowed", "sniBlocked", "dnsBlocked", "pairBlocked", "noDirectoryFd", "cancelledTree"]), 60000);
