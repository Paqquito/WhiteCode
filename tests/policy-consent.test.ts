// Supports: SPEC-CFG-003 (CA-03, CA-10), SPEC-PER-021 (human consent before sensitive effects), gap E-129.
// Multi-session cases have an aggregate envelope; consent guards and every product deadline stay unchanged.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cli, workspace, loadIdentity, trustedPolicyFile, ROOT, type Workspace } from "./helpers/env";
import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { productEnv, record, BUN } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { policyConsentFileName, policyConsentPrincipal, policyConsentProposal } from "../src/config/policy-consent";
import { policyCacheSource } from "../src/config/policy-cache";
import { fingerprint } from "../src/shared/fingerprint";
import { fakeTerminal } from "./helpers/vterm";
import { askPolicyConsent } from "../src/interactive/policy-consent-dialog";
import { spawnSync } from "node:child_process";
import { inspectPolicyConsentProtection } from "../src/platform/policy-file";

const now = () => new Date("2026-10-09T12:00:00.000Z");
function provision(ws: Workspace, settings: Record<string, unknown>) {
  const envelope = JSON.stringify({ schemaVersion: 1, organizationId: "consent-test", perimeter: "all", settings: JSON.stringify(settings) });
  ws.write("managed/policy.json", "{}");
  ws.write("home/config/remote-policy-cache.json", envelope);
  ws.write("managed/cache-authorization.json", JSON.stringify({ schemaVersion: 1, organizationId: "consent-test", perimeter: "all",
    cacheSha256: createHash("sha256").update(envelope).digest("hex"), offlineAllowed: true,
    validFrom: "2026-10-09T11:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", revoked: false }));
}

function attest(ws: Workspace) {
  const text = readFileSync(join(ws.configHome, "remote-policy-consent-receipt.json"), "utf8");
  const receipt = JSON.parse(text);
  // Administrative fixture explicitly attests the answer just delivered by the human test driver.
  return ws.write(`managed/${policyConsentFileName(receipt.principal, receipt.organizationId, receipt.perimeter)}`, text);
}

test("TECH — unavailable coordination is refused before a policy dialog or consent receipt", async () => {
  const ws = workspace(); provision(ws, { hooksConfig: { disabled: false } });
  const provider = new ScriptedProvider([]);
  const terminal = interactive(["--orchestrator"], ws, { provider, rows: 60, extra: { now, coordinatorAvailable: false } });
  const result = await terminal.done;
  expect(result.code).toBe(2); expect(result.stderr).toContain("capacité de coordination");
  expect(terminal.all().join("\n")).not.toContain("Paramètres sensibles de votre organisation");
  expect(existsSync(join(ws.configHome, "remote-policy-consent-receipt.json"))).toBe(false);
  expect(provider.requests).toHaveLength(0);
});

async function accept(ws: Workspace, provider = new ScriptedProvider([]), persist = true) {
  const terminal = interactive([], ws, { provider, rows: 60, env: productEnv(ws), extra: { now } });
  await terminal.waitFor((t) => t.includes("Paramètres sensibles de votre organisation"), "policy consent dialog");
  await sleep(370);
  terminal.type("o");
  await terminal.idle();
  terminal.type("/quit" + KEY.enter);
  expect((await terminal.done).code).toBe(0);
  if (persist) attest(ws);
}

test("SPEC-PER-021/CA-01 — a new authorised offline hook is shown for human consent before its execution or provider composition", async () => {
  const ws = workspace();
  const effect = record(ws, "new-managed-hook");
  provision(ws, { hooks: { session_opened: [{ id: "new-managed-hook", actions: [{ type: "command", command: effect.command }] }] } });
  const provider = new ScriptedProvider([]);
  let factories = 0;
  const terminal = interactive([], ws, { provider, rows: 60, env: productEnv(ws), extra: { now, providerFactory: () => { factories++; return provider; } } });
  try {
    await terminal.waitFor((t) => t.includes("Paramètres sensibles de votre organisation"), "policy consent dialog");
    expect(terminal.all().join("\n")).toContain("session_opened");
    expect(terminal.all().join("\n")).toContain("new-managed-hook");
    expect(effect.read()).toHaveLength(0);
    expect(factories).toBe(0);
    terminal.type("o");
    expect(effect.read()).toHaveLength(0);
    await sleep(370);
    terminal.type("o");
    await terminal.idle();
    expect(effect.read()).toHaveLength(1);
    expect(factories).toBe(1);
  } finally { terminal.type("/quit" + KEY.enter); }
  expect((await terminal.done).code).toBe(0);
}, 20_000);

