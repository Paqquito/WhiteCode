import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, TEST_USER_CONFIG, loadIdentity } from "./helpers/env";
import { Identity } from "../src/identity/identity";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { FeatureFlags, type FeatureFlagOptions } from "../src/config/feature-flags";
import { convertDeprecated } from "../src/config/deprecated";
import { writeFileSync } from "node:fs";
function flags(extra: Partial<FeatureFlagOptions> = {}) { const ws = workspace(); return new FeatureFlags({ cache: join(ws.configHome, "feature-flags.json"), compiled: true, version: "test", platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", disabled: false, intervalMs: 3600_000, internal: false, fetch: (async () => { throw new Error("offline"); }) as FeatureFlagOptions["fetch"], ...extra }); }
test("SPEC-CFG-014/CA-01 — offline startup immediately uses its validated cache and does not wait for refresh", async () => {
  const ws = workspace(), cache = join(ws.configHome, "flags.json"); writeFileSync(cache, JSON.stringify({ values: { schedule_jitter_ms: 25, scheduled_triggers: false } }));
  const client = flags({ url: "https://flags.invalid/values", cache }); const before = client.snapshot(); expect(before).toEqual({ schedule_jitter_ms: 25, scheduled_triggers: false });
  await client.refresh(); expect(client.snapshot()).toEqual(before); client.close();
  const base = loadIdentity().resolved, identity = new Identity({ ...base, values: { ...base.values, SERVICE_FEATURE_FLAGS: { ...base.values["SERVICE_DOCS"]!, value: "https://flags.invalid/values" } } });
  let calls = 0; writeFileSync(join(ws.configHome, "feature-flags.json"), JSON.stringify({ values: { scheduled_triggers: false } }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { cron: "* * * * *", prompt: "check" } }] }, { text: "done" }]);
  const run = await cli(["--non-interactive", "--allow-project-trust", "hello"], ws, { provider, identity, extra: { featureFlagsFetch: (_url, init) => { calls++; return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))); } } }); expect(run.code).toBe(0); expect(calls).toBe(1); expect(JSON.stringify(provider.requests[1]?.history)).toContain("Scheduled prompts are currently disabled");
});
test("SPEC-CFG-014/CA-02 — a remote flag cannot introduce a compiled-out feature or change a permission", async () => {
  let body: Record<string, unknown> = {}; const client = flags({ url: "https://flags.invalid/values", compiled: false, fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ values: { scheduled_triggers: true, schedule_jitter_ms: 30, permissions: "unrestricted" } }); }) as FeatureFlagOptions["fetch"] });
  await client.refresh(); expect(client.snapshot()).toEqual({ scheduled_triggers: false, schedule_jitter_ms: 30 }); expect(Object.keys(body).sort()).toEqual(["installation", "platform", "version"]); expect(client.lastRefresh).toBeDefined(); client.close();
});
test("SPEC-CFG-014/CA-03 — absent dynamic service emits no requests during a real startup", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({ values: {} }); }) as FeatureFlagOptions["fetch"];
  const client = flags({ fetch: fetcher }); client.start(); await client.refresh(); client.close();
  const result = await cli(["--non-interactive", "/status"], workspace(), { provider: new ScriptedProvider([]), extra: { featureFlagsFetch: fetcher } }); expect(result.code).toBe(0); expect(calls).toBe(0);
});
test("TECH — dynamic snapshots remain frozen, managed disable emits no network, and public overrides are ignored", async () => {
  const client = flags({ url: "https://flags.invalid/values", overrides: '{"scheduled_triggers":false}', fetch: (async () => Response.json({ values: { scheduled_triggers: false, schedule_jitter_ms: -1 } })) as FeatureFlagOptions["fetch"] }); const turn = client.snapshot(); expect(turn.scheduled_triggers).toBe(true); await client.refresh(); expect(turn.scheduled_triggers).toBe(true); expect(Object.isFrozen(turn)).toBe(true); expect(client.snapshot()).toEqual({ scheduled_triggers: false, schedule_jitter_ms: 5000 }); client.close();
  let calls = 0; const disabled = flags({ url: "https://flags.invalid/values", disabled: true, fetch: (async () => { calls++; return Response.json({ values: {} }); }) as FeatureFlagOptions["fetch"] }); disabled.start(); await disabled.refresh(); disabled.close(); expect(calls).toBe(0);
  expect(convertDeprecated('{"ui":{"compactWelcome":true}, BROKEN')).toEqual({ text: '{"ui":{"compactWelcome":true}, BROKEN', changed: false });
});
test("TECH — a policy change aborts an in-flight flag refresh and leaves the previous turn unchanged", async () => {
  let enabled = true, started!: () => void; const beginning = new Promise<void>(resolve => { started = resolve; });
  const client = flags({ url: "https://flags.invalid/values", canRefresh: () => enabled, fetch: (_url, init) => { started(); return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")))); } }); const turn = client.snapshot(); const pending = client.refresh(); await beginning; enabled = false; client.recheck(); await pending; expect(client.snapshot()).toBe(turn); expect(client.lastRefresh).toBeUndefined(); client.close();
});
function oldConfig() { const ws = workspace(); ws.write("home/config/config.json", JSON.stringify({ ...TEST_USER_CONFIG, ui: { compactWelcome: true } })); return ws; }
test("SPEC-CFG-009/CA-01 — startup migrates a renamed user key with a backup and a state journal", async () => {
  const ws = oldConfig(), before = readFileSync(join(ws.configHome, "config.json"), "utf8"), provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "/status"], ws, { provider, userConfig: null }); expect(result.code).toBe(0);
  const value = JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")); expect(value.ui.welcome.compact).toBe(true); expect(value.ui.compactWelcome).toBeUndefined();
  const backups = readdirSync(join(ws.configHome, "migration-backups")); expect(backups).toHaveLength(1); expect(readFileSync(join(ws.configHome, "migration-backups", backups[0]!), "utf8")).toBe(before);
  expect(JSON.parse(readFileSync(join(ws.configHome, "state.json"), "utf8")).migrations).toContain("20261013-ui-compact-welcome"); expect(result.stderr).toContain("Migration"); expect(provider.requests).toHaveLength(0);
});
test("SPEC-CFG-009/CA-02 — a completed migration is not applied again on the next startup", async () => {
  const ws = oldConfig(); for (let n = 0; n < 2; n++) await cli(["--non-interactive", "/status"], ws, { provider: new ScriptedProvider([]), userConfig: null });
  expect(readdirSync(join(ws.configHome, "migration-backups"))).toHaveLength(1); expect(JSON.parse(readFileSync(join(ws.configHome, "state.json"), "utf8")).migrations).toEqual(["20261013-ui-compact-welcome"]);
});
test("SPEC-CFG-009/CA-03 — an interrupted migration restores the original file and warns, then retries", async () => {
  const ws = oldConfig(), path = join(ws.configHome, "config.json"), original = readFileSync(path, "utf8");
  const result = await cli(["--non-interactive", "/status"], ws, { provider: new ScriptedProvider([]), userConfig: null, extra: { migrationFault: () => { throw new Error("fixture interruption"); } } });
  expect(result.code).toBe(0); expect(result.stderr).toContain("configuration impossible"); expect(readFileSync(path, "utf8")).toBe(original);
  await cli(["--non-interactive", "/status"], ws, { provider: new ScriptedProvider([]), userConfig: null }); expect(JSON.parse(readFileSync(path, "utf8")).ui.welcome.compact).toBe(true);
});
