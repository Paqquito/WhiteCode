import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
  parseDeepLink,
  resolveDeepLink,
  repositoryName,
} from "../src/integrations/deep-links";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv } from "./helpers/hooks";
test("SPEC-MOD-030/CA-01 — a native terminal launcher receives the known clone and the real UI holds the linked request unsent", async () => {
  const ws = workspace(),
    identity = loadIdentity(),
    scheme = identity.get("URL_SCHEME"),
    q = "Read notes; $(not-a-command) & 'quoted'",
    repo = "forge.example.test/team/project",
    url = `${scheme}://open?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}`;
  const record = join(ws.root, "terminal-arguments.json"),
    script = ws.write(
      "terminal.ts",
      `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));`,
    ),
    terminal = join(
      ws.root,
      process.platform === "win32" ? "terminal.exe" : "terminal",
    );
  const built = Bun.spawn(
    [process.execPath, "build", script, "--compile", "--outfile", terminal],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(await built.exited).toBe(0);
  ws.write(
    "home/config/" + basename(identity.get("USER_STATE_FILE")),
    JSON.stringify({
      trustedProjects: [ws.project],
      deepLinkRepositories: { [repo]: ws.project },
      deepLinkTerminal: terminal,
    }),
  );
  const p = new ScriptedProvider([]),
    opened = await cli(["--open-link", url], ws, {
      provider: p,
      env: productEnv(ws),
    });
  expect(opened.code).toBe(0);
  expect(p.requests).toHaveLength(0);
  const args = JSON.parse(readFileSync(record, "utf8")) as string[];
  expect(args).toContain("--link-input");
  expect(args.at(-1)).toBe(url);
  if (process.platform === "win32")
    expect(args.slice(0, 2)).toEqual(["-d", ws.project]);
  const stop = new AbortController(),
    run = interactive(["--link-input", url], ws, {
      provider: p,
      signal: stop.signal,
      userConfig: { deepLinks: { registration: "disabled" } },
      extra: { cwd: ws.home },
    });
  try {
    await run.waitFor((t) => t.includes("Demande provenant d’un lien"));
    expect(run.screen().join("\n")).toContain(q);
    await sleep(120);
    expect(p.requests).toHaveLength(0);
    expect(run.all().join("\n")).toContain("project");
  } finally {
    stop.abort();
    await run.done;
  }
}, 20000);
test("SPEC-MOD-030/CA-02 — a decoded newline is rejected before opening a terminal or contacting any model", async () => {
  const ws = workspace(),
    scheme = loadIdentity().get("URL_SCHEME"),
    p = new ScriptedProvider([]);
  for (const value of [
    "hello%0Aworld",
    "hello%0Dworld",
    "hello%00world",
    "hello%C2%85world",
  ]) {
    const result = await cli(
      ["--open-link", `${scheme}://open?q=${value}`],
      ws,
      { provider: p },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Lien invalide");
  }
  expect(p.requests).toHaveLength(0);
});
test("TECH — malformed deep links refuse duplicate keys, credentials, relative paths and unknown schemes; unknown clones fall back safely", () => {
  const ws = workspace(),
    scheme = loadIdentity().get("URL_SCHEME");
  for (const u of [
    `${scheme}://open?q=a&q=b`,
    `${scheme}://user@open?q=x`,
    `${scheme}://open?cwd=relative`,
    `${scheme}://open?repo=../../bad`,
    `${scheme}://other?q=x`,
    `https://open?q=x`,
  ])
    expect(() => parseDeepLink(u, scheme)).toThrow();
  expect(repositoryName("https://forge.example.test/team/project.git")).toBe(
    "forge.example.test/team/project",
  );
  expect(
    resolveDeepLink(
      parseDeepLink(
        `${scheme}://open?repo=forge.example.test/team/missing&q=hello`,
        scheme,
      ),
      {
        home: ws.home,
        repositories: {},
        trusted: [],
        platform:
          process.platform === "win32"
            ? "windows"
            : process.platform === "darwin"
              ? "macos"
              : "linux",
      },
    ),
  ).toEqual({ cwd: ws.home, q: "hello", unknown: true });
});