test("SPEC-PER-021/CA-04 — automated unaccepted sensitive cache fails before provider creation, hooks or project code", async () => {
  const ws = workspace();
  const effect = record(ws, "unaccepted-hook");
  provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] } });
  const provider = new ScriptedProvider([]);
  let factories = 0;
  const result = await cli(["--non-interactive", "Read the summary."], ws, { provider, env: productEnv(ws), extra: { now, providerFactory: () => { factories++; return provider; } } });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("session interactive");
  expect(effect.read()).toHaveLength(0);
  expect(factories).toBe(0);
});

test("SPEC-CFG-003/CA-03 — an accepted sensitive cache applies offline after restart without exposing its contents in the consent state", async () => {
  const ws = workspace();
  const effect = record(ws, "accepted-offline-hook");
  provision(ws, { hooks: { session_opened: [{ id: "accepted-hook", actions: [{ type: "command", command: effect.command }] }] }, ui: { history: { maxEntries: 777 } } });
  await accept(ws);
  const provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { provider, env: productEnv(ws), extra: { now } });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("777");
  expect(effect.read()).toHaveLength(2);
  expect(result.stderr).toContain("révocation inconnue");
  expect(provider.requests).toHaveLength(0);
  const state = readFileSync(join(ws.configHome, "remote-policy-consent-receipt.json"), "utf8");
  expect(state).toContain("sha256:");
  expect(state).not.toContain(effect.command);
  expect(state).not.toContain("accepted-offline-hook");
}, 20_000);

test("SPEC-PER-021/CA-02 — an authorised non-sensitive change applies without another dialog while the exact accepted hook remains active", async () => {
  const ws = workspace();
  const effect = record(ws, "same-hook");
  const hooks = { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] };
  provision(ws, { hooks, ui: { history: { maxEntries: 222 } } });
  await accept(ws);
  provision(ws, { hooks, ui: { history: { maxEntries: 777 } }, mcp: { toolDescriptionMax: 3000, connectTimeout: 13000 }, hooksConfig: { commandTimeout: 13000 } });
  const terminal = interactive([], ws, { provider: new ScriptedProvider([]), env: productEnv(ws), extra: { now } });
  try {
    await terminal.idle();
    expect(terminal.all().join("\n")).not.toContain("Paramètres sensibles de votre organisation");
    terminal.type("/preferences ui.history.maxEntries" + KEY.enter);
    await terminal.waitFor((t) => t.includes("777"), "new non-sensitive preference");
  } finally { terminal.type("/quit" + KEY.enter); }
  expect((await terminal.done).code).toBe(0);
  expect(effect.read()).toHaveLength(2);
}, 20_000);

