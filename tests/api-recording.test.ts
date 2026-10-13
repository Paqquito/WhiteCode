// Supports: SPEC-OBS-018; root recording/replay, bounded private references.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { requestFingerprint, withApiRecording } from "../src/providers/api-recording";
import type { ModelEvent } from "../src/providers/types";

test("TECH — ephemeral sessions reject reference-writing modes before any provider request or reference directory", async () => {
  for (const mode of ["record", "auto"]) {
    const ws = workspace(), p = new ScriptedProvider([]), prefix = loadIdentity().get("ENV_PREFIX"), directory = join(ws.root, "references");
    const r = await cli(["--non-interactive", "--ephemeral", "x"], ws, { provider: p, env: { [`${prefix}API_RECORDING`]: mode, [`${prefix}API_RECORDING_DIR`]: directory }, extra: { allowApiRecording: true } });
    expect(r.code).toBe(2); expect(r.stderr).toContain("incompatible avec une session éphémère"); expect(p.requests).toHaveLength(0); expect(existsSync(directory)).toBe(false);
  }
});

test("SPEC-OBS-018/CA-01 — the same real request replays its recorded response without calling its provider", async () => {
  const ws = workspace(), prefix = loadIdentity().get("ENV_PREFIX"), directory = join(ws.root, "references");
  const env = { [`${prefix}API_RECORDING_DIR`]: directory };
  const p = new ScriptedProvider([{ text: "recorded answer" }]);
  const a = await cli(["--non-interactive", "identical"], ws, { provider: p, env: { ...env, [`${prefix}API_RECORDING`]: "record" }, extra: { allowApiRecording: true } });
  const unused = new ScriptedProvider([{ text: "wrong" }]);
  const b = await cli(["--non-interactive", "identical"], ws, { provider: unused, env: { ...env, [`${prefix}API_RECORDING`]: "replay" }, extra: { allowApiRecording: true } });
  expect(a.code).toBe(0); expect(b.code).toBe(0); expect(b.stdout).toBe(a.stdout); expect(unused.requests).toHaveLength(0);
  expect(b.stderr).toContain("replay"); expect(readdirSync(directory)).toHaveLength(1);
});

test("TECH — auto records missing references, preserves stream chunks and normalizes random request IDs", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ text: "obtain request" }]);
  await cli(["--non-interactive", "x"], ws, { provider: p });
  const request = p.requests[0]!, source = new ScriptedProvider([{ text: "chunk", toolCalls: [{ name: "find_files", input: { pattern: "*.txt" } }] }]);
  const directory = join(ws.root, "auto"), wrapped = withApiRecording(source, { mode: "auto", directory, secrets: [] }), signal = new AbortController().signal;
  const original: ModelEvent[] = [], replayed: ModelEvent[] = [];
  for await (const e of wrapped.stream(request, signal)) original.push(e);
  for await (const e of wrapped.stream({ ...request, conversationId: "different-random-id" }, signal)) replayed.push(e);
  expect(replayed).toEqual(original); expect(source.requests).toHaveLength(1);
  const saved = join(directory, readdirSync(directory)[0]!); writeFileSync(saved, JSON.stringify({ version: 1, key: requestFingerprint(request), events: [{ type: "unknown" }] }));
  const collect = async () => { for await (const _e of wrapped.stream(request, signal)) {} };
  await expect(collect()).rejects.toThrow("Référence API invalide");
});

test("SPEC-OBS-018/CA-02 — a missing replay reference names its fingerprint and never calls the provider", async () => {
  const ws = workspace(), prefix = loadIdentity().get("ENV_PREFIX"), p = new ScriptedProvider([]);
  const r = await cli(["--non-interactive", "missing"], ws, { provider: p, env: { [`${prefix}API_RECORDING`]: "replay", [`${prefix}API_RECORDING_DIR`]: join(ws.root, "missing") }, extra: { allowApiRecording: true } });
  expect(r.code).not.toBe(0); expect(r.stderr).toContain("Aucune réponse enregistrée"); expect(r.stderr).toMatch(/[a-f0-9]{64}/); expect(p.requests).toHaveLength(0);
});

test("TECH — public builds refuse API references and known credentials are removed from recorded responses", async () => {
  const ws = workspace(), prefix = loadIdentity().get("ENV_PREFIX"), directory = join(ws.root, "references"), p = new ScriptedProvider([{ text: "dummy-fixture-secret" }]);
  const env = { [`${prefix}API_RECORDING`]: "record", [`${prefix}API_RECORDING_DIR`]: directory, OPENAI_API_KEY: "dummy-fixture-secret" };
  const denied = await cli(["--non-interactive", "x"], ws, { provider: p, env });
  expect(denied.code).toBe(2); expect(p.requests).toHaveLength(0);
  const recorded = await cli(["--non-interactive", "x"], ws, { provider: p, env, extra: { allowApiRecording: true } });
  expect(recorded.code).toBe(0); expect(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8")).not.toContain("dummy-fixture-secret");
});
