// Supports: SPEC-PER-015 (ordinary permission decisions, automatic confined execution and managed exit veto).
import { expect, test } from "bun:test";
import { sandboxMode, sandboxContribution, sandboxFiles, sandboxRules } from "../src/permissions/sandbox";
import { NO_PROTECTED_LOCATIONS } from "../src/permissions/paths";
import { sandboxNetworkAuthority, approveSandboxNetwork } from "../src/permissions/sandbox-network";
import { SETTING_BY_KEY } from "../src/config/settings-schema";
import { compileRaw } from "../src/shared/schema";
import { shellObservation } from "../src/interactive/shell-mode";
import { decide } from "../src/permissions/engine";
import { isRule, parseRule } from "../src/permissions/rules";
const options = { enabled: true, autoAllow: true, allowOutside: true, excludedCommands: ["device-tool"] };
const context = { mode: "ask" as const, rules: [], sessionAllows: [], managedRulesOnly: false, cwd: "/project", home: "/home/member", platform: "linux" as const };
const query = { toolName: "run_shell", subject: { kind: "command" as const, command: "build-tool test" }, flags: { readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: true }, available: true };
test("SPEC-PER-015/CA-02 — confinement auto-allows a command while explicit ask and deny rules still win", () => {
  const contribution = sandboxContribution(options, "build-tool test", false);
  expect(decide({ ...query, contribution }, context).kind).toBe("allow");
  for (const decision of ["ask", "deny"] as const) {
    const rule = parseRule("run_shell(build-tool *)", decision, "managed", "/project"); if (!isRule(rule)) throw Error("invalid fixture");
    expect(decide({ ...query, contribution }, { ...context, rules: [rule] }).kind).toBe(decision);
  }
});
test("SPEC-PER-015/CA-03 — an explicit exit or excluded command returns to ordinary approval", () => {
  expect(sandboxMode(options, "build-tool test", true)).toBe("outside");
  expect(sandboxMode(options, "device-tool inspect", false)).toBe("outside");
  expect(sandboxMode(options, "echo device-tool", false)).toBe("confined");
  expect(sandboxContribution(options, "build-tool test", true)).toBe("ask");
  expect(decide({ ...query, contribution: sandboxContribution(options, "build-tool test", true) }, context).kind).toBe("ask");
});
test("TECH — a managed exit veto applies to both explicit exits and excluded commands", () => {
  const managed = { ...options, allowOutside: false };
  expect(() => sandboxMode(managed, "build-tool test", true)).toThrow("managed");
  expect(() => sandboxMode(managed, "device-tool inspect", false)).toThrow("managed");
  expect(sandboxMode({ ...options, enabled: false }, "build-tool test", true)).toBe("disabled");
});
test("TECH — filesystem profiles grant only literal directory trees and conservatively mask restrictive path rules", () => {
  const rule = (raw: string, decision: "allow" | "deny" | "ask") => { const result = parseRule(raw, decision, "managed", "/project"); if (!isRule(result)) throw Error("fixture"); return result; };
  const files = sandboxFiles({ cwd: "/project", home: "/home/member", allowed: ["/project"], protected: NO_PROTECTED_LOCATIONS, readDenied: () => false, rules: [rule("write_file(//cache/build/**)", "allow"), rule("write_file(//cache/unsafe*/**)", "allow"), rule("read_file(//usr/share/private/**)", "deny"), rule("edit_file(/locked/**)", "ask")] });
  expect(files.writable).toEqual(["/project", "/cache/build"]);
  expect(files.hidden).toContain("/usr/share/private");
  expect(files.readonly).toContain("/project/locked");
  expect(files.writeDenied("/project/locked/a")).toBe(true);
});
test("TECH — network allowlist cannot override managed rules or hooks, and an unlisted domain uses ordinary approval", async () => {
  let requests = 0;
  const controller = new AbortController(), rule = parseRule("fetch_url(domain:allowed.test)", "deny", "managed", "/project"); if (!isRule(rule)) throw Error("fixture");
  const authorities = () => ({ human: { request: async () => { requests++; return { answer: "yes" as const }; } } });
  expect(await approveSandboxNetwork("https://allowed.test/", true, { context: () => ({ ...context, rules: [rule] }), authorities }, controller.signal)).toBe(false);
  expect(await approveSandboxNetwork("https://allowed.test/", true, { context: () => context, authorities, beforeTool: async () => ({ decision: "deny" }) }, controller.signal)).toBe(false);
  expect(requests).toBe(0);
  expect(await approveSandboxNetwork("https://new.test/", false, { context: () => context, authorities }, controller.signal)).toBe(true);
  expect(requests).toBe(1);
  controller.abort();
  await expect(approveSandboxNetwork("https://new.test/", true, { context: () => context, authorities }, controller.signal)).rejects.toThrow();
});
test("TECH — queued domain grants cannot survive permission or installed-hook generation replacement", async () => {
  let current = { ...context, decisionAuthorityVersion: ["first"] };
  const permission = sandboxNetworkAuthority(() => true, { context: () => current, authorities: () => ({}) });
  expect(await permission.authorize("https://allowed.test/", new AbortController().signal)).toBe(true);
  expect(permission.revalidate("https://allowed.test/")).toBe(true);
  current = { ...current, decisionAuthorityVersion: ["replacement"] };
  expect(permission.revalidate("https://allowed.test/")).toBe(false);
});
test("TECH — managed-only file grants exclude ordinary rules and network configuration accepts domain names only", () => {
  const rule = parseRule("write_file(//outside/cache/**)", "allow", "user", "/project"); if (!isRule(rule)) throw Error("fixture");
  expect(sandboxRules({ ...context, managedRulesOnly: true, rules: [rule] })).toEqual([]);
  const valid = compileRaw(SETTING_BY_KEY.get("sandbox.network.allowedDomains")!.schema);
  expect(valid(["allowed.test", "*.allowed.test"])).toBe(true);
  for (const entry of ["https://allowed.test/", "user@allowed.test", "bad..test", "allowed.test:80", "*", "127.0.0.1", "*.127.0.0.1"]) expect(valid([entry])).toBe(false);
});
test("TECH — unrestricted mode and a whole-tool grant do not silently enlarge the sandbox domain allowlist", async () => {
  const controller = new AbortController(), whole = parseRule("fetch_url", "allow", "user", "/project"); if (!isRule(whole)) throw Error("fixture");
  const ports = { context: () => ({ ...context, mode: "unrestricted" as const, rules: [whole] }), authorities: () => ({}) };
  expect(await approveSandboxNetwork("https://unlisted.test/", false, ports, controller.signal)).toBe(false);
  expect(await approveSandboxNetwork("https://allowed.test/", true, ports, controller.signal)).toBe(true);
});
test("TECH — a network grant keeps the context it actually approved across the final async handoff", async () => {
  let current = { ...context, decisionAuthorityVersion: ["before"] };
  const permission = sandboxNetworkAuthority(() => true, { context: () => current, authorities: () => ({}), beforeTool: async () => { queueMicrotask(() => queueMicrotask(() => { current = { ...current, decisionAuthorityVersion: ["after"] }; })); return {}; } });
  expect(await permission.authorize("https://allowed.test/", new AbortController().signal)).toBe(false);
  expect(permission.revalidate("https://allowed.test/")).toBe(false);
});
test("TECH — a confined user-shell observation includes relay violations in model context", () => {
  expect(shellObservation("fetch fixture", { output: "", exitCode: 0, timedOut: false, interrupted: false, durationMs: 20, truncated: false, sandboxed: true, violations: ["Sandbox network violation: refused.test"] }, 4000)).toContain("Sandbox network violation: refused.test");
});
test("TECH — owned worktrees retain the ordinary protected-state carve-out without exposing their ancestor", () => {
  const input = { cwd: "/private/copies/owned", home: "/home/member", allowed: ["/private/copies/owned"], rules: [], protected: { ...NO_PROTECTED_LOCATIONS, ownedWorktrees: ["/private/copies/owned"], directories: ["/private", "/private/copies/owned/config"] }, readDenied: () => false };
  expect(sandboxFiles(input).hidden).toEqual(["/private/copies/owned/config"]);
  expect(sandboxFiles({ ...input, allowed: ["/private"] }).hidden).toContain("/private");
});
