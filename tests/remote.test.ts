// Inputs and outputs of the integration kit over a persistent connection (SPEC-MOD-007): server and client modes,
// authentication, numbering, replay after a cut, keep-alive, frame size, second host.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FramedLink, isLoopback, originAllowed, parseListenAddress } from "../src/control/remote";
import type { WsPeer } from "../src/platform/websocket";
import { cli, workspace } from "./helpers/env";
import { listeningEngine, PREFIX, RemoteHost, TOKEN, type Frame } from "./helpers/remote";
import { ScriptedProvider } from "./helpers/scripted-provider";

const OPENSSL = Bun.which("openssl");
const turnDone = (h: RemoteHost, n = 1) => h.waitFor((f) => f.type === "turn_completed" && f["turn"] === n);

describe("SPEC-MOD-007 server mode", () => {
  test("SPEC-MOD-007/CA-01 — an authenticated host: the initialization comes before any other message, the numbers are continuous", async () => {
    const ws = workspace();
    const engine = await listeningEngine(ws, new ScriptedProvider([{ text: "bonjour de loin" }]));
    const h = new RemoteHost(engine.url);
    expect(await h.opened).toBe(true);
    const init = await h.waitFor((f) => f.type === "control_init");
    expect(h.frames[0]).toBe(init);
    expect(init["seq"]).toBe(1);
    expect(typeof init["resumeToken"]).toBe("string");
    h.init();
    h.send({ type: "user", content: "salut" });
    expect((await turnDone(h))["result"]).toBe("bonjour de loin");
    await h.request("shutdown");
    const r = await engine.run;
    expect(r.code).toBe(0);
    const numbers = h.frames.filter((f) => typeof f["seq"] === "number").map((f) => f["seq"] as number);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1)); // RG-03
    expect(h.frames.at(-1)!.type).toBe("run_completed");
    expect(engine.stderr()).toContain("Hôte distant connecté : 127.0.0.1");
    expect(engine.stderr()).not.toContain(TOKEN); // RG-01
  });

  test("SPEC-MOD-007/CA-02 — an invalid token: the connection is refused without detail on the cause", async () => {
    const ws = workspace();
    const controller = new AbortController();
    const engine = await listeningEngine(ws, new ScriptedProvider([]), { signal: controller.signal });
    const wrong = new RemoteHost(engine.url, { token: "faux" });
    expect(await wrong.opened).toBe(false);
    expect(wrong.frames).toHaveLength(0);
    const http = await fetch(engine.url.replace(/^ws/, "http"), { headers: { Authorization: "Bearer faux" } });
    expect(http.status).toBe(401);
    expect(await http.text()).toBe("Connexion refusée.");
    // A web page (an Origin header not listed) is refused as well, even with the token (EF-08).
    const page = new RemoteHost(engine.url, { headers: { Origin: "https://page.example.test" } });
    expect(await page.opened).toBe(false);
    controller.abort();
    await engine.run;
  });

  test("SPEC-MOD-007/CA-03 — a cut shorter than the resumption window: the missed events are replayed in order", async () => {
    const ws = workspace();
    const engine = await listeningEngine(ws, new ScriptedProvider([{ text: "produit pendant la coupure", delayMs: 600 }, { text: "après" }]));
    const first = new RemoteHost(engine.url);
    const init = await first.waitFor((f) => f.type === "control_init");
    first.init();
    first.send({ type: "user", content: "longue tâche" });
    await first.waitFor((f) => f.type === "user");
    const seen = first.lastSeq;
    first.send({ type: "ack", seq: seen });
    first.close();
    await first.closed;
    await new Promise((r) => setTimeout(r, 1_200)); // the turn ends while nobody is connected
    const second = new RemoteHost(engine.url);
    expect(await second.opened).toBe(true);
    second.send({ type: "resume", resumeToken: init["resumeToken"], lastSeq: seen });
    const resumed = await second.waitFor((f) => f.type === "resumed");
    expect(resumed["lastSeq"]).toBe(seen);
    expect(resumed["resumeToken"]).not.toBe(init["resumeToken"]); // single use, renewed
    const done = await turnDone(second);
    expect(done["result"]).toBe("produit pendant la coupure");
    const numbers = second.frames.filter((f) => typeof f["seq"] === "number").map((f) => f["seq"] as number);
    expect(numbers[0]).toBe(seen + 1);
    expect(numbers).toEqual(numbers.map((_, i) => seen + 1 + i));
    // The channel goes on: a new turn, then the end.
    second.send({ type: "user", content: "suite" });
    await turnDone(second, 2);
    await second.request("shutdown");
    expect((await engine.run).code).toBe(0);
    expect(engine.stderr()).toContain("Hôte distant déconnecté : reprise possible pendant 120 s.");
    expect(engine.stderr()).toContain("Hôte distant reconnecté");
  });

  test.skipIf(!OPENSSL)("SPEC-MOD-007/CA-04 — a public listening address: an explicit warning comes before the listening", async () => {
    const ws = workspace();
    const cert = join(ws.root, "cert.pem");
    const key = join(ws.root, "key.pem");
    const made = Bun.spawnSync([OPENSSL!, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 20_000,
      // The OpenSSL of Git for Windows would turn "/CN=localhost" into a path, then wait for a subject on its input.
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    });
    expect(made.exitCode).toBe(0);
    const controller = new AbortController();
    let err = "";
    let listening: () => void;
    const announced = new Promise<void>((r) => (listening = r));
    const run = cli(["--non-interactive", "--control-listen=0.0.0.0:0"], ws, {
      provider: new ScriptedProvider([]),
      env: { [`${PREFIX}CONTROL_TOKEN`]: TOKEN, [`${PREFIX}CONTROL_TLS_CERT`]: cert, [`${PREFIX}CONTROL_TLS_KEY`]: key },
      signal: controller.signal,
      onErr: (t) => {
        err += t;
        if (err.includes("En écoute sur wss://")) listening();
      },
    });
    await announced;
    controller.abort();
    await run;
    const warning = err.indexOf("adresse d'écoute publique 0.0.0.0:0");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(err.indexOf("En écoute sur wss://"));
  }, 30_000);

  test("SPEC-MOD-007/CA-05 — a second host trying to drive: it is refused", async () => {
    const ws = workspace();
    const engine = await listeningEngine(ws, new ScriptedProvider([]));
    const first = new RemoteHost(engine.url);
    await first.waitFor((f) => f.type === "control_init");
    first.init();
    const second = new RemoteHost(engine.url);
    expect(await second.opened).toBe(true);
    second.init();
    expect(await second.closed).toBe(4409);
    expect(second.frames).toHaveLength(0);
    // The first host still drives the session.
    expect((await first.request("get_state"))["ok"]).toBe(true);
    await first.request("shutdown");
    expect((await engine.run).code).toBe(0);
  });
});

