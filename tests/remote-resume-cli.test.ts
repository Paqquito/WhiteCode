// Supports: SPEC-MOD-015/CA-01/02 (real Git fetch, branch switch and imported local conversation).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { companyFixture } from "./helpers/company";
import { cli } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-MOD-015/CA-01 — reopening a completed remote session fetches its actual branch and restores its history before a local turn", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  const originalBranch = f.git("branch", "--show-current");
  f.git("checkout", "-qb", "remote-work");
  f.ws.write("project/remote.txt", "Fetched branch witness");
  f.git("add", "remote.txt");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Remote work",
  );
  const commit = f.git("rev-parse", "HEAD"),
    bare = join(f.ws.root, "remote.git");
  f.git("clone", "--bare", f.ws.project, bare);
  f.git("checkout", originalBranch);
  f.git("branch", "-D", "remote-work");
  f.git(
    "config",
    "url." + pathToFileURL(bare).href + ".insteadOf",
    "https://forge.example.test/org/repository.git",
  );
  f.handle((path) =>
    path.endsWith("/finished-one/export")
      ? {
          status: "completed",
          repository: "https://forge.example.test/org/repository.git",
          branch: "remote-work",
          commit,
          messages: [
            { role: "user", text: "Previous remote request" },
            {
              role: "assistant",
              text: "Completed remote answer",
              native: { mustNotReachProvider: true },
            },
          ],
        }
      : undefined,
  );
  const provider = new ScriptedProvider([
    (request) => {
      const history = JSON.stringify(request.history);
      expect(history).toContain("Previous remote request");
      expect(history).toContain("Completed remote answer");
      expect(history).not.toContain("mustNotReachProvider");
      return { text: "Local continuation" };
    },
  ]);
  const result = await cli(
    [
      "--non-interactive",
      "--reopen-remote",
      "finished-one",
      "Continue locally",
    ],
    f.ws,
    {
      identity: f.identity,
      extra: f.extra,
      provider,
      env: productEnv(f.ws, {
        GIT_CONFIG_GLOBAL: f.ws.write("empty-gitconfig", ""),
        GIT_CONFIG_NOSYSTEM: "1",
      }),
    },
  );
  if (result.code !== 0) throw new Error(result.stderr + result.stdout);
  expect(result.code).toBe(0);
  expect(f.git("branch", "--show-current")).toBe("remote-work");
  expect(readFileSync(join(f.ws.project, "remote.txt"), "utf8")).toBe(
    "Fetched branch witness",
  );
  expect(result.stdout).toContain("Local continuation");
}, 15000);
test("SPEC-MOD-015/CA-02 — a different repository is explicitly refused before any fetch or local branch change", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  const branch = f.git("branch", "--show-current");
  f.handle((path) =>
    path.endsWith("/other/export")
      ? {
          status: "completed",
          repository: "https://forge.example.test/other/repository.git",
          branch: "work",
          commit: "a".repeat(40),
          messages: [],
        }
      : undefined,
  );
  const result = await cli(
    ["--non-interactive", "--reopen-remote", "other", "Continue"],
    f.ws,
    {
      identity: f.identity,
      extra: f.extra,
      provider: new ScriptedProvider([]),
      env: productEnv(f.ws),
    },
  );
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("Dépôt différent");
  expect(existsSync(join(f.ws.project, ".git/FETCH_HEAD"))).toBe(false);
  expect(f.git("branch", "--show-current")).toBe(branch);
}, 10000);
