// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { Executor, ExecutorCredentialInvalid } from "../src/remote/executor";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { systemInfo } from "../src/platform/system";
import { join } from "node:path";
function fixture(kind: "session" | "job" = "job") {
  const root = mkdtempSync(join(systemInfo().tmp, "executor-proof-")),
    calls: any[] = [],
    reports: string[] = [],
    runs: string[] = [];
  let revoked = false,
    assignments: any[] = [];
  const runner = new Executor({
    kind,
    environment: "env-1",
    organizationId: "org",
    labels: ["windows", "tests"],
    capacity: 1,
    root,
    credential: async () => ({
      kind: "executor",
      token: "executor_" + "f".repeat(40),
      organizationId: "org",
      environment: "env-1",
      expiresAt: Date.now() + 3600000,
    }),
    request: async (path, body, _signal, token) => {
      calls.push({ path, body, token });
      if (revoked) throw new ExecutorCredentialInvalid();
      if (path === "register")
        return {
          id: "runner-one",
          credentialType: "executor",
          organizationId: "org",
          environment: "env-1",
        };
      if (path === "poll") {
        const jobs = assignments;
        assignments = [];
        return { jobs };
      }
      return {};
    },
    prepare: async (work) => {
      writeFileSync(join(work, "fixture.txt"), "workspace");
    },
    run: async (work, input, signal, write) => {
      runs.push(work);
      expect(readFileSync(join(work, "fixture.txt"), "utf8")).toBe("workspace");
      expect(input.prompt).toBe("Run the tests");
      write("actual work receipt");
      return { code: 0, result: "tests passed" };
    },
    report: (s) => reports.push(s),
  });
  return {
    runner,
    root,
    calls,
    reports,
    runs,
    revoke: () => (revoked = true),
    jobs: (value: any[]) => (assignments = value),
  };
}
const job = () => ({
  id: "work-1",
  environment: "env-1",
  labels: ["tests"],
  repository: "https://forge.example.test/org/repo.git",
  commit: "a".repeat(40),
  prompt: "Run the tests",
  workSecret: "work_" + "e".repeat(40),
  expiresAt: Date.now() + 60000,
});
test("SPEC-MOD-024/CA-01 — a registered executor executes compatible work in an isolated folder and returns its result", async () => {
  const f = fixture();
  await f.runner.register(new AbortController().signal);
  f.jobs([job()]);
  await f.runner.poll(new AbortController().signal);
  await f.runner.idle();
  expect(f.runs).toHaveLength(1);
  expect(
    f.calls.find((c) => c.path === "work/work-1/result").body,
  ).toMatchObject({ code: 0, result: "tests passed" });
  await f.runner.close();
});
test("SPEC-MOD-023/CA-01 — a session assignment executes in the customer workspace with a session-scoped work secret", async () => {
  const f = fixture("session");
  await f.runner.register(new AbortController().signal);
  f.jobs([job()]);
  await f.runner.poll(new AbortController().signal);
  await f.runner.idle();
  expect(f.runs[0]).toStartWith(f.root);
  expect(f.calls.find((c) => c.path === "work/work-1/result").token).toBe(
    job().workSecret,
  );
  await f.runner.close();
});
test("SPEC-MOD-023/CA-02 — SPEC-MOD-024/CA-02 — SPEC-API-028/CA-08 — revocation ends polling and no further work starts", async () => {
  const f = fixture();
  await f.runner.register(new AbortController().signal);
  f.revoke();
  f.jobs([job()]);
  await f.runner.poll(new AbortController().signal);
  expect(f.runner.state).toBe("revoked");
  expect(f.runs).toHaveLength(0);
  expect(f.reports.join(" ")).toContain("Identifiant d’exécuteur invalide");
  await f.runner.poll(new AbortController().signal);
  expect(f.calls.filter((c) => c.path === "poll")).toHaveLength(1);
  await f.runner.close();
});
test("SPEC-API-028/CA-09 — a company user token is rejected before executor registration", async () => {
  const f = fixture();
  const invalid = new Executor({
    ...f.runner.options,
    credential: async () =>
      ({
        kind: "company",
        token: "fixture-user-token",
        organizationId: "org",
        environment: "env-1",
        expiresAt: Date.now() + 10000,
      }) as any,
  });
  await expect(invalid.register(new AbortController().signal)).rejects.toThrow(
    "Identifiant",
  );
  expect(f.calls).toHaveLength(0);
  await invalid.close();
  await f.runner.close();
});
test("TECH — incompatible assignments, repeated work and over-capacity jobs never execute", async () => {
  const f = fixture();
  await f.runner.register(new AbortController().signal);
  f.jobs([
    { ...job(), id: "wrong", labels: ["other"] },
    job(),
    { ...job(), id: "excess" },
  ]);
  await f.runner.poll(new AbortController().signal);
  await f.runner.idle();
  f.jobs([job()]);
  await f.runner.poll(new AbortController().signal);
  await f.runner.idle();
  expect(f.runs).toHaveLength(1);
  expect(f.calls.filter((c) => c.path.endsWith("/reject"))).toHaveLength(2);
  await f.runner.close();
});
