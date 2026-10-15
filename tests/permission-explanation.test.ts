// Implements: SPEC-PER-013/CA-01 (real pending terminal dialog and informational model branch).
import { expect, test } from "bun:test";
import { parsePermissionExplanation } from "../src/permissions/explanation";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { productEnv } from "./helpers/hooks";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-PER-013/CA-01 — the human requests an explanation while permission stays pending and can still refuse the command", async () => {
  const ws = workspace(),
    controller = new AbortController(),
    provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "run_shell",
            input: { command: "printf permission-witness" },
          },
        ],
      },
      {
        text: JSON.stringify({
          summary: "Affiche un témoin",
          reason: "Vérifier la sortie du terminal",
          risk: "low",
          risks: [
            "Écrit seulement sur la sortie standard ; vérifier les redirections éventuelles.",
          ],
        }),
      },
      { text: "Command declined receipt" },
    ]);
  const run = interactive([], ws, {
    provider,
    env: productEnv(ws),
    signal: controller.signal,
    rows: 60,
    columns: 180,
  });
  try {
    await run.idle();
    run.type("Try command" + KEY.enter);
    await run.waitFor((text) => text.includes("Expliquer cette commande"));
    expect(provider.requests).toHaveLength(1);
    await sleep(380);
    const text = run.all().join("\n"),
      choice = /([1-9])\. Expliquer cette commande/.exec(text)?.[1];
    expect(choice).toBeDefined();
    run.type(choice!);
    await run.waitFor(
      (text) =>
        text.includes("Résumé : Affiche un témoin") &&
        text.includes("Risque : faible"),
    );
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.purpose).toBe("side");
    expect(provider.requests[1]?.tools).toHaveLength(0);
    expect(run.screen().join("\n")).toContain("Autorisation requise");
    run.type(KEY.escape);
    await run.waitFor((text) => text.includes("Command declined receipt"));
    expect(JSON.stringify(provider.requests[2]?.history)).toContain(
      "Action denied",
    );
  } finally {
    controller.abort();
    await run.done;
  }
}, 15000);
test("TECH — a permission explanation cannot smuggle a decision or an unbounded display value", () => {
  const value = {
    summary: "Summary",
    reason: "Reason",
    risk: "low" as const,
    risks: ["Reason for risk"],
  };
  expect(parsePermissionExplanation(JSON.stringify(value))).toEqual(value);
  expect(
    parsePermissionExplanation(JSON.stringify({ ...value, decision: "allow" })),
  ).toBeUndefined();
  expect(
    parsePermissionExplanation(
      JSON.stringify({ ...value, summary: "x".repeat(513) }),
    ),
  ).toBeUndefined();
});
