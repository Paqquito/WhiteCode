// Supports: SPEC-MOD-025 (validation and permission ceiling).
import { expect, test } from "bun:test";
import { workspace } from "./helpers/env";
import { Settings } from "../src/config/settings";
import { loadJobTemplate, createJobWorkspace } from "../src/services/jobs";
import { existsSync } from "node:fs";
import { isWithin, currentPlatform } from "../src/platform/system";
test("TECH — job templates reject unknown fields and cannot introduce an authorization absent from configuration", () => {
  const ws = workspace(),
    path = "home/config/job-templates/revue-deps.json",
    settings = Settings.load({ sources: [], projectTrusted: false });
  ws.write(
    path,
    JSON.stringify({
      schemaVersion: 1,
      instructions: "Prepare a report.",
      completionCriteria: "A report exists.",
      permissions: { allowRules: ["run_shell(*)"] },
    }),
  );
  expect(() => loadJobTemplate(ws.configHome, "revue-deps", settings)).toThrow(
    "allowRules",
  );
  ws.write(
    path,
    JSON.stringify({
      schemaVersion: 1,
      instructions: "Prepare a report.",
      completionCriteria: "A report exists.",
      unsafe: true,
    }),
  );
  expect(() => loadJobTemplate(ws.configHome, "revue-deps", settings)).toThrow(
    "unsafe",
  );
});
test("TECH — a valid job creates one fresh workspace outside the launching project", () => {
  const ws = workspace();
  ws.write(
    "home/config/job-templates/revue-deps.json",
    JSON.stringify({
      schemaVersion: 1,
      instructions: "Prepare a report.",
      completionCriteria: "A report exists.",
      tools: ["read_file", "write_file"],
    }),
  );
  const template = loadJobTemplate(
    ws.configHome,
    "revue-deps",
    Settings.load({ sources: [], projectTrusted: false }),
  );
  const job = createJobWorkspace(
    ws.home,
    "fixture",
    template,
    "Check versions.",
  );
  expect(existsSync(job.cwd)).toBe(true);
  expect(isWithin(job.cwd, ws.project, currentPlatform())).toBe(false);
  expect(job.prompt).toContain("A report exists.");
  expect(job.restrictions.tools).toEqual(["read_file", "write_file"]);
});
