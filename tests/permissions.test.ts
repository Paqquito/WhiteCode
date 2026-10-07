import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PermissionMode } from "../src/config/settings-schema";
import { decide, type PermissionContext, type PermissionQuery } from "../src/permissions/engine";
import { resolveAsk, type HumanApprovalChannel } from "../src/permissions/resolver";
import { isRule, parseRule, ruleMatches, type Rule, type RuleDecision, type RuleScope } from "../src/permissions/rules";
import { currentPlatform } from "../src/platform/system";
import { readFileTool } from "../src/tools/read-file";
import type { ToolContext } from "../src/tools/types";
import { testToolFields, workspace } from "./helpers/env";

const ws = workspace();
const platform = currentPlatform();

function rule(text: string, decision: RuleDecision, scope: RuleScope = "user"): Rule {
  const r = parseRule(text, decision, scope, ws.project);
  if (!isRule(r)) throw new Error(r.message);
  return r;
}

function ctx(mode: PermissionMode, rules: Rule[] = []): PermissionContext {
  return { mode, rules, sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform };
}

function toolCtx(): ToolContext {
  return {
    platform,
    home: ws.home,
    cwd: ws.project,
    allowedDirectories: [ws.project],
    signal: new AbortController().signal,
    ...testToolFields(),
  };
}

/** Query of a real read_file call, with the contribution of the tool itself. */
function readQuery(path: string): PermissionQuery {
  const input = { path };
  return {
    toolName: "read_file",
    subject: readFileTool.ruleSubject(input, toolCtx()),
    flags: readFileTool.flags(input),
    contribution: readFileTool.permissionContribution!(input, toolCtx()),
    available: true,
  };
}

const neverAsked: HumanApprovalChannel = {
  request: async () => {
    throw new Error("the human channel must not be solicited");
  },
};

describe("SPEC-PER-001 permission engine", () => {
  test("SPEC-PER-001/CA-02 — an ask rule and an allow rule both matching yield ask", () => {
    const outside = join(ws.home, "notes.txt");
    const d = decide(readQuery(outside), ctx("ask", [rule(`read_file(//${outside.replace(/^\//, "")})`, "allow"), rule(`read_file(//${outside.replace(/^\//, "")})`, "ask")]));
    expect(d.kind).toBe("ask");
  });

  test("SPEC-PER-001/CA-04 — no_prompt without rule nor designated delegate: the call is denied", async () => {
    const d = decide(readQuery(join(ws.home, "outside.txt")), ctx("no_prompt"));
    expect(d.kind).toBe("ask");
    const r = await resolveAsk(d as Extract<typeof d, { kind: "ask" }>, { callId: "1", toolName: "read_file", summary: "", reason: "", origin: "default", suggestions: [] }, "no_prompt", {}, new AbortController().signal);
    expect(r.decision).toBe("deny");
  });

  test("SPEC-PER-001/CA-06 — a read inside the working folder is allowed without request in ask mode", () => {
    const d = decide(readQuery(join(ws.project, "src", "a.ts")), ctx("ask"));
    expect(d.kind).toBe("allow");
    expect(d.step).toBe(5);
  });

  test("SPEC-PER-001/CA-07 — a read outside the allowed folders asks in ask mode", () => {
    const d = decide(readQuery(join(ws.home, "elsewhere.txt")), ctx("ask"));
    expect(d.kind).toBe("ask");
  });

  test("SPEC-PER-001/CA-08 — automated run in ask mode, no delegate nor habilitated hook: denied", async () => {
    const d = decide(readQuery(join(ws.home, "elsewhere.txt")), ctx("ask"));
    const r = await resolveAsk(d as Extract<typeof d, { kind: "ask" }>, { callId: "1", toolName: "read_file", summary: "", reason: "", origin: "default", suggestions: [] }, "ask", {}, new AbortController().signal);
    expect(r).toMatchObject({ decision: "deny", by: "none" });
  });

  test("SPEC-PER-001/CA-13 — interactive session in no_prompt: denied without presenting any request", async () => {
    const d = decide(readQuery(join(ws.home, "elsewhere.txt")), ctx("no_prompt"));
    const r = await resolveAsk(d as Extract<typeof d, { kind: "ask" }>, { callId: "1", toolName: "read_file", summary: "", reason: "", origin: "tool_check", suggestions: [] }, "no_prompt", { human: neverAsked }, new AbortController().signal);
    expect(r.decision).toBe("deny");
  });

  test("TECH — resolution table: ask mode with a human interface asks the human", async () => {
    const human: HumanApprovalChannel = { request: async () => ({ answer: "yes" }) };
    const d = decide(readQuery(join(ws.home, "x.txt")), ctx("ask"));
    const r = await resolveAsk(d as Extract<typeof d, { kind: "ask" }>, { callId: "1", toolName: "read_file", summary: "", reason: "", origin: "default", suggestions: [] }, "ask", { human }, new AbortController().signal);
    expect(r).toMatchObject({ decision: "allow", by: "human" });
  });

  test("TECH — a deny rule wins even in unrestricted mode (EF-02)", () => {
    const d = decide(readQuery(join(ws.project, "secret", "k")), ctx("unrestricted", [rule("read_file(secret/**)", "deny", "project")]));
    expect(d.kind).toBe("deny");
  });
});

describe("SPEC-PER-002 rules", () => {
  test("SPEC-PER-002/CA-04 — deny read_file(~/.ssh/**) refuses reading the private key", () => {
    const r = rule("read_file(~/.ssh/**)", "deny");
    expect(ruleMatches(r, "read_file", { kind: "paths", access: "read", paths: [join(ws.home, ".ssh", "id_ed25519")] }, { cwd: ws.project, home: ws.home, platform })).toBe(true);
    expect(decide(readQuery(join(ws.home, ".ssh", "id_ed25519")), ctx("unrestricted", [r])).kind).toBe("deny");
  });

  test("SPEC-PER-002/CA-08 — a rule without closing parenthesis is ignored and reported", () => {
    const r = parseRule("edit_file(src/**", "allow", "project", ws.project);
    expect(isRule(r)).toBe(false);
    expect((r as { code: string }).code).toBe("ERR-02");
  });

  test("TECH — a rule naming an unknown tool is ignored (ERR-01)", () => {
    expect((parseRule("teleport(x)", "allow", "user", ws.project) as { code: string }).code).toBe("ERR-01");
  });
});
