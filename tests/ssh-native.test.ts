import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
import { sshCommand } from "../src/ssh/transport";

const bench = process.env["SSH_SESSION_BENCH"], executable = resolve(import.meta.dir, "../build/ssh-agent-linux");
/** Inspect every byte without a subprocess capture limit or copying the witness into the remote command. */
async function inspectRemoteFiles(program: string, command: string, witness: string): Promise<{ code: number | null; found: boolean; bytes: number; error: string }> {
  const child = spawn(program, ["bench", command], { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  const needle = Buffer.from(witness); let tail = Buffer.alloc(0), found = false, bytes = 0, error = "";
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    const joined = Buffer.concat([tail, chunk]); found ||= joined.includes(needle);
    tail = Buffer.from(joined.subarray(Math.max(0, joined.length - needle.length + 1)));
  });
  child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
  return await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve({ code, found, bytes, error })); });
}
test.skipIf(process.platform !== "linux" || !bench || !existsSync(executable))("SPEC-MOD-020/CA-01, SPEC-MOD-020/CA-02 — real SSH deploys Linux, executes remote tools and authenticates only on the local machine", async () => {
  const ws = workspace(), path = `${bench}/project/remote.txt`, fixtureSecret = "ssh-local-" + randomBytes(24).toString("hex");
  writeFileSync(path, "REMOTE_SSH_FILE_WITNESS");
  const hash = createHash("sha256").update(readFileSync(executable)).digest("hex"), cached = join(bench!, "home/.cache", loadIdentity().get("PRODUCT_SLUG"), "ssh", hash);
  if (existsSync(cached)) unlinkSync(cached);
  expect(existsSync(cached)).toBe(false);
  const api = startFakeOpenAI([{ delayMs: 1200, toolCalls: [{ name: "read_file", arguments: JSON.stringify({ path }) }] }, { text: "SSH_SESSION_COMPLETE" }]);
  const env = { PATH: `${bench}/bin:${process.env["PATH"]}`, OPENAI_API_KEY: fixtureSecret };
  try {
    const running = cli(["ssh-session", "connect", "bench", `${bench}/project`, "--executable", executable, "--non-interactive"], ws, { env, stdin: "Read the remote file and report its content.", userConfig: { api: { provider: "openai_compatible", baseUrl: api.baseURL } } });
    const limit = Date.now() + 20000; while (!api.requests.length && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 30));
    if (!api.requests.length) { const result = await running; throw new Error(`SSH never reached the local relay: ${result.code} ${result.stderr}`); }
    const inspection = spawnSync(`${bench}/bin/ssh`, ["bench", `for p in /proc/[0-9]*; do case "$(readlink "$p/exe" 2>/dev/null)" in */.cache/*/ssh/*) cat "$p/cmdline" "$p/environ";; esac; done`], { encoding: "utf8" });
    expect(inspection.status).toBe(0); expect(inspection.stdout).toContain("__ssh-session-worker"); expect(inspection.stdout).not.toContain(fixtureSecret);
    const result = await running;
    expect(result.code).toBe(0); expect(result.stdout).toContain("SSH_SESSION_COMPLETE"); expect(result.stderr).toContain("exécutable déployé"); expect(result.stderr).toContain(hash); expect(result.stdout + result.stderr).not.toContain(fixtureSecret);
    expect(api.requests).toHaveLength(2); expect(api.requests.every(request => request.headers["authorization"] === `Bearer ${fixtureSecret}`)).toBe(true);
    expect(JSON.stringify(api.requests[1]!.body)).toContain("REMOTE_SSH_FILE_WITNESS"); expect(existsSync(join(ws.project, "remote.txt"))).toBe(false); expect(readFileSync(path, "utf8")).toBe("REMOTE_SSH_FILE_WITNESS");
    const files = await inspectRemoteFiles(`${bench}/bin/ssh`, `find "$HOME" ${JSON.stringify(bench + "/project")} -type f ! -path '*/.cache/*/ssh/*' -size -1024k -exec cat {} +`, fixtureSecret);
    if (files.code !== 0) throw new Error(`SSH privacy inspection failed (${files.code}): ${files.error}`);
    expect(files.code).toBe(0); expect(files.bytes).toBeGreaterThan(0); expect(files.found).toBe(false);
    const second = await cli(["ssh-session", "connect", "bench", `${bench}/project`, "--executable", executable, "--non-interactive"], workspace(), { env, stdin: "Confirm the resumed deployment.", userConfig: { api: { provider: "openai_compatible", baseUrl: api.baseURL } } });
    expect(second.code).toBe(0); expect(second.stderr).toContain("cache vérifié");
    const saved = readFileSync(cached); writeFileSync(cached, "corrupted cached executable");
    try {
      const invalid = await cli(["ssh-session", "connect", "bench", `${bench}/project`, "--executable", executable, "--non-interactive"], workspace(), { env, stdin: "Do not execute a corrupted cache.", extra: { providerFactory: () => { throw new Error("A corrupt cache must be rejected before authentication."); } } });
      expect(invalid.code).toBe(2); expect(invalid.stderr).toContain("Empreinte");
    } finally { writeFileSync(cached, saved); }
  } finally { api.stop(); }
}, 60000);

test.skipIf(process.platform !== "linux" || !bench || !existsSync(executable))("TECH — interruption of the real SSH session closes the worker and local authentication request", async () => {
  const api = startFakeOpenAI([{ hang: true }]), abort = new AbortController();
  try {
    const running = cli(["ssh-session", "connect", "bench", `${bench}/project`, "--executable", executable, "--non-interactive"], workspace(), { signal: abort.signal, stdin: "Wait for interruption.", env: { PATH: `${bench}/bin:${process.env["PATH"]}` }, userConfig: { api: { provider: "openai_compatible", baseUrl: api.baseURL } } });
    const deadline = Date.now() + 15000; while (!api.requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    expect(api.requests).toHaveLength(1); abort.abort();
    const result = await running; expect(result.code).toBe(130);
    let live = "";
    for (let n = 0; n < 30; n++) {
      const inspected = spawnSync(`${bench}/bin/ssh`, ["bench", 'for p in /proc/[0-9]*; do case "$(readlink "$p/exe" 2>/dev/null)" in */.cache/*/ssh/*) printf alive;; esac; done'], { encoding: "utf8" });
      expect(inspected.status).toBe(0); live = inspected.stdout; if (!live) break; await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(live).toBe("");
  } finally { abort.abort(); api.stop(); }
}, 30000);

test.skipIf(process.platform !== "linux" || !bench)("TECH — SSH cancellation during listener installation still stops the child", async () => {
  const controller = new AbortController(), install = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => { controller.abort(); install(type, listener, options); };
  const started = Date.now();
  await expect(sshCommand({ cwd: bench!, env: { PATH: process.env["PATH"]! }, program: `${bench}/bin/ssh`, host: "bench", signal: controller.signal }, "sleep 20")).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
}, 5000);
