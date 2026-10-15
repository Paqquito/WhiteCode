// Supports: SPEC-CMD-079 (actual control confirmation, source validation and configured account service).
import { expect, test } from "bun:test";
import { Host } from "./helpers/control";
import { companyFixture } from "./helpers/company";
import { ScriptedProvider } from "./helpers/scripted-provider";
const definition =
  '---\nname: local-reviewer\ndescription: "Review only the requested source files."\ntools: [read_file]\n---\nRead the requested files and report concrete findings. Never modify a file.\n';
async function fixture(
  answer: (
    params: Record<string, unknown>,
    f: ReturnType<typeof companyFixture>,
  ) => unknown,
) {
  const f = companyFixture();
  await f.login();
  f.ws.write("home/config/agents/local-reviewer.md", definition);
  let allowed = false;
  f.handle((path, body) => {
    if (path === "/api/account/agents/publish") {
      if (!allowed) throw Error("Definition sent before confirmation");
      return { id: "hosted-reviewer" };
    }
    if (path === "/api/account/agents/list")
      return { items: [{ id: "hosted-reviewer", name: "local-reviewer" }] };
    if (path === "/api/account/agents/runs")
      return { items: [{ id: "run-one", status: "completed" }] };
    return undefined;
  });
  const p = new ScriptedProvider([]),
    h = new Host(f.ws, {
      provider: p,
      identity: f.identity,
      extra: f.extra,
      init: { decisionAuthority: true },
      userConfig: { engine: { control: { allowEscalation: true } } },
      answers: {
        confirm_escalation: (params) => {
          const result = answer(params, f) as Record<string, unknown>;
          allowed =
            result.decision === "confirm" &&
            result.escalationId === params.escalationId;
          return result;
        },
      },
    });
  return { f, p, h };
}
test("SPEC-CMD-079/CA-01 — an independently confirmed local definition is sent only after its full publication preview", async () => {
  const { f, p, h } = await fixture((params, f) => {
    expect(f.sent.some((r) => r.path === "/api/account/agents/publish")).toBe(
      false,
    );
    expect(String(params.question)).toContain("Read the requested files");
    return { decision: "confirm", escalationId: params.escalationId };
  });
  try {
    const result = await h.request("invoke_command", {
      command: "/agents-platform publish local-reviewer",
    });
    expect(JSON.stringify(result)).toContain("hosted-reviewer");
    const sent = f.sent.find((r) => r.path === "/api/account/agents/publish")!;
    expect(sent.body).toEqual({
      schemaVersion: 1,
      name: "local-reviewer",
      description: "Review only the requested source files.",
      instructions:
        "Read the requested files and report concrete findings. Never modify a file.",
      tools: ["read_file"],
      excludedTools: [],
    });
    expect(JSON.stringify(sent.body)).not.toContain("config");
    expect(p.requests).toHaveLength(0);
    const listed = await h.request("invoke_command", {
        command: "/agents-platform",
      }),
      runs = await h.request("invoke_command", {
        command: "/agents-platform runs hosted-reviewer",
      });
    expect(JSON.stringify(listed)).toContain("local-reviewer");
    expect(JSON.stringify(runs)).toContain("run-one");
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
test("TECH — rejection or changed source never publishes an agent", async () => {
  for (const changed of [false, true]) {
    const { f, h } = await fixture((params, f) => {
      if (changed)
        f.ws.write(
          "home/config/agents/local-reviewer.md",
          definition + "Changed after preview.\n",
        );
      return {
        decision: changed ? "confirm" : "cancel",
        escalationId: params.escalationId,
      };
    });
    try {
      const response = await h.request("invoke_command", {
        command: "/agents-platform publish local-reviewer",
      });
      expect(JSON.stringify(response)).toContain(
        changed ? "modifié" : "annulée",
      );
      expect(f.sent.some((r) => r.path === "/api/account/agents/publish")).toBe(
        false,
      );
    } finally {
      h.feed.end();
      await h.finish();
    }
  }
}, 15000);
test("TECH — secrets, local hooks and malformed operations are refused before publication confirmation", async () => {
  const { f, h } = await fixture((params) => ({
    decision: "confirm",
    escalationId: params.escalationId,
  }));
  try {
    f.ws.write(
      "home/config/agents/local-reviewer.md",
      definition + "password=fictional-private-value\n",
    );
    await h.request("invoke_command", {
      command: "/agents-platform publish local-reviewer",
    });
    expect(h.demands("confirm_escalation")).toHaveLength(0);
    const invalid = await h.request("invoke_command", {
      command: "/agents-platform unknown argument",
    });
    expect(JSON.stringify(invalid)).toContain("Usage");
    expect(f.sent.some((r) => r.path === "/api/account/agents/publish")).toBe(
      false,
    );
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
