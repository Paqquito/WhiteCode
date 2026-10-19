import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Teams, type TeamNotice } from "../src/agents/teams";
import { workspace } from "./helpers/env";
async function until(predicate: () => boolean) { for (let n = 0; n < 200 && !predicate(); n++) await Bun.sleep(5); expect(predicate()).toBe(true); }
function fixture(run: ConstructorParameters<typeof Teams>[0]["run"] = async () => ({ id: "fixture-agent", text: "Complete", isError: false })) {
  const folder = join(workspace().root, "teams"), notices: TeamNotice[] = [];
  const teams = new Teams({ folder, enabled: () => true, maxMembers: () => 8, maxBytes: () => 65536, shutdownMs: () => 30, run, notify: notice => notices.push(notice), redact: text => text });
  return { teams, folder, notices };
}
test("TECH — detaching a leader preserves its live team and reconnects the pending turn before queued mail", async () => {
  const folder = join(workspace().root, "teams"), notices: TeamNotice[] = []; let stops = 0;
  const options = { folder, enabled: () => true, maxMembers: () => 8, maxBytes: () => 65536, shutdownMs: () => 30, redact: (text: string) => text, notify: (notice: TeamNotice) => notices.push(notice), detached: () => true, stop: async () => { stops++; } };
  const first = new Teams({ ...options, run: async (_input, signal) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { id: "retained", text: "Interrupted", isError: true }; } });
  first.form("review"); first.spawn("reader", "ORIGINAL_TASK"); first.tasks!.create("Shared task", { owner: "reader" }); first.send("lead", "reader", "QUEUED_MAIL_51"); const saved = first.snapshot!; await first.close(); expect(stops).toBe(0); expect(notices).toHaveLength(0);
  const calls: Array<{ attach?: boolean; prompt: string }> = [], next = new Teams({ ...options, detached: () => false, run: async input => { calls.push(input); return { id: "retained", text: "Recovered report", isError: false }; } });
  try { next.restore(saved); await until(() => calls.length === 2 && next.members[0]?.state === "idle"); expect(calls[0]).toMatchObject({ attach: true, prompt: "" }); expect(calls[1]?.attach).toBe(false); expect(calls[1]?.prompt).toContain("QUEUED_MAIL_51"); expect(calls[1]?.prompt).not.toContain("ORIGINAL_TASK"); expect(next.tasks!.tasks[0]?.owner).toBe("reader"); }
  finally { await next.close(); }
});

test("TECH — malformed saved members are all rejected before any teammate is started", async () => {
  const { teams } = fixture(); teams.form("review"); const saved = teams.snapshot!, folder = teams.options.folder; let starts = 0;
  const resumed = new Teams({ ...teams.options, folder, run: async () => { starts++; return { id: "unexpected", text: "unexpected", isError: false }; } });
  try { expect(() => resumed.restore({ ...saved, members: [{ name: "reader", state: "active" }, { name: "reader", state: "active" }] })).toThrow("Invalid saved teammate"); expect(starts).toBe(0); expect(resumed.active).toBeUndefined(); }
  finally { await teams.close(); await resumed.close(); }
});
test("TECH — a failed teammate releases its unfinished shared tasks", async () => {
  const { teams } = fixture(async () => ({ id: "failed-reader", text: "Failure", isError: true })); teams.form("review");
  try { const task = teams.tasks!.create("Work", { owner: "reader" }); teams.tasks!.update(task.id, { status: "in_progress" }); teams.spawn("reader", "Start"); await until(() => teams.members[0]?.state === "stopped"); expect(teams.tasks!.get(task.id)).toMatchObject({ owner: "", status: "pending" }); expect(teams.tasks!.update(task.id, { owner: "replacement" }).ok).toBe(true); }
  finally { await teams.close(); }
});
test("TECH — a blocking teammate waiting hook resumes the same member with its reason", async () => {
  const calls: string[] = [], folder = join(workspace().root, "teams"); let checks = 0;
  const teams = new Teams({ folder, enabled: () => true, maxMembers: () => 8, maxBytes: () => 65536, shutdownMs: () => 30, redact: value => value, notify: () => {}, run: async input => { calls.push(input.prompt); return { id: "retained", text: "Done", isError: false }; }, waiting: async () => ++checks === 1 ? "VERIFY_TEAM_WITNESS" : undefined });
  teams.form("review"); try { teams.spawn("reader", "Start"); await until(() => calls.length === 2 && teams.members[0]?.state === "idle"); expect(calls[1]).toContain("VERIFY_TEAM_WITNESS"); expect(checks).toBe(2); } finally { await teams.close(); }
});

