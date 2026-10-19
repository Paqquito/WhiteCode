// Supports: SPEC-IHM-037, SPEC-CMD-099 (real terminal composition and per-send consent).
import { expect, test } from "bun:test";
import { Identity } from "../src/identity/identity";
import { workspace, loadIdentity } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import type { ModelProvider } from "../src/providers/types";
import { profiledTest } from "./helpers/profiled-test";
const internalTest = profiledTest(import.meta.path, "internal");

{
const test = internalTest;
test("TECH — typing and erasing a draft during a real turn clears its deferred targeted survey without sending anything", async () => {
  const f = setup(), controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scripted = new ScriptedProvider([{text: "TARGETED TURN FINISHED"}]);
  const provider: ModelProvider = { id: "targeted-input-fixture", async *stream(request, signal) {
    yield {type: "text_delta", text: "TARGETED TURN WAITING"};
    signal.addEventListener("abort", release, {once: true});
    try { await gate; if (!signal.aborted) yield* scripted.stream(request, signal); }
    finally { signal.removeEventListener("abort", release); }
  }};
  const run = interactive([], f.ws, {identity: f.identity, extra: f.extra, signal: controller.signal, provider, columns: 180, rows: 40});
  try {
    await run.idle(); run.type("Ça ne marche pas !" + KEY.enter);
    await run.waitFor(text => text.includes("TARGETED TURN WAITING"));
    run.type("x" + KEY.ctrlU); release();
    await run.waitFor(text => text.includes("TARGETED TURN FINISHED") && text.includes("Alt+3 mal"));
    expect(run.screen().join("\n")).not.toContain("Un problème dans cet échange");
    expect(f.sent).toEqual([]);
  } finally { release(); controller.abort(); await run.done; }
}, 10000);
}
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
{
const test = internalTest;
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
}
