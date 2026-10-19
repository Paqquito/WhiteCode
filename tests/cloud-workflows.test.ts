// Supports: SPEC-PER-020, SPEC-MOD-013/016/017, SPEC-AGT-019, SPEC-OUT-032/047, SPEC-CMD-017/018/055/056/057/064/103/105, SPEC-EXT-027.
import { test, expect } from "bun:test";
import { CloudWorkflows } from "../src/remote/workflows";
function fixture() {
  let authenticated = true,
    accepted = true,
    selected = "env-b",
    status: any = { status: "running" },
    calls: any[] = [],
    records: any[] = [],
    contexts: string[] = [],
    notices: string[] = [],
    questions: string[] = [];
  const account = {
    profile: async () =>
      authenticated
        ? { account: "member", organization: { id: "org" } }
        : undefined,
    request: async (service: string, path: string, body: any) => {
      calls.push({ service, path, body });
      if (path === "environments")
        return {
          environments: [
            { id: "env-a", name: "A" },
            { id: "env-b", name: "B" },
          ],
        };
      if (path === "estimate") return { available: false };
      if (path === "key-status")
        return { repositoryAccessible: true, delegatedKey: true };
      if (service === "share")
        return { url: "https://web.example.test/shared/one" };
      if (path === "create")
        return {
          id: "remote-1",
          url: "https://sessions.example.test/remote-1",
        };
      if (path.endsWith("/status")) return status;
      if (service === "share")
        return { url: "https://web.example.test/shared/one" };
      if (path === "repository-access") return { accessible: true };
      return { id: "trigger-1", items: [] };
    },
  };
  let environment: string | undefined;
  const c = new CloudWorkflows({
    account,
    sessionUrl: "https://sessions.example.test/",
    webUrl: "https://web.example.test/",
    repository: async () => ({
      repository: "https://forge.example.test/org/repo.git",
      branch: "main",
      commit: "a".repeat(40),
    }),
    confirm: async (q: string) => {
      questions.push(q);
      return accepted;
    },
    select: async () => selected,
    environment: () => environment,
    setEnvironment: (v) => {
      environment = v;
    },
    record: (r) => records.push(r),
    context: (s) => contexts.push(s),
    report: (s) => notices.push(s),
    open: () => true,
    qr: async () => "QR fixture",
    history: () => [{ role: "user", text: "share witness" }],
    redact: (s) => s,
    refusal: () => undefined,
    pollMs: 10,
  });
  return {
    c,
    calls,
    records,
    contexts,
    notices,
    questions,
    auth: (v: boolean) => (authenticated = v),
    accept: (v: boolean) => (accepted = v),
    status: (v: any) => (status = v),
    environment: () => environment,
  };
}
test("SPEC-CMD-056/CA-01 — selecting an accessible environment controls subsequent remote creations", async () => {
  const f = fixture();
  await f.c.command("cloud-environment", "", new AbortController().signal);
  expect(f.environment()).toBe("env-b");
  await f.c.command("deep-review", "", new AbortController().signal);
  expect(f.calls.find((c) => c.path === "create").body.environment).toBe(
    "env-b",
  );
  await f.c.close();
});
test("SPEC-CMD-018/CA-01 — estimation availability is disclosed before any billable creation and refusal creates nothing", async () => {
  const f = fixture();
  f.accept(false);
  await f.c.command("deep-review", "42", new AbortController().signal);
  expect(f.questions.join(" ")).toContain("Estimation indisponible");
  expect(f.calls.some((c) => c.path === "create")).toBe(false);
  await f.c.close();
});
test("SPEC-CMD-017/CA-01 — a remote plan has an early link and only the approved revision is imported", async () => {
  const f = fixture();
  await f.c.command(
    "deep-plan",
    "Refactor parser",
    new AbortController().signal,
  );
  expect(f.notices.join(" ")).toContain(
    "https://sessions.example.test/remote-1",
  );
  f.status({
    status: "completed",
    approved: false,
    plan: "unapproved witness",
  });
  await f.c.refresh(new AbortController().signal);
  expect(f.contexts).toHaveLength(0);
  f.status({
    status: "completed",
    approved: true,
    revision: "rev-1",
    plan: "approved witness",
  });
  await f.c.refresh(new AbortController().signal);
  expect(f.contexts.join(" ")).toContain("approved witness");
  await f.c.close();
});
test("SPEC-AGT-019/CA-01 — recorded remote review identity restores its current service state after closing", async () => {
  const f = fixture();
  await f.c.command("deep-review", "", new AbortController().signal);
  const saved = structuredClone(f.records);
  await f.c.close();
  const next = fixture();
  next.status({ status: "completed", result: "review result" });
  await next.c.restore(saved, new AbortController().signal);
  expect(next.c.tasks[0]?.status).toBe("completed");
  expect(next.contexts.join(" ")).toContain("review result");
  await next.c.close();
});
test("SPEC-CMD-057/CA-01 — remote configuration follows the human forge flow and verifies repository access without a forge credential", async () => {
  const f = fixture();
  const note = await f.c.command(
    "configure-remote",
    "",
    new AbortController().signal,
  );
  expect(note).toContain("accès confirmé");
  expect(f.calls.some((c) => c.path === "repository-access")).toBe(true);
  await f.c.close();
});
test("SPEC-CMD-105/CA-01 — sharing sends the reviewed history only after confirmation and returns its link", async () => {
  const f = fixture();
  f.accept(false);
  await f.c.command("share", "", new AbortController().signal);
  expect(f.calls).toHaveLength(0);
  f.accept(true);
  expect(
    await f.c.command("share", "", new AbortController().signal),
  ).toContain("/shared/one");
  expect(f.calls[0].body.messages[0].text).toBe("share witness");
  await f.c.close();
});
test("SPEC-CMD-064/CA-01 — a known remote task exposes its validated address and QR", async () => {
  const f = fixture();
  await f.c.command("deep-review", "", new AbortController().signal);
  expect(
    await f.c.command("session", "", new AbortController().signal),
  ).toContain("QR fixture");
  await f.c.close();
});
test("SPEC-OUT-032/CA-02 — listing remote triggers without a company account asks the user to connect", async () => {
  const f = fixture();
  f.auth(false);
  await expect(
    f.c.triggers("list", {}, new AbortController().signal),
  ).rejects.toThrow("Connectez");
  expect(f.calls).toHaveLength(0);
  await f.c.close();
});
test("SPEC-OUT-032/CA-01 — a daily remote trigger is created only after an explicit recap confirmation", async () => {
  const f = fixture();
  f.accept(false);
  await f.c.triggers(
    "create",
    {
      prompt: "Summarize tickets",
      cron: "0 9 * * *",
      timeZone: "Europe/Paris",
    },
    new AbortController().signal,
  );
  expect(f.calls.some((c) => c.service === "triggers")).toBe(false);
  f.accept(true);
  await f.c.triggers(
    "create",
    {
      prompt: "Summarize tickets",
      cron: "0 9 * * *",
      timeZone: "Europe/Paris",
    },
    new AbortController().signal,
  );
  expect(f.questions.at(-1)).toContain("0 9 * * *");
  expect(
    f.calls.some((c) => c.service === "triggers" && c.path === "create"),
  ).toBe(true);
  await f.c.close();
});
test("SPEC-EXT-027/CA-01 — a weekly schedule recap displays the cron and local time before service creation", async () => {
  const f = fixture();
  await f.c.triggers(
    "create",
    {
      prompt: "Summarize open tickets",
      cron: "0 9 * * 1",
      timeZone: "Europe/Paris",
    },
    new AbortController().signal,
  );
  expect(f.questions[0]).toContain("09:00");
  expect(f.questions[0]).toContain("Europe/Paris");
  expect(f.questions[0]).toContain("0 9 * * 1");
  await f.c.close();
});
test("TECH — creating a hosted trigger sends the pinned branch, commit, explicit ceiling and permitted capability selection", async () => {
  const f = fixture();
  try {
    await f.c.triggers("create", { name: "Daily inspection", prompt: "Inspect the project", cron: "0 9 * * *", timeZone: "UTC", maxCost: 1.5, tools: ["read_file"], connectors: [], paused: true }, new AbortController().signal);
    const creation = f.calls.find(call => call.service === "triggers" && call.path === "create");
    expect(creation.body).toMatchObject({ branch: "main", commit: "a".repeat(40), maxCost: 1.5, name: "Daily inspection", tools: ["read_file"], connectors: [], paused: true });
    expect(f.questions.at(-1)).toContain("1.5");
  } finally { await f.c.close(); }
});
test("SPEC-OUT-047/CA-01 — declining a background proposal records the refusal and never creates a remote session", async () => {
  const f = fixture();
  f.accept(false);
  expect(
    await f.c.suggest(
      {
        title: "Fix neighbor",
        reason: "Adjacent bug",
        prompt: "Fix only neighbor",
      },
      new AbortController().signal,
    ),
  ).toContain("declined");
  expect(f.calls.some((c) => c.path === "create")).toBe(false);
  expect(f.records.some((c) => c.event === "remote_suggestion_declined")).toBe(
    true,
  );
  await f.c.close();
});
test("TECH — changing the company identity rejects restored remote tasks and malicious links never become available", async () => {
  const f = fixture();
  await f.c.restore(
    [
      {
        event: "remote_task",
        id: "r",
        kind: "review",
        account: "other",
        organizationId: "org",
        url: "https://attacker.example.test",
      },
    ],
    new AbortController().signal,
  );
  expect(f.c.tasks).toHaveLength(0);
  await f.c.close();
});
