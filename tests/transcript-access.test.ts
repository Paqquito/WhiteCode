// Transcript capabilities use local processes and isolated profiles; no external service is contacted.
import { expect, test } from "bun:test";
import { TranscriptAccess, readTranscriptReference } from "../src/session/transcript-access";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, ROOT, workspace } from "./helpers/env";
import { BUN, hook, productEnv, POSIX, platform } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { runCommandHook } from "../src/hooks/command";
import { HookRuntime } from "../src/hooks/runtime";
import { buildSnapshot } from "../src/hooks/config";

const read = async (reference: string): Promise<string> => { const out: string[] = []; await readTranscriptReference(reference, (text) => out.push(text)); return out.join(""); };
test("TECH — closing during a pending grant rejects it instead of leaving a hook suspended", async () => {
  const access = new TranscriptAccess(() => Buffer.from("private witness"));
  const pending = access.grant(); access.close();
  await expect(pending).rejects.toThrow("terminé");
});

test("TECH — a command with an already aborted signal creates no child and no side effect", async () => {
  const ws = workspace(), marker = join(ws.root, "cancelled-marker");
  const command = hook(ws, "cancelled", `(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "unexpected");`);
  const controller = new AbortController(); controller.abort();
  const result = await runCommandHook({ type: "command", command }, "{}", { cwd: ws.project, env: productEnv(ws), shell: POSIX ? { path: POSIX.path, kind: "posix" } : { path: "powershell.exe", kind: "powershell" }, timeoutMs: 5000, outputMaxSize: 1000, platform, signal: controller.signal });
  expect(result.exitCode).toBeNull(); expect(existsSync(marker)).toBe(false);
});

test("TECH — session close during a transcript grant cancels the asynchronous hook before any side effect", async () => {
  const ws = workspace(), marker = join(ws.root, "late-marker");
  const command = hook(ws, "late", `(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "unexpected");`);
  const access = new TranscriptAccess(() => Buffer.from("private witness"));
  const reports: string[] = [];
  const runtime = new HookRuntime({ transcriptAccess: access,
    snapshot: buildSnapshot([{ origin: "user", value: { session_closed: [{ async: true, actions: [{ type: "command", command }] }] } }], { managedOnly: false, noHooks: false, maxTimeoutMs: 5000 }),
    sessionId: "test-session", cwd: ws.project, platform, approvalMode: () => "ask", environment: (extra) => ({ ...productEnv(ws), ...extra }), envPrefix: "TEST_",
    shells: POSIX ? { posix: { path: POSIX.path, kind: "posix" } } : { powershell: { path: "powershell.exe", kind: "powershell" } },
    commandTimeoutMs: 5000, outputMaxSize: 1000, payloadMaxSize: 1000, http: { timeoutMs: 5000, allowedEnvVars: [] }, maxAsync: 1, asyncKillOnExit: true,
    report: (text) => reports.push(text), addContext: () => {},
  });
  try {
    await runtime.fire("session_closed", {}); await runtime.close();
    expect(existsSync(marker)).toBe(false); expect(reports.join(" ")).toContain("arrêté");
  } finally { await runtime.close(); access.close(); }
});

test("TECH — invocation references are unpredictable, readable only while granted, and revoked at session close", async () => {
  const access = new TranscriptAccess(() => Buffer.from("private witness — 漢字\n"));
  try {
    const first = await access.grant(), second = await access.grant();
    expect(first.reference).not.toBe(second.reference);
    expect(await read(first.reference)).toBe("private witness — 漢字\n");
    first.release(); await expect(read(first.reference)).rejects.toThrow("indisponible");
    expect(await read(second.reference)).toContain("private witness");
    access.close(); await expect(read(second.reference)).rejects.toThrow();
    await expect(access.grant()).rejects.toThrow();
  } finally { access.close(); }
});

test("TECH — references cannot choose another host, scheme or path; a forged token reveals no content", async () => {
  const access = new TranscriptAccess(() => Buffer.from("private witness"));
  try {
    const grant = await access.grant();
    const forged = grant.reference.slice(0, -43) + "a".repeat(43);
    await expect(read(forged)).rejects.toThrow("indisponible");
    for (const ref of ["https://example.invalid/", "session:v1:0:" + "a".repeat(43), grant.reference + "/other", "session:v1:65536:" + "a".repeat(43)]) await expect(read(ref)).rejects.toThrow("invalide");
  } finally { access.close(); }
});

test("TECH — closing one session revokes its references without exposing or closing another session", async () => {
  const first = new TranscriptAccess(() => Buffer.from("first session")), second = new TranscriptAccess(() => Buffer.from("second session"));
  try {
    const a = await first.grant(), b = await second.grant();
    expect(await read(a.reference)).toBe("first session"); expect(await read(b.reference)).toBe("second session");
    first.close(); await expect(read(a.reference)).rejects.toThrow("expirée");
    expect(await read(b.reference)).toBe("second session");
  } finally { first.close(); second.close(); }
});

test("TECH — browser origins and non-read requests are refused; read and stdout failures disclose no diagnostic content", async () => {
  let failed = false;
  const access = new TranscriptAccess(() => { if (failed) throw new Error("private witness"); return Buffer.from("content"); });
  try {
    const grant = await access.grant();
    const [port, token] = grant.reference.slice("session:v1:".length).split(":");
    const url = `http://127.0.0.1:${port}/read/${token}`;
    for (const options of [{ headers: { Origin: "https://example.invalid" } }, { method: "POST" }]) {
      const response = await fetch(url, options);
      expect(response.status).toBe(404); expect(await response.text()).not.toContain("content");
    }
    await expect(readTranscriptReference(grant.reference, () => { throw new Error("stdout closed"); })).rejects.toThrow("indisponible");
    failed = true;
    await expect(read(grant.reference)).rejects.toThrow("indisponible");
    const response = await fetch(url); expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.text()).not.toContain("private witness");
  } finally { access.close(); }
});

