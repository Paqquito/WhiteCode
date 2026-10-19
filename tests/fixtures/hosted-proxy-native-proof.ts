// Supports: SPEC-PER-023 (actual authenticated upstream, curl TLS trust, kernel same-UID memory checks and no routing fallback).
import { dlopen } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { HostedProxy } from "../../src/platform/hosted-proxy";
import { CommandSandbox } from "../../src/platform/sandbox";
import { ShellRuntime } from "../../src/tools/shell-runtime";
import { ToolRegistry } from "../../src/tools/registry";
import { ResponseExecution } from "../../src/engine/executor";
import { NEUTRAL_HOOKS } from "../../src/extension-points/hooks";
import { NO_PROTECTED_LOCATIONS } from "../../src/permissions/paths";
import type { ToolSettings } from "../../src/tools/types";
import { startChild } from "../../src/platform/process";
const root = process.argv[3]!;
if (!/^\/var\/tmp\/whitecode-native-tests-1mstsgkw\/per023-proof-[a-zA-Z0-9_-]+$/.test(root) || JSON.parse(readFileSync(join(root, "ownership.json"), "utf8")).purpose !== "upstream-relay-native-proof") throw Error("Unowned proxy fixture.");
const project = join(root, "project"), control = join(root, "control"), runtime = join(root, "runtime");
mkdirSync(project); mkdirSync(control, { mode: 0o700 }); chmodSync(root, 0o711); writeFileSync(runtime, readFileSync(process.argv[2]!), { mode: 0o555 });
const token = randomBytes(40).toString("base64url"), tokenFile = join(control, "session.token"), ca = join(control, "ca.pem"), caKey = join(control, "ca.key"), cert = join(control, "server.pem"), key = join(control, "server.key");
writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
const openssl = (...args: string[]) => { const result = Bun.spawnSync(["/usr/bin/openssl", ...args], { cwd: control, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw Error("Fixture certificate generation failed."); };
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "1", "-subj", "/CN=Proxy fixture authority", "-addext", "basicConstraints=critical,CA:TRUE"); chmodSync(ca, 0o600);
openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", join(control, "server.csr"), "-subj", "/CN=download.fixture");
writeFileSync(join(control, "extensions"), "subjectAltName=DNS:download.fixture,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
openssl("x509", "-req", "-in", join(control, "server.csr"), "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", join(control, "extensions"));
const facts: Record<string, unknown> = { root };
const diagnostic = () => { const api = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" }, getpid: { args: [], returns: "i32" } }); try { return { pid: process.pid, nativePid: api.symbols.getpid(), dumpable: api.symbols.prctl(3, 0, 0, 0, 0), status: readFileSync("/proc/self/status", "utf8").split("\n").filter(line => /^(Uid|CapEff|CapPrm|CapBnd|NoNewPrivs):/.test(line)) }; } finally { api.close(); } };
facts.beforeProtection = diagnostic();
const libc = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" }, malloc: { args: ["u64"], returns: "ptr" }, memset: { args: ["ptr", "i32", "u64"], returns: "ptr" } });
const publicAddress = libc.symbols.malloc(32); if (!publicAddress) throw Error("Native public probe unavailable."); libc.symbols.memset(publicAddress, 80, 32);
if (libc.symbols.prctl(0x59616d61, 0xffffffffffffffffn, 0, 0, 0) !== 0) throw Error("Cannot establish same-UID positive control."); libc.close();
const inspection = `import os,json,ctypes\npid=${process.pid}\naddress=${publicAddress}\nresult={'uid':os.getuid(),'ptraceCap':bool(int(open('/proc/self/status').read().split('CapEff:')[1].split()[0],16)&(1<<19))}\nfor name in ['mem','environ','fd']:\n try:\n  p='/proc/'+str(pid)+'/'+name\n  if name=='fd': os.readlink(p+'/0')\n  else:\n   with open(p,'rb',buffering=0) as f:\n    if name=='mem': f.seek(address); result[name]=len(f.read(1))==1; continue\n    else: result[name]=len(f.read(1))==1; continue\n  result[name]=True\n except OSError as e: result[name]=False; result[name+'_errno']=e.errno\nclass IO(ctypes.Structure): _fields_=[('base',ctypes.c_void_p),('size',ctypes.c_size_t)]\nb=ctypes.create_string_buffer(1);local=IO(ctypes.addressof(b),1);remote=IO(address,1)\napi=ctypes.CDLL(None,use_errno=True);result['vm']=api.process_vm_readv(pid,ctypes.byref(local),1,ctypes.byref(remote),1,0)==1;result['vm_errno']=ctypes.get_errno()\nprint(json.dumps(result))\n`;
const inspect = async () => { const child = Bun.spawn(["/usr/bin/python3", "-c", inspection], { stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code !== 0) throw Error("Kernel inspection fixture failed: " + err); return JSON.parse(out); };
facts.memoryBefore = await inspect();
let downloads = 0, connections = 0, tunnels = 0, authenticated = true, fileAtCa = false, fileAtReady = false, rejectReady = false, replaceToken: string | undefined;
const sessions = new Set<import("node:http2").ServerHttp2Session>(), peers = new Set<import("node:net").Socket>();
const payload = "NATIVE_DOWNLOAD_THROUGH_AUTHENTICATED_RELAY\n";
const target = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => { downloads++; response.writeHead(200).end(payload); });
await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve)); const address = target.address(); if (!address || typeof address === "string") throw Error("Fixture target unavailable.");
let releaseReady!: () => void, observedReady!: () => void;
const gate = new Promise<void>(resolve => { releaseReady = resolve; }), reached = new Promise<void>(resolve => { observedReady = resolve; });
const upstream = createSecureServer({ key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: false });
upstream.on("session", session => { connections++; sessions.add(session); session.on("error", () => {}); session.once("close", () => sessions.delete(session)); });
upstream.on("stream", (raw, headers) => {
  const stream = raw as import("node:http2").ServerHttp2Stream;
  stream.on("error", () => {});
  const accepted = headers.authorization === "Bearer " + token; authenticated &&= accepted;
  if (!accepted) { stream.respond({ ":status": 403 }); stream.end(); return; }
  if (headers[":method"] === "CONNECT") {
    tunnels++;
    if (headers[":authority"] !== "download.fixture:443") { stream.respond({ ":status": 403 }); stream.end(); return; }
    const socket = connect({ host: "127.0.0.1", port: address.port }); peers.add(socket); socket.on("error", () => stream.destroy()); stream.once("close", () => socket.destroy()); socket.once("close", () => peers.delete(socket));
    socket.once("connect", () => { stream.respond({ ":status": 200 }); socket.pipe(stream); stream.pipe(socket); }); return;
  }
  if (headers[":path"] === "/session-relay/ca.pem") { fileAtCa = existsSync(tokenFile); stream.respond({ ":status": 200, "x-session-relay": "1" }); stream.end(readFileSync(ca)); return; }
  if (headers[":path"] === "/session-relay/ready") { fileAtReady = existsSync(tokenFile); observedReady(); void gate.then(() => { if (!stream.destroyed) { if (replaceToken) { writeFileSync(replaceToken + ".next", randomBytes(40).toString("base64url"), { mode: 0o600 }); renameSync(replaceToken + ".next", replaceToken); } stream.respond({ ":status": rejectReady ? 503 : 200, "x-session-relay": "1" }); stream.end("ready\n"); } }); return; }
  stream.respond({ ":status": 404 }); stream.end();
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); const endpoint = upstream.address(); if (!endpoint || typeof endpoint === "string") throw Error("Fixture upstream unavailable.");
let relay: HostedProxy | undefined;
try {
  const config = { protocol: "h2-connect-v1" as const, url: `https://127.0.0.1:${endpoint.port}/`, tokenFile, bootstrapCaFile: ca }, started = Date.now();
  process.umask(0o077);
  const opening = HostedProxy.start(config, { runtime, trustParent: root, signal: new AbortController().signal });
  await Promise.race([reached, opening.then(() => { throw Error("Relay started before readiness gate."); }), Bun.sleep(2500).then(() => { throw Error("Readiness not reached."); })]);
  facts.tokenRetainedUntilReady = existsSync(tokenFile); releaseReady(); relay = await opening;
  facts.startupMs = Date.now() - started; facts.ca01 = !existsSync(tokenFile) && fileAtCa && fileAtReady && relay.endpoint.startsWith("http://127.0.0.1:");
  const malformedCapability = async (method: "GET" | "CONNECT") => {
    const endpoint = new URL(relay!.endpoint);
    return new Promise<number>((resolve, reject) => {
      const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) }); let response = "";
      const timer = setTimeout(() => { socket.destroy(); reject(Error("Malformed relay capability was not refused.")); }, 2000);
      const finish = () => { clearTimeout(timer); resolve(Number(/^HTTP\/1\.1 (\d{3}) /.exec(response)?.[1])); };
      socket.on("data", bytes => { response += bytes.toString("latin1"); }); socket.once("close", finish);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => socket.write(Buffer.from(`${method} ${method === "GET" ? "/_ready" : "download.fixture:443"} HTTP/1.1\r\nHost: localhost\r\nx-relay-capability: ${"\xe9".repeat(43)}\r\nConnection: close\r\n\r\n`, "latin1")));
    });
  };
  facts.nonAsciiCapabilityResponses = [await malformedCapability("GET"), await malformedCapability("CONNECT")];
  facts.nonAsciiCapabilityRejected = (facts.nonAsciiCapabilityResponses as number[]).every(status => status === 503) && relay.metrics.ready && !relay.failure.aborted && tunnels === 0;
  facts.afterProtection = diagnostic();
  facts.memoryAfter = await inspect(); facts.sameUid = (facts.memoryBefore as any).uid === (facts.memoryAfter as any).uid && (facts.memoryAfter as any).uid === process.getuid?.();
  class RelayedSandbox extends CommandSandbox {
    constructor() { super(() => ({ enabled: true, autoAllow: true, allowOutside: false, excludedCommands: [], files: { writable: [project], hidden: [], readDenied: () => false, writeDenied: () => false }, network: { authorize: async () => false, allowsPrivate: () => false, violation: () => {} } }), runtime); }
    override launch(input: Parameters<HostedProxy["launch"]>[0]) { return relay!.launch(input); }
  }
  let prompts = 0;
  const shell = new ShellRuntime({ sandbox: new RelayedSandbox(), platform: "linux", projectCwd: project, allowedDirectories: [project], childEnv: { PATH: "/usr/bin:/bin", LANG: "C", HOME: project }, forcedVariables: {}, excluded: () => true, posix: { name: "sh", path: "/bin/sh" }, workDir: join(root, "shell"), settings: { defaultTimeoutMs: 10000, maxTimeoutMs: 10000, outputLimit: 20000, graceMs: 100, powershellLoadProfile: false } });
  const registry = ToolRegistry.build({ platform: "linux", home: project, shells: { posix: { path: "/bin/sh", name: "sh" } } }, { toolset: ["run_shell"] });
  const execute = async (command: string) => {
    const execution = new ResponseExecution({ registry, hooks: NEUTRAL_HOOKS, authorities: { human: { request: async () => { prompts++; return { answer: "yes" }; } } }, permissionContext: () => ({ mode: "ask", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: project, home: project, platform: "linux" }), toolContext: signal => ({ cwd: project, home: project, platform: "linux", allowedDirectories: [project], signal, shell, settings: {} as ToolSettings, readState: new Map(), protectedLocations: NO_PROTECTED_LOCATIONS, readDenied: () => false, modelImages: false }), emit: () => {}, concurrency: 1, toolTimeoutMs: 12000 }, new AbortController().signal);
    execution.submit({ callId: crypto.randomUUID(), name: "run_shell", input: { command } }); execution.responseComplete("tool_use"); return (await execution.results())[0]!;
  };
  const download = await execute("curl --fail --silent --show-error --output payload https://download.fixture/blob");
  facts.downloadResult = download;
  facts.ca02 = !download.isError && existsSync(join(project, "payload")) && readFileSync(join(project, "payload"), "utf8") === payload && downloads === 1 && tunnels === 1;
  const repeated = await execute("curl --fail --silent --show-error --output second https://download.fixture/blob");
  facts.persistent = !repeated.isError && connections === 1 && downloads === 2 && tunnels === 2;
  facts.relayUsableAfterInvalidCapability = facts.nonAsciiCapabilityRejected === true && facts.ca02 === true && facts.persistent === true;
  const untrusted = await execute("env -u SSL_CERT_FILE -u CURL_CA_BUNDLE -u REQUESTS_CA_BUNDLE -u NODE_EXTRA_CA_CERTS -u GIT_SSL_CAINFO -u npm_config_cafile curl --fail --silent --show-error --output untrusted https://download.fixture/blob");
  facts.tlsVerified = !existsSync(join(project, "untrusted")) && JSON.stringify(untrusted.content).includes("certificate") && downloads === 2;
  const direct = await execute(`python3 -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect(("127.0.0.1",${address.port})); print("DIRECT_ESCAPE")'; python3 -c 'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b"probe",("8.8.8.8",53))'`);
  facts.noDirect = downloads === 2 && !JSON.stringify(direct.content).includes("DIRECT_ESCAPE") && JSON.stringify(direct.content).includes("Network is unreachable");
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  writeFileSync(tokenFile, randomBytes(40).toString("base64url"), { mode: 0o600 });
  const state = await execute(`python3 -c 'import os,hashlib; print("TOKEN_FILE_VISIBLE" if os.path.exists("${tokenFile}") else "TOKEN_FILE_ABSENT"); print("AUTH_ENV_PRESENT" if any(hashlib.sha256(v.encode()).hexdigest()=="${tokenDigest}" for v in os.environ.values()) else "AUTH_ENV_ABSENT")'`);
  facts.childTokenAbsent = JSON.stringify(state.content).includes("TOKEN_FILE_ABSENT") && JSON.stringify(state.content).includes("AUTH_ENV_ABSENT");
  const uidProject = join(root, "uid-project"); mkdirSync(uidProject, { mode: 0o700 }); chownSync(uidProject, 65534, 65534);
  const uidLaunch = relay.launch({ command: "native distinct identity download", file: "/bin/sh", args: ["-c", "id -u > uid; curl --fail --silent --show-error --output payload https://download.fixture/blob"], cwd: uidProject, allowed: [uidProject], environment: { PATH: "/usr/bin:/bin", HOME: uidProject, LANG: "C" } });
  try {
    let output = "";
    const child = startChild("/usr/bin/setpriv", ["--reuid=65534", "--regid=65534", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", uidLaunch.file, ...uidLaunch.args], { cwd: uidProject, env: uidLaunch.environment, extraFds: uidLaunch.fds, onData: bytes => { output += bytes.toString(); } }); uidLaunch.spawned();
    const timeout = setTimeout(() => { void child.killTree(100); }, 8000); const code = await child.exited; clearTimeout(timeout);
    facts.distinctUid = code === 0 && readFileSync(join(uidProject, "uid"), "utf8").trim() === "65534" && readFileSync(join(uidProject, "payload"), "utf8") === payload;
    if (!facts.distinctUid) facts.uidDiagnostic = output;
  } finally { uidLaunch.close(); }
  facts.authenticated = authenticated; facts.prompts = prompts; facts.upstreamConnections = connections; facts.tunnels = tunnels;
  facts.bytes = relay.metrics.bytes;
  for (const session of sessions) session.destroy();
  const deadline = Date.now() + 1000; while (!relay.failure.aborted && Date.now() < deadline) await Bun.sleep(10);
  const refused = await execute("curl --fail --silent --show-error --output after-failure https://download.fixture/blob");
  facts.closedFailure = relay.failure.aborted && refused.isError && !existsSync(join(project, "after-failure"));
  facts.replenishedTokenKept = existsSync(tokenFile);
  const failedToken = join(control, "failed.token"); writeFileSync(failedToken, token, { mode: 0o600 }); rejectReady = true;
  try { const unexpected = await HostedProxy.start({ ...config, tokenFile: failedToken }, { runtime, trustParent: root, signal: new AbortController().signal }); unexpected.close(); facts.failedStartupKeepsToken = false; }
  catch { facts.failedStartupKeepsToken = existsSync(failedToken); }
  rejectReady = false;
  const replacedToken = join(control, "replaced.token"); writeFileSync(replacedToken, token, { mode: 0o600 }); replaceToken = replacedToken;
  try { const unexpected = await HostedProxy.start({ ...config, tokenFile: replacedToken }, { runtime, trustParent: root, signal: new AbortController().signal }); unexpected.close(); facts.replacementKept = false; }
  catch { facts.replacementKept = existsSync(replacedToken) && readFileSync(replacedToken, "utf8") !== token; }
  replaceToken = undefined;
  const untrustedToken = join(control, "untrusted.token"); writeFileSync(untrustedToken, token, { mode: 0o600 });
  try { const unexpected = await HostedProxy.start({ protocol: config.protocol, url: config.url, tokenFile: untrustedToken }, { runtime, trustParent: root, signal: new AbortController().signal }); unexpected.close(); facts.bootstrapTlsRequired = false; }
  catch { facts.bootstrapTlsRequired = existsSync(untrustedToken); }
  const rejectedToken = join(control, "rejected.token"); writeFileSync(rejectedToken, randomBytes(40).toString("base64url"), { mode: 0o600 });
  try { const unexpected = await HostedProxy.start({ ...config, tokenFile: rejectedToken }, { runtime, trustParent: root, signal: new AbortController().signal }); unexpected.close(); facts.authenticationRequired = false; }
  catch { facts.authenticationRequired = existsSync(rejectedToken); }
  facts.payloadSha256 = createHash("sha256").update(payload).digest("hex");
} finally {
  relay?.close(); for (const session of sessions) session.destroy(); for (const socket of peers) socket.destroy();
  await new Promise<void>(resolve => upstream.close(() => resolve())); await new Promise<void>(resolve => target.close(() => resolve()));
}
console.log(JSON.stringify(facts));
