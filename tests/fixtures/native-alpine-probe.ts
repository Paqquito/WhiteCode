// Supports: SPEC-BLD-004/CA-01 (Alpine, HTTPS bootstrap, verified musl binary and launcher), gap E-235.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveIdentityText } from "../../src/identity/resolver";
import { Identity } from "../../src/identity/identity";
import { bootstrapScript } from "../../src/installation/bootstrap";
if (process.platform !== "linux" || Bun.version !== "1.4.2") throw Error("Native Linux Bun 1.4.2 required");
const repository = process.cwd(), base = process.env.WC_NATIVE_RESOURCES_DIR;
if (!base || !base.startsWith("/")) throw Error("Native resources directory required");
const assets = mkdtempSync(join(base, "alpine-proof-"));
const home = join(assets, "home"); mkdirSync(home, { mode: 0o700 });
mkdirSync(join(base, "alpine/home/test"), { recursive: true }); mkdirSync(join(base, "alpine/fixture"), { recursive: true });
async function command(argv: string[], env = process.env) {
  const child = Bun.spawn(argv, { cwd: assets, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(JSON.stringify({ argv, code, stdout, stderr })); return { stdout, stderr };
}
await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(assets, "test.key"), "-out", join(assets, "test.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"]);
const requests: string[] = []; let bytes = Buffer.alloc(0), digest = "";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: readFileSync(join(assets, "test.crt")), key: readFileSync(join(assets, "test.key")) }, fetch(request): Response {
  const path = new URL(request.url).pathname; requests.push(path);
  const artifact = { url: "/program", sha256: digest, size: bytes.length };
  if (path === "/v1/stable-linux-x64-musl.txt") return new Response(`0.2.0\n${digest}\n${bytes.length}\nhttps://127.0.0.1:${server.port}/program\n`);
  if (path === "/v1/0.2.0.json") return Response.json({ schemaVersion: 1, version: "0.2.0", artifacts: { "linux-x64-musl": artifact } });
  if (path === "/program") return new Response(bytes); return new Response("Unavailable", { status: 404 });
} });
try {
  const input = JSON.parse(readFileSync("identity/dev.identity.json", "utf8")); (input.services ??= {}).SERVICE_DOWNLOADS = `https://127.0.0.1:${server.port}`;
  const resolved = resolveIdentityText(JSON.stringify(input), { version: "0.2.0", strict: true }); if (!resolved.identity) throw Error(JSON.stringify(resolved.issues));
  const identity = new Identity(resolved.identity), entry = join(assets, "entry.ts"), binary = join(assets, "product-musl");
  writeFileSync(entry, `import {runCli} from ${JSON.stringify(join(repository, "src/headless/run.ts"))};
import {Identity} from ${JSON.stringify(join(repository, "src/identity/identity.ts"))};
import {ModelCatalog} from ${JSON.stringify(join(repository, "src/providers/catalog.ts"))};
import {MODEL_CATALOG_DATA} from ${JSON.stringify(join(repository, "src/identity/generated/build-data.ts"))};
import {processStreams} from ${JSON.stringify(join(repository, "src/platform/io.ts"))};
import {systemInfo} from ${JSON.stringify(join(repository, "src/platform/system.ts"))};
process.exit(await runCli(process.argv.slice(2),{streams:processStreams(),environment:process.env,cwd:process.cwd(),system:systemInfo(),identity:new Identity(${JSON.stringify(resolved.identity)}),catalog:new ModelCatalog(MODEL_CATALOG_DATA)}));`);
  await command([process.execPath, "build", entry, "--compile", "--target=bun-linux-x64-musl", "--outfile", binary]);
  bytes = readFileSync(binary); digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(assets, "install.sh"), bootstrapScript(identity, "sh"));
  const prefix = identity.get("ENV_PREFIX"), cli = identity.get("PRODUCT_CLI"), config = "/home/test/config";
  const args = [join(base, "bubblewrap/usr/bin/bwrap"), "--unshare-all", "--share-net", "--uid", "0", "--gid", "0", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", join(base, "alpine"), "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", home, "/home/test", "--ro-bind", assets, "/fixture", "--chdir", "/home/test", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/home/test", "--setenv", prefix + "CONFIG_HOME", config, "--setenv", prefix + "EXTRA_CA_CERTS", "/fixture/test.crt", "--"];
  const installed = await command([...args, "/bin/sh", "/fixture/install.sh"]);
  const version = await command([...args, config + "/installation/bin/" + cli, "--version"]);
  const status = await command([...args, config + "/installation/bin/" + cli, "installation", "show", "--json"]);
  console.log(JSON.stringify({ assets, requests, installed, version, status, artifactSHA256: digest }, null, 2));
} finally { server.stop(true); }
