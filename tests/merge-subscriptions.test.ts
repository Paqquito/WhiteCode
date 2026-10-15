// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { MergeSubscriptions } from "../src/remote/merge-subscriptions";
function setup() {
  let events: any[] = [],
    identity = { account: "member", organization: { id: "org" } };
  const calls: any[] = [],
    delivered: any[] = [],
    records: any[] = [];
  const client = new MergeSubscriptions({
    account: {
      profile: async () => identity,
      request: async (_service, path, body) => {
        calls.push({ path, body });
        if (path === "repository-access") return { accessible: true };
        if (path === "subscriptions/create") return { id: "subscription-one" };
        if (path.endsWith("/events")) return { events };
        return {};
      },
    },
    repository: async () => "https://forge.example.test/org/repo.git",
    record: (record) => records.push(record),
    deliver: (value) => delivered.push(value),
    report: () => {},
    redact: (s) => s,
    active: () => true,
    intervalMs: 100000,
  });
  return {
    client,
    calls,
    delivered,
    records,
    events: (value: any[]) => (events = value),
  };
}
test("SPEC-OUT-046/CA-01 — a CI failure is delivered as identified external data and its cursor prevents duplicate delivery", async () => {
  const f = setup();
  await f.client.command("42", new AbortController().signal);
  f.events([
    {
      seq: 1,
      type: "ci_failed",
      text: "Tests failed in check-types",
      url: "https://forge.example.test/org/repo/actions/runs/1",
    },
  ]);
  await f.client.poll(new AbortController().signal);
  await f.client.poll(new AbortController().signal);
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toContain("untrusted external data");
  expect(f.delivered[0]).toContain("Tests failed");
  expect(f.records.at(-1).after).toBe(1);
  await f.client.close();
});
test("SPEC-OUT-046/CA-02 — a merged request terminates its subscription and later events are not delivered", async () => {
  const f = setup();
  await f.client.command("42", new AbortController().signal);
  f.events([{ seq: 1, type: "merged", text: "Merged" }]);
  await f.client.poll(new AbortController().signal);
  expect(f.client.active).toHaveLength(0);
  expect(f.calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
  const count = f.calls.length;
  await f.client.poll(new AbortController().signal);
  expect(f.calls).toHaveLength(count);
  await f.client.close();
});
test("SPEC-CMD-094/CA-01 — subscribing to an open request delivers later review comments with file and line and can be listed and cancelled", async () => {
  const f = setup();
  expect(await f.client.command("42", new AbortController().signal)).toContain(
    "42",
  );
  f.events([
    {
      seq: 1,
      type: "review_comment",
      text: "Check the empty input",
      file: "src/parser.ts",
      line: 23,
    },
  ]);
  await f.client.poll(new AbortController().signal);
  expect(f.delivered[0]).toContain("src/parser.ts:23");
  expect(await f.client.command("", new AbortController().signal)).toContain(
    "42",
  );
  await f.client.command("off", new AbortController().signal);
  expect(f.client.active).toHaveLength(0);
  await f.client.close();
});
