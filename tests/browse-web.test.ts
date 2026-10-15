// Supports: SPEC-OUT-014 (native isolated Chromium against a real local HTTP application).
import { expect, test } from "bun:test";
import { BrowserSession } from "../src/tools/browse-web";
import { browserExecutable } from "../src/platform/browser-pipe";
import { cli, workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive } from "./helpers/interactive";

function fixture() {
  const ws = workspace(),
    env = productEnv(ws),
    executable = browserExecutable(env);
  if (!executable)
    throw Error(
      "Native browser verification requires an installed Chromium browser.",
    );
  const observations: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const u = new URL(request.url);
      if (u.pathname === "/observed") {
        observations.push(u.searchParams.get("value") ?? "");
        return new Response("ok");
      }
      return new Response(
        `<!doctype html><html lang="en"><title>Local application</title><h1>Local browser acceptance</h1><label for="ordinary">Project title</label><input id="ordinary" oninput="fetch('/observed?value='+encodeURIComponent(this.value))"><label for="protected">Password</label><input id="protected" type="password" autocomplete="current-password" oninput="fetch('/observed?value='+encodeURIComponent(this.value))"><button onclick="document.querySelector('h1').textContent='Clicked safely'">Change heading</button></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return {
    ws,
    env,
    executable,
    observations,
    server,
    url: `http://127.0.0.1:${server.port}/`,
  };
}
const body = (r: Awaited<ReturnType<BrowserSession["run"]>>) =>
  r.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
test("SPEC-OUT-014/CA-01 — a real local application is read by the CLI without permission prompts", async () => {
  const f = fixture(),
    p = new ScriptedProvider([
      {
        toolCalls: [
          { name: "browse_web", input: { action: "navigate", url: f.url } },
        ],
      },
      { text: "Read completed" },
    ]);
  try {
    const r = await cli(["--non-interactive", "inspect local page"], f.ws, {
      provider: p,
      env: f.env,
      extra: { browserLaunch: { executable: f.executable, headless: true } },
    });
    expect(r.code).toBe(0);
    expect(p.requests.length).toBe(2);
    const history = JSON.stringify(p.requests[1]!.history);
    expect(history).toContain("Local browser acceptance");
    expect(history).toContain("Untrusted page data");
    expect(history).not.toContain("No human");
  } finally {
    f.server.stop(true);
  }
}, 20000);
test("SPEC-OUT-014/CA-02 — typing into a native password control is refused while an ordinary field remains usable", async () => {
  const f = fixture(),
    browser = new BrowserSession({
      env: f.env,
      executable: f.executable,
      headless: true,
      allowLocalhost: () => true,
      allowedDomains: () => [],
    }),
    signal = new AbortController().signal;
  try {
    let page = body(
      await browser.run({ action: "navigate", url: f.url }, signal),
    );
    const password = /^\[([^\]]+)\] textbox Password$/m.exec(page)?.[1],
      ordinary = /^\[([^\]]+)\] textbox Project title$/m.exec(page)?.[1];
    expect(password).toBeDefined();
    expect(ordinary).toBeDefined();
    const refused = await browser.run(
      { action: "type", ref: password, text: "fictional-test-value" },
      signal,
    );
    expect(refused.isError).toBe(true);
    expect(body(refused)).toContain("Sensitive");
    expect(f.observations).toEqual([]);
    page = body(await browser.run({ action: "read" }, signal));
    const next = /^\[([^\]]+)\] textbox Project title$/m.exec(page)![1];
    const accepted = await browser.run(
      { action: "type", ref: next, text: "Public project title" },
      signal,
    );
    expect(accepted.isError).toBe(false);
    for (let i = 0; i < 40 && !f.observations.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.observations).toEqual(["Public project title"]);
    const shot = await browser.run({ action: "screenshot" }, signal, true);
    expect(
      shot.content.some(
        (p) => p.type === "image" && p.dataBase64.startsWith("iVBOR"),
      ),
    ).toBe(true);
  } finally {
    await browser.close();
    f.server.stop(true);
  }
}, 20000);
test("SPEC-OUT-014/CA-03 — the interactive takeover key informs the model and suspends subsequent browser actions", async () => {
  const f = fixture(),
    controller = new AbortController(),
    p = new ScriptedProvider([
      {
        toolCalls: [
          { name: "browse_web", input: { action: "navigate", url: f.url } },
        ],
      },
      { text: "First page read." },
      {
        toolCalls: [
          {
            name: "browse_web",
            input: { action: "navigate", url: f.url + "other" },
          },
        ],
      },
      { text: "Waiting for human control." },
    ]);
  const r = interactive([], f.ws, {
    provider: p,
    env: f.env,
    signal: controller.signal,
    extra: { browserLaunch: { executable: f.executable, headless: true } },
    userConfig: {
      ui: { promptSuggestions: false },
      sessions: { autoTitle: false },
    },
  });
  try {
    await r.idle();
    r.type("inspect page\r");
    await r.waitFor(
      (t) => t.includes("First page read."),
      "first native browser turn",
      15000,
    );
    r.raw("\u001b[98;7u");
    await r.waitFor(
      (t) => t.includes("main à l’utilisateur"),
      "browser takeover panel",
    );
    r.type("continue browsing\r");
    await r.waitFor(
      (t) => t.includes("Waiting for human control."),
      "suspended browser turn",
    );
    expect(JSON.stringify(p.requests[2]!.history)).toContain(
      "The user took control",
    );
    expect(JSON.stringify(p.requests[3]!.history)).toContain(
      "Wait until control is explicitly returned",
    );
  } finally {
    controller.abort();
    await r.done;
    f.server.stop(true);
  }
}, 30000);
