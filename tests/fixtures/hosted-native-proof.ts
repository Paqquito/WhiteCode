// Supports: SPEC-API-029, SPEC-PLA-002 (real Linux kernel identities and actual product worker).
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { startHostedServiceFile, hostedWorkerFile } from "../../src/hosted/runtime";
import { Identity } from "../../src/identity/identity";
import { RESOLVED_IDENTITY } from "../../src/identity/generated/build-data";
const [mode, argument] = process.argv.slice(2);
const privateWrite = (path: string, value: string, uid = 0) => { writeFileSync(path, value, { mode: 0o600 }); chownSync(path, uid, uid); };
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", TERM: "xterm" };
const json = (value: unknown) => JSON.stringify(value);
const run = async (argv: string[], environment: Record<string, string> = env) => {
  const child = Bun.spawn(argv, { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Error(json({ argv: argv.slice(0, 3), code, out, err })); return out.trim();
};
if (mode === "broker") {
  const clock = process.argv[4]!;
  const server = await startHostedServiceFile(argument!, { now: () => Number(readFileSync(clock, "utf8")) });
  console.log(json({ ready: server.url, uid: process.getuid!() }));
  const end = () => { void server.close().then(() => process.exit(0)); }; process.on("SIGTERM", end); process.on("SIGINT", end);
  await new Promise(() => {});
} else if (mode === "worker" || mode === "worker-unconfirmed") {
  const shutdown = new AbortController(); process.on("SIGTERM", () => shutdown.abort()); process.on("SIGINT", () => shutdown.abort());
  const worker = hostedWorkerFile(argument!, Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))), signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(30000)]);
  if (mode === "worker-unconfirmed") {
    let failed = false, refused = false;
    try { await worker.poll(signal); } catch { failed = true; }
    try { await worker.poll(signal); } catch (error) { refused = (error as Error).message.includes("Arrêt de session non confirmé"); }
    console.log(json({ worked: true, unconfirmedClosed: failed && refused }));
  } else { await worker.poll(signal); console.log(json({ worked: true, uid: process.getuid!() })); }
} else if (mode === "client") {
  const value = JSON.parse(readFileSync(argument!, "utf8"));
  const response = await fetch(value.url, { method: "POST", headers: { authorization: "Bearer " + value.token, "content-type": "application/json" }, body: json(value.body) });
  const result = await response.text(); if (!response.ok) throw Error(result); console.log(result);
} else if (mode === "harness") {
  if (process.getuid?.() !== 0 || !/^\/var\/tmp\/hosted-proof-[a-zA-Z0-9]{6}$/.test(argument ?? "")) throw Error("Owned native proof root required");
  const root = argument!, brokerUid = 65534, prefix = new Identity(RESOLVED_IDENTITY).get("ENV_PREFIX"), token = "fixture-account-" + "a".repeat(40), adminToken = "fixture-admin-" + "b".repeat(40), workerToken = "fixture-worker-" + "c".repeat(40), personal = "fixture-personal-" + "d".repeat(40), organization = "fixture-organization-" + "e".repeat(40);
  privateWrite(join(root, "ownership.json"), json({ purpose: "hosted-native-proof", pid: process.pid }));
  for (const name of ["broker", "worker-control", "public", "repository", "previous"]) mkdirSync(join(root, name), { mode: 0o700 });
  chmodSync(join(root, "public"), 0o755); chmodSync(join(root, "repository"), 0o755);
  chownSync(join(root, "broker"), brokerUid, brokerUid); chownSync(join(root, "previous"), 65535, 65535);
  privateWrite(join(root, "previous", "config.json"), "OTHER_SESSION_PRIVATE", 65535);
  const clock = join(root, "public", "clock"), targets = join(root, "public", "targets.json");
  writeFileSync(clock, String(Date.UTC(2026, 9, 19, 8, 59)), { mode: 0o644 });
  const inspection = `import os,json,errno\ntargets=json.load(open(${json(targets)}))\nrefusals={}\nfor name,path in targets.items():\n try:\n  with open(path,'rb') as f: f.read(256)\n  refusals[name]=False\n except OSError as e: refusals[name]=e.errno in [errno.EACCES,errno.EPERM]\nstatus=dict(line.strip().split(':',1) for line in open('/proc/self/status') if ':' in line)\nfiles={}\nfor name in os.listdir(os.path.join(os.environ['HOME'],'config')):\n p=os.path.join(os.environ['HOME'],'config',name)\n if os.path.isfile(p): files[name]=open(p).read()\nprint('INSPECTION_COMPLETE '+json.dumps(dict(uid=os.getuid(),gid=os.getgid(),groups=os.getgroups(),noNewPrivs=status['NoNewPrivs'].strip(),caps=status['CapEff'].strip(),ambient=status['CapAmb'].strip(),permitted=status['CapPrm'].strip(),inheritable=status['CapInh'].strip(),bounding=status['CapBnd'].strip(),refusals=refusals,env=dict(os.environ),files=files)))\n`;
  writeFileSync(join(root, "repository", "inspect.py"), inspection, { mode: 0o644 });
  writeFileSync(join(root, "repository", "wait.py"), "import subprocess,os,time\np=subprocess.Popen(['/usr/bin/sleep','1000'],start_new_session=True)\nopen(os.path.join(os.environ['HOME'],'descendant.pid'),'w').write(str(p.pid))\ntime.sleep(1000)\n", { mode: 0o644 });
  writeFileSync(join(root, "repository", "leak.py"), "import subprocess,os\np=subprocess.Popen(['/usr/bin/sleep','1000'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen(os.path.join(os.environ['HOME'],'unconfirmed.pid'),'w').write(str(p.pid))\nprint('Detached descendant created')\n", { mode: 0o644 });
  const git = (args: string[], cwd = join(root, "repository")) => { const result = Bun.spawnSync(["/usr/bin/git", "-c", "core.hooksPath=", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  git(["init", "-q"]); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Fixture"]);
  const commit = git(["rev-parse", "HEAD"]), bare = join(root, "bare.git"); git(["clone", "--bare", join(root, "repository"), bare], root);
  const requests: Array<{ authorization: string | null; body: any }> = []; let turn = 0, behavior = "inspect";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "HEAD") return new Response(null);
    const body = await request.json() as any; requests.push({ authorization: request.headers.get("authorization"), body });
    if (body.stream !== true) return Response.json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const tool = behavior === "wait" ? "python3 wait.py" : behavior === "leak" && turn++ === 0 ? "python3 leak.py" : behavior === "inspect" && turn++ === 0 ? "python3 inspect.py" : undefined;
    const chunks = [{ choices: [{ delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: "inspect-call", type: "function", function: { name: "run_shell", arguments: json({ command: tool }) } }] } : { role: "assistant", content: "Hosted work completed." }, finish_reason: tool ? "tool_calls" : "stop" }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } }];
    return new Response(chunks.map(chunk => "data: " + json(chunk) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const model = { id: "hosted-fixture", provider: "openai_compatible", family: "fixture", label: "Hosted fixture", contextWindow: 32768, maxOutputTokens: 2048, capabilities: { toolCalling: true }, pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 1, cacheWritePerMTok: 1, effectiveDate: "2026-10-19", source: "Fictitious test price" } };
  const master = join(root, "broker", "encryption.key"), accounts = join(root, "broker", "accounts.json"), serverConfig = join(root, "broker", "config.json"), workerConfig = join(root, "worker-control", "config.json");
  privateWrite(master, randomBytes(32).toString("base64"), brokerUid);
  privateWrite(accounts, json({ accounts: [{ account: "alice", organizationId: "team", administrator: false, tokenHash: createHash("sha256").update(token).digest("hex"), repositories: ["https://forge.example.test/team/repo.git"] }, { account: "admin", organizationId: "team", administrator: true, tokenHash: createHash("sha256").update(adminToken).digest("hex"), repositories: ["https://forge.example.test/team/repo.git"] }] }), brokerUid);
  privateWrite(serverConfig, json({ directory: join(root, "broker", "data"), encryptionKeyFile: master, accountsFile: accounts, workerToken, publicBaseUrl: "https://service.example.test/", currency: "USD", providers: [{ id: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1/`, model }], environments: [{ id: "default", provider: "fixture", tools: ["run_shell", "read_file"], connectors: [] }] }), brokerUid);
  const broker = Bun.spawn(["/usr/bin/setpriv", "--reuid=" + brokerUid, "--regid=" + brokerUid, "--clear-groups", "--no-new-privs", process.execPath, "--no-env-file", process.argv[1]!, "broker", serverConfig, clock], { env, stdout: "pipe", stderr: "pipe" });
  const brokerErrors = new Response(broker.stderr).text(); const brokerReader = broker.stdout.getReader();
  const ready = await brokerReader.read(); if (ready.done) throw Error("Broker did not start: " + await brokerErrors);
  const startup = JSON.parse(Buffer.from(ready.value).toString()), url = startup.ready as string;
  const call = async (path: string, body?: unknown, authorization = token) => { const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: json(body) }) }); return { status: response.status, body: await response.json() as any }; };
  privateWrite(workerConfig, json({ serviceUrl: url, workerToken, root: join(root, "worker-runs"), prefix, productBinary: join(root, "bin", "product"), isolation: { firstUid: 65536, lastUid: 65635 } }));
  let active: ReturnType<typeof Bun.spawn> | undefined, previousProfile = join(root, "previous", "config.json"); const allocated = new Set<number>();
  const input = { repository: "https://forge.example.test/team/repo.git", branch: "main", commit, prompt: "Inspect the environment, protected paths and isolation using the available tools.", environment: "default" };
  const startWorker = (repository = "file://" + bare, unconfirmed = false) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", process.argv[1]!, unconfirmed ? "worker-unconfirmed" : "worker", workerConfig], { env: { ...env, ...(unconfirmed ? { PATH: join(root, "bin") + ":" + env.PATH } : {}), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url." + repository + ".insteadOf", GIT_CONFIG_VALUE_0: "https://forge.example.test/team/repo.git" }, stdout: "pipe", stderr: "pipe" }); active = child;
    writeFileSync(targets, json({ brokerConfig: serverConfig, master, vault: join(root, "broker", "data", "state.json"), workerConfig, otherSession: previousProfile, brokerEnvironment: `/proc/${broker.pid}/environ`, workerEnvironment: `/proc/${active.pid}/environ`, brokerMemory: `/proc/${broker.pid}/mem`, workerMemory: `/proc/${active.pid}/mem` }), { mode: 0o644 });
    return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, code]) => { if (code !== 0 || !out.includes('"worked":true')) throw Error(json({ code, out, err })); return JSON.parse(out); });
  };
  const completed = async (id: string) => { const result = await call(`sessions/${id}/status`); if (result.body.status !== "completed") throw Error(json(result)); return result.body; };
  try {
    await call("console/keys/deposit", { provider: "fixture", label: "Personal fixture", owner: "personal", secret: personal });
    const firstAt = requests.length, first = await call("sessions/create", { ...input, idempotencyKey: "personal" }); turn = 0; await startWorker(); const firstResult = await completed(first.body.id);
    const extract = () => { const request = requests.at(-1)!.body; const toolMessage = request.messages.findLast((message: any) => message.role === "tool").content as string; const match = /INSPECTION_COMPLETE (\{[^\n]*\})/.exec(toolMessage); if (!match) throw Error("No actual inspection: " + toolMessage); const facts = JSON.parse(match[1]!); allocated.add(facts.uid); return facts; };
    const firstFacts = extract(), personalUsed = requests.slice(firstAt).every(request => request.authorization === "Bearer " + personal);
    previousProfile = readdirSync(join(root, "worker-runs")).filter(name => name.startsWith("session-")).map(name => join(root, "worker-runs", name, "home", "config", "config.json")).find(path => statSync(path).uid === firstFacts.uid)!;
    // The actual root Git clone must be interrupted before a product process starts.
    const preparationFacts: boolean[] = [];
    for (const revoke of [true, false]) {
      let cloneEntered = false, releaseClone = () => {}, preparationGit = 0;
      const blockedRepository = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { cloneEntered = true; await new Promise<void>(resolve => { releaseClone = resolve; }); return new Response(null, { status: 503 }); } });
      try {
      const preparing = await call("sessions/create", { ...input, idempotencyKey: revoke ? "revoked-preparation" : "expired-preparation", ...(revoke ? {} : { maxDurationSeconds: 1 }) }), providerCalls = requests.length;
      const waiting = startWorker(`http://127.0.0.1:${blockedRepository.port}/repository.git`);
      for (const end = Date.now() + 5000; Date.now() < end && (!cloneEntered || !preparationGit);) {
        for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) try {
          const status = readFileSync(`/proc/${pid}/status`, "utf8"), command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
          if (Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]) === active!.pid && command.includes("clone")) preparationGit = Number(pid);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        if (!cloneEntered || !preparationGit) await Bun.sleep(10);
      }
      if (!cloneEntered || !preparationGit) throw Error("No actual blocked root Git clone");
      if (revoke) { const key = (await call("console/keys/list")).body.keys.find((row: any) => row.owner === "personal" && !row.revoked); await call("console/keys/revoke", { id: key.id }); }
      const returnedBeforeRelease = await Promise.race([waiting.then(() => true), Bun.sleep(2500).then(() => false)]);
      const gitStopped = !existsSync(`/proc/${preparationGit}/stat`) || /^\d+ \([^)]*\) Z /.test(readFileSync(`/proc/${preparationGit}/stat`, "utf8"));
      preparationFacts.push(returnedBeforeRelease && gitStopped && requests.length === providerCalls && (!revoke || (await call(`sessions/${preparing.body.id}/status`)).body.status === "stopped"));
      releaseClone(); await blockedRepository.stop(true); await waiting;
      } finally {
        releaseClone(); await blockedRepository.stop(true);
        if (preparationGit) try { process.kill(-preparationGit, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (revoke) await call("console/keys/deposit", { provider: "fixture", label: "Personal renewed after preparation", owner: "personal", secret: personal });
    }
    // A root-owned controlled pkill that reports success without signalling must fail closed.
    writeFileSync(join(root, "bin", "pkill"), "#!/bin/sh\nexit 0\n", { mode: 0o555 });
    behavior = "leak"; turn = 0;
    const unconfirmedSession = await call("sessions/create", { ...input, idempotencyKey: "unconfirmed-stop" }), unconfirmedResult = await startWorker(undefined, true);
    let unconfirmedAlive = false;
    for (const name of readdirSync(join(root, "worker-runs"))) {
      const path = join(root, "worker-runs", name, "home", "unconfirmed.pid");
      if (existsSync(path)) { const pid = Number(readFileSync(path, "utf8")), uid = statSync(path).uid; allocated.add(uid); unconfirmedAlive = existsSync(`/proc/${pid}/stat`) && !/^\d+ \([^)]*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); Bun.spawnSync(["/usr/bin/pkill", "-KILL", "-u", String(uid)], { env, stdout: "ignore", stderr: "ignore" }); }
    }
    const unconfirmedClosed = unconfirmedResult.unconfirmedClosed === true && unconfirmedAlive;
    await call(`sessions/${unconfirmedSession.body.id}/stop`, {}); behavior = "inspect";
    await call("console/keys/deposit", { provider: "fixture", label: "Organization fixture", owner: "organization", secret: organization }, adminToken);
    await call("console/organization", { enforcedKey: true }, adminToken);
    const orgAt = requests.length, second = await call("sessions/create", { ...input, idempotencyKey: "organization" }); turn = 0; await startWorker(); await completed(second.body.id); const secondFacts = extract(), organizationUsed = requests.slice(orgAt).every(request => request.authorization === "Bearer " + organization);
    const trigger = await call("triggers/create", { ...input, idempotencyKey: "revoked-trigger", cron: "0 9 * * *", timeZone: "UTC" });
    const key = (await call("console/keys/list", undefined, adminToken)).body.keys.find((key: any) => key.owner === "organization");
    behavior = "wait"; const running = await call("sessions/create", { ...input, idempotencyKey: "revoked-running" }), waiting = startWorker();
    let descendant = 0;
    for (const end = Date.now() + 10000; Date.now() < end && !descendant;) { for (const name of readdirSync(join(root, "worker-runs"))) { const path = join(root, "worker-runs", name, "home", "descendant.pid"); if (existsSync(path)) { descendant = Number(readFileSync(path, "utf8")); allocated.add(statSync(path).uid); } } if (!descendant) await Bun.sleep(30); }
    if (!descendant) throw Error("No actual detached descendant created");
    await call("console/keys/revoke", { id: key.id }, adminToken); await waiting;
    const stopped = (await call(`sessions/${running.body.id}/status`)).body;
    const processStopped = () => !existsSync(`/proc/${descendant}/stat`) || /^\d+ \([^)]*\) Z /.test(readFileSync(`/proc/${descendant}/stat`, "utf8"));
    for (const end = Date.now() + 3000; Date.now() < end && !processStopped();) await Bun.sleep(30);
    const refused = await call("sessions/create", { ...input, idempotencyKey: "after-revocation" });
    writeFileSync(clock, String(Date.UTC(2026, 9, 19, 9)));
    let revokedHistory: any;
    for (const end = Date.now() + 5000; Date.now() < end;) { revokedHistory = (await call("triggers/get", { id: trigger.body.id })).body.history; if (revokedHistory.length) break; await Bun.sleep(30); }
    await call("console/organization", { enforcedKey: false }, adminToken); behavior = "complete";
    const personalKey = (await call("console/keys/list")).body.keys.find((key: any) => key.owner === "personal" && !key.revoked);
    await call("console/keys/revoke", { id: personalKey.id });
    const empty = await call("triggers/create", { ...input, idempotencyKey: "no-key-trigger", cron: "1 9 * * *", timeZone: "UTC" });
    writeFileSync(clock, String(Date.UTC(2026, 9, 19, 9, 1)));
    let emptyHistory: any;
    for (const end = Date.now() + 5000; Date.now() < end;) { emptyHistory = (await call("triggers/get", { id: empty.body.id })).body.history; if (emptyHistory.length) break; await Bun.sleep(30); }
    await call("triggers/delete", { id: empty.body.id });
    await call("console/keys/deposit", { provider: "fixture", label: "Personal renewed", owner: "personal", secret: personal });
    const clientFile = join(root, "worker-control", "client.json"); privateWrite(clientFile, json({ url: url + "triggers/create", token, body: { ...input, idempotencyKey: "daily", cron: "2 9 * * *", timeZone: "UTC" } }));
    const daily = JSON.parse(await run([process.execPath, "--no-env-file", process.argv[1]!, "client", clientFile]));
    writeFileSync(clock, String(Date.UTC(2026, 9, 19, 9, 2)));
    let dailyHistory: any;
    for (const end = Date.now() + 5000; Date.now() < end;) { dailyHistory = (await call("triggers/get", { id: daily.id })).body.history; if (dailyHistory.length) break; await Bun.sleep(30); }
    await startWorker(); dailyHistory = (await call("triggers/get", { id: daily.id })).body.history;
    const immediate = await call("triggers/run", { id: daily.id }); await startWorker(); await completed(immediate.body.id);
    const allText = json([requests.map(request => request.body), firstResult, firstFacts, secondFacts]);
    console.log(json({ runtime: Bun.version, productSha256: createHash("sha256").update(readFileSync(join(root, "bin", "product"))).digest("hex"), brokerUid: startup.uid, workerUid: 0, firstFacts, secondFacts, otherActualSessionRefused: secondFacts.refusals.otherSession === true, personalUsed, organizationUsed, organizationNotice: second.body.notice, noSecrets: ![personal, organization, workerToken, token, adminToken].some(secret => allText.includes(secret)), preparationStopped: preparationFacts[0], preparationDeadlineStopped: preparationFacts[1], unconfirmedClosed, revoked: stopped.status === "stopped" && refused.body.error.includes("ERR-01"), descendantStopped: processStopped(), revokedHistory, emptyHistory, dailyHistory, immediate: immediate.status === 201 && immediate.body.status === "queued", uids: [...allocated] }));
  } finally {
    active?.kill(); if (active) await active.exited; broker.kill(); await broker.exited; await brokerErrors; brokerReader.releaseLock(); provider.stop(true);
    if (existsSync(join(root, "worker-runs"))) for (const name of readdirSync(join(root, "worker-runs"))) { if (name.startsWith("session-")) { const uid = statSync(join(root, "worker-runs", name)).uid; if (uid) allocated.add(uid); } }
    for (const uid of allocated) { if (uid < 65536 || uid > 65635) throw Error("Invalid owned identity cleanup"); Bun.spawnSync(["/usr/bin/pkill", "-KILL", "-u", String(uid)], { env, stdout: "ignore", stderr: "ignore" }); }
  }
} else throw Error("Unknown native proof mode");
