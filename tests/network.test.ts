// Network of the product (SPEC-PER-022): the proxy of the outgoing connections and its exceptions, the extra
// authorities, the variables given to the child processes.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EnvironmentView } from "../src/config/environment";
import { networkFetch, proxyFor, safeHost } from "../src/platform/network";
import type { ModelRequest } from "../src/providers/types";
import { cli, workspace } from "./helpers/env";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
import { PREFIX } from "./helpers/remote";
import { ScriptedProvider } from "./helpers/scripted-provider";

const OPENSSL = Bun.which("openssl");
const results = (r: ModelRequest | undefined) => JSON.stringify([...(r?.history ?? [])].reverse().find((m) => m.role === "user") ?? null);

describe("SPEC-PER-022 proxy and authorities", () => {
  test("SPEC-PER-022/CA-01 — a proxy configured: the call to the model service goes through it", async () => {
    const service = startFakeOpenAI([{ text: "réponse par le mandataire" }]);
    const seen: string[] = [];
    // A plain forwarding proxy: the request comes with the absolute address of its destination.
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        seen.push(req.url);
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
        const upstream = await fetch(req.url, { method: req.method, headers: req.headers, body });
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
      },
    });
    try {
      const r = await cli(["--non-interactive", "bonjour"], workspace(), {
        userConfig: { api: { baseUrl: service.baseURL } },
        env: { HTTP_PROXY: `http://utilisateur:motdepasse@127.0.0.1:${proxy.port}` },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("réponse par le mandataire");
      expect(seen.some((u) => u.startsWith(service.baseURL))).toBe(true);
      expect(r.stderr).not.toContain("motdepasse"); // EF-03
    } finally {
      proxy.stop(true);
      service.stop();
    }
  });

  test.skipIf(!OPENSSL)("SPEC-PER-022/CA-02 — an internal authority added: the connection to an internal server is accepted", async () => {
    const ws = workspace();
    const cert = join(ws.root, "interne.pem");
    const key = join(ws.root, "interne.key");
    const made = Bun.spawnSync(
      [OPENSSL!, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 20_000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } },
    );
    expect(made.exitCode).toBe(0);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, fetch: () => new Response("contenu du serveur interne", { headers: { "content-type": "text/plain" } }) });
    try {
      const url = `https://localhost:${server.port}/page`;
      const fetchIt = () => new ScriptedProvider([{ toolCalls: [{ name: "fetch_url", input: { url, prompt: "lis" } }] }, { text: "fini" }]);
      const without = fetchIt();
      await cli(["--non-interactive", "--allow-rule", "fetch_url(domain:localhost)", "go"], ws, { provider: without });
      expect(results(without.requests[1])).toContain(`Certificat du serveur non reconnu : ajoutez l'autorité de votre entreprise (variable ${PREFIX}EXTRA_CA_CERTS).`);
      const withIt = fetchIt();
      await cli(["--non-interactive", "--allow-rule", "fetch_url(domain:localhost)", "go"], ws, { provider: withIt, env: { [`${PREFIX}EXTRA_CA_CERTS`]: cert } });
      expect(results(withIt.requests[1])).toContain("contenu du serveur interne");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("TECH — the exceptions of the proxy, the hidden credentials, the variables of the children, an unreachable proxy (§ 5.3 steps 1 and 4, EF-03, ERR-02)", async () => {
    const s = { httpProxy: "http://p:3128", httpsProxy: "http://u:secret@ps:3129", noProxy: ["localhost", ".interne.example", "api.example:8443"], caHint: "x" };
    expect(proxyFor(new URL("https://service.example/v1"), s)).toBe("http://u:secret@ps:3129");
    expect(proxyFor(new URL("http://service.example/"), s)).toBe("http://p:3128");
    expect(proxyFor(new URL("http://localhost:9/"), s)).toBeUndefined();
    expect(proxyFor(new URL("https://git.interne.example/"), s)).toBeUndefined();
    expect(proxyFor(new URL("https://api.example:8443/"), s)).toBeUndefined();
    expect(proxyFor(new URL("https://api.example/"), s)).toBe("http://u:secret@ps:3129");
    expect(proxyFor(new URL("https://x.example/"), { ...s, noProxy: ["*"] })).toBeUndefined();
    expect(safeHost("http://u:secret@ps:3129")).toBe("ps:3129");
    const view = new EnvironmentView(PREFIX, { [`${PREFIX}EXTRA_CA_CERTS`]: "/ca/interne.pem", HTTPS_PROXY: "http://ps:3129" });
    expect(view.childEnvironment()).toMatchObject({ NODE_EXTRA_CA_CERTS: "/ca/interne.pem", HTTPS_PROXY: "http://ps:3129" });
    const unreachable = networkFetch({ httpProxy: "http://u:secret@127.0.0.1:9", noProxy: [], caHint: "x" });
    const error = await unreachable("http://localhost:1/").then(() => undefined, (e: Error) => e);
    expect(error?.message).toBe("Mandataire injoignable : 127.0.0.1:9.");
  });
});
