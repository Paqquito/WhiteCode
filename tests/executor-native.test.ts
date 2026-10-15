// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { nativeExecutorPorts } from "../src/remote/executor-runtime";
import { workspace, TEST_USER_CONFIG, ROOT } from "./helpers/env";
import { productEnv, prefix } from "./helpers/hooks";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
test("TECH — native executor ports clone a pinned repository and run the actual product child against a local model fixture", async () => {
  const ws = workspace(),
    git = (cwd: string, args: string[]) => {
      const r = spawnSync("git", ["-c", "core.hooksPath=", ...args], {
        cwd,
        encoding: "utf8",
      });
      if (r.status !== 0) throw Error(r.stderr);
      return r.stdout.trim();
    };
  git(ws.project, ["init", "-q"]);
  ws.write("project/input.txt", "native workspace witness");
  git(ws.project, ["add", "input.txt"]);
  git(ws.project, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Fixture",
  ]);
  const commit = git(ws.project, ["rev-parse", "HEAD"]),
    bare = join(ws.root, "bare.git");
  git(ws.root, ["clone", "--bare", ws.project, bare]);
  const server = startFakeOpenAI([{ text: "Native executor receipt" }]),
    catalog = JSON.parse(
      readFileSync(join(ROOT, "tests/fixtures/test.models.json"), "utf8"),
    );
  writeFileSync(
    join(ws.configHome, "config.json"),
    JSON.stringify({
      ...TEST_USER_CONFIG,
      api: { provider: "openai_compatible", baseUrl: server.baseURL },
      models: {
        ...TEST_USER_CONFIG.models,
        selected: "test-medium",
        extraCatalog: catalog.models,
      },
    }),
  );
  const directory = join(ws.root, "isolated");
  mkdirSync(directory);
  const env = productEnv(ws, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url." + pathToFileURL(bare).href + ".insteadOf",
      GIT_CONFIG_VALUE_0: "https://forge.example.test/org/repository.git",
    }),
    ports = nativeExecutorPorts({
      env,
      configDir: ws.configHome,
      prefix,
      redact: (s) => s,
    }),
    signal = AbortSignal.timeout(20000);
  try {
    await ports.prepare(
      directory,
      {
        id: "work-one",
        repository: "https://forge.example.test/org/repository.git",
        commit,
        prompt: "Report readiness",
        environment: "env",
        labels: [],
        workSecret: "work_" + "f".repeat(40),
        expiresAt: Date.now() + 10000,
      },
      signal,
    );
    expect(readFileSync(join(directory, "input.txt"), "utf8")).toBe(
      "native workspace witness",
    );
    const result = await ports.run(
      directory,
      { id: "work-one", prompt: "Report readiness" },
      signal,
      () => {},
    );
    expect(result.code).toBe(0);
    expect(result.result).toContain("Native executor receipt");
    expect(server.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(server.requests)).not.toContain(
      "work_" + "f".repeat(40),
    );
  } finally {
    server.stop();
  }
}, 25000);
