import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextOccurrence } from "../src/schedule/cron";
import { Scheduler } from "../src/schedule/engine";
import { interactive, KEY } from "./helpers/interactive";
import { workspace, cli } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import { PROJECT_DIR } from "./helpers/hooks";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "schedule-")), folder = join(root, "project"); mkdirSync(folder);
  let time = new Date(2026, 0, 5, 8, 1).getTime(); const submitted: string[] = [], proposals: string[] = [];
  const options = { folder, lock: join(root, "leader.lock"), now: () => time, random: () => 0, maxActive: () => 50, maxAgeDays: () => 7, submit: (t: { id: string }) => { submitted.push(t.id); return true; }, warn: (_: string) => {}, missed: async (t: { id: string }) => { proposals.push(t.id); return false; } };
  return { root, folder, submitted, proposals, options, time: (value: number) => { time = value; } };
}
test("SPEC-OUT-031/CA-01 — five-minute cron announces its next local occurrence", () => {
  const f = fixture(), engine = new Scheduler(f.options);
  try { const trigger = engine.create({ cron: "*/5 * * * *", prompt: "check", durable: false }); expect(new Date(trigger.nextAt).getMinutes()).toBe(5); expect(new Date(trigger.nextAt).getHours()).toBe(8); expect(engine.list()[0]?.nextLocal).toContain("08:05"); } finally { engine.close(); }
});
test("SPEC-OUT-031/CA-02 — session triggers disappear on close and are never persisted", () => {
  const f = fixture(), first = new Scheduler(f.options); first.create({ cron: "* * * * *", prompt: "check" }); first.close();
  const second = new Scheduler(f.options); try { expect(second.list()).toEqual([]); } finally { second.close(); }
});
test("SPEC-OUT-031/CA-03 — invalid and impossible expressions refuse creation", () => {
  const f = fixture(), engine = new Scheduler(f.options);
  try { for (const cron of ["bad", "60 * * * *", "*/0 * * * *", "0 0 31 2 *"]) expect(() => engine.create({ cron, prompt: "check" })).toThrow(); expect(engine.list()).toEqual([]); } finally { engine.close(); }
});
test("SPEC-PLA-001/CA-01 — two project sessions execute each five-minute occurrence only once", async () => {
  const f = fixture(), one = new Scheduler(f.options), two = new Scheduler(f.options);
  try { const trigger = one.create({ cron: "*/5 * * * *", prompt: "check", durable: true }); await one.tick(); await two.tick(); f.time(trigger.nextAt); await Promise.all([one.tick(), two.tick()]); expect(f.submitted).toEqual([trigger.id]); f.time(trigger.nextAt + 300_000); await Promise.all([two.tick(), one.tick()]); expect(f.submitted).toEqual([trigger.id, trigger.id]); } finally { one.close(); two.close(); }
});
test("SPEC-PLA-001/CA-03 — missed one-shot is proposed on startup and refusal prevents execution", async () => {
  const f = fixture(), first = new Scheduler(f.options); const trigger = first.create({ cron: "* * * * *", prompt: "check", durable: true, recurring: false }); first.close(); f.time(trigger.nextAt + 1000);
  const second = new Scheduler(f.options); try { await second.tick(); expect(f.proposals).toEqual([trigger.id]); expect(f.submitted).toEqual([]); expect(second.list()).toEqual([]); } finally { second.close(); }
});
test("SPEC-PLA-001/CA-02 — a killed native holder releases the project lock to another session", async () => {
  const f = fixture(), initial = new Scheduler(f.options); initial.create({ cron: "*/5 * * * *", prompt: "check", durable: true }); initial.close();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "schedule-holder.ts"), f.folder, f.options.lock, String(new Date(2026, 0, 5, 8, 1).getTime())], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const passive = new Scheduler(f.options);
  try { const reader = child.stdout.getReader(), result = await reader.read(); expect(new TextDecoder().decode(result.value)).toContain("leader"); await passive.tick(); expect(passive.leader).toBe(false); child.kill(); await child.exited; const started = Date.now(); await passive.tick(); expect(passive.leader).toBe(true); expect(Date.now() - started).toBeLessThan(60_000); } finally { child.kill(); await child.exited; passive.close(); }
}, 10_000);
test("TECH — real driver exposes schedule tools and refuses an invalid cron without project writes", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { cron: "bad", prompt: "check" } }] }, { text: "refused" }]);
  const result = await cli(["--non-interactive", "--allow-project-trust", "check"], ws, { provider }); expect(result.code).toBe(0); expect(provider.requests[0]!.tools.some(t => t.name === "schedule_create")).toBe(true); expect(JSON.stringify(provider.requests[1]!.history)).toContain("Expression de planification invalide");
});
test("SPEC-PLA-005/CA-01 — an executed recurrent prompt is visibly labelled and follows ordinary permissions", async () => {
  const ws = workspace(); let time = new Date(2026, 0, 5, 8, 1).getTime();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { cron: "*/5 * * * *", prompt: "scheduled witness" } }] }, { text: "created" }, { text: "executed witness" }]);
  const controller = new AbortController(), run = interactive(["--allow-project-trust"], ws, { provider, signal: controller.signal, extra: { scheduleNow: () => time, scheduleRandom: () => 0 } });
  try { await run.idle(); run.type("create" + KEY.enter); await run.waitFor(t => t.includes("created")); await run.idle(); time = new Date(2026, 0, 5, 8, 5).getTime(); await run.waitFor(t => t.includes("executed witness"), "scheduled execution", 5000); expect(run.all().join("\n")).toMatch(/planifi[ée]/); expect(JSON.stringify(provider.requests[2]!.history)).toContain("[Scheduled prompt"); expect(JSON.stringify(provider.requests[2]!.history)).toContain("ordinary execution permissions"); } finally { controller.abort(); await run.done; }
}, 12_000);
test("SPEC-PLA-005/CA-02 — deletion in the visible task panel prevents the next occurrence", async () => {
  const ws = workspace(); let time = new Date(2026, 0, 5, 8, 1).getTime();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { cron: "*/5 * * * *", prompt: "deleted witness" } }] }, { text: "created" }]);
  const controller = new AbortController(), run = interactive(["--allow-project-trust"], ws, { provider, signal: controller.signal, extra: { scheduleNow: () => time, scheduleRandom: () => 0 } });
  try { await run.idle(); run.type("create" + KEY.enter); await run.waitFor(t => t.includes("created")); await run.idle(); run.type("/background-tasks" + KEY.enter); await run.waitFor(t => t.includes("Consignes planifiées — choisir")); await Bun.sleep(380); run.type(KEY.enter); await run.waitFor(t => t.includes("Consigne planifiée — action")); await Bun.sleep(380); run.type(KEY.down + KEY.enter); await run.waitFor(t => t.includes("Consigne planifiée supprimée")); await run.idle(); time = new Date(2026, 0, 5, 8, 5).getTime(); await Bun.sleep(1300); expect(provider.requests).toHaveLength(2); run.type("/background-tasks" + KEY.enter); await run.waitFor(t => t.includes("Aucune tâche de fond")); } finally { controller.abort(); await run.done; }
}, 12_000);
test("TECH — recurrence expiry, positive jitter and corrupt-store preservation", async () => {
  const f = fixture(), engine = new Scheduler({ ...f.options, random: () => 0.5 });
  try { const t = engine.create({ cron: "* * * * *", prompt: "check", durable: true }); expect(new Date(t.nextAt).getSeconds()).toBe(2); f.time(t.createdAt + 8 * 86400_000); await engine.tick(); expect(engine.list()).toEqual([]); writeFileSync(join(f.folder, "schedules.json"), "invalid"); expect(() => engine.create({ cron: "* * * * *", prompt: "another", durable: true })).toThrow(); expect(readFileSync(join(f.folder, "schedules.json"), "utf8")).toBe("invalid"); } finally { engine.close(); }
});
test("TECH — cron skips nonexistent month days and suppresses repeated local minutes", () => {
  const leap = nextOccurrence("0 0 29 2 *", new Date(2025, 2, 1).getTime()); expect(new Date(leap).getFullYear()).toBe(2028);
  const first = nextOccurrence("* * * * *", new Date(2026, 0, 1, 8, 0).getTime()); expect(nextOccurrence("* * * * *", first, "2026-01-01T08:01")).toBe(first + 60_000);
});
test("TECH — durable creation asks permission, stores outside encryption and controlled execution uses current rules", async () => {
  const ws = workspace(); let time = new Date(2026, 0, 5, 8, 1).getTime(); let approvals = 0;
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { cron: "*/5 * * * *", prompt: "write blocked file", durable: true } }] }, { text: "created durable" }, { toolCalls: [{ name: "write_file", input: { path: join(ws.project, "blocked.txt"), content: "no" } }] }, { text: "denied scheduled" }]);
  const host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true }, answers: { approval_request: () => { approvals++; return { decision: "allow" }; } }, userConfig: { permissions: { denyRules: ["write_file(**)"] } }, extra: { scheduleNow: () => time, scheduleRandom: () => 0 } });
  try { host.user("create"); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 1); expect(approvals).toBe(1); time = new Date(2026, 0, 5, 8, 5).getTime(); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 2); expect(JSON.stringify(provider.requests[3]!.history)).toContain("Denied by the rule write_file(**)"); expect(approvals).toBe(1); } finally { host.feed.end(); await host.finish(); }
}, 10_000);
test("TECH — disabled scheduling and an untrusted project never expose automatic tools", async () => {
  for (const argv of [[], ["--allow-project-trust"]]) { const ws = workspace(), provider = new ScriptedProvider([{ text: "done" }]); await cli(["--non-interactive", ...argv, "hello"], ws, { provider, userConfig: argv.length ? { schedule: { enabled: false } } : {} }); expect(provider.requests[0]!.tools.some(t => t.name.startsWith("schedule_"))).toBe(false); }
});
test("TECH — real local timezone skips spring gaps and duplicated autumn minutes", async () => {
  const module = join(import.meta.dir, "..", "src", "schedule", "cron.ts");
  const source = `import {nextOccurrence} from ${JSON.stringify(module)}; const spring=nextOccurrence('30 2 * * *',new Date('2026-03-29T00:00:00Z').getTime()); const autumn=nextOccurrence('* * * * *',new Date('2026-10-25T00:59:00Z').getTime(),'2026-10-25T02:59'); console.log(JSON.stringify([new Date(spring).toISOString(),new Date(autumn).toISOString()]));`;
  const child = Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, TZ: "Europe/Paris" }, stdout: "pipe", stderr: "pipe" }); expect(await child.exited).toBe(0); expect(JSON.parse(await new Response(child.stdout).text())).toEqual(["2026-03-30T00:30:00.000Z", "2026-10-25T02:00:00.000Z"]);
});
test("TECH — missed one-shot startup shows a human proposal before any model request", async () => {
  const ws = workspace(), time = new Date(2026, 0, 5, 8, 1).getTime(), provider = new ScriptedProvider([]);
  const engine = new Scheduler({ folder: join(ws.project, PROJECT_DIR), lock: join(ws.configHome, "fixture.lock"), now: () => time, maxActive: () => 50, maxAgeDays: () => 7, submit: () => true, missed: async () => false, warn: () => {} });
  const trigger = engine.create({ cron: "* * * * *", prompt: "missed human witness", durable: true, recurring: false }); engine.close();
  const controller = new AbortController(), run = interactive(["--allow-project-trust"], ws, { provider, signal: controller.signal, extra: { scheduleNow: () => trigger.nextAt + 1000 } });
  try { await run.waitFor(t => t.includes("Consigne planifiée unique manquée")); expect(provider.requests).toHaveLength(0); await Bun.sleep(380); run.type("n"); await run.idle(); const file = join(ws.project, PROJECT_DIR, "schedules.json"), deadline = Date.now() + 2000; while (JSON.parse(readFileSync(file, "utf8")).triggers.length && Date.now() < deadline) await Bun.sleep(15); expect(provider.requests).toHaveLength(0); expect(JSON.parse(readFileSync(file, "utf8")).triggers).toEqual([]); } finally { controller.abort(); await run.done; }
}, 12_000);