test("SPEC-CFG-003/CA-10 — SPEC-PER-021/CA-03 — refusing a sensitive replacement suspends covered actions without running either old or new policy", async () => {
  const ws = workspace();
  const oldEffect = record(ws, "old-policy-hook");
  const newEffect = record(ws, "new-policy-hook");
  provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: oldEffect.command }] }] } });
  await accept(ws);
  const provider = new ScriptedProvider([]);
  const running = interactive([], ws, { provider, env: productEnv(ws), extra: { now } });
  await running.idle();
  expect(oldEffect.read()).toHaveLength(2);
  provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: newEffect.command }] }] } });
  try {
    running.type("Read the summary." + KEY.enter);
    await running.waitFor((t) => t.includes("adoption supplémentaire"), "suspension before covered actions");
    expect(provider.requests).toHaveLength(0);
  } finally { running.type("/quit" + KEY.enter); }
  expect((await running.done).code).toBe(0);
  const refused = interactive([], ws, { provider, env: productEnv(ws), extra: { now } });
  await refused.waitFor((t) => t.includes("Paramètres sensibles de votre organisation"), "replacement review on restart");
  await sleep(370);
  refused.type("n");
  const result = await refused.done;
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("sans application de l'ancienne politique");
  expect(oldEffect.read()).toHaveLength(2);
  expect(newEffect.read()).toHaveLength(0);
  expect(provider.requests).toHaveLength(0);
  expect((await cli(["--non-interactive", "Read the summary."], ws, { provider, extra: { now } })).code).toBe(4);
}, 20_000);

test("TECH — a policy changed or revoked during human review does not inherit the pending consent", async () => {
  for (const revoke of [false, true]) {
    const ws = workspace();
    const oldEffect = record(ws, "reviewed-hook");
    const newEffect = record(ws, "unreviewed-hook");
    provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: oldEffect.command }] }] } });
    const provider = new ScriptedProvider([]);
    const terminal = interactive([], ws, { provider, rows: 60, env: productEnv(ws), extra: { now } });
    await terminal.waitFor((t) => t.includes("Paramètres sensibles de votre organisation"), "pending consent");
    provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: newEffect.command }] }] } });
    if (revoke) {
      const path = join(ws.managed, "cache-authorization.json");
      ws.write("managed/cache-authorization.json", JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), revoked: true }));
    }
    await sleep(370);
    terminal.type("o");
    expect((await terminal.done).code).toBe(4);
    expect(provider.requests).toHaveLength(0);
    expect(oldEffect.read()).toHaveLength(0);
    expect(newEffect.read()).toHaveLength(0);
    expect(existsSync(join(ws.configHome, basename(loadIdentity().get("USER_STATE_FILE"))))).toBe(false);
  }
});

test("TECH — prior consent is qualified by organisation and perimeter; fabricated boolean approval never grants it", async () => {
  const ws = workspace();
  const effect = record(ws, "qualified-hook");
  provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] } });
  await accept(ws, new ScriptedProvider([]), false);
  const statePath = join(ws.configHome, basename(loadIdentity().get("USER_STATE_FILE")));
  const receipt = JSON.parse(readFileSync(join(ws.configHome, "remote-policy-consent-receipt.json"), "utf8"));
  for (const approvals of [{ '["other-organisation","all"]': receipt.fingerprints },
    { '["consent-test","remote"]': receipt.fingerprints }, { '["consent-test","all"]': { hooks: true } }, { '["consent-test","all"]': receipt.fingerprints }]) {
    ws.write(`home/config/${basename(statePath)}`, JSON.stringify({ policyApprovals: approvals }));
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider: new ScriptedProvider([]), extra: { now } })).code).toBe(4);
  }
  expect(effect.read()).toHaveLength(1);
}, 20_000);

test("TECH — an unrestricted agent can write a receipt but cannot forge a durable human grant", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", "{}");
  ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, JSON.stringify({ unrestrictedAccepted: true }));
  const effect = record(ws, "future-sensitive-hook");
  const settings = { hooks: { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] } };
  const proposal = policyConsentProposal(JSON.stringify(settings), "consent-test", "all", "anticipated-authority")!;
  const receiptFile = join(ws.configHome, "remote-policy-consent-receipt.json");
  const content = JSON.stringify({ schemaVersion: 1, principal: policyConsentPrincipal(), organizationId: proposal.organizationId, perimeter: proposal.perimeter, fingerprints: proposal.fingerprints });
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: receiptFile, content } }] }, { text: "done" }]);
  expect((await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "Write the receipt."], ws, { provider, env: productEnv(ws), extra: { now } })).code).toBe(0);
  expect(readFileSync(receiptFile, "utf8")).toBe(content);
  provision(ws, settings);
  expect((await cli(["--non-interactive", "Read the summary."], ws, { provider: new ScriptedProvider([]), extra: { now } })).code).toBe(4);
  expect(effect.read()).toHaveLength(0);
});

