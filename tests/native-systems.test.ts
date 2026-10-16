// Supports: SPEC-SES-001/CA-06, SPEC-BLD-004/CA-01 (actual native Linux vault and Alpine installation), gaps E-234, E-235.
import { expect, test } from "bun:test";
import { ROOT } from "./helpers/env";
const resources = process.env.WC_NATIVE_LINUX_RESOURCES, distribution = process.env.WC_NATIVE_LINUX_DISTRIBUTION ?? "Ubuntu";
const runtime = process.env.WC_NATIVE_LINUX_BUN;
const available = process.platform === "win32" && !!resources && !!runtime;
const unixRoot = available ? (await command(["wsl.exe", "-d", distribution, "--exec", "/usr/bin/wslpath", "-u", ROOT])).trim() : "";
async function command(argv: string[]) {
  const process = Bun.spawn(argv, { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw Error(JSON.stringify({ code, stdout, stderr })); return stdout;
}
const wsl = (...args: string[]) => ["wsl.exe", "-d", distribution, ...args];
test.skipIf(!available)("SPEC-SES-001/CA-06 — a second actual OS account reads the encrypted session copy but cannot obtain its system-vault key or open it", async () => {
  await command(wsl("--exec", "/usr/bin/test", "-x", resources! + "/vault/usr/bin/gnome-keyring-daemon"));
  const proof = (await command(wsl("--exec", "/usr/bin/mktemp", "-d", "/tmp/whitecode-vault-proof-XXXXXX"))).trim();
  const owner = Bun.spawn(wsl("--exec", "/usr/bin/env", "WC_NATIVE_RESOURCES_DIR=" + resources, "WC_NATIVE_PROOF_DIR=" + proof, "WC_NATIVE_REPOSITORY=" + unixRoot, "WC_NATIVE_BUN=" + runtime, "/bin/sh", unixRoot + "/tests/fixtures/native-vault-session.sh", "owner"), { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = new Response(owner.stdout).text(), errors = new Response(owner.stderr).text();
  let ownerCode: number | undefined;
  void owner.exited.then(code => { ownerCode = code; });
  let foreign: Record<string, unknown> | undefined;
  try {
    const deadline = Date.now() + 60000; let receipt = "";
    while (!receipt && Date.now() < deadline) {
      if (ownerCode !== undefined) throw Error(`Native owner exited ${ownerCode}: ${await errors}`);
      try { receipt = await command(wsl("--exec", "/bin/cat", proof + "/vault-public/receipt.json")); } catch { await Bun.sleep(100); }
    }
    if (!receipt) throw Error("Owner did not produce a ciphertext copy");
    const facts = JSON.parse(receipt);
    const raw = await command(wsl("--user", "nobody", "--exec", "/usr/bin/env", "WC_NATIVE_PROOF_DIR=" + proof, "LD_LIBRARY_PATH=" + resources + "/vault/usr/lib/x86_64-linux-gnu", "DBUS_SESSION_BUS_ADDRESS=" + facts.bus, "PATH=/usr/bin:/bin", runtime!, unixRoot + "/tests/fixtures/native-vault-probe.ts", "foreign"));
    foreign = JSON.parse(raw); expect(foreign).toMatchObject({ uid: 65534, nativeLibraryLoaded: true, copiedReadable: true, lookupRefused: true, refused: true });
    expect(facts.ownerUid).not.toBe(foreign!.uid); expect(facts.encrypted).toBeGreaterThan(0);
    await command(wsl("--exec", "/usr/bin/python3", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])", proof + "/vault-public/foreign-result.json", JSON.stringify(foreign)));
    expect(await owner.exited).toBe(0); expect(await errors).toBe(""); expect(await output).toContain("encrypted");
  } finally {
    if (!foreign) { await command(wsl("--exec", "/usr/bin/python3", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('{}')", proof + "/vault-public/foreign-result.json")).catch(() => {}); }
    await owner.exited;
  }
}, 120000);
test.skipIf(!available)("SPEC-BLD-004/CA-01 — the real Alpine container selects, verifies, installs and starts the musl executable through HTTPS", async () => {
  await command(wsl("--exec", "/usr/bin/test", "-x", resources! + "/bubblewrap/usr/bin/bwrap"));
  const output = await command(wsl("--exec", "/usr/bin/env", "WC_NATIVE_RESOURCES_DIR=" + resources, runtime!, unixRoot + "/tests/fixtures/native-alpine-probe.ts"));
  const receipt = JSON.parse(output);
  expect(receipt.requests).toEqual(["/v1/stable-linux-x64-musl.txt", "/program", "/v1/0.2.0.json", "/program"]);
  expect(receipt.version.stderr).toBe(""); expect(receipt.version.stdout).toContain("0.2.0");
  expect(JSON.parse(receipt.status.stdout)).toMatchObject({ version: "0.2.0", method: "native", target: "linux-x64-musl" });
}, 120000);
