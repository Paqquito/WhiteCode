// File history and checkpoints of a session, and their restoration from the command line
// (SPEC-SES-006, SPEC-SES-007, SPEC-OUT-003 CA-06).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, hashBytes } from "../src/session/file-history";
import { applyPlan, computePlan } from "../src/session/restore";
import { readTranscript } from "../src/session/sessions";
import { projectKey, TranscriptWriter } from "../src/session/transcript";
import { currentPlatform } from "../src/platform/system";
import { cli, workspace, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const platform = currentPlatform();
const line = (content: string) => JSON.stringify({ type: "user", content });
const write = (path: string, content: string) => ({ name: "write_file", input: { path, content } });
const read = (path: string) => ({ name: "read_file", input: { path } });
const transcriptPath = (ws: Workspace, id: string) => join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)), `${id}.jsonl`);

/** Message 1 creates a, b and c; message 2 changes them and creates d. Returns the session and the second user message. */
async function editingSession(ws: Workspace, extra: string[] = []) {
  const [a, b, c, d] = ["a.txt", "b.txt", "c.txt", "d.txt"].map((n) => join(ws.project, n));
  const provider = new ScriptedProvider([
    { toolCalls: [write(a!, "A1\n"), write(b!, "B1\n"), write(c!, "C1\n")] },
    { text: "created" },
    { toolCalls: [read(a!), read(b!), read(c!)] },
    { toolCalls: [write(a!, "A2\n"), write(b!, "B2\n"), write(c!, "C2\n"), write(d!, "D2\n")] },
    { text: "changed" },
  ]);
  const stdin = [line("create the files"), line("change them")].join("\n") + "\n";
  const r = await cli(["--non-interactive", "--approval-mode", "auto_edit", "--request-format", "jsonl", "--result-format", "json", ...extra], ws, { provider, stdin });
  expect(r.code).toBe(0);
  const session = JSON.parse(r.stdout).sessionId as string;
  const users = readTranscript(transcriptPath(ws, session)).records.filter((x) => x.type === "user");
  return { session, message1: users[0]!.id, message2: users[1]!.id, a: a!, b: b!, c: c!, d: d! };
}

const restore = (ws: Workspace, session: string, point: string, args: string[] = [], userConfig?: Record<string, unknown> | null) =>
  cli(["--non-interactive", `--reopen=${session}`, "--restore-files", point, ...args], ws, { provider: new ScriptedProvider([]), ...(userConfig !== undefined ? { userConfig } : {}) });
const text = (path: string) => readFileSync(path, "utf8");

