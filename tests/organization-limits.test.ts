// Supports: SPEC-PER-020, SPEC-MOD-013/016/017, SPEC-AGT-019, SPEC-OUT-032/047, SPEC-CMD-017/018/055/056/057/064/103/105, SPEC-EXT-027.
import { test, expect } from "bun:test";
import { OrganizationLimits } from "../src/permissions/organization-limits";
import { limitsSource } from "../src/permissions/limits-source";
import { workspace } from "./helpers/env";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
function setup(required = false, perimeter: "all" | "remote" = "remote") {
  let source: any = {
      schemaVersion: 1,
      organizationId: "org",
      version: "one",
      validUntil: Date.now() + 86400000,
      limits: ["remote_sessions"],
    },
    offline = false,
    cache: any;
  const reports: string[] = [],
    owner = { account: "member", organizationId: "org" };
  const limits = new OrganizationLimits({
    owner: () => owner,
    authority: () => ({ required, perimeter, authorizedCache: () => false }),
    readCache: () => cache,
    writeCache: (value, account) => (cache = { value, account }),
    load: async () => {
      if (offline) throw Error("offline");
      return source;
    },
    report: (s) => reports.push(s),
  });
  return {
    limits,
    reports,
    source: (value: any) => (source = value),
    offline: () => (offline = true),
    cache: (value: any) => (cache = { value, account: owner.account }),
    owner,
  };
}
test("SPEC-PER-020/CA-01 — an organization remote-session limit refuses use with a reason", async () => {
  const f = setup();
  await f.limits.initialize(new AbortController().signal);
  await f.limits.refresh(new AbortController().signal);
  expect(f.limits.refusal("remote_sessions")).toContain(
    "politique de votre organisation",
  );
  expect(f.limits.refusal("local")).toBeUndefined();
  f.limits.close();
});
test("SPEC-PER-020/CA-02 — an unreachable optional source starts using its valid account-bound cache", async () => {
  const f = setup();
  f.cache({
    schemaVersion: 1,
    organizationId: "org",
    version: "cached",
    validUntil: Date.now() + 10000,
    limits: ["remote_sessions"],
  });
  f.offline();
  await f.limits.initialize(new AbortController().signal);
  expect(f.limits.refusal("remote")).toContain("politique");
  expect(f.limits.refusal("local")).toBeUndefined();
  f.limits.close();
});
test("SPEC-PER-020/CA-03 — a required unreachable source cannot use an unauthorized user cache and blocks its perimeter", async () => {
  const f = setup(true);
  f.cache({
    schemaVersion: 1,
    organizationId: "org",
    version: "cached",
    validUntil: Date.now() + 10000,
    limits: [],
  });
  f.offline();
  await f.limits.initialize(new AbortController().signal);
  expect(f.limits.refusal("remote")).toContain("source obligatoire");
  expect(f.limits.refusal("local")).toBeUndefined();
  f.limits.close();
});
test("SPEC-PER-020/CA-04 — an unknown required limit invalidates the whole version while other functions stay available", async () => {
  const f = setup(true);
  f.source({
    schemaVersion: 1,
    organizationId: "org",
    version: "new",
    validUntil: Date.now() + 10000,
    limits: ["unknown_future_limit"],
  });
  await f.limits.initialize(new AbortController().signal);
  expect(f.limits.refusal("remote")).toContain("source obligatoire");
  expect(f.limits.refusal("unrestricted_mode")).toBeUndefined();
  expect(f.reports.join(" ")).toContain("limite inconnue");
  f.limits.close();
});
test("TECH — another account cannot inherit required limits or an earlier account cache", async () => {
  const f = setup(true);
  f.source({
    schemaVersion: 1,
    organizationId: "org",
    version: "one",
    validUntil: Date.now() + 10000,
    limits: [],
  });
  await f.limits.initialize(new AbortController().signal);
  expect(f.limits.refusal("remote")).toBeUndefined();
  f.owner.account = "other";
  expect(f.limits.refusal("remote")).toContain("source obligatoire");
  f.limits.close();
});
test("TECH — only independent administrative protection and the exact offline digest can authorize a required limits cache", async () => {
  const ws = workspace(),
    value = {
      schemaVersion: 1 as const,
      organizationId: "org",
      version: "offline-one",
      validUntil: Date.now() + 100000,
      limits: ["remote_sessions"],
    },
    path = join(ws.managed, "limits-source.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      organizationId: "org",
      required: true,
      perimeter: "remote",
      offline: {
        sha256: createHash("sha256")
          .update(JSON.stringify(value))
          .digest("hex"),
        validUntil: Date.now() + 100000,
      },
    }),
  );
  let protectedFile = true;
  const source = limitsSource({
    managedDir: ws.managed,
    configDir: ws.configHome,
    organizationId: "org",
    protection: () => ({ writable: !protectedFile }),
    report: () => {},
  });
  source.writeCache(value, "member");
  const make = () =>
    new OrganizationLimits({
      owner: () => ({ account: "member", organizationId: "org" }),
      authority: source.authority,
      readCache: source.readCache,
      writeCache: source.writeCache,
      load: async () => {
        throw Error("offline");
      },
      report: () => {},
    });
  const authorized = make();
  await authorized.initialize(new AbortController().signal);
  expect(authorized.refusal("remote")).toContain("politique");
  expect(authorized.refusal("local")).toBeUndefined();
  protectedFile = false;
  expect(authorized.refusal("remote")).toContain("source obligatoire");
  expect(authorized.refusal("local")).toContain("source obligatoire");
  authorized.close();
  protectedFile = true;
  writeFileSync(
    source.cacheFile,
    JSON.stringify({ account: "member", value: { ...value, limits: [] } }),
  );
  const altered = make();
  await altered.initialize(new AbortController().signal);
  expect(altered.refusal("remote")).toContain("source obligatoire");
  altered.close();
});
