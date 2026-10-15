// Supports: SPEC-EXT-016, SPEC-MCP-018 (real administration entry points).
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, cli } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { productEnv, BUN } from "./helpers/hooks";
import { fixtureZip } from "./helpers/connector-zip";

test("TECH — the archive CLI confirms installation, writes its declaration and validates the installed stdio process", async () => {
  const ws = workspace(),
    code = `for await(const line of console){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'archive-proof',version:'1.0.0'}}:m.method==='tools/list'?{tools:[]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));}`;
  const path = join(ws.root, "proof.mcpb");
  writeFileSync(
    path,
    fixtureZip(
      {
        "manifest.json": JSON.stringify({
          manifest_version: "0.3",
          name: "archive-proof",
          version: "1.0.0",
          description: "Fixture connector",
          author: { name: "Fixture" },
          server: {
            type: "node",
            entry_point: "main.js",
            mcp_config: { command: BUN, args: ["${__dirname}/main.js"] },
          },
        }),
        "main.js": code,
      },
      true,
    ),
  );
  const run = interactive(
    ["connector", "install-archive", path, "--scope", "user"],
    ws,
    { env: productEnv(ws) },
  );
  await run.waitFor((text) =>
    text.includes("Installer le connecteur archive-proof"),
  );
  await sleep(400);
  run.type("o");
  const done = await run.done;
  expect(done.code).toBe(0);
  expect(done.stdout).toContain("déclaré");
  expect(
    JSON.parse(readFileSync(join(ws.configHome, "connectors.json"), "utf8"))
      .servers["archive-proof"].command,
  ).toBe(BUN);
  const checked = await cli(["connector", "validate", "archive-proof"], ws, {
    env: productEnv(ws),
  });
  expect(checked.code).toBe(0);
  expect(checked.stdout).toContain("connected");
}, 15000);

test("SPEC-MCP-018/CA-01 — the desktop import confirms two selected connectors and atomically preserves the third and existing configuration", async () => {
  const ws = workspace(),
    file = ws.write(
      "desktop.json",
      JSON.stringify({
        servers: Object.fromEntries(
          ["one", "two", "three"].map((name) => [
            name,
            { command: BUN, args: ["--version"] },
          ]),
        ),
      }),
    );
  writeFileSync(
    join(ws.configHome, "connectors.json"),
    '{\n// commentaire conservé\n"servers":{"existing":{"command":"runtime"}}\n}',
  );
  const run = interactive(
    ["connector", "import", "desktop", file, "one,two"],
    ws,
  );
  await run.waitFor((text) => text.includes("Importer en portée utilisateur"));
  await sleep(400);
  run.type("o");
  expect((await run.done).code).toBe(0);
  const text = readFileSync(join(ws.configHome, "connectors.json"), "utf8");
  expect(text).toContain("commentaire conservé");
  expect(text).toContain('"one"');
  expect(text).toContain('"two"');
  expect(text).toContain('"existing"');
  expect(text).not.toContain('"three"');
}, 10000);
