// Supports: SPEC-PER-020, SPEC-MOD-013/016/017, SPEC-CMD-017/018/055/056/057/064/105, SPEC-AGT-019, SPEC-OUT-032/047, SPEC-EXT-027.
import { expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { companyFixture } from "./helpers/company";
import { allSessions } from "../src/session/discovery";
import { Host } from "./helpers/control";
import { cli, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv } from "./helpers/hooks";
const confirmation = (params: Record<string, unknown>) => ({
  decision: "confirm",
  escalationId: params["escalationId"],
});
test("TECH — actual control commands estimate, confirm, create a remote review with its ceiling and restore that task after reopening", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  let complete = false;
  f.handle((path, body) =>
    path.endsWith("/estimate")
      ? { available: true, amount: 0.5, unit: "service units" }
      : path.endsWith("/create")
        ? {
            id: "review-one",
            url: "https://company.example.test/sessions/review-one",
            effectiveMaxCost: 1,
          }
        : path.endsWith("/review-one/status")
          ? {
              status: complete ? "completed" : "running",
              result: "Remote review receipt",
            }
          : undefined,
  );
  const h = new Host(f.ws, {
    identity: f.identity,
    provider: new ScriptedProvider([]),
    extra: f.extra,
    argv: ["--model", "large"],
    init: { decisionAuthority: true },
    userConfig: {
      engine: { control: { allowEscalation: true }, limits: { maxCost: 1 } },
    },
    answers: { confirm_escalation: confirmation },
  });
  let sessionId: string | undefined;
  try {
    const result = await Promise.race([
      h.request("invoke_command", { command: "/deep-review 42" }),
      h.run.then((result) => {
        throw new Error(result.stderr);
      }),
    ]);
    expect(JSON.stringify(result)).toContain("review-one");
    expect(
      h
        .demands("confirm_escalation")
        .some((message) => JSON.stringify(message).includes("0.5")),
    ).toBe(true);
    const state = await h.request("get_state");
    sessionId = (state["result"] as Record<string, unknown>)[
      "sessionId"
    ] as string;
    expect(
      f.sent.find((row) => row.path === "/sessions/create")?.body,
    ).toMatchObject({ kind: "review", mergeRequest: 42, maxCost: 1 });
  } finally {
    h.feed.end();
    const end = await h.finish();
    if (end.code !== 0) throw new Error(end.stderr);
  }
  sessionId = allSessions(join(f.ws.configHome, "sessions"))[0]?.id;
  expect(sessionId).toBeDefined();
  complete = true;
  const next = new Host(f.ws, {
    identity: f.identity,
    provider: new ScriptedProvider([]),
    extra: f.extra,
    argv: ["--reopen=" + sessionId!],
  });
  try {
    await Promise.race([
      next.request("get_state"),
      next.run.then((result) => {
        throw new Error(result.stderr);
      }),
    ]);
    for (
      let i = 0;
      i < 100 && !f.sent.some((row) => row.path.endsWith("/review-one/status"));
      i++
    )
      await sleep(10);
    expect(f.sent.some((row) => row.path.endsWith("/review-one/status"))).toBe(
      true,
    );
    expect(
      JSON.stringify(
        await next.request("invoke_command", { command: "/background-tasks" }),
      ),
    ).toContain("review-one");
  } finally {
    next.feed.end();
    const end = await next.finish();
    if (end.code !== 0) throw new Error(end.stderr);
  }
}, 15000);
test("SPEC-CMD-055/CA-01 — the actual terminal command renders a validated relay link and QR while retaining the ordinary permission mode", async () => {
  const f = companyFixture();
  await f.login();
  f.handle((path, body) =>
    path.endsWith("/local/register")
      ? {
          id: "local-one",
          url: "https://company.example.test/local/one",
          trustedDevice: true,
        }
      : path.endsWith("/local/local-one/poll")
        ? {
            ack:
              (body as { events: Array<{ seq: number }> }).events.at(-1)?.seq ??
              0,
            commands: [],
          }
        : path.endsWith("/close")
          ? {}
          : undefined,
  );
  const controller = new AbortController(),
    run = interactive([], f.ws, {
      identity: f.identity,
      extra: f.extra,
      provider: new ScriptedProvider([]),
      signal: controller.signal,
      columns: 180,
      rows: 60,
      userConfig: { remote: { controlAtStartup: false } },
    });
  try {
    await run.idle();
    run.type("/remote-access Proof" + KEY.enter);
    await run.waitFor(
      (text) =>
        text.includes("https://company.example.test/local/one") &&
        /[▀▄█]/.test(text),
    );
    expect(run.all().join("\n")).toContain("mode : ask");
    expect(
      f.sent.find((row) => row.path.endsWith("/local/register"))?.body,
    ).toMatchObject({ name: "Proof", readOnly: false });
  } finally {
    controller.abort();
    expect([0, 130]).toContain((await run.done).code);
  }
}, 15000);
test("TECH — an actual unauthenticated model call receives an English connection instruction from the remote trigger tool", async () => {
  const f = companyFixture(),
    provider = new ScriptedProvider([
      { toolCalls: [{ name: "start_remote_run", input: { action: "list" } }] },
      (request) => {
        expect(JSON.stringify(request.history)).toContain(
          "Company account required",
        );
        return { text: "Connection required" };
      },
    ]);
  expect(
    (
      await cli(["--non-interactive", "List hosted triggers"], f.ws, {
        identity: f.identity,
        provider,
        extra: f.extra,
      })
    ).code,
  ).toBe(0);
  expect(f.sent.some((row) => row.path.includes("/triggers/"))).toBe(false);
});
test("TECH — the actual CLI applies a retrieved remote limit before any session creation and starts local provider work from cache offline", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  f.handle((path) =>
    path.endsWith("/policy/limits")
      ? {
          schemaVersion: 1,
          organizationId: "org",
          version: "restricted",
          validUntil: Date.now() + 86400000,
          limits: ["remote_sessions"],
        }
      : undefined,
  );
  const refused = await cli(
    ["--remote-session", "Forbidden remote work"],
    f.ws,
    { identity: f.identity, extra: f.extra },
  );
  expect(refused.code).toBe(4);
  expect(refused.stderr).toContain("politique de votre organisation");
  expect(f.sent.some((row) => row.path === "/sessions/create")).toBe(false);
  f.handle(() => {
    throw new Error("offline");
  });
  const local = await cli(["--non-interactive", "Local work"], f.ws, {
    identity: f.identity,
    provider: new ScriptedProvider([{ text: "local receipt" }]),
    extra: f.extra,
  });
  expect(local.code).toBe(0);
  expect(local.stdout).toContain("local receipt");
});
test("TECH — an independently protected required limits source blocks only its remote perimeter without authorizing a user cache", async () => {
  const ws = workspace();
  writeFileSync(
    join(ws.managed, "limits-source.json"),
    JSON.stringify({
      schemaVersion: 1,
      organizationId: "org",
      required: true,
      perimeter: "remote",
    }),
  );
  const local = await cli(["--non-interactive", "Local work"], ws, {
    provider: new ScriptedProvider([{ text: "local remains available" }]),
  });
  expect(local.code).toBe(0);
  expect(local.stdout).toContain("local remains available");
  const remote = await cli(["--remote-session", "Blocked work"], ws);
  expect(remote.code).toBe(4);
  expect(remote.stderr).toContain("source obligatoire");
});
test("TECH — the actual hosted schedule skill presents its weekly cron and local time to the human host before creation", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  const prompts: string[] = [];
  f.handle((path) =>
    path === "/sessions/triggers/create"
      ? {
          id: "weekly-one",
          url: "https://company.example.test/triggers/weekly-one",
          nextLocal: "lundi 09:00 Europe/Paris",
        }
      : undefined,
  );
  const provider = new ScriptedProvider([
    (request) => {
      expect(JSON.stringify(request.history)).toContain(
        "Translate a daily or weekly recurrence",
      );
      return {
        toolCalls: [
          {
            name: "start_remote_run",
            input: {
              action: "create",
              body: {
                prompt: "Summarize open tickets",
                cron: "0 9 * * 1",
                timeZone: "Europe/Paris",
              },
            },
          },
        ],
      };
    },
    (request) => {
      expect(JSON.stringify(request.history)).toContain("weekly-one");
      return { text: "Weekly trigger receipt" };
    },
  ]);
  const h = new Host(f.ws, {
    identity: f.identity,
    extra: f.extra,
    provider,
    init: { decisionAuthority: true },
    userConfig: { engine: { control: { allowEscalation: true } } },
    answers: {
      confirm_escalation: (params) => {
        prompts.push(String(params["question"]));
        expect(
          f.sent.some((row) => row.path === "/sessions/triggers/create"),
        ).toBe(false);
        return confirmation(params);
      },
    },
  });
  try {
    h.user(
      "/schedule Chaque lundi à 9 h Europe/Paris, résume les tickets ouverts",
    );
    await h.waitFor((message) => message.type === "turn_completed");
    expect(prompts.join(" ")).toContain("0 9 * * 1");
    expect(prompts.join(" ")).toContain("09:00");
    expect(prompts.join(" ")).toContain("Europe/Paris");
    expect(
      f.sent.find((row) => row.path === "/sessions/triggers/create")?.body,
    ).toMatchObject({
      repository: "https://forge.example.test/org/repository.git",
      cron: "0 9 * * 1",
    });
  } finally {
    h.feed.end();
    const end = await h.finish();
    if (end.code !== 0) throw new Error(end.stderr);
  }
}, 15000);
test("TECH — actual interactive startup attaches by default for an eligible account and explicit false prevents registration", async () => {
  for (const enabled of [true, false]) {
    const f = companyFixture();
    await f.login();
    f.handle((path, body) =>
      path.endsWith("/local/register")
        ? {
            id: "startup-one",
            url: "https://company.example.test/local/startup",
            trustedDevice: true,
          }
        : path.endsWith("/poll")
          ? {
              ack:
                (body as { events: Array<{ seq: number }> }).events.at(-1)
                  ?.seq ?? 0,
              commands: [],
            }
          : path.endsWith("/close")
            ? {}
            : undefined,
    );
    const controller = new AbortController(),
      run = interactive([], f.ws, {
        identity: f.identity,
        extra: f.extra,
        provider: new ScriptedProvider([]),
        signal: controller.signal,
        ...(!enabled
          ? { userConfig: { remote: { controlAtStartup: false } } }
          : {}),
      });
    try {
      await run.idle();
      if (enabled)
        await run.waitFor((text) => text.includes("Contrôle distant connecté"));
      else await sleep(1100);
      expect(f.sent.some((row) => row.path.endsWith("/local/register"))).toBe(
        enabled,
      );
    } finally {
      controller.abort();
      await run.done;
    }
  }
}, 15000);
test("TECH — the actual mirrored session publishes its local answer and rejects a message typed on the remote side", async () => {
  const f = companyFixture();
  await f.login();
  let sentMessage = false;
  f.handle((path, body) =>
    path.endsWith("/local/register")
      ? {
          id: "mirror-one",
          url: "https://company.example.test/local/mirror",
          trustedDevice: true,
        }
      : path.endsWith("/poll")
        ? {
            ack:
              (body as { events: Array<{ seq: number }> }).events.at(-1)?.seq ??
              0,
            commands: sentMessage
              ? []
              : ((sentMessage = true),
                [{ seq: 1, type: "message", text: "Remote must not run" }]),
          }
        : path.endsWith("/close")
          ? {}
          : undefined,
  );
  const controller = new AbortController(),
    provider = new ScriptedProvider([{ text: "Local mirrored answer" }]),
    run = interactive([], f.ws, {
      identity: f.identity,
      extra: f.extra,
      provider,
      signal: controller.signal,
      env: { [f.identity.get("ENV_PREFIX") + "SESSION_MIRROR"]: "1" },
    });
  try {
    await run.idle();
    await run.waitFor((text) =>
      text.includes("Miroir distant en lecture seule"),
    );
    run.type("Local request" + KEY.enter);
    await run.waitFor((text) => text.includes("Local mirrored answer"));
    for (
      let i = 0;
      i < 300 &&
      !f.sent.some((row) =>
        JSON.stringify(row.body ?? null).includes('"read_only"'),
      );
      i++
    )
      await sleep(10);
    expect(JSON.stringify(f.sent.map((row) => row.body))).toContain(
      "Local mirrored answer",
    );
    expect(JSON.stringify(f.sent.map((row) => row.body))).toContain(
      '"read_only"',
    );
    expect(provider.requests).toHaveLength(1);
  } finally {
    controller.abort();
    await run.done;
  }
}, 15000);
test("TECH — a real mobile permission answer closes the actual local dialog and executes the exact shell command once", async () => {
  const f = companyFixture();
  await f.login();
  let replied = false;
  f.handle((path, body) => {
    if (path.endsWith("/local/register"))
      return {
        id: "mobile-one",
        url: "https://company.example.test/local/mobile",
        trustedDevice: true,
      };
    if (path.endsWith("/close")) return {};
    if (!path.endsWith("/poll")) return;
    const events = (
        body as {
          events: Array<{ seq: number; event: Record<string, unknown> }>;
        }
      ).events,
      approval = events.find((row) => row.event["type"] === "approval_request");
    const commands =
      approval && !replied
        ? ((replied = true),
          [
            {
              seq: 1,
              type: "approval",
              requestId: approval.event["requestId"],
              answer: "allow",
            },
          ])
        : [];
    return { ack: events.at(-1)?.seq ?? 0, commands };
  });
  const controller = new AbortController(),
    provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "run_shell",
            input: { command: "printf mobile-command-witness" },
          },
        ],
      },
      (request) => {
        expect(JSON.stringify(request.history)).toContain(
          "mobile-command-witness",
        );
        return { text: "Mobile-approved receipt" };
      },
    ]),
    run = interactive([], f.ws, {
      identity: f.identity,
      extra: f.extra,
      provider,
      signal: controller.signal,
      env: productEnv(f.ws),
      rows: 60,
    });
  try {
    await run.idle();
    await run.waitFor((text) => text.includes("Contrôle distant connecté"));
    run.type("Try shell" + KEY.enter);
    await run.waitFor((text) => text.includes("Autorisation requise"));
    await run.waitFor((text) => text.includes("Mobile-approved receipt"));
    expect(replied).toBe(true);
    expect(run.screen().join("\n")).not.toContain("Autorisation requise");
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(f.sent.map((row) => row.body))).not.toContain(
      "fixture-company-only",
    );
  } finally {
    controller.abort();
    await run.done;
  }
}, 15000);
