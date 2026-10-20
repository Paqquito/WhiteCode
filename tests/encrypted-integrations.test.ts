import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { cli, workspace, ROOT } from "./helpers/env";
import { BUN, bunCommand, productEnv, prefix, hook } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { afterNativeStart } from "./helpers/native-ready";
import type { CredentialVault } from "../src/platform/credential-vault";
import {
  privateStorageScope,
  openPrivateStorage,
  storeRead,
} from "../src/session/private-storage";
import { allSessions } from "../src/session/discovery";
const encrypted = {
  storage: { encryption: { enabled: true } },
  engine: { nonInteractive: { persistSession: true } },
};
const vault = (): CredentialVault => {
  const entries = new Map<string, string>();
  return {
    read: (s, a) => entries.get(s + a),
    write: (s, a, v) => {
      entries.set(s + a, v);
    },
    remove: (s, a) => {
      entries.delete(s + a);
    },
  };
};
function noClear(root: string, witness: string) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) noClear(path, witness);
    else expect(readFileSync(path).toString()).not.toContain(witness);
  }
}
test("SPEC-OUT-024/CA-04 — an encrypted plan is edited and approved in the product and saved without a clear copy", async () => {
  const ws = workspace(),
    keychain = vault(),
    provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "submit_plan", input: { plan_text: "original plan" } },
        ],
      },
      { text: "plan accepted" },
    ]);
  const run = interactive(["--approval-mode", "planning"], ws, {
    provider,
    userConfig: encrypted,
    extra: { credentialVault: keychain },
  });
  try {
    await run.idle();
    run.type("Plan work");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Que faire de ce plan ?"));
    await sleep(380);
    run.type("3");
    await run.waitFor((t) => t.includes("Plan modifié"));
    run.type(KEY.ctrlU);
    run.type("private plan witness");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Reprendre dans quel mode ?"));
    await sleep(380);
    run.type("2");
    await run.waitFor((t) => t.includes("plan accepted"));
    expect(JSON.stringify(provider.requests[1]!.history)).toContain(
      "private plan witness",
    );
  } finally {
    run.type(KEY.escape);
    run.type(KEY.ctrlC);
    run.type(KEY.ctrlC);
    await run.done;
  }
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "pilote-dev:archives",
      vault: keychain,
      enabled: true,
    });
    try {
      const info = allSessions(join(ws.configHome, "sessions"))[0]!;
      expect(
        storeRead(
          info.path.replace(/\.jsonl$/, "") + "/approved-plan.md",
          "utf8",
        ),
      ).toBe("private plan witness");
    } finally {
      close();
    }
  });
  noClear(ws.configHome, "private plan witness");
}, 20000);
test("SPEC-OUT-028/CA-03 — a binary connector resource is encrypted and exposed through an opaque reference", async () => {
  const ws = workspace(),
    keychain = vault(),
    witness = "private binary witness",
    fixture = ws.write(
      "resources.json",
      JSON.stringify({
        tools: [],
        resources: [
          {
            uri: "binary:data",
            name: "data",
            mimeType: "application/octet-stream",
            blob: Buffer.from(witness).toString("base64"),
          },
        ],
      }),
    );
  writeFileSync(
    join(ws.configHome, "connectors.json"),
    JSON.stringify({
      servers: {
        docs: {
          transport: "stdio",
          command: BUN,
          args: [join(import.meta.dir, "helpers", "mcp-server.ts"), fixture],
        },
      },
    }),
  );
  let reference = "";
  const provider = new ScriptedProvider([
    {
      toolCalls: [
        {
          name: "read_connector_resource",
          input: { server: "docs", uri: "binary:data" },
        },
      ],
    },
    (request) => {
      reference =
        /archive:v1:[a-f0-9]{64}/.exec(JSON.stringify(request.history))?.[0] ??
        "";
      return { toolCalls: [{ name: "read_file", input: { path: reference } }] };
    },
    { text: "resource read" },
  ]);
  const result = await cli(
    [
      "--non-interactive",
      "--wait-for-mcp",
      "--allow-rule",
      "read_connector_resource",
      "Read the resource",
    ],
    ws,
    { provider, userConfig: encrypted, extra: { credentialVault: keychain } },
  );
  expect(result.code).toBe(0);
  expect(reference).toMatch(/^archive:v1:/);
  expect(JSON.stringify(provider.requests[2]!.history.at(-1))).toContain(
    witness,
  );
  noClear(ws.configHome, witness);
});
test("TECH — a real encrypted connector result beyond its limit is fully available to the model by reference", async () => {
  const ws = workspace(),
    keychain = vault(),
    witness = "private large witness",
    fixture = ws.write(
      "large.json",
      JSON.stringify({
        tools: [{ name: "dump" }],
        responses: { dump: { text: witness + "\n", repeat: 200 } },
      }),
    );
  writeFileSync(
    join(ws.configHome, "connectors.json"),
    JSON.stringify({
      servers: {
        docs: {
          transport: "stdio",
          command: BUN,
          args: [join(import.meta.dir, "helpers", "mcp-server.ts"), fixture],
          maxOutputTokens: 100,
        },
      },
    }),
  );
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "cnx_docs_dump", input: {} }] },
    (request) => {
      const reference = /saved to (archive:v1:[a-f0-9]{64})/.exec(
        JSON.stringify(request.history),
      )?.[1];
      expect(reference).toBeDefined();
      return {
        toolCalls: [
          { name: "read_file", input: { path: reference, limit: 1000 } },
        ],
      };
    },
    { text: "read all" },
  ]);
  const result = await cli(
    ["--non-interactive", "--wait-for-mcp", "Read output"],
    ws,
    {
      provider,
      userConfig: { ...encrypted, permissions: { allowRules: ["cnx_docs"] } },
      extra: { credentialVault: keychain },
    },
  );
  expect(result.code).toBe(0);
  expect(
    JSON.stringify(provider.requests[2]!.history.at(-1)).match(
      /private large witness/g,
    ),
  ).toHaveLength(200);
  noClear(ws.configHome, witness);
});
test("TECH — an actual detached shell command has encrypted output that the model can retrieve", async () => {
  const ws = workspace(),
    keychain = vault(),
    script = ws.write(
      "scripts/output.ts",
      `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(join(ws.root,"output-ready"))},"ready");console.log("private shell witness");`,
    );
  const provider = new ScriptedProvider([
    {
      toolCalls: [
        {
          name: "run_shell",
          input: {
            command: bunCommand(script.replace(/\\/g, "/")),
            detached: true,
            description: "fixture",
          },
        },
      ],
    },
    {
      toolCalls: [
        { name: "background_output", input: { task_id: "b1", timeout: 3000 } },
      ],
    },
    { text: "output retrieved" },
  ]);
  afterNativeStart(provider,join(ws.root,"output-ready"));
  const result = await cli(
    ["--non-interactive", "--allow-rule", "run_shell", "Run output"],
    ws,
    {
      provider,
      userConfig: encrypted,
      env: productEnv(ws),
      extra: { credentialVault: keychain },
    },
  );
  expect(result.code).toBe(0);
  expect(JSON.stringify(provider.requests[2]!.history)).toContain(
    "private shell witness",
  );
  expect(JSON.stringify(provider.requests[2]!.history)).toContain(
    "archive:v1:",
  );
  noClear(ws.configHome, "private shell witness");
}, 20000);
test("TECH — encrypted ephemeral background output stays in memory and an external memory directory is refused", async () => {
  const ws = workspace(),
    keychain = vault(),
    script = ws.write(
      "scripts/output.ts",
      `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(join(ws.root,"output-ready"))},"ready");console.log("private ephemeral witness");`,
    );
  const provider = new ScriptedProvider([
    {
      toolCalls: [
        {
          name: "run_shell",
          input: {
            command: bunCommand(script.replace(/\\/g, "/")),
            detached: true,
            description: "fixture",
          },
        },
      ],
    },
    {
      toolCalls: [
        { name: "background_output", input: { task_id: "b1", timeout: 3000 } },
      ],
    },
    { text: "output retrieved" },
  ]);
  afterNativeStart(provider,join(ws.root,"output-ready"));
  const result = await cli(
    [
      "--non-interactive",
      "--ephemeral",
      "--allow-rule",
      "run_shell",
      "Run output",
    ],
    ws,
    {
      provider,
      userConfig: encrypted,
      env: productEnv(ws),
      extra: { credentialVault: keychain },
    },
  );
  expect(result.code).toBe(0);
  expect(JSON.stringify(provider.requests[2]!.history)).toContain(
    "private ephemeral witness",
  );
  noClear(ws.configHome, "private ephemeral witness");
  const refused = await cli(["--non-interactive", "Work"], ws, {
    provider: new ScriptedProvider([]),
    userConfig: {
      ...encrypted,
      memory: {
        directory: join(ws.home, "external-memory"),
        automatic: { enabled: true },
      },
    },
    extra: { credentialVault: keychain },
  });
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("aucun stockage mémoire externe");
}, 20000);
test("TECH — a real hook child CLI reads its encrypted transcription only on stdout", async () => {
  const ws = workspace(),
    keychain = vault(),
    file = ws.write("project/read.txt", "read");
  const command = hook(
    ws,
    "reader",
    `const child=Bun.spawn([${JSON.stringify(BUN)},${JSON.stringify(join(ROOT, "src/main.ts"))},"session","read",payload.transcriptRef],{stdout:"pipe",stderr:"pipe",env:process.env});const output=await new Response(child.stdout).text();const errors=await new Response(child.stderr).text();if(await child.exited!==0||errors||!output.includes("private hook cli witness"))throw new Error("read failed");console.log(JSON.stringify({context:"verified encrypted hook read"}));`,
  );
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "read_file", input: { path: file } }] },
    { text: "read" },
  ]);
  const result = await cli(
    ["--non-interactive", "private hook cli witness"],
    ws,
    {
      provider,
      userConfig: {
        ...encrypted,
        hooks: { before_tool: [{ actions: [{ type: "command", command }] }] },
      },
      env: productEnv(ws),
      extra: { credentialVault: keychain },
    },
  );
  expect(result.code).toBe(0);
  expect(JSON.stringify(provider.requests[1]!.history)).toContain(
    "verified encrypted hook read",
  );
  noClear(ws.configHome, "private hook cli witness");
}, 20000);
test("TECH — a declared user agent persists encrypted memory through the real child registry", async () => {
  const ws = workspace(),
    keychain = vault();
  ws.write(
    "home/config/agents/recorder.md",
    '---\nname: recorder\ndescription: Records facts\nmemory: user\ntools: ["write_file"]\n---\nRecord durable facts.\n',
  );
  const provider = new ScriptedProvider(
    [
      {
        toolCalls: [
          {
            name: "spawn_agent",
            input: {
              role: "recorder",
              description: "Record",
              prompt: "Remember the preference",
            },
          },
        ],
      },
      { text: "parent done" },
    ],
    [
      (request) => {
        const system = request.system
          .map((block) => block.text)
          .join("\n")
          .split("# Agent memory")
          .at(-1)!;
        const folder = /Memory folder: (archive-dir:v1:[a-f0-9]{64})/.exec(
          system,
        )?.[1];
        expect(folder).toBeDefined();
        return {
          toolCalls: [
            {
              name: "write_file",
              input: {
                path: folder + "/fact.md",
                content:
                  "---\nname: Durable\ndescription: A test convention\ntype: feedback\n---\nprivate child memory witness\n",
              },
            },
          ],
        };
      },
      (request) => {
        expect(JSON.stringify(request.history)).toContain(
          "Updated project memory fact.md",
        );
        return { text: "Remembered" };
      },
    ],
  );
  const result = await cli(["--non-interactive", "Record"], ws, {
    provider,
    userConfig: encrypted,
    extra: { credentialVault: keychain },
  });
  expect(result.code).toBe(0);
  noClear(ws.configHome, "private child memory witness");
});