test("TECH — malformed or scope-substituted attestations never turn their protected file into a consent grant", async () => {
  const ws = workspace();
  const effect = record(ws, "attested-hook");
  provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] } });
  await accept(ws);
  const receipt = JSON.parse(readFileSync(join(ws.configHome, "remote-policy-consent-receipt.json"), "utf8"));
  const file = `managed/${policyConsentFileName(receipt.principal, receipt.organizationId, receipt.perimeter)}`;
  for (const invalid of [JSON.stringify({ ...receipt, principal: "other-native-account" }), JSON.stringify({ ...receipt, organizationId: "other-org" }),
    JSON.stringify({ ...receipt, perimeter: "remote" }), JSON.stringify({ ...receipt, fingerprints: { hooks: true } }),
    JSON.stringify({ ...receipt, extra: true }), JSON.stringify(receipt).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')]) {
    ws.write(file, invalid);
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider: new ScriptedProvider([]), extra: { now } })).code).toBe(4);
  }
  expect(effect.read()).toHaveLength(1);
});

test.each([
    [{ hooksConfig: { disabled: true } }, { hooksConfig: { disabled: false } }],
    [{ hooksConfig: { disabled: true } }, {}],
    [{ hooksConfig: { managedOnly: true } }, {}],
    [{ hooksConfig: { http: { allowedEnvVars: [] } } }, { hooksConfig: { http: { allowedEnvVars: ["SECRET"] } } }],
    [{ hooksConfig: { http: { allowedUrls: ["https://allowed.invalid"] } } }, {}],
    [{ extensions: { managedOnly: true } }, { extensions: { managedOnly: false } }],
    [{ extensions: { managedOnly: true } }, {}],
    [{ extensions: { enabled: { absent: true } } }, {}],
    [{ extensions: { blocked: ["blocked@catalog"] } }, {}],
    [{ extensions: { blockedCatalogs: ["catalog"] } }, {}],
    [{ extensions: { strictCatalogs: ["catalog"] } }, {}],
  ])("TECH — hook enablement, environment exposure and removal of execution controls require fresh human review, case %#", async (before, after) => {
    const ws = workspace();
    const effect = record(ws, "controlled-hook");
    const hooks = { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] };
    provision(ws, { hooks, ...before });
    await accept(ws);
    const previous = effect.read().length;
    provision(ws, { hooks, ...after });
    const provider = new ScriptedProvider([]);
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider, extra: { now } })).code).toBe(4);
    expect(effect.read()).toHaveLength(previous);
    expect(provider.requests).toHaveLength(0);
});

test("TECH — incomplete Escape, paste, paging and resize cannot accidentally accept unreviewed content", async () => {
  const proposal = policyConsentProposal(JSON.stringify({ hooks: { session_opened: [{ actions: [{ type: "command", command: "x".repeat(800) }] }] } }), "dialog", "all", "authority")!;
  const terminal = fakeTerminal(12, 5);
  const outcome = askPolicyConsent(terminal, proposal);
  let answered = false;
  void outcome.then(() => { answered = true; });
  await sleep(370);
  terminal.type("o");
  terminal.type("\u001b[200~o\u001b[201~");
  expect(answered).toBe(false);
  terminal.resize(100, 12);
  await sleep(370);
  terminal.type("o");
  expect(answered).toBe(false);
  terminal.type(KEY.escape);
  expect(await outcome).toBe(false);
  expect(terminal.vt.raw).toBe(false);
  const abort = new AbortController();
  const interrupted = askPolicyConsent(fakeTerminal(), proposal, abort.signal);
  abort.abort();
  expect(await interrupted).toBe(false);
});

