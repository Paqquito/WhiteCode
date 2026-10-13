// Supports: SPEC-SES-016, SPEC-SES-018, SPEC-CFG-008; real sessions, hooks and subprocesses.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { interactive } from "./helpers/interactive";
import { answer, productEnv, POSIX } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-SES-016/CA-01 — a prompt from session A is offered by up in session B of the same project", async () => {
  const ws = workspace();
  for (const first of [true, false]) {
    const c = new AbortController(), p = new ScriptedProvider([{ text: "stored" }]), ui = interactive([], ws, { provider: p, signal: c.signal });
    try {
      await ui.idle();
      if (first) { ui.type("prompt from A\r"); await ui.waitFor(t => t.includes("● stored")); }
      else { ui.type("\u001b[A"); await ui.waitFor(() => ui.screen().some(l => l.startsWith("│ › prompt from A"))); expect(p.requests).toHaveLength(0); }
    } finally { c.abort(); await ui.done; }
  }
});

test("SPEC-SES-016/CA-02 — a leading space keeps a submitted prompt out of persistent history", async () => {
  const ws = workspace(), c = new AbortController(), p = new ScriptedProvider([{ text: "private sent" }]), ui = interactive([], ws, { provider: p, signal: c.signal });
  try { await ui.idle(); ui.type(" private prompt\r"); await ui.waitFor(t => t.includes("● private sent")); }
  finally { c.abort(); await ui.done; }
  const file = join(ws.configHome, "input-history.jsonl");
  expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain("private prompt");
  expect(JSON.stringify(p.requests[0]!.history)).toContain("private prompt");
});

async function checkSessionEnvironment(managed: boolean): Promise<void> {
  const ws = workspace();
  if (managed) ws.write("managed/policy.json", JSON.stringify({ environment: { variables: { PROJECT_ENV: "prod" } } }));
  const command = answer(ws, "env", { sessionEnv: { PROJECT_ENV: "dev" } });
  const p = new ScriptedProvider([{ toolCalls: [{ name: POSIX ? "run_shell" : "run_powershell", input: { command: POSIX ? "printf '%s' \"$PROJECT_ENV\"" : "Write-Output $env:PROJECT_ENV" } }] }, { text: "done" }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider: p, env: productEnv(ws), userConfig: { hooks: { session_opened: [{ actions: [{ type: "command", command }] }] }, permissions: { allowRules: ["run_shell", "run_powershell"] } } });
  expect(r.code).toBe(0);
  const result = p.requests[1]!.history.filter(m => m.role === "user").flatMap(m => m.parts).find(p => p.type === "tool_result");
  expect(JSON.stringify(result)).toContain(managed ? "prod" : "dev");
  if (managed) expect(JSON.stringify(result)).not.toContain('"text":"dev');
}
test("SPEC-SES-018/CA-01 — session_opened variables reach a real model-requested subprocess", () => checkSessionEnvironment(false));
test("SPEC-SES-018/CA-02 — managed prod overrides dev from session_opened in the real shell", () => checkSessionEnvironment(true));

test("SPEC-CFG-008/CA-01 — managed HTTPS_PROXY replaces the user's value before every provider connection", async () => {
  const ws = workspace(), prefix = loadIdentity().get("ENV_PREFIX"), seen: string[] = [];
  // The HTTPS CONNECT is deliberately rejected: the purpose is to prove which proxy receives the connection.
  const proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket, data) { seen.push(data.toString()); socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); } } });
  ws.write("managed/policy.json", JSON.stringify({ environment: { variables: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } } }));
  let network: typeof fetch | undefined;
  const p = new ScriptedProvider([{ text: "done" }]);
  try {
    const r = await cli(["--non-interactive", "x"], ws, { provider: p, env: { HTTPS_PROXY: "http://127.0.0.1:1", [`${prefix}NO_AUTO_UPDATES`]: "1" }, extra: { providerFactory: o => { network = o.fetch; return p; } } });
    expect(r.code).toBe(0);
    for (const host of ["localhost", "127.0.0.1"]) await network!(`https://${host}/private`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    expect(seen.join("\n")).toContain("CONNECT localhost:443"); expect(seen.join("\n")).toContain("CONNECT 127.0.0.1:443");
  } finally { proxy.stop(true); }
});
