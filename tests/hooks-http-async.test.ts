// HTTP hooks (SPEC-HOK-004) and asynchronous hooks (SPEC-HOK-007).
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HttpAction } from "../src/hooks/config";
import { forbiddenAddress, runHttpHook, substituteHeaders } from "../src/hooks/http";
import { cli, workspace, type Workspace } from "./helpers/env";
import { hook, productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

/** A local HTTP server that records what it receives and answers `reply`. */
function server(reply: (body: any) => Response = () => new Response(null, { status: 204 })) {
  const received: Array<{ headers: Headers; body: any; path: string }> = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (r) => {
      const text = await r.text();
      const body = text ? JSON.parse(text) : undefined;
      received.push({ headers: r.headers, body, path: new URL(r.url).pathname });
      return reply(body);
    },
  });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}`, port: s.port, received };
}
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

const run = (ws: Workspace, provider: ScriptedProvider, userConfig: Record<string, unknown>, args: string[] = [], extraEnv: Record<string, string> = {}) =>
  cli(["--non-interactive", ...args, "x"], ws, { provider, userConfig, env: productEnv(ws, extraEnv) });
const options = (o: Partial<Parameters<typeof runHttpHook>[2]> = {}) => ({ timeoutMs: 5_000, allowedEnvVars: [], env: {}, outputMaxSize: 65_536, ...o });
const http = (url: string, extra: Partial<HttpAction> = {}): HttpAction => ({ type: "http", url, ...extra });

describe("SPEC-HOK-004 HTTP hooks", () => {
  test("SPEC-HOK-004/CA-01 — an allowed URL: the server receives the payload in a JSON POST", async () => {
    const ws = workspace();
    const srv = server();
    const a = ws.write("project/a.txt", "a\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    const res = await run(ws, provider, { hooks: { after_tool: [{ match: "read_file", actions: [{ type: "http", url: `${srv.url}/hook` }] }] }, hooksConfig: { http: { allowedUrls: [`${srv.url}/*`] } } });
    expect(res.code).toBe(0);
    expect(srv.received).toHaveLength(1);
    expect(srv.received[0]!.headers.get("content-type")).toBe("application/json");
    expect(srv.received[0]!.body).toMatchObject({ schemaVersion: 1, event: "after_tool", toolId: "read_file", toolArguments: { path: a } });
  });

  test("SPEC-HOK-004/CA-02 — a name that resolves to the cloud metadata address: the request is not sent", async () => {
    let resolved = 0;
    const r = await runHttpHook(http("https://metadata.example.test/latest"), "{}", options({ resolve: async () => (resolved++, [{ address: "169.254.169.254", family: 4 }]) }));
    expect(resolved).toBe(1);
    expect(r.refused).toContain("métadonnées cloud");
    expect(r.status).toBeUndefined();
  });

  test("TECH — SPEC-HOK-004/EF-02, RG-01, ERR-01 — the address checked is the one contacted: a name re-bound to the loopback is refused, the server receives nothing; a literal internal address is refused with the message", async () => {
    const srv = server();
    const r = await runHttpHook(http(`https://rebind.example.test:${srv.port}/x`), "{}", options({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] }));
    expect(r.refused).toContain("boucle locale");
    expect(srv.received).toHaveLength(0);
    for (const ip of ["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.2", "169.254.169.254", "100.100.100.200", "0.0.0.0", "::1", "fe80::1", "fd00:ec2::254", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe"]) expect(forbiddenAddress(ip)).toBeDefined();
    for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) expect(forbiddenAddress(ip)).toBeUndefined();
    const ws = workspace();
    const res = await run(ws, new ScriptedProvider([{ text: "done" }]), { hooks: { session_opened: [{ actions: [{ type: "http", url: "https://169.254.169.254/latest/meta-data" }] }] } });
    expect(res.code).toBe(0); // EF-05: never blocking
    expect(res.stderr).toContain("Crochet HTTP refusé : adresse non autorisée");
  });

  test("TECH — SPEC-HOK-004/EF-04, FA-02 — outside allowedUrls: refused; plain http to another host: refused; a redirection is followed only when the target passes the same checks", async () => {
    const target = server(() => Response.json({ context: "redirected" }));
    const bounce = server(() => new Response(null, { status: 307, headers: { location: `${target.url}/final` } }));
    expect((await runHttpHook(http(`${bounce.url}/a`), "{}", options({ allowedUrls: ["https://hooks.example.test/*"] }))).refused).toContain("allowedUrls");
    expect((await runHttpHook(http("http://hooks.example.test/a"), "{}", options())).refused).toContain("https");
    const followed = await runHttpHook(http(`${bounce.url}/a`), '{"a":1}', options());
    expect(followed.status).toBe(200);
    expect(target.received[0]).toMatchObject({ path: "/final", body: { a: 1 } });
    const stopped = await runHttpHook(http(`${bounce.url}/a`), "{}", options({ allowedUrls: [`${bounce.url}/*`] }));
    expect(stopped.refused).toContain("allowedUrls");
    expect(target.received).toHaveLength(1);
  });

  test("SPEC-HOK-004/CA-03 — an Authorization header with an allowed variable: the value is substituted; a variable not allowed is left with a warning", async () => {
    const warnings: string[] = [];
    expect(substituteHeaders({ Authorization: "Bearer ${TOKEN}", "X-Other": "${SECRET}" }, ["TOKEN"], { TOKEN: "abc", SECRET: "s" }, warnings)).toEqual({ Authorization: "Bearer abc", "X-Other": "${SECRET}" });
    expect(warnings).toEqual(["Variable `SECRET` non autorisée dans un crochet HTTP."]);
    const ws = workspace();
    const srv = server();
    const res = await run(
      ws,
      new ScriptedProvider([{ text: "done" }]),
      { hooks: { session_opened: [{ actions: [{ type: "http", url: srv.url, headers: { Authorization: "Bearer ${HOOK_TEST_TOKEN}", "X-Other": "${HOOK_TEST_OTHER}" } }] }] }, hooksConfig: { http: { allowedEnvVars: ["HOOK_TEST_TOKEN"] } } },
      [],
      { HOOK_TEST_TOKEN: "t0k3n", HOOK_TEST_OTHER: "hidden" },
    );
    expect(srv.received[0]!.headers.get("authorization")).toBe("Bearer t0k3n");
    expect(srv.received[0]!.headers.get("x-other")).toBe("${HOOK_TEST_OTHER}");
    expect(res.stderr).toContain("Variable `HOOK_TEST_OTHER` non autorisée dans un crochet HTTP.");
  });

  test("TECH — SPEC-HOK-004/ERR-02, EF-05 — a server that does not answer in time or fails: the turn goes on, the failure is reported", async () => {
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => (await Bun.sleep(3_000), new Response("{}")) });
    servers.push(slow);
    const failing = server(() => new Response("oops", { status: 500 }));
    const ws = workspace();
    const res = await run(ws, new ScriptedProvider([{ text: "done" }]), {
      hooks: { session_opened: [{ actions: [{ type: "http", url: `http://127.0.0.1:${slow.port}/`, timeout: "500ms" }, { type: "http", url: failing.url }] }] },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("done");
    expect(res.stderr).toContain("Crochet HTTP sans réponse");
    expect(res.stderr).toContain("statut HTTP 500");
  });
});

describe("SPEC-HOK-007 asynchronous hooks", () => {
  test("SPEC-HOK-007/CA-01 — an asynchronous hook of 30 s on after_tool: the turn goes on at once", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "a\n");
    const started = join(ws.root, "started").replace(/\\/g, "/");
    const slow = hook(ws, "slow", `(await import("node:fs")).writeFileSync(${JSON.stringify(started)}, "1"); await Bun.sleep(30_000);`);
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { delayMs: 1_500, text: "done" }]);
    const t0 = Date.now();
    const res = await run(ws, provider, { hooks: { after_tool: [{ async: true, actions: [{ type: "command", command: slow }] }] }, hooksConfig: { asyncKillOnExit: true } });
    expect(res.code).toBe(0);
    expect(provider.requests).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(await Bun.file(started).exists()).toBe(true);
  }, 40_000);

  test("SPEC-HOK-007/CA-02 — the same hook returns context: it reaches the model at the next safe point, marked with its hook and event", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "a\n");
    const late = record(ws, "late", { context: "LATE-CONTEXT-42" });
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { delayMs: 2_500, toolCalls: [{ name: "find_files", input: { pattern: "*.txt" } }] }, { text: "done" }]);
    await run(ws, provider, { hooks: { after_tool: [{ id: "tests", match: "read_file", async: true, actions: [{ type: "command", command: late.command }] }] } });
    expect(late.read()).toHaveLength(1);
    const later = JSON.stringify(provider.requests.slice(1).map((r) => r.history));
    expect(later).toContain("LATE-CONTEXT-42");
    expect(later).toContain("after_tool, asynchronous hook user/after_tool/tests");
  }, 30_000);

  test("TECH — SPEC-HOK-007/EF-02, EF-03, ERR-01 — decisional fields of an asynchronous hook are ignored with a warning; beyond maxAsync the hooks wait for a slot", async () => {
    const ws = workspace();
    const marks = join(ws.root, "marks.txt").replace(/\\/g, "/");
    const deny = hook(ws, "deny", `console.log(JSON.stringify({ decision: "deny", stopTurn: true }));`);
    const slot = hook(ws, "slot", `const fs = await import("node:fs"); fs.appendFileSync(${JSON.stringify(marks)}, "start " + Date.now() + "\\n"); await Bun.sleep(700); fs.appendFileSync(${JSON.stringify(marks)}, "end " + Date.now() + "\\n");`);
    const provider = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, provider, {
      hooks: { prompt_submitted: [{ async: true, actions: [{ type: "command", command: deny }] }], session_opened: [{ async: true, actions: [{ type: "command", command: slot }, { type: "command", command: slot }] }] },
      hooksConfig: { maxAsync: 1 },
    });
    expect(res.stdout).toContain("done");
    expect(res.stderr).toContain("decision, stopTurn ignorés : un crochet asynchrone ne décide pas.");
    const lines = (await Bun.file(marks).text()).trim().split("\n");
    // One slot: the second hook starts only after the first has ended.
    expect(lines.map((l) => l.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  }, 30_000);

  test("TECH — SPEC-HOK-007/FA-01 — end of the session: without asyncKillOnExit, the hook goes on until its end and delivers no context", async () => {
    const ws = workspace();
    const done = join(ws.root, "done").replace(/\\/g, "/");
    const finish = hook(ws, "finish", `await Bun.sleep(800); (await import("node:fs")).writeFileSync(${JSON.stringify(done)}, "1"); console.log(JSON.stringify({ context: "TOO-LATE" }));`);
    const provider = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, provider, { hooks: { prompt_submitted: [{ async: true, actions: [{ type: "command", command: finish }] }] } });
    expect(res.code).toBe(0);
    expect(await Bun.file(done).exists()).toBe(true);
    expect(JSON.stringify(provider.requests.map((r) => r.history))).not.toContain("TOO-LATE");
  }, 30_000);
});