test("TECH — a bracketed paste split across a delay never supplies a consent key", async () => {
  const proposal = policyConsentProposal(JSON.stringify({ hooksConfig: { disabled: false } }), "paste", "all", "authority")!;
  const terminal = fakeTerminal(100, 60);
  const outcome = askPolicyConsent(terminal, proposal);
  let answered = false;
  void outcome.then(() => { answered = true; });
  await sleep(370);
  terminal.type("\u001b[200~pasted text");
  await sleep(60);
  terminal.type("o\u001b[201~");
  await sleep(60);
  expect(answered).toBe(false);
  terminal.type(KEY.escape);
  expect(await outcome).toBe(false);
});

test("TECH — consent authority is protected, principal-qualified and expires during its own read", async () => {
  const ws = workspace();
  provision(ws, { hooks: { session_opened: [{ actions: [{ type: "command", command: "exit 0" }] }] } });
  await accept(ws);
  expect(inspectPolicyConsentProtection(attest(ws)).writable).toBe(true);
  const native = policyConsentPrincipal();
  const child = spawnSync(BUN, ["-e", "import { policyConsentPrincipal } from './src/config/policy-consent'; process.stdout.write(policyConsentPrincipal())"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, USERPROFILE: join(ws.home, "forged-profile"), USERNAME: "forged-user", HOME: join(ws.home, "forged-home") } });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(native);
  let time = now().getTime();
  const source = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, (file) => {
    if (basename(file).startsWith("cache-consent.")) time += 3_600_000;
    return trustedPolicyFile(file);
  }, () => time);
  expect(source.read().issues.some((i) => i.message.includes("validité hors ligne perdue"))).toBe(true);
  const modifiable = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined,
    (file) => basename(file).startsWith("cache-consent.") ? { writable: true } : trustedPolicyFile(file), () => now().getTime());
  expect(modifiable.read().issues.some((i) => i.severity === "error")).toBe(true);
  // A well-formed receipt for another scope lives at another protected name and cannot grant this scope.
  const foreign = { schemaVersion: 1, principal: native, organizationId: "other-org", perimeter: "all", fingerprints: { hooks: fingerprint({}) } };
  ws.write(`managed/${policyConsentFileName(native, "other-org", "all")}`, JSON.stringify(foreign));
  expect(policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, trustedPolicyFile, () => now().getTime()).read().proposal).toBeUndefined();
});

test.each([false, true])("TECH — remote-only sensitive policy is reviewable from a normal interactive launch and refusal preserves local work, consent %s", async (consent) => {
    const ws = workspace();
    const effect = record(ws, "remote-sensitive-hook");
    const settings = JSON.stringify({ hooks: { session_opened: [{ actions: [{ type: "command", command: effect.command }] }] } });
    const envelope = JSON.stringify({ schemaVersion: 1, organizationId: "consent-test", perimeter: "remote", settings });
    provision(ws, {});
    ws.write("home/config/remote-policy-cache.json", envelope);
    const auth = JSON.parse(readFileSync(join(ws.managed, "cache-authorization.json"), "utf8"));
    ws.write("managed/cache-authorization.json", JSON.stringify({ ...auth, perimeter: "remote", cacheSha256: createHash("sha256").update(envelope).digest("hex") }));
    const terminal = interactive([], ws, { provider: new ScriptedProvider([]), rows: 60, env: productEnv(ws), extra: { now } });
    await terminal.waitFor((t) => t.includes("Paramètres sensibles de votre organisation"), "remote review in ordinary launch");
    await sleep(370);
    terminal.type(consent ? "o" : "n");
    await terminal.idle();
    terminal.type("/quit" + KEY.enter);
    expect((await terminal.done).code).toBe(0);
    expect(effect.read()).toHaveLength(consent ? 1 : 0);
    if (consent) attest(ws);
    const result = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { env: productEnv(ws), extra: { now, policyCapability: "remote" } });
    if (!consent) expect(result.code).toBe(4);
    else expect(result.code).toBe(0);
});
