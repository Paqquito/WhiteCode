import { expect, test } from "bun:test";
import { companyFixture } from "./helpers/company";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Identity } from "../src/identity/identity";
test("SPEC-INT-013/CA-01 — an exposed long turn reaches the mobile subscriber with fixed metadata only", async () => {
  const f = companyFixture();
  await f.login();
  const identity = new Identity({
    ...f.identity.resolved,
    values: {
      ...f.identity.resolved.values,
      SERVICE_MOBILE_IOS: {
        value: "https://company.example.test/mobile",
        origin: "provided",
      },
    },
  });
  const inbox: unknown[] = [];
  f.handle((path, body) =>
    path.endsWith("/local/register")
      ? {
          id: "local-one",
          url: "https://company.example.test/local/one",
          trustedDevice: true,
        }
      : path.endsWith("/local/local-one/poll")
        ? { ack: 0, commands: [] }
        : path.endsWith("/notifications")
          ? (inbox.push(body), { delivered: true })
          : undefined,
  );
  const h = new Host(f.ws, {
    identity,
    extra: f.extra,
    init: { decisionAuthority: true },
    answers: {
      confirm_escalation: (p) => ({
        decision: "confirm",
        escalationId: p["escalationId"],
      }),
    },
    provider: new ScriptedProvider([
      { text: "Private source code must not be a notification", delayMs: 1100 },
    ]),
    userConfig: {
      engine: { control: { allowEscalation: true } },
      notifications: { minTurnSeconds: 1, mobile: true },
    },
  });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/remote-access" }),
      ),
    ).toContain("local/one");
    h.user("Sensitive user request");
    await h.waitFor((m) => m.type === "turn_completed");
    for (let i = 0; i < 100 && !inbox.length; i++) await Bun.sleep(10);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual({
      idempotencyKey: expect.any(String),
      kind: "task_completed",
      audience: "mobile",
    });
    expect(JSON.stringify(inbox)).not.toContain("Private source");
    expect(JSON.stringify(inbox)).not.toContain("Sensitive");
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
}, 15000);
