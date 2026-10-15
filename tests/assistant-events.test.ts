// Supports: SPEC-MOD-026 (event-driven persistent control session).
import { expect, test } from "bun:test";
import { Host } from "./helpers/control";
import { companyFixture } from "./helpers/company";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-MOD-026/CA-01 — an actual assistant control session starts a new turn for an incoming review comment", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  let delivered = false;
  f.handle((path) =>
    path.endsWith("subscriptions/create")
      ? { id: "review-one" }
      : path.endsWith("/events")
        ? {
            events: delivered
              ? []
              : ((delivered = true),
                [
                  {
                    seq: 1,
                    type: "review_comment",
                    text: "Handle the empty list",
                    file: "src/list.ts",
                    line: 12,
                  },
                ]),
          }
        : undefined,
  );
  const p = new ScriptedProvider([{ text: "Acknowledged review event." }]),
    h = new Host(f.ws, {
      identity: f.identity,
      provider: p,
      extra: f.extra,
      env: { [f.identity.get("ENV_PREFIX") + "ASSISTANT_WORKER"]: "1" },
      init: {},
      userConfig: {
        sessions: { autoTitle: false },
        ui: { promptSuggestions: false },
      },
    });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", {
          command: "/merge-request-subscribe 42",
        }),
      ),
    ).toContain("42");
    await h.waitFor((event) => event.type === "turn_completed");
    expect(p.requests).toHaveLength(1);
    expect(JSON.stringify(p.requests[0]!.history)).toContain(
      "Handle the empty list",
    );
    expect(JSON.stringify(p.requests[0]!.history)).toContain(
      "untrusted external data",
    );
    expect(
      h.messages.some(
        (event) =>
          event.type === "text_delta" &&
          JSON.stringify(event).includes("Acknowledged"),
      ) || JSON.stringify(h.messages).includes("Acknowledged review event."),
    ).toBe(true);
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
