import { profiledTest } from "./helpers/profiled-test";
import { expect, test } from "bun:test";
import { Identity } from "../src/identity/identity";
import { loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
const internalProfileTest = profiledTest(import.meta.path, "internal");

const reportIdentity = () => { const old = loadIdentity().resolved; return new Identity({ ...old, values: { ...old.values, SERVICE_FEEDBACK: { value: "https://feedback.fixture.test/report", origin: "provided" } } }); };

test("SPEC-CMD-027/CA-01 — sending feedback without attachments transmits no conversation", async () => {
  const controller = new AbortController(), bodies: string[] = [], provider = new ScriptedProvider([{ text: "PRIVATE_CONVERSATION_REPLY" }]);
  const run = interactive([], workspace(), { provider, identity: reportIdentity(), signal: controller.signal, extra: { feedbackFetch: (async (_url, init) => { bodies.push(String(init?.body)); return Response.json({ id: "feedback-id" }); }) as typeof fetch } });
  try {
    await run.idle(); run.type("PRIVATE_USER_MESSAGE" + KEY.enter); await run.waitFor(text => text.includes("PRIVATE_CONVERSATION_REPLY")); await run.idle();
    run.type("/send-feedback Improve keyboard help." + KEY.enter); await run.waitFor(text => text.includes("Relire le signalement")); expect(bodies).toHaveLength(0);
    await sleep(380); run.type("1" + KEY.enter); await run.waitFor(text => text.includes("Signalement envoyé"));
    expect(bodies).toHaveLength(1); expect(bodies[0]).toContain("Improve keyboard help."); expect(bodies[0]).not.toContain("PRIVATE_USER_MESSAGE"); expect(bodies[0]).not.toContain("PRIVATE_CONVERSATION_REPLY");
  } finally { controller.abort(); await run.done; }
}, 15_000);

async function canceledReport(command: "report-issue" | "perf-report") {
    let calls = 0; const controller = new AbortController();
    const run = interactive([], workspace(), { identity: reportIdentity(), provider: new ScriptedProvider([]), signal: controller.signal, extra: { feedbackFetch: (async (_url, _init) => { calls++; return Response.json({ id: "unused" }); }) as typeof fetch } });
    try {
      await run.idle(); run.type(`/${command}` + KEY.enter); await run.waitFor(text => text.includes("Décrire")); await sleep(380); run.type("A reproducible issue." + KEY.enter);
      await run.waitFor(text => text.includes("Relire le signalement")); expect(run.screen().join("\n")).toContain('"version"'); expect(calls).toBe(0);
      await sleep(380); run.type(KEY.enter); await run.waitFor(text => text.includes("aucun envoi")); expect(calls).toBe(0);
    } finally { controller.abort(); await run.done; }
}
{
  const test = internalProfileTest;
test("SPEC-CMD-093/CA-01 — the full issue payload is previewed and cancellation sends nothing", () => canceledReport("report-issue"), 15_000);
}

{
  const test = internalProfileTest;
test("SPEC-CMD-098/CA-01 — the performance payload is previewed and cancellation sends nothing", () => canceledReport("perf-report"), 15_000);
}


test("TECH — a long signalement preview can be read to its final line before deciding", async () => {
  let calls = 0; const controller = new AbortController();
  const run = interactive([], workspace(), { columns: 70, provider: new ScriptedProvider([]), identity: reportIdentity(), signal: controller.signal, extra: { feedbackFetch: (async (_url, _init) => { calls++; return Response.json({ id: "unused" }); }) as typeof fetch } });
  try {
    await run.idle(); run.type("/send-feedback " + "Words to review. ".repeat(80) + "FINAL_PREVIEW_WITNESS" + KEY.enter); await run.waitFor(text => text.includes("Relire le signalement"));
    await sleep(380); for (let count = 0; count < 10 && !run.screen().join("\n").includes("FINAL_PREVIEW_WITNESS"); count++) { run.type("\u001b[6~"); await sleep(25); }
    expect(run.screen().join("\n")).toContain("FINAL_PREVIEW_WITNESS"); expect(calls).toBe(0); run.type(KEY.escape);
  } finally { controller.abort(); await run.done; }
}, 15_000);

{
  const test = internalProfileTest;
test("SPEC-CMD-107/CA-01 — trace on displays the identifier actually attached to exported spans", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([{ text: "TRACE_DONE" }]); const prefix = loadIdentity().get("ENV_PREFIX");
  const exports: string[] = [];
  const run = interactive([], workspace(), { provider, signal: controller.signal, env: { OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9", OTEL_METRICS_EXPORTER: "none", OTEL_LOGS_EXPORTER: "none", [`${prefix}NO_TELEMETRY`]: "0" }, extra: { observabilityFetch: (async (_url, init) => { exports.push(String(init?.body)); return Response.json({}); }) as typeof fetch } });
  let id = "";
  try { await run.idle(); run.type("/trace on" + KEY.enter); await run.waitFor(text => /identifiant : [a-f0-9]{32}/.test(text)); id = /identifiant : ([a-f0-9]{32})/.exec(run.all().join("\n"))![1]!;
    await run.idle(); run.type("Work." + KEY.enter); await run.waitFor(text => text.includes("TRACE_DONE")); await run.idle(); run.type("/trace off" + KEY.enter); await run.waitFor(text => text.includes("Traçage manuel inactif"));
  } finally { controller.abort(); await run.done; expect(exports.join()).toContain(`"traceId":"${id}"`); }
}, 15_000);
}
