import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeProjectKey, effectiveMeta, projectKey, readTranscript, TranscriptWriter } from "../src/session/transcript";
import { ROOT, workspace } from "./helpers/env";

describe("SPEC-SES-001 transcripts", () => {
  test("SPEC-SES-001/CA-01 — a process killed brutally leaves three complete exchanges", async () => {
    const ws = workspace();
    const script = ws.write(
      "writer.ts",
      [
        `import { TranscriptWriter } from ${JSON.stringify(join(ROOT, "src/session/transcript.ts"))};`,
        `const w = new TranscriptWriter({ sessionsDir: ${JSON.stringify(join(ws.root, "sessions"))}, projectRealPath: "/p", sessionId: "s1" });`,
        `w.append("session_meta", { title: "t" });`,
        `for (let i = 1; i <= 3; i++) { w.append("user", { text: "q" + i }); w.append("assistant", { text: "a" + i }); }`,
        `process.kill(process.pid, "SIGKILL");`,
        `await new Promise((r) => setTimeout(r, 10_000));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    const dir = join(ws.root, "sessions", projectKey("/p"));
    const { records } = readTranscript(join(dir, "s1.jsonl"));
    expect(records.filter((r) => r.type === "user").map((r) => r.data["text"])).toEqual(["q1", "q2", "q3"]);
    expect(records.filter((r) => r.type === "assistant")).toHaveLength(3);
  });

  test("SPEC-SES-001/CA-02 — a truncated last line is ignored, previous lines stay usable", () => {
    const ws = workspace();
    const w = new TranscriptWriter({ sessionsDir: ws.root, projectRealPath: "/p" });
    w.append("user", { text: "hello" });
    w.append("assistant", { text: "hi" });
    w.close();
    appendFileSync(w.path, '{"v":1,"type":"user","id":"x","da');
    const r = readTranscript(w.path);
    expect(r.records).toHaveLength(2);
    expect(r.skippedLines).toBe(1);
  });

  test("SPEC-SES-001/CA-03 — after a rename the effective title is the last recorded one", () => {
    const ws = workspace();
    const w = new TranscriptWriter({ sessionsDir: ws.root, projectRealPath: "/p" });
    w.append("session_meta", { title: "first" });
    w.append("user", { text: "q" });
    w.append("session_meta", { title: "second" });
    w.close();
    expect(effectiveMeta(readTranscript(w.path).records)["title"]).toBe("second");
  });

  test("TECH — records chain their parents; the project key is reversible and file-system safe", () => {
    const ws = workspace();
    const w = new TranscriptWriter({ sessionsDir: ws.root, projectRealPath: "C:\\Users\\a b\\é" });
    const a = w.append("user", { text: "1" });
    w.append("assistant", { text: "2" });
    w.close();
    const recs = readTranscript(w.path).records;
    expect(recs[1]!.parentId).toBe(a);
    const key = projectKey("C:\\Users\\a b\\é");
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(decodeProjectKey(key)).toBe("C:\\Users\\a b\\é");
    expect(readdirSync(ws.root)).toContain(key);
  });
});
