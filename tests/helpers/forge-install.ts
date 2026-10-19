// Supports: SPEC-CMD-037. Owned HTTPS forge, executable CLI and native Git Smart HTTP, without an external account.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { workspace } from "./env";
import type { ForgeAppContract } from "../../src/integrations/forge-install";

export async function forgeInstallFixture() {
  const ws = workspace(), git = Bun.which("git");
  const openssl = Bun.which("openssl") ?? (existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : undefined);
  if (!git || !openssl) throw Error("Git and OpenSSL are required for the native fixture.");
  const ca = join(ws.root, "ca.pem"), key = join(ws.root, "ca-key.pem");
  const certificate = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", ca, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }, stdio: "ignore" });
  if (certificate.status !== 0) throw Error("Local certificate generation failed.");
  const home = join(ws.root, "git-home"), projectRoot = join(ws.root, "repos"), bare = join(projectRoot, "owner/project.git"), deployment = join(ws.root, "deployment"), author = ["-c", "user.name=Fixture Human", "-c", "user.email=fixture@example.invalid"];
  mkdirSync(home); mkdirSync(join(projectRoot, "owner"), { recursive: true }); mkdirSync(deployment);
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(?:GH_|GITHUB_|GIT_|.*API_KEY$|.*TOKEN$)/i.test(entry[0])));
  Object.assign(environment, { HOME: home, USERPROFILE: home, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*", NO_PROXY: "127.0.0.1", HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "" });
  writeFileSync(join(home, ".gitconfig"), `[user]\n name = Fixture Human\n email = fixture@example.invalid\n[http]\n sslCAInfo = ${ca.replaceAll("\\", "/")}\n sslBackend = openssl\n`);
  const run = (args: string[], cwd = ws.project, input?: string) => {
    const result = spawnSync(git, [...author, ...args], { cwd, env: environment, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
    if (result.status !== 0) throw Error(`Fixture Git failed: ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(["init", "--initial-branch=main"]); writeFileSync(join(ws.project, "hello.txt"), "Fixture project\n"); run(["add", "."]); run(["commit", "-m", "Initial fixture"]);
  run(["clone", "--bare", ws.project, bare]); run(["config", "http.receivepack", "true"], bare);
  run(["init", "--initial-branch=main"], deployment); mkdirSync(join(deployment, ".github/workflows"), { recursive: true });
  const deploymentPath = ".github/workflows/agent.yml", deploymentSource = "name: Company fixture\non:\n  workflow_call:\n    inputs:\n      mode:\n        required: true\n        type: string\n    secrets:\n      service_token:\n        required: true\njobs:\n  company_agent:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Invoke the configured company service\n        env:\n          SERVICE_TOKEN: ${{ secrets.service_token }}\n          FLOW_MODE: ${{ inputs.mode }}\n        run: |\n          test -n \"$SERVICE_TOKEN\"\n          test \"$FLOW_MODE\" = mention -o \"$FLOW_MODE\" = review\n";
  writeFileSync(join(deployment, deploymentPath), deploymentSource); run(["add", "."], deployment); run(["commit", "-m", "Company contract fixture"], deployment);
  const sha = run(["rev-parse", "HEAD"], deployment), base = run(["rev-parse", "main"], bare);
  const state = { admin: true, installed: false, secretRefused: false, wrongInstallation: false, malformedVerification: false, auth: true, authDelay: false, extraRequiredInput: false, secretVisible: true, secretAttempts: 0, secret: "", secretName: "", secrets: new Map<string,string>(), branch: "", body: "", checkAuthorization: "", requests: [] as string[], invocations: [] as { args: string[]; hasInput: boolean; pid: number }[], authorizations: [] as string[], gitExtraHeaders: [] as string[], prs: [] as Array<Record<string,unknown>>, pr: undefined as undefined | Record<string, unknown> };
  let origin = "";
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: readFileSync(ca), key: readFileSync(key) }, async fetch(request) {
    const url = new URL(request.url); state.requests.push(request.method + " " + url.pathname); state.authorizations.push(request.headers.get("authorization") ?? "");
    if (url.pathname.startsWith("/owner/project.git/")) {
      state.gitExtraHeaders.push(request.headers.get("x-unexpected") ?? "");
      if (request.headers.get("authorization") !== "Basic " + Buffer.from("fixture-human:fixture-forge-auth").toString("base64")) return new Response("Fixture forge authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="Owned forge fixture"' } });
      const buffer = Buffer.from(await request.arrayBuffer());
      return await new Promise<Response>(resolve => {
        const chunks: Buffer[] = [], child = spawn(git, ["http-backend"], { cwd: projectRoot, env: { ...environment, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(buffer.length), REMOTE_USER: "fixture-human", HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        child.stdout.on("data", data => chunks.push(Buffer.from(data))); child.on("error", () => resolve(new Response("Native Git backend unavailable", { status: 500 })));
        child.on("close", () => { const raw = Buffer.concat(chunks), end = raw.indexOf("\r\n\r\n"); if (end < 0) return resolve(new Response("Native Git backend failed", { status: 500 })); const headers = new Headers(); let status = 200; for (const line of raw.subarray(0, end).toString().split("\r\n")) { const index = line.indexOf(":"); if (index < 1) continue; if (line.slice(0, index).toLowerCase() === "status") status = Number(line.slice(index + 1).trim().split(" ")[0]); else headers.set(line.slice(0, index), line.slice(index + 1).trim()); } resolve(new Response(raw.subarray(end + 4), { status, headers })); });
        child.stdin.on("error", () => {}); child.stdin.end(buffer);
      });
    }
    if (url.pathname === "/auth") { if (state.authDelay) await new Promise(resolve => setTimeout(resolve, 2000)); return state.auth ? json({ authenticated: true }) : json({ error: "Sign in yourself" }, 401); }
    if (url.pathname === "/current") return json({ nameWithOwner: "owner/project", url: origin + "/owner/project" });
    if (url.pathname === "/repos/owner/project") return json({ id: 41, full_name: "owner/project", permissions: { admin: state.admin }, default_branch: "main", clone_url: origin + "/owner/project.git" });
    if (url.pathname === "/repos/company/deployment/contents/" + deploymentPath) {
      if (url.searchParams.get("ref") !== sha) return json({ error: "Unknown immutable revision" }, 404);
      const source = (run(["show", `${sha}:${deploymentPath}`], deployment) + "\n").replace("    secrets:\n", state.extraRequiredInput ? "      unsupported:\n        required: true\n        type: string\n    secrets:\n" : "    secrets:\n");
      return json({ type: "file", path: deploymentPath, encoding: "base64", size: Buffer.byteLength(source), content: Buffer.from(source).toString("base64") });
    }
    if (url.pathname === "/apps/company-fixture/installations/new") return new Response('<form action="/human/install" method="POST"><button>Install on owner/project</button></form>', { headers: { "content-type": "text/html" } });
    if (url.pathname === "/human/install" && request.method === "POST") { state.installed = true; return json({ installed: true }); }
    if (url.pathname === "/company/verify" && request.method === "POST") { state.checkAuthorization = request.headers.get("authorization") ?? ""; if (state.malformedVerification) return new Response("untrusted-response-marker"); const body = await request.json() as Record<string, unknown>; return json({ version: 1, installed: state.installed && body["repository"] === "owner/project" && body["repositoryId"] === 41 && body["application"] === "company-fixture", application: "company-fixture", repository: "owner/project", repositoryId: state.wrongInstallation ? 42 : 41 }); }
    if (url.pathname === "/secret" && request.method === "PUT") { const body=await request.json() as {name:string;value:string};state.secretAttempts++; if (state.secretRefused) return new Response(body.value, { status: 403 }); state.secret=body.value;state.secretName=body.name;state.secrets.set(body.name,body.value);return json({ stored: true }); }
    if (url.pathname === "/secret") return json(state.secretVisible ? [...state.secrets.keys()].map(name=>({name})) : []);
    if (url.pathname === "/requests" && request.method === "POST") {
      const body = await request.json() as { head: string; base: string; body: string };
      if (body.base !== "main" || !/^dev-agent\/install-forge-[a-f0-9-]+$/.test(body.head)) return json({ error: "Unrecognized branch" }, 400);
      const changed = run(["diff", "--name-only", "main..." + body.head], bare).split("\n");
      if (changed.length !== 1 || changed[0] !== ".github/workflows/dev-agent-agent.yml") return json({ error: "Unexpected changes" }, 400);
      state.branch = body.head; state.body = body.body; state.pr = { url: origin + "/owner/project/pull/"+(state.prs.length+1), state: "OPEN", headRefName: body.head, baseRefName: "main", files: changed.map(path => ({ path })) };state.prs.push(state.pr);
      return json(state.pr);
    }
    const requested=/^\/owner\/project\/pull\/([1-9][0-9]*)$/.exec(url.pathname),pr=requested?state.prs[Number(requested[1])-1]:undefined;
    if(requested)return pr ? json({ ...pr, workflow: run(["show", pr.headRefName + ":.github/workflows/dev-agent-agent.yml"], bare) }) : json({ error: "No request" }, 404);
    if (url.pathname === "/invocation" && request.method === "POST") { state.invocations.push(await request.json() as { args: string[]; hasInput: boolean; pid: number }); return json({}); }
    return json({ error: "Unknown route" }, 404);
  } });
  origin = `https://127.0.0.1:${server.port}`;
  const cliPath = join(ws.root, "forge-cli.ts");
  writeFileSync(cliPath, `import {readFileSync} from 'node:fs';
const [origin,ca,...args]=process.argv.slice(2), tls={ca:readFileSync(ca!)};
const call=async(path:string,method='GET',body?:string)=>{const response=await fetch(origin+path,{method,tls,...(body!==undefined?{body}:{}),headers:{'content-type':'application/json'}});const text=await response.text();if(!response.ok){process.stdout.write(text);process.stderr.write(text);process.exit(1)}return text};
const value=(flag:string)=>args[args.indexOf(flag)+1]!;
await call('/invocation','POST',JSON.stringify({args,hasInput:args[0]==='secret'&&args[1]==='set',pid:process.pid}));
if(args[0]==='auth'&&args[1]==='status'){await call('/auth');process.exit(0)}
if(args[0]==='auth'&&args[1]==='git-credential'){const request=await Bun.stdin.text();if(args[2]==='get'&&request.includes('host='+new URL(origin!).host)&&request.includes('protocol=https'))process.stdout.write('username=fixture-human\\npassword=fixture-forge-auth\\n\\n');process.exit(0)}
if(args[0]==='repo'&&args[1]==='view')process.stdout.write(await call('/current'));
else if(args[0]==='api')process.stdout.write(await call('/'+args[1]));
else if(args[0]==='secret'&&args[1]==='set'){const input=await Bun.stdin.text();await call('/secret','PUT',JSON.stringify({name:args[2],value:input}))}
else if(args[0]==='secret'&&args[1]==='list')process.stdout.write(await call('/secret'));
else if(args[0]==='pr'&&args[1]==='create'){const row=JSON.parse(await call('/requests','POST',JSON.stringify({head:value('--head'),base:value('--base'),body:readFileSync(value('--body-file'),'utf8')})));process.stdout.write(row.url)}
else if(args[0]==='pr'&&args[1]==='view')process.stdout.write(await call(new URL(args[2]!).pathname));
else process.exit(2);
`);
  const trustedFetch: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, { ...init, tls: { ca: readFileSync(ca) } })) as typeof fetch;
  const contract: ForgeAppContract = { workflow: `company/deployment/${deploymentPath}@${sha}`, installationCheckUrl: origin + "/company/verify", secretName: "COMPANY_SERVICE_KEY", secretInput: "service_token" };
  return { ws, home, ca, origin, state, base, bare, run, environment, contract, fetch: trustedFetch, program: { file: process.execPath, args: ["--no-env-file", cliPath, origin, ca] }, close: () => server.stop(true) };
}
