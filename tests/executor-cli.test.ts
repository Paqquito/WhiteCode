// Supports: SPEC-MOD-023/024, SPEC-API-028 (public command boundary and independent machine credentials).
import { expect, test } from "bun:test";
import { companyFixture } from "./helpers/company";
import { cli } from "./helpers/env";
import { executorCredentials } from "../src/remote/executor-runtime";

test("TECH — a standalone executor cannot bypass a required account-limits source or import its machine key first", async () => {
  const f = companyFixture(),
    credential = f.ws.write(
      "machine.json",
      JSON.stringify({
        kind: "executor",
        token: "executor_" + "r".repeat(40),
        organizationId: "org",
        environment: "env-one",
        expiresAt: Date.now() + 60000,
      }),
    );
  f.ws.write(
    "managed/limits-source.json",
    JSON.stringify({
      schemaVersion: 1,
      organizationId: "org",
      required: true,
      perimeter: "remote",
    }),
  );
  const result = await cli(
    [
      "job-runner",
      "start",
      "--organization",
      "org",
      "--environment",
      "env-one",
      "--credential-file",
      credential,
    ],
    f.ws,
    { identity: f.identity, extra: f.extra },
  );
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("source obligatoire");
  expect(f.sent).toEqual([]);
  expect(f.entries.size).toBe(0);
});

test("TECH — both public runner commands register independently, honour capacity and stop on machine credential revocation", async () => {
  for (const family of ["session-runner", "job-runner"]) {
    const f = companyFixture(),
      credential = f.ws.write(
        "machine.json",
        JSON.stringify({
          kind: "executor",
          token: "executor_" + "t".repeat(40),
          organizationId: "org",
          environment: "env-one",
          expiresAt: Date.now() + 60000,
        }),
      );
    f.handle((path, body) =>
      path.endsWith("/executors/register")
        ? {
            id: "runner-one",
            credentialType: "executor",
            organizationId: "org",
            environment: "env-one",
          }
        : path.endsWith("/executors/poll")
          ? new Response(null, { status: 401 })
          : undefined,
    );
    const result = await cli(
      [
        family,
        "start",
        "--organization",
        "org",
        "--environment",
        "env-one",
        "--credential-file",
        credential,
        "--concurrent-sessions",
        "2",
      ],
      f.ws,
      { identity: f.identity, extra: f.extra },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("infrastructure locale");
    expect(result.stderr).toContain("Identifiant d’exécuteur invalide");
    const registration = f.sent.find((row) =>
      row.path.endsWith("/executors/register"),
    )!;
    expect(registration.body).toMatchObject({
      capacity: 2,
      environment: "env-one",
      kind: family === "session-runner" ? "session" : "job",
    });
    expect(registration.authorization).toStartWith("Executor executor_");
    expect(f.sent.some((row) => row.path.includes("/account/"))).toBe(false);
    expect(
      await executorCredentials(
        f.vault,
        f.identity.get("KEYCHAIN_SERVICE") + ":executors",
        "org",
        "env-one",
      ).read(),
    ).toMatchObject({ kind: "executor" });
  }
}, 15000);

test("TECH — a public runner cannot substitute a human company login or bypass offline policy", async () => {
  const f = companyFixture();
  await f.login();
  const args = [
    "job-runner",
    "start",
    "--organization",
    "org",
    "--environment",
    "env-one",
  ];
  const result = await cli(args, f.ws, {
    identity: f.identity,
    extra: f.extra,
  });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("Identifiant d’exécuteur");
  expect(f.sent.some((row) => row.path.includes("/executors/"))).toBe(false);
  const offline = await cli(args, f.ws, {
    identity: f.identity,
    extra: f.extra,
    env: { [f.identity.get("ENV_PREFIX") + "OFFLINE_MINIMAL"]: "1" },
  });
  expect(offline.code).toBe(2);
  expect(f.sent.some((row) => row.path.includes("/executors/"))).toBe(false);
});