describe("SPEC-SES-006 file history and checkpoints", () => {
  test("SPEC-SES-006/CA-01 — SPEC-SES-007/CA-01 — three files changed and one created after message 2: restored at message 2, the three get their content back and the created one is deleted", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    const r = await restore(ws, s.session, s.message2);
    expect(r.code).toBe(0);
    expect([text(s.a), text(s.b), text(s.c)]).toEqual(["A1\n", "B1\n", "C1\n"]);
    expect(existsSync(s.d)).toBe(false);
    expect(r.stdout).toContain("Restaurés :");
    expect(r.stdout).toContain("Les effets des commandes shell ne sont pas suivis"); // EF-05
    // EF-02, EF-04: one checkpoint per user message; saved contents are stored once per fingerprint.
    const records = readTranscript(transcriptPath(ws, s.session)).records;
    expect(records.filter((x) => x.type === "file_snapshot" && x.data["kind"] === "checkpoint")).toHaveLength(2);
    const blobs = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)), s.session, "file-history");
    expect(existsSync(join(blobs, hashBytes(Buffer.from("A1\n"))))).toBe(true);
  });

  test("SPEC-OUT-003/CA-06 — a write accepted, then the rewind: the file gets its previous content back", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    expect(text(s.a)).toBe("A2\n");
    expect((await restore(ws, s.session, s.message2)).code).toBe(0);
    expect(text(s.a)).toBe("A1\n");
    // Back to message 1: the files did not exist yet.
    expect((await restore(ws, s.session, s.message1)).code).toBe(0);
    expect(existsSync(s.a)).toBe(false);
  });

  test("SPEC-SES-006/CA-03 — a file over the size limit changed by the agent: the user is warned it will not be restorable", async () => {
    const ws = workspace();
    const big = ws.write("project/big.txt", Array.from({ length: 1000 }, () => "line").join("\n"));
    const provider = new ScriptedProvider([{ toolCalls: [read(big)] }, { toolCalls: [write(big, "small")] }, { text: "done" }]);
    const r = await cli(["--non-interactive", "--approval-mode", "auto_edit", "x"], ws, { provider, userConfig: { sessions: { snapshotMaxFileSize: 1024 } } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`Fichier trop volumineux pour être sauvegardé : ${big}`);
    expect(r.stderr).toContain("il ne pourra pas être restauré");
  });

  test("SPEC-SES-006/CA-04 — SPEC-SES-006/CA-11 — SPEC-SES-007/CA-05 — a file deleted outside the agent: external conflict; without consent nothing is restored, code 5", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    rmSync(s.b);
    const r = await restore(ws, s.session, s.message2);
    expect(r.code).toBe(5);
    expect(r.stdout).toContain("Conflits externes");
    expect(r.stdout).toContain(s.b);
    expect(r.stderr).toContain("Des fichiers ont été modifiés hors de l'agent");
    expect([text(s.a), text(s.c)]).toEqual(["A2\n", "C2\n"]); // nothing else restored
    expect(existsSync(s.d)).toBe(true);
  });

  test("SPEC-SES-006/CA-05 — a file replaced by a folder: external conflict, and the folder is never removed", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    rmSync(s.c);
    mkdirSync(s.c);
    const preview = await restore(ws, s.session, s.message2, ["--dry-run", "--result-format", "json"]);
    const plan = JSON.parse(preview.stdout);
    expect(plan.conflicts.map((f: { path: string }) => f.path)).toEqual([s.c]);
    const r = await restore(ws, s.session, s.message2, ["--allow-external-overwrite", plan.fingerprint]);
    expect(r.code).toBe(6);
    expect(r.stdout).toContain("non remplacé");
    expect(text(s.a)).toBe("A1\n");
  });

  test("SPEC-SES-006/CA-06 — a file appeared where the restoration must create one: external conflict", () => {
    const ws = workspace();
    const path = join(ws.project, "gone.txt");
    const blobs = new BlobStore(join(ws.root, "blobs"));
    const before = Buffer.from("old\n");
    blobs.put(hashBytes(before), before);
    const writer = new TranscriptWriter({ sessionsDir: join(ws.root, "sessions"), projectRealPath: ws.project });
    const point = writer.append("user", { content: [{ type: "text", text: "go" }] });
    writer.append("file_snapshot", { kind: "backup", path, before: { kind: "file", hash: hashBytes(before), size: before.length } });
    writer.append("file_snapshot", { kind: "written", path, after: { kind: "absent" } }); // removed by the agent
    writer.close();
    writeFileSync(path, "someone else\n");
    const plan = computePlan({ session: writer.sessionId, records: readTranscript(writer.path).records, point, root: ws.project, blobs, maxFileSize: 1e6, denied: () => undefined, platform });
    expect(plan.conflicts.map((f) => [f.path, f.operation])).toEqual([[path, "replace"]]);
    expect(plan.operations).toEqual([]);
  });

  test("SPEC-SES-006/CA-07 — SPEC-SES-007/CA-07 — a file changed between the preview and the application: the consent is refused and a new report is produced", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    writeFileSync(s.b, "hand edit\n");
    const first = JSON.parse((await restore(ws, s.session, s.message2, ["--dry-run", "--result-format", "json"])).stdout);
    writeFileSync(s.b, "another hand edit\n");
    const r = await restore(ws, s.session, s.message2, ["--allow-external-overwrite", first.fingerprint]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("Les fichiers ont changé depuis l'aperçu : nouvel accord nécessaire.");
    expect(r.stdout).toContain("Empreinte du plan :");
    expect(r.stdout).not.toContain(first.fingerprint);
    expect(text(s.a)).toBe("A2\n");
  });

  test("SPEC-SES-006/CA-08 — SPEC-SES-006/CA-12 — a managed deny rule on a file of the plan: withdrawn and reported, the other files restored", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["write_file(b.txt)"] } }));
    const preview = await restore(ws, s.session, s.message2, ["--dry-run"]);
    expect(preview.stdout).toContain("Retirés du plan");
    expect(preview.stdout).toContain(`${s.b} — refusé par la règle write_file(b.txt)`);
    writeFileSync(s.c, "hand edit\n");
    const plan = JSON.parse((await restore(ws, s.session, s.message2, ["--dry-run", "--result-format", "json"])).stdout);
    const r = await restore(ws, s.session, s.message2, ["--allow-external-overwrite", plan.fingerprint]);
    expect(r.code).toBe(0);
    expect(text(s.b)).toBe("B2\n"); // not written, even with the consent
    expect([text(s.a), text(s.c)]).toEqual(["A1\n", "C1\n"]);
  });

  test("SPEC-SES-006/CA-10 — an incident on one file during the application: the report lists exactly the files restored and not restored", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    const dir = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)));
    const blobs = new BlobStore(join(dir, s.session, "file-history"));
    const records = readTranscript(join(dir, `${s.session}.jsonl`)).records;
    const plan = computePlan({ session: s.session, records, point: s.message2, root: ws.project, blobs, maxFileSize: 1e6, denied: () => undefined, platform });
    writeFileSync(s.c, "changed during the application\n");
    const outcome = applyPlan(plan, { blobs, maxFileSize: 1e6, record: () => {}, platform });
    expect([...outcome.restored].sort()).toEqual([s.a, s.b, s.d].sort());
    expect(outcome.failed).toEqual([{ path: s.c, reason: "modifié depuis le calcul du plan" }]);
  });
});

