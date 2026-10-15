// Supports: SPEC-SES-014 (real Git snapshots and account storage, only the company HTTP boundary simulated).
import { expect, test } from "bun:test";
import { StateCapture } from "../src/session/state-capture";
import { findExecutable } from "../src/platform/system";
import { configuredCompanyAccount } from "../src/auth/company-runtime";
import { Settings } from "../src/config/settings";
import { companyFixture } from "./helpers/company";
import { productEnv } from "./helpers/hooks";
import { loadIdentity } from "./helpers/env";
async function fixture() {
  const f = companyFixture();
  f.repository();
  await f.login();
  const account = configuredCompanyAccount(
    f.identity,
    f.ws.configHome,
    () => Settings.load({ sources: [], projectTrusted: false }),
    f.vault,
    f.network,
  )!;
  f.handle((path) =>
    path === "/api/account/state-captures" ? { accepted: true } : undefined,
  );
  const reports: string[] = [];
  let disabled = false;
  const capture = new StateCapture({
    account,
    git: findExecutable("git")!,
    cwd: () => f.ws.project,
    environment: productEnv(f.ws),
    organizations: () => ["forge.example.test/org"],
    disabled: () => disabled,
    maxFileSize: () => 1024,
    sessionId: crypto.randomUUID(),
    projectDirectory: loadIdentity().get("PROJECT_DIR"),
    redact: (t) => t,
    report: (state, reason) =>
      reports.push(state + (reason ? ": " + reason : "")),
  });
  return {
    ...f,
    capture,
    reports,
    disable: () => {
      disabled = true;
    },
  };
}
test("SPEC-SES-014/CA-01 — an authenticated snapshot records the real changed worktree, indexed by session and turn, with no conversation", async () => {
  const f = await fixture();
  f.ws.write("project/fixture.txt", "changed code");
  f.ws.write("project/new.txt", "new source");
  f.ws.write("project/.gitignore", "ignored.txt\n");
  f.ws.write("project/ignored.txt", "ignored private file");
  f.ws.write("project/.env", "LOCAL_PASSWORD=fictional");
  f.ws.write("project/credential.txt", "password=fictional-sensitive-value");
  f.ws.write("project/large.txt", "X".repeat(2048));
  f.capture.turnEnded();
  await f.capture.close();
  const rows = f.sent.filter((r) => r.path === "/api/account/state-captures");
  expect(rows.length, JSON.stringify(f.reports)).toBe(1);
  expect(f.reports).toEqual(["success"]);
  const payload = rows[0]!.body as any;
  expect(payload.message).toBe(1);
  expect(payload.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(payload.snapshot.base).toBe(f.git("rev-parse", "HEAD"));
  expect(
    payload.snapshot.files.find((file: any) => file.path === "fixture.txt")
      .data,
  ).toBe(Buffer.from("changed code").toString("base64"));
  expect(
    payload.snapshot.files.find((file: any) => file.path === "new.txt").data,
  ).toBe(Buffer.from("new source").toString("base64"));
  expect(
    payload.snapshot.files.find((file: any) => file.path === "large.txt")
      .omitted,
  ).toBeDefined();
  const raw = JSON.stringify(payload);
  expect(raw).not.toContain("ignored.txt");
  expect(raw).not.toContain(".env");
  expect(raw).not.toContain("credential.txt");
  expect(raw).not.toContain("history");
  expect(raw).not.toContain("prompt");
}, 10000);
test("SPEC-SES-014/CA-02 — a repository with the same organization name on another forge is never captured", async () => {
  const f = await fixture();
  f.git(
    "remote",
    "set-url",
    "origin",
    "https://other.example.test/org/repository.git",
  );
  f.ws.write("project/fixture.txt", "other organization private source");
  f.capture.turnEnded();
  await f.capture.close();
  expect(f.sent.some((r) => r.path === "/api/account/state-captures")).toBe(
    false,
  );
  expect(f.reports).toEqual([]);
}, 10000);
test("SPEC-SES-014/CA-03 — the runtime disable switch prevents capture before any Git or upload activity", async () => {
  const f = await fixture();
  f.disable();
  f.capture.turnEnded();
  await f.capture.close();
  expect(f.sent.some((r) => r.path === "/api/account/state-captures")).toBe(
    false,
  );
  expect(f.reports).toEqual([]);
}, 10000);
test("TECH — equivalent state is not uploaded twice and a deleted tracked file stays represented", async () => {
  const f = await fixture();
  f.git("rm", "fixture.txt");
  f.capture.turnEnded();
  for (
    let i = 0;
    i < 100 && !f.sent.some((r) => r.path === "/api/account/state-captures");
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  f.capture.turnEnded();
  await f.capture.close();
  const rows = f.sent.filter((r) => r.path === "/api/account/state-captures");
  expect(rows.length, JSON.stringify(f.reports)).toBe(1);
  expect(JSON.stringify(rows[0]!.body)).toContain('"deleted":true');
}, 10000);
