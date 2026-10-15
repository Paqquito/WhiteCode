// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { fixtureZip } from "./helpers/connector-zip";
import {
  parseConnectorBundle,
  installConnectorBundle,
} from "../src/connectors/bundle";
import { workspace } from "./helpers/env";
import { productEnv, BUN } from "./helpers/hooks";
import { currentPlatform } from "../src/platform/system";
import { StdioConnection } from "../src/connectors/stdio-client";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const server = `let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bundle-fixture',version:'1.0.0'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Return the installation witness.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:m.method==='tools/call'?{content:[{type:'text',text:'archive server receipt'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`;
const archive = () =>
  fixtureZip(
    {
      "manifest.json": JSON.stringify({
        manifest_version: "0.3",
        name: "bundle-fixture",
        version: "1.0.0",
        description: "Test connector",
        author: { name: "Fixture" },
        server: {
          type: "node",
          entry_point: "server/main.js",
          mcp_config: { command: BUN, args: ["${__dirname}/server/main.js"] },
        },
      }),
      "server/main.js": server,
    },
    true,
  );
test("SPEC-EXT-016/CA-01 — a valid connector bundle is installed after confirmation and its actual MCP server answers", async () => {
  const ws = workspace(),
    bundle = parseConnectorBundle(archive(), 1048576, currentPlatform()),
    questions: string[] = [];
  const installed = await installConnectorBundle(bundle, {
    configDir: ws.configHome,
    confirm: async (text) => {
      questions.push(text);
      return true;
    },
  });
  expect(installed).toBeDefined();
  expect(questions[0]).toContain("server/main.js");
  const conn = await StdioConnection.open({
    name: installed!.name,
    ...installed!.declaration,
    cwd: ws.project,
    env: productEnv(ws),
    platform: currentPlatform(),
    connectTimeoutMs: 3000,
    clientInfo: { name: "fixture", version: "1.0.0" },
  });
  try {
    expect((await conn.listTools(1000))[0]?.name).toBe("echo");
    expect(
      JSON.stringify(await conn.callTool("echo", {}, { timeoutMs: 1000 })),
    ).toContain("archive server receipt");
  } finally {
    await conn.close();
  }
});
test("TECH — declining installation writes no cache and an altered cached server refuses reuse", async () => {
  const ws = workspace(),
    bundle = parseConnectorBundle(archive(), 1048576, currentPlatform()),
    before = readdirSync(ws.configHome);
  expect(
    await installConnectorBundle(bundle, {
      configDir: ws.configHome,
      confirm: async () => false,
    }),
  ).toBeUndefined();
  expect(readdirSync(ws.configHome)).toEqual(before);
  const installed = await installConnectorBundle(bundle, {
    configDir: ws.configHome,
    confirm: async () => true,
  });
  writeFileSync(installed!.declaration.args[0]!, "altered");
  await expect(
    installConnectorBundle(bundle, {
      configDir: ws.configHome,
      confirm: async () => true,
    }),
  ).rejects.toThrow("altéré");
});
