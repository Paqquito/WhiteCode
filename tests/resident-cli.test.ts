// Supports: SPEC-MOD-021/022 (actual source CLI and native worker processes).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { workspace, loadIdentity, ROOT, type Workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import {
  startFakeOpenAI,
  type FakeChatTurn,
} from "./helpers/fake-openai-server";
import { interactive, sleep } from "./helpers/interactive";
import { readResidentEndpoint } from "../src/services/supervisor";
import { residentRequest } from "../src/services/transport";
import { isWithin } from "../src/platform/system";
const until = async <T>(
  sample: () => Promise<T>,
  predicate: (value: T) => boolean,
) => {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await sample();
    if (predicate(value)) return value;
    if (Date.now() > deadline)
      throw Error("Resident CLI deadline: " + JSON.stringify(value));
    await new Promise((r) => setTimeout(r, 100));
  }
};

test("SPEC-CMD-080/CA-01 — accepting the proposed installation directory starts a native service and transfers the terminal", async () => {
  const f = fixture();
  const config = f.config();
  delete config.assistant;
  f.ws.write("home/config/config.json", JSON.stringify(config));
  const controller = new AbortController(),
    client = interactive([], f.ws, {
      userConfig: config,
      extra: { onboarding: false },
      signal: controller.signal,
    });
  try {
    await client.idle();
    client.type("/resident-agent\r");
    await client.waitFor(
      (text) => text.includes("Dossier de l’assistant"),
      "installation directory",
    );
    await sleep(400);
    client.type("\r");
    await client.waitFor(
      (text) => text.includes("Installer et rattacher"),
      "installation consent",
    );
    await sleep(400);
    client.type("o");
    await client.waitFor(
      (text) => text.includes("Session rattachée"),
      "native attachment",
    );
    const saved = f.config();
    expect(saved.assistant.installDirectory).toBeDefined();
    expect(isWithin(saved.assistant.installDirectory, f.ws.project)).toBe(
      false,
    );
    const state = await f.state();
    expect(
      state.workers.some(
        (worker) => worker.kind === "assistant" && worker.pid > 0,
      ),
    ).toBe(true);
    client.type("\u0004");
    expect((await client.done).code).toBe(0);
  } finally {
    controller.abort();
    await client.done;
    await f.stop();
  }
}, 40000);

