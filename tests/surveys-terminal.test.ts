// Supports: SPEC-IHM-037, SPEC-CMD-099 (real terminal composition and per-send consent).
import { expect, test } from "bun:test";
import { Identity } from "../src/identity/identity";
import { workspace, loadIdentity } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
function setup() {
  const ws = workspace(),
    original = loadIdentity(),
    sent: unknown[] = [],
    identity = new Identity({
      ...original.resolved,
      values: {
        ...original.resolved.values,
        SERVICE_FEEDBACK: {
          origin: "provided",
          value: "https://feedback.example.test/",
        },
      },
    });
  return {
    ws,
    identity,
    sent,
    extra: {
      surveyRandom: () => 0,
      feedbackFetch: (async (_input: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "feedback-one" });
      }) as typeof fetch,
    },
  };
}
test("TECH — a bad rating in the actual terminal followed by refused sharing sends nothing", async () => {
  const f = setup(),
    controller = new AbortController(),
    run = interactive([], f.ws, {
      identity: f.identity,
      extra: f.extra,
      signal: controller.signal,
      provider: new ScriptedProvider([{ text: "Survey answer" }]),
      columns: 180,
      rows: 40,
    });
  try {
    await run.idle();
    run.type("Work" + KEY.enter);
    await run.waitFor((text) => text.includes("Alt+3 mal"));
    run.type("\u001b3");
    await run.waitFor((text) => text.includes("Partager cet échange"));
    await sleep(400);
    run.type(KEY.enter);
    await run.waitFor(
      (text) => !run.screen().join("\n").includes("Partager cet échange"),
    );
    expect(f.sent).toEqual([]);
  } finally {
    controller.abort();
    await run.done;
  }
}, 10000);
test("TECH — managed survey disabling wins over user preference in an actual terminal", async () => {
  const f = setup();
  f.ws.write(
    "managed/policy.json",
    JSON.stringify({ ui: { surveys: { enabled: false } } }),
  );
  const controller = new AbortController(),
    run = interactive([], f.ws, {
      identity: f.identity,
      extra: f.extra,
      signal: controller.signal,
      provider: new ScriptedProvider([{ text: "Disabled survey answer" }]),
    });
  try {
    await run.idle();
    run.type("Work" + KEY.enter);
    await run.waitFor((text) => text.includes("Disabled survey answer"));
    await sleep(100);
    expect(run.all().join("\n")).not.toContain("Alt+3 mal");
    expect(f.sent).toEqual([]);
  } finally {
    controller.abort();
    await run.done;
  }
}, 10000);
test("TECH — the actual praise command sends only its comment when attachment is refused", async () => {
  const f = setup(),
    controller = new AbortController(),
    run = interactive([], f.ws, {
      identity: f.identity,
      extra: f.extra,
      signal: controller.signal,
      provider: new ScriptedProvider([]),
    });
  try {
    await run.idle();
    run.type("/praise Clear useful answer" + KEY.enter);
    await run.waitFor((text) => text.includes("Joindre l’échange récent"));
    await sleep(400);
    run.type(KEY.enter);
    await run.waitFor((text) => text.includes("Envoyer ce retour positif"));
    await sleep(400);
    run.type("o");
    await run.waitFor((text) => text.includes("Retour positif envoyé"));
    expect(f.sent).toEqual([
      { kind: "positive", comment: "Clear useful answer" },
    ]);
  } finally {
    controller.abort();
    await run.done;
  }
}, 10000);