describe("SPEC-MOD-007 encryption and client mode", () => {
  test("SPEC-MOD-007/CA-06 — a plaintext transport to an address that is not local: the launch fails", async () => {
    const ws = workspace();
    const env = { [`${PREFIX}CONTROL_TOKEN`]: TOKEN };
    const client = await cli(["--non-interactive", "--control-connect", "ws://192.0.2.10:9/hote"], ws, { provider: new ScriptedProvider([]), env });
    expect(client.code).toBe(2);
    expect(client.stderr).toContain("Un transport chiffré est requis.");
    const server = await cli(["--non-interactive", "--control-listen=0.0.0.0:0"], ws, { provider: new ScriptedProvider([]), env });
    expect(server.code).toBe(2);
    expect(server.stderr).toContain("Un transport chiffré est requis.");
    // Neither without a token.
    const noToken = await cli(["--non-interactive", "--control-listen"], ws, { provider: new ScriptedProvider([]) });
    expect(noToken.code).toBe(2);
    expect(noToken.stderr).toContain(`${PREFIX}CONTROL_TOKEN`);
  });

  test("TECH — client mode: the engine connects to the endpoint of the host with its token and the same protocol (EF-06)", async () => {
    const ws = workspace();
    const frames: Frame[] = [];
    let headers = "";
    let socket: { send(t: string): void } | undefined;
    let gotInit: () => void;
    const initialized = new Promise<void>((r) => (gotInit = r));
    let completed: () => void;
    const turn = new Promise<void>((r) => (completed = r));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        headers = req.headers.get("authorization") ?? "";
        return srv.upgrade(req) ? undefined : new Response("non", { status: 400 });
      },
      websocket: {
        open(s) {
          socket = s;
        },
        message(_s, m) {
          const f = JSON.parse(String(m)) as Frame;
          frames.push(f);
          if (f.type === "control_init") gotInit();
          if (f.type === "turn_completed") completed();
        },
      },
    });
    const run = cli(["--non-interactive", "--control-connect", `ws://127.0.0.1:${server.port}/hote`], ws, { provider: new ScriptedProvider([{ text: "connecté" }]), env: { [`${PREFIX}CONTROL_TOKEN`]: TOKEN } });
    await initialized;
    expect(headers).toBe(`Bearer ${TOKEN}`);
    socket!.send(JSON.stringify({ type: "control_init", protocolVersion: "1.0", demands: [] }));
    socket!.send(JSON.stringify({ type: "user", content: "bonjour" }));
    await turn;
    socket!.send(JSON.stringify({ type: "control_request", id: "fin", request: "shutdown", params: {} }));
    const r = await run;
    server.stop(true);
    expect(r.code).toBe(0);
    expect(frames[0]!.type).toBe("control_init");
    expect(frames.find((f) => f.type === "turn_completed")!["result"]).toBe("connecté");
  });
});

