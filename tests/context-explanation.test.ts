import { expect, test } from "bun:test";
import { Host } from "./helpers/control";
import { workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { ContextExplanations } from "../src/engine/context-explanation";

test("SPEC-CMD-090/CA-01 — actual instruction file ranks first using the corresponding request, without changing subsequent history", async () => {
  const ws = workspace(),
    identity = loadIdentity();
  const path = ws.write(
    "project/" + identity.get("INSTRUCTIONS_FILE"),
    "Always finish answers with the word ORCHID.",
  );
  // The side model selects from the captured source index, rather than a file reread after the answer.
  const provider = new ScriptedProvider([
    { text: "Work completed. ORCHID" },
    (request) => {
      const message = request.history.at(-1)!;
      expect(request.purpose).toBe("side");
      if (message.role !== "user" || message.parts[0]?.type !== "text")
        throw Error("missing index");
      const data = JSON.parse(message.parts[0].text) as {
        entries: { id: string; title: string; excerpt: string }[];
      };
      const file = data.entries.find((e) => e.title === path)!;
      expect(file.excerpt).toContain("ORCHID");
      expect(file.excerpt).not.toContain("UPDATED");
      return {
        text: JSON.stringify([
          {
            id: file.id,
            reason: "The response ends with the word required by this file.",
          },
        ]),
      };
    },
    { text: "Next answer. ORCHID" },
  ]);
  const h = new Host(ws, {
    provider,
    argv: ["--allow-project-trust"],
    userConfig: { context: { explanation: { enabled: true } } },
  });
  try {
    h.user("Finish the work.");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" && JSON.stringify(m).includes("ORCHID"),
    );
    ws.write("project/" + identity.get("INSTRUCTIONS_FILE"), "UPDATED");
    const result = JSON.stringify(
      await h.request("invoke_command", { command: "/explain-context" }),
    );
    expect(result).toContain("Estimation");
    expect(result).toContain("1. " + path.replaceAll("\\", "\\\\"));
    h.user("Continue.");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Next answer"),
    );
    const history = JSON.stringify(provider.requests[2]!.history);
    expect(history).not.toContain("explain-context");
    expect(history).not.toContain("The response ends");
    expect(history).toContain("Finish the work.");
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
}, 20000);

test("TECH — context analysis unavailable and disabled never call a model; unknown ids cannot manufacture sources", async () => {
  const p = new ScriptedProvider([]),
    h = new Host(workspace(), { provider: p });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", { command: "/explain-context" }),
      ),
    ).toContain("désactivée");
    expect(p.requests).toHaveLength(0);
  } finally {
    h.feed.end();
    await h.finish();
  }
  const c = new ContextExplanations((t) => t);
  expect(
    await c.explain(1, async () => {
      throw Error("must not call");
    }),
  ).toContain("Aucune réponse");
});
