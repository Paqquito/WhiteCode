// Supports: SPEC-AGT-001/CA-02 (independent connector lifetime and unchanged parent permissions).
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { processExists } from "../src/platform/process";
test("SPEC-AGT-001/CA-02 — a declared agent connector closes when its agent finishes while the parent connector remains alive", async () => {
  const ws = workspace(),
    pidFile = join(ws.root, "pids.txt"),
    configuration = ws.write(
      "connector.json",
      JSON.stringify({
        pidFile,
        tools: [{ name: "lookup" }],
        responses: { lookup: { text: "Own agent connector receipt" } },
      }),
    );
  writeFileSync(
    join(ws.configHome, "connectors.json"),
    JSON.stringify({
      servers: {
        docs: {
          command: BUN,
          args: [join(import.meta.dir, "helpers/mcp-server.ts"), configuration],
        },
      },
    }),
  );
  ws.write(
    "home/config/agents/connected.md",
    '---\nname: connected\ndescription: "Use the admitted documentation connector."\nconnectors: ["docs"]\ntools: ["cnx_docs_lookup"]\n---\nRead the supplied documentation and report.',
  );
  const pids = () =>
    readFileSync(pidFile, "utf8").trim().split(/\r?\n/).map(Number);
  const provider = new ScriptedProvider(
    [
      {
        toolCalls: [
          {
            name: "spawn_agent",
            input: {
              role: "connected",
              description: "Read docs",
              prompt: "Read the witness",
            },
          },
        ],
      },
      (request) => {
        expect(JSON.stringify(request.history)).toContain("Child finished");
        expect(pids()).toHaveLength(2);
        expect(processExists(pids()[0]!)).toBe(true);
        expect(processExists(pids()[1]!)).toBe(false);
        return { text: "Parent still connected" };
      },
    ],
    [
      (request) => {
        expect(request.tools.map((tool) => tool.name)).toEqual([
          "cnx_docs_lookup",
        ]);
        return { toolCalls: [{ name: "cnx_docs_lookup", input: {} }] };
      },
      (request) => {
        expect(JSON.stringify(request.history)).toContain(
          "Own agent connector receipt",
        );
        return { text: "Child finished" };
      },
    ],
  );
  const result = await cli(
    ["--non-interactive", "--wait-for-mcp", "Read docs"],
    ws,
    {
      provider,
      env: productEnv(ws),
      userConfig: { permissions: { allowRules: ["cnx_docs"] } },
    },
  );
  if (result.code !== 0) throw new Error(result.stderr + result.stdout);
  expect(result.code).toBe(0);
  expect(pids().every((pid) => !processExists(pid))).toBe(true);
}, 10000);