test("TECH — a local read ignores all proxy environment variables, never exposing its capability or content", async () => {
  let requests = 0;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Response("intercepted", { status: 407 }); } });
  const ws = workspace();
  const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  try {
    const file = ws.write("scripts/proxy-reader.ts", `import { TranscriptAccess, readTranscriptReference } from ${JSON.stringify(join(ROOT, "src/session/transcript-access.ts").replace(/\\/g, "/"))};
const access = new TranscriptAccess(() => Buffer.from("private witness"));
try { const grant = await access.grant(); let text = ""; await readTranscriptReference(grant.reference, (part) => { text += part; }); console.log(text); }
finally { access.close(); }`);
    const env = productEnv(ws, Object.fromEntries(names.map((name) => [name, name.toLowerCase() === "no_proxy" ? "" : `http://127.0.0.1:${proxy.port}`])));
    const child = Bun.spawn([BUN, file], { env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(errors).toBe(""); expect(output.trim()).toBe("private witness"); expect(requests).toBe(0);
  } finally { await proxy.stop(true); }
});

test("TECH — a real hook reads session content through the child CLI on stdout, without receiving a store path", async () => {
  const ws = workspace(), output = join(ws.root, "read-response.json");
  const command = hook(ws, "reader", `const proc = Bun.spawn([${JSON.stringify(BUN)}, ${JSON.stringify(join(ROOT, "src/main.ts"))}, "session", "read", payload.transcriptRef], { stdout: "pipe", stderr: "pipe", env: process.env });
const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ code: await proc.exited, stdout, stderr, reference: payload.transcriptRef }));`);
  const result = await cli(["--non-interactive", "private witness 7241"], ws, { env: productEnv(ws), provider: new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: ws.write("project/read.txt", "read") } }] }, { text: "done" }]), userConfig: { hooks: { before_tool: [{ actions: [{ type: "command", command }] }] } } });
  expect(result.code).toBe(0);
  const captured = JSON.parse(readFileSync(output, "utf8"));
  expect(captured.code).toBe(0); expect(captured.stdout).toContain("private witness 7241");
  expect(captured.stderr).toBe(""); expect(captured.reference).toMatch(/^session:v1:\d+:[A-Za-z0-9_-]{43}$/);
  expect(captured.reference).not.toContain(ws.configHome);
}, 20_000);

test("TECH — after_tool references expose the complete current result before persistence, including in ephemeral sessions", async () => {
  for (const ephemeral of [false, true]) for (const async of [false, true]) {
    const ws = workspace(), output = join(ws.root, "current-result.json");
    const full = "FULL_RESULT_WITNESS_93472".repeat(20);
    const command = hook(ws, "current", `const proc = Bun.spawn([${JSON.stringify(BUN)}, ${JSON.stringify(join(ROOT, "src/main.ts"))}, "session", "read", payload.transcriptRef], { stdout: "pipe", stderr: "pipe", env: process.env });
const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
(await import("node:fs")).writeFileSync(${JSON.stringify(output)}, JSON.stringify({ code: await proc.exited, stdout, stderr, payload }));`);
    const result = await cli(["--non-interactive", ...(ephemeral ? ["--ephemeral"] : []), "current result"], ws, { env: productEnv(ws), provider: new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: ws.write("project/witness.txt", full) } }] }, { text: "done" }]), userConfig: { hooksConfig: { payloadMaxSize: 8 }, hooks: { after_tool: [{ async, actions: [{ type: "command", command }] }] } } });
    expect(result.code).toBe(0);
    const captured = JSON.parse(readFileSync(output, "utf8"));
    expect(captured.code).toBe(0); expect(captured.stderr).toBe(""); expect(captured.payload.toolResult).not.toContain(full);
    expect(captured.payload.toolResultTruncated.originalBytes).toBeGreaterThan(8); expect(captured.stdout).toContain(full);
    const records = captured.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
    const results = records.flatMap((record: { type?: string; data?: unknown; role?: string; parts?: unknown[] }) => record.type === "tool_result" ? [record.data] : record.role === "user" ? record.parts ?? [] : []);
    expect(results.filter((part: { callId?: string }) => part.callId === captured.payload.callId)).toHaveLength(1);
  }
}, 30_000);

test("SPEC-SES-001/CA-13 — SPEC-SES-001/CA-15 — the CLI refuses a finished hook's reference during the session and after its end", async () => {
  const ws = workspace(), referenceFile = join(ws.root, "reference.txt");
  const command = hook(ws, "capture", `const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(referenceFile)}, payload.transcriptRef);`);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const provider = new ScriptedProvider([() => { enter(); return { text: "done", delayMs: 2000 }; }]);
  const running = cli(["--non-interactive", "witness"], ws, { env: productEnv(ws), provider, userConfig: { hooks: { prompt_submitted: [{ actions: [{ type: "command", command }] }] } } });
  await entered;
  const reference = readFileSync(referenceFile, "utf8");
  const expired = await cli(["session", "read", reference], ws, { userConfig: null, env: productEnv(ws) });
  expect(expired.code).toBe(2); expect(expired.stdout).toBe(""); expect(expired.stderr).toContain("expirée");
  expect((await running).code).toBe(0);
  const ended = await cli(["session", "read", reference], ws, { userConfig: null, env: productEnv(ws) });
  expect(ended.code).toBe(2); expect(ended.stdout).toBe("");
}, 20_000);
