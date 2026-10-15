// Supports: SPEC-OUT-046, SPEC-CMD-094, SPEC-SES-013 (actual control and CLI composition).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { companyFixture } from "./helpers/company";
import { cli } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv } from "./helpers/hooks";
import { sleep } from "./helpers/interactive";

test("TECH — the actual subscription command delivers external CI events and terminates locally even if remote cancellation fails", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  let poll = 0;
  f.handle((path) =>
    path.endsWith("/subscriptions/create")
      ? { id: "sub-one" }
      : path.endsWith("/subscriptions/sub-one/events")
        ? {
            events:
              ++poll === 1
                ? [
                    {
                      seq: 1,
                      type: "ci_failed",
                      text: "Fixture CI failed: parser.ts",
                    },
                    { seq: 2, type: "merged", text: "Merged receipt" },
                  ]
                : [],
          }
        : path.endsWith("/cancel")
          ? new Response(null, { status: 503 })
          : undefined,
  );
  const provider = new ScriptedProvider([
    (request) => {
      expect(JSON.stringify(request.history)).toContain(
        "untrusted external data",
      );
      return { text: "External events received safely" };
    },
  ]);
  const h = new Host(f.ws, { identity: f.identity, extra: f.extra, provider });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", {
          command: "/merge-request-subscribe 42",
        }),
      ),
    ).toContain("sub-one");
    for (
      let i = 0;
      i < 600 && !f.sent.some((row) => row.path.endsWith("/cancel"));
      i++
    )
      await sleep(10);
    expect(f.sent.some((row) => row.path.endsWith("/cancel"))).toBe(true);
    expect(
      JSON.stringify(
        await h.request("invoke_command", {
          command: "/merge-request-subscribe",
        }),
      ),
    ).toContain("Aucun abonnement actif");
    expect(JSON.stringify(h.messages)).toContain("Fixture CI failed");
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
}, 15000);

test("TECH — an actual automated turn uploads its two written files, emits retrievable IDs and excludes a third ignored file", async () => {
  const f = companyFixture();
  f.repository();
  await f.login();
  f.ws.write("project/.gitignore", "outputs/ignored.txt\n");
  let uploads = 0;
  f.handle((path) =>
    path.endsWith("/files/upload") ? { id: "output-" + ++uploads } : undefined,
  );
  const provider = new ScriptedProvider([
    {
      toolCalls: ["a", "b", "ignored"].map((name) => ({
        name: "write_file",
        input: {
          path: join(f.ws.project, "outputs", name + ".txt"),
          content: name + " receipt",
        },
      })),
    },
    { text: "Outputs ready" },
  ]);
  const result = await cli(
    [
      "--non-interactive",
      "--approval-mode",
      "auto_edit",
      "--result-format",
      "jsonl",
      "Create outputs",
    ],
    f.ws,
    {
      identity: f.identity,
      extra: f.extra,
      provider,
      env: productEnv(f.ws),
      userConfig: { sessions: { outputFiles: { enabled: true } } },
    },
  );
  expect(result.code).toBe(0);
  if (uploads !== 2) throw new Error(result.stderr + result.stdout);
  expect(uploads).toBe(2);
  const event = result.stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    })
    .find((row) => row.type === "output_files");
  expect(
    event.files.map((entry: { path: string }) => entry.path).sort(),
  ).toEqual(["outputs/a.txt", "outputs/b.txt"]);
  expect(
    event.files.every((entry: { id: string }) =>
      entry.id.startsWith("output-"),
    ),
  ).toBe(true);
  expect(
    f.sent
      .filter((row) => row.path.endsWith("/files/upload"))
      .some((row) => JSON.stringify(row.body).includes("ignored")),
  ).toBe(false);
}, 15000);