test("SPEC-OUT-019/CA-01 — forming a team creates a private shared task list and refuses a second team", async () => {
  const { teams } = fixture();
  try { const formed = teams.form("review"); expect(existsSync(formed.tasksFile)).toBe(true); expect(JSON.parse(readFileSync(formed.tasksFile, "utf8"))).toEqual([]); expect(() => teams.form("another")).toThrow("already"); teams.tasks!.create("Shared work"); expect(readFileSync(formed.tasksFile, "utf8")).toContain("Shared work"); }
  finally { await teams.close(); }
});

test("SPEC-OUT-019/CA-02 — an idle live teammate prevents dissolution until it has stopped", async () => {
  const { teams } = fixture(); teams.form("review");
  try { teams.spawn("reader", "Read the project"); await until(() => teams.members[0]?.state === "idle"); expect(() => teams.disband()).toThrow("reader"); teams.shutdown("lead", "reader"); await until(() => teams.members[0]?.state === "stopped"); const folder = teams.active!.folder; teams.disband(); expect(existsSync(folder)).toBe(false); }
  finally { await teams.close(); }
});

test("SPEC-AGT-011/CA-01 — a teammate finishing its turn becomes idle and notifies its leader", async () => {
  const { teams, notices } = fixture(); teams.form("review");
  try { teams.spawn("reader", "Read the project"); await until(() => teams.members[0]?.state === "idle"); expect(notices).toContainEqual(expect.objectContaining({ type: "idle", from: "reader", text: "Complete" })); }
  finally { await teams.close(); }
});

test("SPEC-AGT-011/CA-02 — shutdown aborts and joins an unresponsive teammate after the configured deadline", async () => {
  let aborted = false;
  const { teams, notices } = fixture(async (_input, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); return { id: "fixture-agent", text: "Interrupted", isError: true }; }); teams.form("review");
  try { teams.spawn("reader", "Keep working"); await until(() => teams.members[0]?.state === "active"); teams.shutdown("lead", "reader"); await until(() => teams.members[0]?.state === "stopped"); expect(aborted).toBe(true); expect(notices).toContainEqual(expect.objectContaining({ type: "stopped", from: "reader", forced: true })); }
  finally { await teams.close(); }
});

test("SPEC-OUT-017/CA-01 — team broadcast deposits one intact message for every other member", async () => {
  const calls: Array<{ name: string; prompt: string }> = [], { teams } = fixture(async input => { calls.push({ name: input.name, prompt: input.prompt }); return { id: input.name, text: "Idle", isError: false }; }); teams.form("review");
  try { teams.spawn("one", "Start"); teams.spawn("two", "Start"); await until(() => teams.members.every(member => member.state === "idle")); expect(teams.send("lead", "*", "BROADCAST_WITNESS_50")).toEqual(["one", "two"]); await until(() => calls.length === 4); for (const name of ["one", "two"]) expect(calls.filter(call => call.name === name).at(-1)!.prompt).toContain("BROADCAST_WITNESS_50"); }
  finally { await teams.close(); }
});

test("SPEC-OUT-017/CA-02 — a message wakes an idle teammate with its prior conversation identifier", async () => {
  const resumes: Array<string | undefined> = [], { teams } = fixture(async input => { resumes.push(input.resume); return { id: "retained-agent", text: "Ready", isError: false }; }); teams.form("review");
  try { teams.spawn("reader", "Start"); await until(() => teams.members[0]?.state === "idle"); teams.send("lead", "reader", "Continue"); await until(() => resumes.length === 2); expect(resumes).toEqual([undefined, "retained-agent"]); }
  finally { await teams.close(); }
});

test("SPEC-AGT-013/CA-01 — twenty simultaneous messages retain order and complete content in the mailbox and next turn", async () => {
  let release!: () => void; const calls: string[] = [], { teams } = fixture(async input => { calls.push(input.prompt); if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; }); return { id: "retained-agent", text: "Ready", isError: false }; }); const active = teams.form("review");
  try { teams.spawn("reader", "Start"); await until(() => !!release); await Promise.all(Array.from({ length: 20 }, async (_, n) => teams.send("lead", "reader", `COMPLETE_MESSAGE_${n}`))); release(); await until(() => calls.length === 2); const data = JSON.parse(calls[1]!.split("\n").at(-1)!); expect(data.messages.map((message: { text: string }) => message.text)).toEqual(Array.from({ length: 20 }, (_, n) => `COMPLETE_MESSAGE_${n}`)); expect(readFileSync(join(active.folder, "mail-reader.jsonl"), "utf8").trim().split("\n")).toHaveLength(20); }
  finally { release?.(); await teams.close(); }
});
