// `jsonl` input and output (SPEC-MOD-003, decision D-03).
import { describe, expect, test } from "bun:test";
import { fitEvent, jsonLine } from "../src/headless/stream-output";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const events = (stdout: string) => stdout.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("SPEC-MOD-003 jsonl output", () => {
  test("SPEC-MOD-003/CA-01 — every output line is an object parsable on its own, with type, timestamp and session id", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "content\n");
    const provider = new ScriptedProvider([{ text: "Reading.", toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "Done." }]);
    const r = await cli(["--non-interactive", "--result-format", "jsonl", "go"], ws, { provider });
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const sessionId = parsed[0]!["sessionId"];
    expect(typeof sessionId).toBe("string");
    for (const e of parsed) {
      expect(typeof e["type"]).toBe("string");
      expect(Number.isNaN(Date.parse(String(e["timestamp"])))).toBe(false);
      expect(e["sessionId"]).toBe(sessionId);
    }
    const types = parsed.map((e) => e["type"]);
    expect(types[0]).toBe("session");
    expect(types[types.length - 1]).toBe("run_completed");
    expect(types.filter((t) => t === "run_completed")).toHaveLength(1);
    // A tool call precedes its result (EF-05); the conversation can be rebuilt (EF-08).
    expect(types.indexOf("tool_call")).toBeLessThan(types.indexOf("tool_result"));
    expect(parsed.find((e) => e["type"] === "tool_call")).toMatchObject({ toolId: "read_file", input: { path: file } });
    expect(parsed.filter((e) => e["type"] === "user").map((e) => (e["content"] as Array<{ type: string }>)[0]!.type)).toEqual(["text", "tool_result"]);
    expect(parsed.filter((e) => e["type"] === "assistant" && e["partial"] === false).map((e) => e["content"])).toEqual(["Reading.", "Done."]);
    expect(parsed[parsed.length - 1]).toMatchObject({ result: "Done.", haltReason: "completed", exitCode: 0, turns: 1, iterations: 2 });
    expect(parsed[0]).toMatchObject({ model: "test-medium", tools: expect.arrayContaining(["read_file", "write_file"]) });
  });

  test("SPEC-MOD-003/CA-02 — the run fails: the closing event is still written last", async () => {
    const provider = new ScriptedProvider([{ text: "partial", stopReason: "refusal" }]);
    const failed = await cli(["--non-interactive", "--result-format", "jsonl", "x"], workspace(), { provider });
    const list = events(failed.stdout);
    expect(list[list.length - 1]).toMatchObject({ type: "run_completed", haltReason: "refusal", exitCode: 1 });
    // A failure before the session starts closes the stream too.
    const noProvider = await cli(["--non-interactive", "--result-format", "jsonl", "x"], workspace(), { userConfig: null });
    expect(noProvider.code).toBe(2);
    const closing = events(noProvider.stdout);
    expect(closing).toHaveLength(1);
    expect(closing[0]).toMatchObject({ type: "run_completed", haltReason: "error", exitCode: 2 });
  });

  test("SPEC-MOD-003/CA-06 — escape sequences of a tool result are escaped in the output", async () => {
    const ws = workspace();
    const file = ws.write("project/color.txt", "\u001b[31mred\u001b[0m and   separator\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "ok" }]);
    const r = await cli(["--non-interactive", "--result-format", "jsonl", "go"], ws, { provider });
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).not.toContain(" ");
    expect(r.stdout).toContain("\\u001b[31mred");
    const result = events(r.stdout).find((e) => e["type"] === "tool_result")!;
    expect(String(result["output"])).toContain("\u001b[31mred");
  });

  test("TECH — SPEC-MOD-003 — an event beyond the maximum size is truncated with a marker and stays one line", () => {
    const event = { type: "tool_result", output: "x".repeat(10_000), callId: "c" };
    const fitted = fitEvent(event, 1_000);
    const line = jsonLine(fitted);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1_000);
    expect(fitted).toMatchObject({ truncated: true, callId: "c" });
    expect(String(fitted["output"])).toEndWith("[… truncated]");
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  test("TECH — SPEC-MOD-003/FA-04 — thinking fragments are written only when enabled", async () => {
    const provider = () => new ScriptedProvider([{ text: "a" }]);
    const off = await cli(["--non-interactive", "--result-format", "jsonl", "x"], workspace(), { provider: provider() });
    expect(events(off.stdout).some((e) => e["type"] === "thinking")).toBe(false);
  });
});

describe("SPEC-MOD-003 jsonl input", () => {
  const line = (content: unknown) => JSON.stringify({ type: "user", content });

  test("SPEC-MOD-003/CA-04 — three messages are processed in order, in the same session", async () => {
    const provider = new ScriptedProvider([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const stdin = [line("first"), line([{ type: "text", text: "second" }]), line("third")].join("\n") + "\n";
    const r = await cli(["--non-interactive", "--request-format", "jsonl", "--result-format", "jsonl"], workspace(), { provider, stdin });
    expect(r.code).toBe(0);
    const list = events(r.stdout);
    expect(list.filter((e) => e["type"] === "turn_completed").map((e) => e["result"])).toEqual(["one", "two", "three"]);
    expect(list[list.length - 1]).toMatchObject({ type: "run_completed", turns: 3, result: "three" });
    // Same session: the third request carries the whole conversation.
    const texts = provider.requests[2]!.history.flatMap((m) => (m.role === "user" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []));
    expect(texts).toEqual(["first", "second", "third"]);
    expect(new Set(list.map((e) => e["sessionId"])).size).toBe(1);
  });

  test("SPEC-MOD-003/CA-05 — an invalid line among three: the two valid ones are processed and an error event reports the third", async () => {
    const provider = new ScriptedProvider([{ text: "one" }, { text: "two" }]);
    const stdin = [line("first"), "{not json", line("third")].join("\n");
    const r = await cli(["--non-interactive", "--request-format", "jsonl", "--result-format", "jsonl"], workspace(), { provider, stdin });
    expect(r.code).toBe(0);
    const list = events(r.stdout);
    expect(list.filter((e) => e["type"] === "turn_completed")).toHaveLength(2);
    expect(list.find((e) => e["type"] === "error")).toMatchObject({ code: "invalid_input_line", message: expect.stringContaining("ligne 2") });
  });

  test("E-050 — jsonl input with text output writes each answer; with json output one document of the whole run", async () => {
    const stdin = [line("a"), line("b")].join("\n");
    const text = await cli(["--non-interactive", "--request-format", "jsonl"], workspace(), { provider: new ScriptedProvider([{ text: "A" }, { text: "B" }]), stdin });
    expect(text.stdout).toBe("A\nB\n");
    const json = await cli(["--non-interactive", "--request-format", "jsonl", "--result-format", "json"], workspace(), { provider: new ScriptedProvider([{ text: "A" }, { text: "B" }]), stdin });
    const doc = JSON.parse(json.stdout);
    expect(doc).toMatchObject({ type: "result", result: "B", turns: 2, iterations: 2 });
  });

  test("TECH — SPEC-MOD-003/ERR-03 — binary content on the input stops the launch", async () => {
    const r = await cli(["--non-interactive"], workspace(), { provider: new ScriptedProvider([{ text: "x" }]), stdin: "abc\u0000def" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("L'entrée doit être du texte");
  });
});