describe("SPEC-SES-007 restoration from the command line", () => {
  test("SPEC-SES-007/CA-02 — an invalid message identifier: code 2 and ERR-01", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    const r = await restore(ws, s.session, "not-a-message");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Point de reprise introuvable.");
  });

  test("SPEC-SES-007/CA-03 — SPEC-SES-007/CA-10 — --dry-run: files and transcript identical before and after, no restoration event", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    const before = readFileSync(transcriptPath(ws, s.session), "utf8");
    const r = await restore(ws, s.session, s.message2, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Opérations prévues :");
    expect(r.stdout).toContain(`supprimer ${s.d}`);
    expect([text(s.a), text(s.b), text(s.c), text(s.d)]).toEqual(["A2\n", "B2\n", "C2\n", "D2\n"]);
    expect(readFileSync(transcriptPath(ws, s.session), "utf8")).toBe(before);
  });

  test("SPEC-SES-007/CA-04 — SPEC-SES-007/CA-06 — a conflict in the preview with the fingerprint; with the matching consent, the file is overwritten after a backup", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    writeFileSync(s.a, "hand edit\n");
    const plan = JSON.parse((await restore(ws, s.session, s.message2, ["--dry-run", "--result-format", "json"])).stdout);
    expect(plan.conflicts.map((f: { path: string }) => f.path)).toEqual([s.a]);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const r = await restore(ws, s.session, s.message2, ["--allow-external-overwrite", plan.fingerprint]);
    expect(r.code).toBe(0);
    expect(text(s.a)).toBe("A1\n");
    // The hand edit was saved before being replaced (SPEC-SES-006 EF-08), inside the restoration event (RG-01).
    const event = readTranscript(transcriptPath(ws, s.session)).records.find((x) => x.type === "system" && x.data["event"] === "files_restored")!;
    const backups = (event.data["snapshots"] as Array<{ kind: string; path: string; before?: { hash: string } }>).filter((x) => x.kind === "backup" && x.path === s.a);
    expect(backups[0]!.before!.hash).toBe(hashBytes(Buffer.from("hand edit\n")));
  });

  test("SPEC-SES-007/CA-08 — no provider nor API key configured: the preview is produced", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    const r = await restore(ws, s.session, s.message2, ["--dry-run"], null);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Plan de restauration");
  });

  test("SPEC-SES-007/CA-09 — --dry-run with --allow-external-overwrite: refused before any effect, code 2", async () => {
    const ws = workspace();
    const s = await editingSession(ws);
    const r = await restore(ws, s.session, s.message2, ["--dry-run", "--allow-external-overwrite", "abc"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ne peuvent pas être utilisées ensemble");
    expect(text(s.a)).toBe("A2\n");
  });
});
