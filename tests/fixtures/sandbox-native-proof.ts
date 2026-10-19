// Supports: SPEC-PER-015 (real Linux kernel file, namespace and syscall guards in an owned native test directory).
import { mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandboxLaunch } from "../../src/platform/sandbox-kernel";
import { startChild } from "../../src/platform/process";
import { CommandSandbox } from "../../src/platform/sandbox";
import { ShellRuntime } from "../../src/tools/shell-runtime";
import { ToolRegistry } from "../../src/tools/registry";
import { ResponseExecution } from "../../src/engine/executor";
import { NEUTRAL_HOOKS } from "../../src/extension-points/hooks";
import { NO_PROTECTED_LOCATIONS } from "../../src/permissions/paths";
import type { ToolSettings } from "../../src/tools/types";
const root = process.argv[3]!;
if (!/^\/var\/tmp\/whitecode-native-tests-1mstsgkw\/sandbox-proof-[a-zA-Z0-9_-]+$/.test(root) || JSON.parse(readFileSync(join(root, "ownership.json"), "utf8")).purpose !== "sandbox-native-proof") throw Error("Unowned native fixture.");
const project = join(root, "project"), outside = join(root, "outside");
mkdirSync(project); mkdirSync(outside);
writeFileSync(join(outside, "secret"), "PRIVATE_FIXTURE"); writeFileSync(join(project, "hidden"), "HIDDEN_FIXTURE");
linkSync(join(outside, "secret"), join(project, "hardlink")); symlinkSync(join(outside, "secret"), join(project, "symlink"));
let output = "", facts: Record<string, unknown> = {};
const launch = sandboxLaunch({ cwd: project, file: "/bin/sh", args: ["-c", "printf OK > inside; printf BAD > /etc/sandbox-forbidden; cat hidden; cat hardlink; printf BAD > hardlink; cat symlink; printf DONE"], environment: { PATH: "/usr/bin:/bin", LANG: "C" }, files: { writable: [project], hidden: [join(project, "hidden")], readDenied: () => false, writeDenied: () => false } });
try {
  const child = startChild(launch.file, launch.args, { cwd: project, env: launch.environment, extraFds: launch.fds, onData: bytes => { output += bytes.toString(); } }); launch.spawned();
  await child.exited;
  facts = { root, output, inside: existsSync(join(project, "inside")) && readFileSync(join(project, "inside"), "utf8") === "OK", outsideUnchanged: readFileSync(join(outside, "secret"), "utf8") === "PRIVATE_FIXTURE", noSecret: !output.includes("FIXTURE"), outsideDenied: /Read-only file system|Permission denied|cannot create/.test(output), completed: output.includes("DONE") };
} finally { launch.close(); }
mkdirSync(join(project, "locked"));
const absent = sandboxLaunch({ cwd: project, file: "/bin/sh", args: ["-c", "printf OK > unrestricted; printf BAD > locked/future"], environment: { PATH: "/usr/bin:/bin", LANG: "C" }, files: { writable: [project], hidden: [], readonly: [join(project, "locked", "future")], readDenied: () => false, writeDenied: () => false } });
try {
  let diagnostics = "";
  const child = startChild(absent.file, absent.args, { cwd: project, env: absent.environment, extraFds: absent.fds, onData: bytes => { diagnostics += bytes.toString(); } }); absent.spawned(); await child.exited;
  facts.absentDenied = !existsSync(join(project, "locked", "future")) && readFileSync(join(project, "unrestricted"), "utf8") === "OK" && /Read-only|Permission denied/.test(diagnostics);
} finally { absent.close(); }
if (process.argv[2]) {
  const runtime = join(root, "runtime"); writeFileSync(runtime, readFileSync(process.argv[2]), { mode: 0o555 });
  const key = join(outside, "key.pem"), cert = join(project, "certificate.pem");
  const generated = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=allowed.test", "-addext", "subjectAltName=DNS:allowed.test"]);
  if (generated.exitCode !== 0) throw Error("Fixture certificate unavailable.");
  const secure = Bun.serve({ hostname: "127.0.0.1", port: 443, tls: { key: readFileSync(key), cert: readFileSync(cert) }, fetch: () => new Response("TLS_ALLOWED_REPLY") });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ALLOWED_REPLY") }), violations: string[] = [];
  const sandbox = new CommandSandbox(() => ({ enabled: true, autoAllow: true, allowOutside: false, excludedCommands: [], files: { writable: [project], hidden: [join(project, "hidden")], readDenied: () => false, writeDenied: () => false }, network: {
    authorize: async url => new URL(url).hostname === "allowed.test", allowsPrivate: host => host === "allowed.test", resolve: async () => [{ address: "127.0.0.1", family: 4 }], violation: message => { violations.push(message); },
  } }), runtime);
  const python = `import urllib.request,urllib.parse,socket,ssl,os,stat\nfor host in ['allowed.test','denied.test']:\n try: print(host,urllib.request.urlopen('http://'+host+':${server.port}/',timeout=4).read().decode())\n except Exception: print(host,'REFUSED')\ncontext=ssl.create_default_context(cafile='certificate.pem')\ntry: print(urllib.request.urlopen('https://allowed.test/',context=context,timeout=4).read().decode())\nexcept Exception as e: print('TLS_FAILED',str(e))\np=urllib.parse.urlparse(os.environ['HTTPS_PROXY'])\ntry:\n s=socket.create_connection((p.hostname,p.port),timeout=3);s.sendall(b'CONNECT allowed.test:443 HTTP/1.1\\r\\nHost: allowed.test:443\\r\\n\\r\\n');s.recv(4096);context.wrap_socket(s,server_hostname='denied.test');print('SNI_ESCAPE')\nexcept Exception: print('SNI_BLOCKED')\nfor kind,addr in [(socket.AF_INET,('127.0.0.1',${server.port})),(socket.AF_INET,('8.8.8.8',53)),(socket.AF_INET6,('::1',443))]:\n try:\n  s=socket.socket(kind);s.settimeout(1);s.connect(addr);print('DIRECT_ESCAPE')\n except OSError: print('DIRECT_BLOCKED')\ntry:\n s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.sendto(b'DNS_FIXTURE',('8.8.8.8',53));print('DNS_ESCAPE')\nexcept OSError: print('DNS_BLOCKED')\ntry: socket.socket(socket.AF_UNIX);print('UNIX_ESCAPE')\nexcept OSError: print('UNIX_BLOCKED')\ntry: socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);print('PAIR_ESCAPE')\nexcept OSError: print('PAIR_BLOCKED')\nfor fd in range(3,64):\n try:\n  if stat.S_ISDIR(os.fstat(fd).st_mode): print('FD_ESCAPE')\n except OSError: pass\nprint('FD_CHECKED')\n`;
  const command = "python3 -c '" + python.replace(/'/g, "'\\''") + "'", wrapped = sandbox.launch({ command, file: "/bin/sh", args: ["-c", command], cwd: project, allowed: [project], environment: { PATH: "/usr/bin:/bin", LANG: "C" } });
  let networkOutput = "";
  try {
    const child = startChild(wrapped.file, wrapped.args, { cwd: project, env: wrapped.environment, extraFds: wrapped.fds, onData: bytes => { networkOutput += bytes.toString(); } }); wrapped.spawned();
    const timer = setTimeout(() => { void child.killTree(100); }, 15000); facts.networkCode = await child.exited; clearTimeout(timer);
    facts.networkOutput = networkOutput; facts.networkViolations = violations; facts.networkAllowed = networkOutput.includes("allowed.test ALLOWED_REPLY"); facts.networkDenied = networkOutput.includes("denied.test REFUSED") && violations.some(value => value.includes("denied.test")); facts.noDirectEscape = !networkOutput.includes("DIRECT_ESCAPE") && networkOutput.includes("DIRECT_BLOCKED"); facts.unixBlocked = networkOutput.includes("UNIX_BLOCKED") && !networkOutput.includes("UNIX_ESCAPE");
    facts.tlsAllowed = networkOutput.includes("TLS_ALLOWED_REPLY"); facts.sniBlocked = networkOutput.includes("SNI_BLOCKED") && !networkOutput.includes("SNI_ESCAPE") && violations.some(value => value.includes("TLS domain differs"));
    facts.dnsBlocked = networkOutput.includes("DNS_BLOCKED") && !networkOutput.includes("DNS_ESCAPE"); facts.pairBlocked = networkOutput.includes("PAIR_BLOCKED") && !networkOutput.includes("PAIR_ESCAPE"); facts.noDirectoryFd = networkOutput.includes("FD_CHECKED") && !networkOutput.includes("FD_ESCAPE");
  } finally { wrapped.close(); await server.stop(true); await secure.stop(true); }
  let prompts = 0, allowOutside = true;
  const warnings: string[] = [], shell = new ShellRuntime({ sandbox: new CommandSandbox(() => ({ ...sandbox.profile(project, [project]), allowOutside }), runtime), platform: "linux", projectCwd: project, allowedDirectories: [project], childEnv: { PATH: "/usr/bin:/bin", LANG: "C" }, forcedVariables: {}, excluded: () => true, posix: { name: "sh", path: "/bin/sh" }, workDir: join(root, "session"), settings: { defaultTimeoutMs: 10000, maxTimeoutMs: 10000, outputLimit: 24000, graceMs: 100, powershellLoadProfile: false }, warn: message => warnings.push(message) });
  const registry = ToolRegistry.build({ platform: "linux", home: root, shells: { posix: { name: "sh", path: "/bin/sh" } } }, { toolset: ["run_shell"] });
  const execute = async (command: string, unsandboxed = false) => {
    const execution = new ResponseExecution({ registry, hooks: NEUTRAL_HOOKS, authorities: { human: { request: async () => { prompts++; return { answer: "yes" }; } } }, permissionContext: () => ({ mode: "ask", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: project, home: root, platform: "linux" }), toolContext: signal => ({ cwd: project, home: root, platform: "linux", allowedDirectories: [project], signal, shell, settings: {} as ToolSettings, readState: new Map(), protectedLocations: NO_PROTECTED_LOCATIONS, readDenied: () => false, modelImages: false }), emit: () => {}, concurrency: 1, toolTimeoutMs: 15000 }, new AbortController().signal);
    execution.submit({ callId: "fixture-" + crypto.randomUUID(), name: "run_shell", input: { command, unsandboxed } }); execution.responseComplete("tool_use");
    return (await execution.results())[0]!;
  };
  const confined = await execute("printf CONFINED > ca02; printf BAD > /etc/sandbox-forbidden");
  const model = confined.content.map(part => part.type === "text" ? part.text : "").join("");
  facts.ca01 = confined.isError && model.includes("Sandbox filesystem or system access denied") && warnings.length > 0;
  facts.ca02 = prompts === 0 && readFileSync(join(project, "ca02"), "utf8") === "CONFINED" && model.includes("Confined command");
  const escaped = await execute("printf ORDINARY > ca03", true);
  facts.ca03 = prompts === 1 && !escaped.isError && readFileSync(join(project, "ca03"), "utf8") === "ORDINARY";
  allowOutside = false;
  const veto = await execute("printf FORBIDDEN > veto", true);
  facts.managedVeto = veto.isError && prompts === 1 && !existsSync(join(project, "veto"));
  const samples: number[] = [];
  for (let count = 0; count < 3; count++) { const result = await shell.runPosix(":", 5000, new AbortController().signal); samples.push(result.durationMs); }
  facts.startupMs = samples;
  writeFileSync(join(project, "detached.py"), "import os,time\nif os.fork(): os._exit(0)\nos.setsid()\nwhile True:\n open('heartbeat','w').write(str(time.time_ns()))\n time.sleep(.03)\n");
  const cancellation = new AbortController(), pending = shell.runPosix("python3 detached.py; sleep 20", 5000, cancellation.signal);
  const readyBy = Date.now() + 2000;
  while (!existsSync(join(project, "heartbeat")) && Date.now() < readyBy) await Bun.sleep(10);
  cancellation.abort(); const cancelled = await pending;
  const last = existsSync(join(project, "heartbeat")) ? readFileSync(join(project, "heartbeat"), "utf8") : undefined;
  await Bun.sleep(150);
  facts.cancelledTree = cancelled.interrupted && last !== undefined && last === readFileSync(join(project, "heartbeat"), "utf8");
}
console.log(JSON.stringify(facts));