test("TECH — a real resident assistant receives append-only memory and brief mode without enabling them for other workers", async () => {
  const f = fixture([
    {
      toolCalls: [
        {
          name: "append_journal",
          arguments: JSON.stringify({ text: "Native worker memory witness." }),
        },
      ],
    },
    { text: "Stored." },
  ]);
  try {
    expect((await f.run(["service", "start", "--json"])).code).toBe(0);
    const state = await until(
        f.state,
        (value) => value.workers[0]?.status === "idle",
      ),
      id = state.workers[0]!.id,
      endpoint = readResidentEndpoint(f.ws.configHome)!;
    await residentRequest(
      endpoint,
      "/workers/" + id + "/message",
      { text: "Remember the observation." },
      AbortSignal.timeout(5000),
    );
    await until(
      async () => f.model.requests.length,
      (value) => value >= 2,
    );
    const tools = f.model.requests[0]!.body["tools"];
    expect(JSON.stringify(tools)).toContain("append_journal");
    expect(JSON.stringify(tools)).toContain("message_user");
    expect(JSON.stringify(f.model.requests[1]!.body["messages"])).toContain(
      "Appended memory",
    );
  } finally {
    await f.stop();
  }
}, 40000);
function fixture(
  turns: FakeChatTurn[] | ((ws: Workspace) => FakeChatTurn[]) = [
    { hang: true },
  ],
) {
  const ws = workspace(),
    model = startFakeOpenAI(typeof turns === "function" ? turns(ws) : turns),
    identity = loadIdentity(),
    prefix = identity.get("ENV_PREFIX");
  ws.write(
    "home/config/config.json",
    JSON.stringify({
      api: { provider: "openai_compatible", baseUrl: model.baseURL },
      models: {
        selected: "fixture-model",
        identifierMap: {
          large: "fixture-model",
          medium: "fixture-model",
          small: "fixture-model",
        },
        extraCatalog: [
          {
            id: "fixture-model",
            provider: "openai_compatible",
            family: "fixture",
            label: "Fixture",
            contextWindow: 128000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true },
          },
        ],
      },
      assistant: { installDirectory: ws.project },
      sessions: { autoTitle: false, taskSummary: { enabled: false } },
      memory: {
        automatic: { enabled: false },
        autoExtraction: { enabled: false },
        session: { enabled: false },
      },
      notifications: { channel: "disabled" },
      ui: { promptSuggestions: false },
    }),
  );
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, join(ROOT, "src/main.ts"), ...args],
      {
        cwd: ws.project,
        env: productEnv(ws, { [prefix + "CONFIG_HOME"]: ws.configHome }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 25000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  };
  const state = async () => {
    const result = await run(["service", "show", "--json"]);
    if (result.code !== 0) throw Error(result.stderr);
    return JSON.parse(result.stdout) as {
      workers: Array<{
        id: string;
        pid: number;
        kind: string;
        status: string;
        restarts: number;
        summary: string;
      }>;
    };
  };
  const stop = async () => {
    const endpoint = readResidentEndpoint(ws.configHome);
    try {
      if (endpoint) {
        await residentRequest(endpoint, "/stop", {}, AbortSignal.timeout(5000));
        await until(
          async () => readResidentEndpoint(ws.configHome),
          (value) => value === undefined,
        );
      }
    } finally {
      model.stop();
    }
  };
  return {
    ws,
    model,
    run,
    state,
    stop,
    config: () =>
      JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")),
  };
}
test("SPEC-MOD-021/CA-01 — service start detaches a real supervisor and show lists its live worker", async () => {
  const f = fixture();
  try {
    const result = await f.run(["service", "start", "--json"]);
    expect(result.code).toBe(0);
    const state = await until(
      f.state,
      (s) => s.workers.length === 1 && s.workers[0]!.status === "idle",
    );
    expect(state.workers[0]!.pid).toBeGreaterThan(0);
  } finally {
    await f.stop();
  }
}, 40000);
test("SPEC-MOD-021/CA-02 — the supervisor restarts a crashed native worker with the same session identifier", async () => {
  const f = fixture();
  try {
    const result = await f.run(["service", "start", "--json"]);
    expect(result.code).toBe(0);
    const before = (
      await until(f.state, (s) => s.workers[0]?.status === "idle")
    ).workers[0]!;
    process.kill(before.pid);
    const after = await until(
      f.state,
      (s) =>
        s.workers[0]?.status === "idle" && s.workers[0]!.pid !== before.pid,
    );
    expect(after.workers[0]!.id).toBe(before.id);
    expect(after.workers[0]!.restarts).toBe(1);
  } finally {
    await f.stop();
  }
}, 40000);
test("SPEC-MOD-022/CA-01 — background launch returns an identifier that is visible in the actual list command", async () => {
  const f = fixture();
  try {
    const launched = await f.run([
      "--background",
      "lancer les tests",
      "--result-format",
      "json",
    ]);
    expect(launched.code).toBe(0);
    const id = JSON.parse(launched.stdout).id;
    const result = await f.run(["background-session", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).workers).toContainEqual(
      expect.objectContaining({
        id,
        kind: "background",
        summary: "lancer les tests",
      }),
    );
    await until(
      async () => f.model.requests.length,
      (count) => count > 0,
    );
  } finally {
    await f.stop();
  }
}, 40000);
test("SPEC-MOD-022/CA-02 — attachment shows the pending permission and a human approval permits the exact file write", async () => {
  const f = fixture((ws) => [
    {
      toolCalls: [
        {
          name: "write_file",
          arguments: JSON.stringify({
            path: join(ws.project, "approved.txt"),
            content: "human approved",
          }),
        },
      ],
    },
    { text: "finished" },
  ]);
  let attached: ReturnType<typeof interactive> | undefined;
  try {
    const launch = await f.run([
      "--background",
      "write approved.txt",
      "--result-format",
      "json",
    ]);
    expect(launch.code).toBe(0);
    const id = JSON.parse(launch.stdout).id;
    await until(f.state, (state) =>
      state.workers.some(
        (worker) => worker.id === id && worker.status === "waiting",
      ),
    );
    expect(existsSync(join(f.ws.project, "approved.txt"))).toBe(false);
    attached = interactive(["background-session", "attach", id], f.ws, {
      userConfig: f.config(),
    });
    await attached.waitFor(
      (text) => text.includes("Autorisation de la session détachée"),
      "pending detached permission",
    );
    await sleep(400);
    attached.type("o");
    await until(
      async () => existsSync(join(f.ws.project, "approved.txt")),
      Boolean,
    );
    expect(readFileSync(join(f.ws.project, "approved.txt"), "utf8")).toBe(
      "human approved",
    );
    expect((await attached.done).code).toBe(0);
  } finally {
    attached?.type("\u0004");
    await attached?.done;
    await f.stop();
  }
}, 40000);
test("SPEC-PER-001/CA-25 — without attachment the actual ask request stays pending then is refused at the bounded deadline", async () => {
  const f = fixture((ws) => [
    {
      toolCalls: [
        {
          name: "write_file",
          arguments: JSON.stringify({
            path: join(ws.project, "denied.txt"),
            content: "must not appear",
          }),
        },
      ],
    },
    { text: "denied" },
  ]);
  try {
    const config = f.config();
    config.permissions = { detachedWaitTimeout: "1s" };
    f.ws.write("home/config/config.json", JSON.stringify(config));
    const launch = await f.run([
      "--background",
      "write denied.txt",
      "--result-format",
      "json",
    ]);
    expect(launch.code).toBe(0);
    const id = JSON.parse(launch.stdout).id;
    await until(f.state, (state) =>
      state.workers.some(
        (worker) => worker.id === id && worker.status === "completed",
      ),
    );
    expect(existsSync(join(f.ws.project, "denied.txt"))).toBe(false);
    const toolResults = f.model.requests.flatMap((request) =>
      (
        request.body["messages"] as Array<{ role: string; content: unknown }>
      ).filter((message) => message.role === "tool"),
    );
    expect(JSON.stringify(toolResults)).toContain("No valid human approval");
  } finally {
    await f.stop();
  }
}, 40000);
test("SPEC-MOD-025/CA-01 — job create validates the template, creates its workspace and starts the real session", async () => {
  const f = fixture([{ hang: true }]);
  f.ws.write(
    "home/config/job-templates/revue-deps.json",
    JSON.stringify({
      schemaVersion: 1,
      instructions: "Prepare a dependency checklist.",
      completionCriteria: "The checklist is ready.",
      tools: ["read_file", "write_file"],
    }),
  );
  try {
    const made = await f.run([
      "job",
      "create",
      "revue-deps",
      "check versions",
      "--json",
    ]);
    expect(made.code).toBe(0);
    const job = JSON.parse(made.stdout);
    expect(existsSync(job.cwd)).toBe(true);
    expect(job.cwd.startsWith(f.ws.project)).toBe(false);
    await until(
      async () => f.model.requests.length,
      (count) => count > 0,
    );
    expect(JSON.stringify(f.model.requests[0]!.body["messages"])).toContain(
      "The checklist is ready.",
    );
  } finally {
    await f.stop();
  }
}, 40000);
test("SPEC-MOD-025/CA-02 — replying to a classified blocked job starts a new turn without granting permissions", async () => {
  const f = fixture([
    { text: "Need a choice." },
    {
      text: JSON.stringify({
        state: "blocked",
        summary: "A choice is required.",
      }),
    },
    { text: "Choice received." },
    { text: JSON.stringify({ state: "done", summary: "Ready." }) },
  ]);
  f.ws.write(
    "home/config/job-templates/revue-deps.json",
    JSON.stringify({
      schemaVersion: 1,
      instructions: "Ask for a choice and continue when answered.",
      completionCriteria: "The choice is handled.",
      tools: [],
    }),
  );
  try {
    const made = await f.run(["job", "create", "revue-deps", "--json"]);
    expect(made.code).toBe(0);
    const id = JSON.parse(made.stdout).id;
    const list = async () => {
      const result = await f.run(["job", "list", "--json"]);
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout) as {
        workers: Array<{ id: string; jobState?: { state: string } }>;
      };
    };
    await until(list, (value) =>
      value.workers.some(
        (job) => job.id === id && job.jobState?.state === "blocked",
      ),
    );
    const reply = await f.run(["job", "reply", id, "oui", "--json"]);
    expect(reply.code).toBe(0);
    await until(list, (value) =>
      value.workers.some(
        (job) => job.id === id && job.jobState?.state === "done",
      ),
    );
    expect(
      f.model.requests.some((request) =>
        JSON.stringify(request.body["messages"]).includes("oui"),
      ),
    ).toBe(true);
  } finally {
    await f.stop();
  }
}, 40000);