describe("SPEC-MOD-007 keep-alive, sizes and buffer", () => {
  test("TECH — a silent connection is closed after the keep-alive delay; once the window expired the run stops (EF-07, FA-03)", async () => {
    const ws = workspace();
    const engine = await listeningEngine(ws, new ScriptedProvider([]), { userConfig: { remote: { transport: { keepAliveSeconds: 1, resumeWindowSeconds: 1 } } } });
    const h = new RemoteHost(engine.url);
    await h.waitFor((f) => f.type === "control_init");
    h.init();
    await h.waitFor((f) => f.type === "keepalive");
    expect(await h.closed).toBe(4001);
    const r = await engine.run;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("Fenêtre de reprise expirée : exécution arrêtée");
  });

  test("TECH — a message beyond the maximal size is rejected with a correlated error; the run goes on (FA-05, ERR-04)", async () => {
    const ws = workspace();
    const engine = await listeningEngine(ws, new ScriptedProvider([]), { userConfig: { remote: { transport: { maxFrameBytes: 1_024 } } } });
    const h = new RemoteHost(engine.url);
    await h.waitFor((f) => f.type === "control_init");
    h.init();
    h.send({ type: "control_request", id: "gros", request: "add_context", params: { text: "x".repeat(4_000) } });
    const refused = await h.waitFor((f) => f.type === "control_response" && f["id"] === "gros");
    expect(refused["error"]).toEqual({ code: "message_too_large", message: "Message trop volumineux." });
    expect((await h.request("get_state"))["ok"]).toBe(true);
    await h.request("shutdown");
    expect((await engine.run).code).toBe(0);
  });

  test("TECH — the replay buffer is bounded and emptied by the confirmations; a resumption from a lost number is refused (ENF-03, EF-05)", () => {
    const notices: string[] = [];
    const link = new FramedLink({ resumeWindowMs: 60_000, keepAliveMs: 60_000, maxFrameBytes: 1_000_000, maxBuffered: 3, notice: (t) => notices.push(t), trace: () => {} });
    const peer = (name: string) => {
      const sent: string[] = [];
      const p: WsPeer & { sent: string[]; closedWith?: number } = { sent, remoteAddress: name, send: (t) => sent.push(t), close: (c) => (p.closedWith = c) };
      return p;
    };
    const a = peer("a");
    link.open(a);
    link.sendLine('{"type":"control_init","protocolVersion":"1.0"}');
    for (let i = 0; i < 5; i++) link.sendLine(`{"type":"event","n":${i}}`);
    const token = (JSON.parse(a.sent[0]!) as Record<string, unknown>)["resumeToken"];
    link.receive(a, JSON.stringify({ type: "ack", seq: 5 }));
    link.closed(a);
    link.sendLine('{"type":"event","n":"pendant"}');
    const b = peer("b");
    link.open(b);
    link.receive(b, JSON.stringify({ type: "resume", resumeToken: token, lastSeq: 5 }));
    expect(b.sent.map((t) => (JSON.parse(t) as Record<string, unknown>)["seq"] ?? (JSON.parse(t) as Record<string, unknown>)["type"])).toEqual(["resumed", 6, 7]);
    // A number older than what is kept: refused, the link ends (nothing can be replayed without loss).
    const resumedToken = (JSON.parse(b.sent[0]!) as Record<string, unknown>)["resumeToken"];
    link.closed(b);
    for (let i = 0; i < 4; i++) link.sendLine(`{"type":"event","n":"x${i}"}`);
    const c = peer("c");
    link.open(c);
    link.receive(c, JSON.stringify({ type: "resume", resumeToken: resumedToken, lastSeq: 7 }));
    expect(c.closedWith).toBe(4410);
    expect(link.expired).toBe(true);
    expect(notices.some((n) => n.startsWith("Reprise impossible"))).toBe(true);
    link.close();
  });

  test("TECH — listening addresses, loopback and admitted origins (EF-08)", () => {
    expect(parseListenAddress("8443")).toEqual({ hostname: "127.0.0.1", port: 8443 });
    expect(parseListenAddress("[::1]:9000")).toEqual({ hostname: "::1", port: 9000 });
    expect(parseListenAddress("0.0.0.0:0")).toEqual({ hostname: "0.0.0.0", port: 0 });
    expect(typeof parseListenAddress("hote:99999")).toBe("string");
    expect(isLoopback("127.0.0.1") && isLoopback("::1") && isLoopback("localhost") && !isLoopback("0.0.0.0")).toBe(true);
    expect(originAllowed("127.0.0.1", null, [])).toBe(true);
    expect(originAllowed("203.0.113.5", null, [])).toBe(false);
    expect(originAllowed("::ffff:203.0.113.5", null, ["203.0.113.5"])).toBe(true);
    expect(originAllowed("127.0.0.1", "https://page.example.test", [])).toBe(false);
  });
});
