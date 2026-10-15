// Supports: SPEC-CMD-019, SPEC-INT-012 (native desktop receiver; OS URL opening is the only replaced boundary).
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transferToDesktop } from "../src/integrations/desktop";
import { interactive } from "./helpers/interactive";
import { workspace, ROOT, loadIdentity } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
async function fixture(mode = "normal") {
  const ws = workspace(),
    output = join(ws.root, "desktop-conversation.json"),
    registration = join(ws.configHome, "desktop", "instance.json");
  const child = Bun.spawn(
    [
      process.execPath,
      join(ROOT, "tests/fixtures/desktop-app.ts"),
      ws.configHome,
      output,
      mode,
    ],
    { env: productEnv(ws), stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; i < 200 && !existsSync(registration); i++)
    await new Promise((r) => setTimeout(r, 20));
  if (!existsSync(registration)) {
    child.kill();
    throw Error("Desktop receiver did not register.");
  }
  const endpoint = JSON.parse(readFileSync(registration, "utf8"));
  let links = 0;
  return {
    ws,
    output,
    endpoint,
    child,
    open: (url: string) => {
      links++;
      void fetch(`http://127.0.0.1:${endpoint.port}/desktop/open`, {
        method: "POST",
        headers: {
          authorization: "Bearer " + endpoint.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      }).catch(() => {});
      return true;
    },
    links: () => links,
    close: async () => {
      child.kill();
      await child.exited;
    },
  };
}
test("SPEC-CMD-019/CA-01 — SPEC-INT-012/CA-01 — the CLI closes only after the native desktop receives and opens its complete conversation", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    file = f.ws.write("project/example.ts", "export const result=42;"),
    p = new ScriptedProvider([
      { toolCalls: [{ name: "read_file", input: { path: file } }] },
      { text: "The source contains result=42." },
    ]);
  const run = interactive([], f.ws, {
    provider: p,
    env: productEnv(f.ws),
    signal: controller.signal,
    extra: { openServiceUrl: f.open },
    userConfig: {
      ui: { promptSuggestions: false },
      sessions: { autoTitle: false },
    },
  });
  try {
    await run.idle();
    run.type("Read the example source\r");
    await run.waitFor((t) => t.includes("The source contains result=42."));
    run.type("/move-to-desktop\r");
    const result = await run.done;
    expect(result.code).toBe(0);
    expect(f.links()).toBe(1);
    const received = JSON.parse(readFileSync(f.output, "utf8"));
    expect(received.cwd).toBe(f.ws.project);
    expect(received.link).toStartWith(
      loadIdentity().get("PRODUCT_SLUG") + "-desktop://session/",
    );
    const history = JSON.stringify(received.history);
    expect(history).toContain("Read the example source");
    expect(history).toContain("export const result=42;");
    expect(history).toContain("The source contains result=42.");
    expect(history).not.toContain('"native"');
    expect(received.link).not.toContain(f.endpoint.token);
  } finally {
    controller.abort();
    await run.done;
    await f.close();
  }
}, 15000);
test("TECH — a mismatched desktop receipt keeps the terminal interactive", async () => {
  const f = await fixture("bad-ack"),
    controller = new AbortController(),
    run = interactive([], f.ws, {
      provider: new ScriptedProvider([]),
      env: productEnv(f.ws),
      signal: controller.signal,
      extra: { openServiceUrl: f.open },
      userConfig: { ui: { promptSuggestions: false } },
    });
  try {
    await run.idle();
    run.type("/move-to-desktop\r");
    await run.waitFor((t) => t.includes("terminal reste actif"));
    expect(run.finished()).toBe(false);
  } finally {
    controller.abort();
    await run.done;
    await f.close();
  }
}, 10000);
test("TECH — missing acknowledgement and absent application cannot end the local session", async () => {
  const f = await fixture("no-ack");
  try {
    const options = {
      configDir: f.ws.configHome,
      slug: loadIdentity().get("PRODUCT_SLUG"),
      sessionId: crypto.randomUUID(),
      cwd: f.ws.project,
      history: () => [],
      redact: (t: string) => t,
      flush: () => {},
      open: f.open,
      signal: new AbortController().signal,
      assertPolicy: () => {},
      timeoutMs: 400,
    };
    await expect(transferToDesktop(options)).rejects.toThrow();
    expect(existsSync(f.output)).toBe(true);
    expect(
      await transferToDesktop({
        ...options,
        configDir: join(f.ws.root, "absent"),
      }),
    ).toBe(false);
  } finally {
    await f.close();
  }
}, 10000);
test("TECH — history changed during desktop opening requires a fresh transfer", async () => {
  const f = await fixture();
  const history: import("../src/providers/types").HistoryMessage[] = [];
  try {
    await expect(
      transferToDesktop({
        configDir: f.ws.configHome,
        slug: loadIdentity().get("PRODUCT_SLUG"),
        sessionId: crypto.randomUUID(),
        cwd: f.ws.project,
        history: () => history,
        redact: (t) => t,
        flush: () => {},
        open: (url) => {
          history.push({
            role: "user",
            parts: [{ type: "text", text: "arrived during handoff" }],
          });
          return f.open(url);
        },
        signal: new AbortController().signal,
        assertPolicy: () => {},
      }),
    ).rejects.toThrow("conversation a changé");
  } finally {
    await f.close();
  }
}, 10000);
